// 项目发现 + git 近况信号采集。纯 Node，不依赖 Electron，可被 scripts/test-scan.js 直接引用。
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 4;
const AI_SESSION_DIRS = ['.kimi-code', '.claude', '.codex'];
// 会话目录 → 工具 id（详情面板的 AI 会话痕迹明细用，issue #17）
const AI_TOOL_DIRS = [['.kimi-code', 'kimi'], ['.claude', 'claude'], ['.codex', 'codex']];
const MAX_BRANCHES = 50;
// 扫描总耗时超过该阈值时在控制台输出 breakdown（issue #8）
const SLOW_SCAN_MS = 3000;

// git 子进程全局并发上限：超过的命令排队，避免多项目同时铺开拖死系统（issue #8）
const GIT_CONCURRENCY = 6;
let gitRunning = 0;
const gitQueue = [];

// 单项目扫描预算：超时降级为缓存数据（issue #24）
const PROJECT_SCAN_BUDGET_MS = 3000;

function gitSlotAcquire() {
  if (gitRunning < GIT_CONCURRENCY) {
    gitRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gitQueue.push(resolve));
}

function gitSlotRelease() {
  const next = gitQueue.shift();
  if (next) next();
  else gitRunning--;
}

function git(projectPath, args, timeout = 5000) {
  return gitSlotAcquire().then(
    () =>
      new Promise((resolve, reject) => {
        execFile('git', ['-C', projectPath].concat(args), { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      })
  ).finally(gitSlotRelease);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// 递归找含 .git 的目录，深度上限 MAX_DEPTH；跳过黑名单与 . 开头目录（.git 本身只探测不进入）
// extraPaths 为逐项指定的补充路径，要求自身含 .git
async function discover(roots, blacklist, extraPaths) {
  const skip = new Set(blacklist.map((s) => s.toLowerCase()));
  const found = new Map();

  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((e) => e.name === '.git');
    if (hasGit) {
      found.set(path.resolve(dir).toLowerCase(), path.resolve(dir));
      return; // 已是项目，不再深入（忽略嵌套仓库）
    }
    if (depth >= MAX_DEPTH) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name.toLowerCase()))
        .map((e) => walk(path.join(dir, e.name), depth + 1))
    );
  };

  await Promise.all(roots.filter(Boolean).map((root) => walk(path.resolve(root), 0).catch(() => {})));
  // 补充路径：逐项指定、含 .git 才收，不再深入
  for (const extra of extraPaths || []) {
    if (!extra) continue;
    if (!(await exists(path.join(extra, '.git')))) continue;
    found.set(path.resolve(extra).toLowerCase(), path.resolve(extra));
  }
  return [...found.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function emptyProject(projectPath) {
  return {
    path: projectPath,
    name: path.basename(projectPath),
    branch: '',
    branches: [], // 本地分支列表：[{name, at}]，按最后提交时间倒序，上限 MAX_BRANCHES（issue #4）
    lastCommitAt: null,
    commits7d: 0,
    recentCommits: [],
    dirtyCount: 0,
    dirtyFiles: [],
    dirtyAt: null,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    activity365: new Array(365).fill(0),
    activityDate: null, // activity365 构建时的本地日期，供缓存平移对齐
    headSha: null, // 当前 HEAD 提交哈希，activity365 分档缓存的比对键（issue #23）
    degraded: false, // 扫描超时降级为缓存数据时为 true（issue #24）
    aiSessionAt: null,
    lastActivityAt: null,
    memo: '',
    band: 'stale',
    warnings: [],
    github: null,
    originUrl: null,
  };
}

// 单个目录内最新文件 mtime（有界遍历，budget 共享条目数上限）
async function dirLatestMtime(dir, budget) {
  let latest = 0;
  const walk = async (d, depth) => {
    if (budget.n <= 0 || depth > 3) return;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.n <= 0) return;
      budget.n--;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) await walk(full, depth + 1);
        else {
          const st = await fsp.stat(full);
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        }
      } catch { /* 忽略不可读项 */ }
    }
  };
  await walk(dir, 0);
  return latest;
}

// AI 会话痕迹：.kimi-code / .claude / .codex 目录内最新文件 mtime（有界遍历）
async function aiSessionAt(projectPath) {
  let latest = 0;
  const budget = { n: 300 };
  for (const d of AI_SESSION_DIRS) {
    const dir = path.join(projectPath, d);
    if (await exists(dir)) {
      const t = await dirLatestMtime(dir, budget);
      if (t > latest) latest = t;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// AI 会话痕迹明细：按工具目录分别统计最新 mtime，按时间倒序（issue #17）
async function aiSessionTraces(projectPath) {
  const out = [];
  for (const pair of AI_TOOL_DIRS) {
    const dir = path.join(projectPath, pair[0]);
    if (!(await exists(dir))) continue;
    const t = await dirLatestMtime(dir, { n: 300 });
    if (t > 0) out.push({ tool: pair[1], at: new Date(t).toISOString() });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return out;
}

// README 首段摘要：去 markdown 标记，截 ~200 字（issue #17）
async function readmeSummary(projectPath) {
  let names;
  try {
    names = await fsp.readdir(projectPath);
  } catch {
    return '';
  }
  const hit = names.find((n) => /^readme(\.(md|markdown|txt|rst))?$/i.test(n));
  if (!hit) return '';
  let raw;
  try {
    raw = await fsp.readFile(path.join(projectPath, hit), 'utf8');
  } catch {
    return '';
  }
  const lines = raw.replace(/\r/g, '').split('\n');
  const para = [];
  let paraIsHeading = false; // 首段仅是标题行时，续取下一段作为摘要
  for (const line of lines) {
    const t = line.trim();
    // 跳过 badge / 图片 / HTML 行，不作为摘要内容
    if (/^\[!\[|^<|^!?\[.*\]\(.*\)$/.test(t)) continue;
    if (!t) {
      if (para.length && !paraIsHeading) break;
      if (para.length && paraIsHeading) paraIsHeading = false; // 标题段结束，进入正文段
      continue;
    }
    if (!para.length) paraIsHeading = /^#/.test(t);
    else if (!paraIsHeading && /^#/.test(t)) break; // 正文段止于下一个标题
    para.push(t);
  }
  let text = para
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/[*_`>]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 200) text = text.slice(0, 200).replace(/[，。、；,.;:\s]+$/, '') + '…';
  return text;
}

// 详情面板按需取的单项目深区数据（issue #17）：README 摘要 + AI 会话痕迹明细
async function projectDetail(projectPath) {
  const [readme, aiSessions] = await Promise.all([
    readmeSummary(projectPath),
    aiSessionTraces(projectPath),
  ]);
  return { readme, aiSessions };
}

// log --since="365 days ago" 按天聚合，今天在最后
function buildActivity365(logOutput, now) {
  const counts = new Array(365).fill(0);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const line of logOutput.split('\n')) {
    const t = Date.parse(line.trim());
    if (!Number.isFinite(t)) continue;
    const idx = 364 - Math.floor((todayStart + DAY_MS - 1 - t) / DAY_MS);
    if (idx >= 0 && idx < 365) counts[idx]++;
  }
  return counts;
}

// 缓存的 activity365 按天数平移对齐到今天的窗口（HEAD 未变时复用，issue #23）：
// cachedDate 是构建缓存时的「今天」(YYYY-MM-DD)，每过一天最旧的一格出窗、末尾补 0
function shiftActivity365(cachedArr, cachedDate, now) {
  const out = new Array(365).fill(0);
  if (!Array.isArray(cachedArr)) return out;
  const cachedDay = Date.parse(cachedDate + 'T00:00:00');
  if (!Number.isFinite(cachedDay)) return cachedArr.slice(0, 365);
  const todayDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const shift = Math.round((todayDay - cachedDay) / DAY_MS);
  if (shift <= 0) return cachedArr.slice(0, 365);
  if (shift >= 365) return out;
  for (let i = 0; i + shift < 365; i++) out[i] = cachedArr[i + shift] || 0;
  return out;
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function bandOf(lastActivityAt, now) {
  if (!lastActivityAt) return 'archive';
  const days = (now.getTime() - Date.parse(lastActivityAt)) / DAY_MS;
  if (days <= 3) return 'hot';
  if (days <= 7) return 'active';
  if (days <= 30) return 'cooling';
  if (days <= 90) return 'stale';
  return 'archive';
}

// 未提交改动里最近的文件修改时间（取前 20 个脏文件，改名条目取新路径）
async function dirtyMtime(projectPath, dirtyLines) {
  const stats = await Promise.all(
    dirtyLines.slice(0, 20).map(async (line) => {
      let rel = line.slice(3).trim();
      const arrow = rel.indexOf(' -> ');
      if (arrow >= 0) rel = rel.slice(arrow + 4);
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      try {
        return (await fsp.stat(path.join(projectPath, rel))).mtimeMs;
      } catch {
        return 0; // 已删除或不可读
      }
    })
  );
  const latest = Math.max(0, ...stats);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// 警示标记。github 数据在扫描后由 github.js 挂接，PR 警示由调用方补充。
function localWarnings(p, now) {
  const warnings = [];
  if (p.dirtyCount > 0 && p.lastCommitAt) {
    const days = (now.getTime() - Date.parse(p.lastCommitAt)) / DAY_MS;
    // 近似：无法得知脏文件起始时间，用最后提交时间近似「滞留超3天」
    if (days > 3) warnings.push({ type: 'dirty', label: `${p.dirtyCount} 文件未提交超3天` });
  }
  if (p.ahead > 0) warnings.push({ type: 'ahead', label: `${p.ahead} 提交未推送` });
  return warnings;
}

function parseCommitLines(logOutput) {
  return logOutput
    ? logOutput.split('\n').filter(Boolean).map((line) => {
        const i = line.lastIndexOf('|');
        return i >= 0
          ? { msg: line.slice(0, i), rel: line.slice(i + 1) }
          : { msg: line, rel: '' };
      })
    : [];
}

// 本地分支列表（含各自最后提交时间），按最后提交倒序，超上限截断（issue #4）
function parseBranches(out) {
  if (!out) return [];
  return out.split('\n').filter(Boolean).slice(0, MAX_BRANCHES).map((line) => {
    const i = line.indexOf('\0');
    return i >= 0 ? { name: line.slice(0, i), at: line.slice(i + 1) || null } : { name: line, at: null };
  });
}

async function scanProject(projectPath, now, opts) {
  const p = emptyProject(projectPath);
  const cached = opts && opts.cached;
  try {
    // 先取 HEAD sha：与缓存一致则跳过最慢的 365 天日志（issue #23 快慢分档）
    const headSha = await git(projectPath, ['rev-parse', 'HEAD']).catch(() => '');
    p.headSha = headSha || null;
    const reuseActivity = !!(
      cached && cached.headSha && headSha && cached.headSha === headSha &&
      Array.isArray(cached.activity365) && cached.activity365.length === 365
    );

    // 任一可用即视为活仓库；lastCommitAt 为空（空仓）时整体降级
    const [branch, lastCommitAt, commits7d, recentLog, status, aheadBehind, activityLog, origin, branchesOut] =
      await Promise.all([
        git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        git(projectPath, ['log', '-1', '--format=%cI']).catch(() => ''),
        git(projectPath, ['rev-list', '--count', '--since=7 days ago', 'HEAD']).catch(() => '0'),
        git(projectPath, ['log', '-5', '--format=%s|%cr']).catch(() => ''),
        git(projectPath, ['status', '--porcelain']).catch(() => ''),
        git(projectPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => null),
        reuseActivity
          ? Promise.resolve(null)
          : git(projectPath, ['log', '--since=365 days ago', '--format=%cI']).catch(() => ''),
        git(projectPath, ['remote', 'get-url', 'origin']).catch(() => ''),
        git(projectPath, ['branch', '--sort=-committerdate', '--format=%(refname:short)%00%(committerdate:iso)']).catch(() => ''),
      ]);

    p.branch = branch === 'HEAD' ? '' : branch;
    p.branches = parseBranches(branchesOut);
    p.lastCommitAt = lastCommitAt || null;
    p.commits7d = parseInt(commits7d, 10) || 0;
    p.recentCommits = parseCommitLines(recentLog);
    const dirtyLines = status ? status.split('\n').filter(Boolean) : [];
    p.dirtyCount = dirtyLines.length;
    p.dirtyFiles = dirtyLines.slice(0, 8).map((l) => l.slice(3).trim());
    p.dirtyAt = dirtyLines.length ? await dirtyMtime(projectPath, dirtyLines) : null;
    if (aheadBehind) {
      const m = aheadBehind.match(/(\d+)\s+(\d+)/);
      if (m) {
        p.hasUpstream = true;
        p.ahead = parseInt(m[1], 10);
        p.behind = parseInt(m[2], 10);
      }
    }
    p.activity365 = reuseActivity
      ? shiftActivity365(cached.activity365, cached.activityDate, now)
      : buildActivity365(activityLog, now);
    p.activityDate = localDateStr(now);
    p.originUrl = origin || null;
  } catch {
    // 坏仓库降级为 only-path 条目
  }
  p.aiSessionAt = await aiSessionAt(projectPath);
  // 最后活动时间 = max(最后提交, AI 会话, 脏文件修改时间)
  p.lastActivityAt = [p.lastCommitAt, p.aiSessionAt, p.dirtyAt]
    .filter(Boolean)
    .sort()
    .pop() || null;
  p.band = bandOf(p.lastActivityAt, now);
  p.warnings = localWarnings(p, now);
  return p;
}

// 按需取某分支的详情：最后提交时间 + 最近提交列表（issue #4，切分支时才调，不进全量扫描）
async function branchDetail(projectPath, branch) {
  const name = String(branch || '');
  if (!name || name.length > 120) return null;
  const ref = 'refs/heads/' + name;
  const ok = await git(projectPath, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
  if (!ok) return null;
  const [lastCommitAt, recentLog] = await Promise.all([
    git(projectPath, ['log', '-1', '--format=%cI', ref, '--']).catch(() => ''),
    git(projectPath, ['log', '-5', '--format=%s|%cr', ref, '--']).catch(() => ''),
  ]);
  return { lastCommitAt: lastCommitAt || null, commits: parseCommitLines(recentLog) };
}

async function scan(roots, blacklist, extraPaths, opts) {
  const now = new Date();
  const cache = (opts && opts.cache) || { projects: {} };
  const onLate = opts && opts.onLate;
  const t0 = Date.now();
  const paths = await discover(roots, blacklist, extraPaths);
  const tDiscover = Date.now();
  const timings = [];
  const late = [];
  const projects = await Promise.all(
    paths.map(async (p) => {
      const resolved = path.resolve(p);
      const cached = cache.projects[resolved] || null;
      const s = Date.now();
      // 单项目 3s 预算：超时降级为缓存数据（带 degraded 标记），无缓存则给空壳（issue #24）
      // 真实扫描不取消：完成后经 onLate 回补缓存，避免慢仓库永远拿不到数据
      let lost = false;
      let timeoutId;
      const budget = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          lost = true;
          const fallback = cached
            ? Object.assign(emptyProject(resolved), cached, { degraded: true })
            : Object.assign(emptyProject(resolved), { degraded: true });
          resolve(fallback);
        }, PROJECT_SCAN_BUDGET_MS);
      });
      const real = scanProject(resolved, now, { cached });
      const proj = await Promise.race([real, budget]);
      clearTimeout(timeoutId);
      if (lost && onLate) {
        late.push(real.then((fresh) => { onLate(resolved, fresh); }).catch(() => {}));
      }
      timings.push({ name: proj.name, ms: Date.now() - s, degraded: proj.degraded });
      return proj;
    })
  );
  const total = Date.now() - t0;
  if (total > SLOW_SCAN_MS) {
    const slow = timings.sort((a, b) => b.ms - a.ms).slice(0, 5)
      .map((t) => `${t.name} ${t.ms}ms${t.degraded ? '(降级)' : ''}`).join(', ');
    console.log(`[devboard] 扫描耗时 ${total}ms（目录发现 ${tDiscover - t0}ms，${paths.length} 个项目）；最慢: ${slow}`);
  }
  // settled：全部迟到的真实扫描落地后 resolve（无迟到项则为已解决的空 Promise）
  projects.settled = Promise.all(late);
  return projects;
}

module.exports = { scan, discover, bandOf, localWarnings, emptyProject, branchDetail, projectDetail, scanProject };
