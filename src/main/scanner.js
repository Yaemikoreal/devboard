// 项目发现 + git 近况信号采集。纯 Node，不依赖 Electron，可被 scripts/test-scan.js 直接引用。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 4;
const AI_SESSION_DIRS = ['.kimi-code', '.claude', '.codex'];

function git(projectPath, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', projectPath].concat(args), { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// 递归找含 .git 的目录，深度上限 MAX_DEPTH；跳过黑名单与 . 开头目录（.git 本身只探测不进入）
// extraPaths 为逐项指定的补充路径，要求自身含 .git
function discover(roots, blacklist, extraPaths) {
  const skip = new Set(blacklist.map((s) => s.toLowerCase()));
  const found = new Map();

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((e) => e.name === '.git');
    if (hasGit) {
      found.set(path.resolve(dir).toLowerCase(), path.resolve(dir));
      return; // 已是项目，不再深入（忽略嵌套仓库）
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (skip.has(e.name.toLowerCase())) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    if (root && fs.existsSync(root)) walk(path.resolve(root), 0);
  }
  // 补充路径：逐项指定、含 .git 才收，不再深入
  for (const extra of extraPaths || []) {
    if (!extra || !fs.existsSync(extra)) continue;
    if (!fs.existsSync(path.join(extra, '.git'))) continue;
    found.set(path.resolve(extra).toLowerCase(), path.resolve(extra));
  }
  return [...found.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function emptyProject(projectPath) {
  return {
    path: projectPath,
    name: path.basename(projectPath),
    branch: '',
    lastCommitAt: null,
    commits7d: 0,
    recentCommits: [],
    dirtyCount: 0,
    dirtyFiles: [],
    dirtyAt: null,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    activity30: new Array(30).fill(0),
    aiSessionAt: null,
    lastActivityAt: null,
    memo: '',
    band: 'stale',
    warnings: [],
    github: null,
    originUrl: null,
  };
}

// AI 会话痕迹：.kimi-code / .claude / .codex 目录内最新文件 mtime（有界遍历）
function aiSessionAt(projectPath) {
  let latest = 0;
  const walk = (dir, depth, budget) => {
    if (latest === Infinity || budget.n <= 0 || depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.n <= 0) return;
      budget.n--;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1, budget);
        else {
          const st = fs.statSync(full);
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        }
      } catch { /* 忽略不可读项 */ }
    }
  };
  for (const d of AI_SESSION_DIRS) {
    const dir = path.join(projectPath, d);
    if (fs.existsSync(dir)) walk(dir, 0, { n: 300 });
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// log --since="30 days ago" 按天聚合，今天在最后
function buildActivity30(logOutput, now) {
  const counts = new Array(30).fill(0);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const line of logOutput.split('\n')) {
    const t = Date.parse(line.trim());
    if (!Number.isFinite(t)) continue;
    const idx = 29 - Math.floor((todayStart + DAY_MS - 1 - t) / DAY_MS);
    if (idx >= 0 && idx < 30) counts[idx]++;
  }
  return counts;
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
function dirtyMtime(projectPath, dirtyLines) {
  let latest = 0;
  for (const line of dirtyLines.slice(0, 20)) {
    let rel = line.slice(3).trim();
    const arrow = rel.indexOf(' -> ');
    if (arrow >= 0) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    try {
      const st = fs.statSync(path.join(projectPath, rel));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch { /* 已删除或不可读 */ }
  }
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

async function scanProject(projectPath, now) {
  const p = emptyProject(projectPath);
  try {
    // 任一可用即视为活仓库；lastCommitAt 为空（空仓）时整体降级
    const [branch, lastCommitAt, commits7d, recentLog, status, aheadBehind, activityLog, origin] =
      await Promise.all([
        git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        git(projectPath, ['log', '-1', '--format=%cI']).catch(() => ''),
        git(projectPath, ['rev-list', '--count', '--since=7 days ago', 'HEAD']).catch(() => '0'),
        git(projectPath, ['log', '-5', '--format=%s|%cr']).catch(() => ''),
        git(projectPath, ['status', '--porcelain']).catch(() => ''),
        git(projectPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => null),
        git(projectPath, ['log', '--since=30 days ago', '--format=%cI']).catch(() => ''),
        git(projectPath, ['remote', 'get-url', 'origin']).catch(() => ''),
      ]);

    p.branch = branch === 'HEAD' ? '' : branch;
    p.lastCommitAt = lastCommitAt || null;
    p.commits7d = parseInt(commits7d, 10) || 0;
    p.recentCommits = recentLog
      ? recentLog.split('\n').filter(Boolean).map((line) => {
          const i = line.lastIndexOf('|');
          return i >= 0
            ? { msg: line.slice(0, i), rel: line.slice(i + 1) }
            : { msg: line, rel: '' };
        })
      : [];
    const dirtyLines = status ? status.split('\n').filter(Boolean) : [];
    p.dirtyCount = dirtyLines.length;
    p.dirtyFiles = dirtyLines.slice(0, 8).map((l) => l.slice(3).trim());
    p.dirtyAt = dirtyLines.length ? dirtyMtime(projectPath, dirtyLines) : null;
    if (aheadBehind) {
      const m = aheadBehind.match(/(\d+)\s+(\d+)/);
      if (m) {
        p.hasUpstream = true;
        p.ahead = parseInt(m[1], 10);
        p.behind = parseInt(m[2], 10);
      }
    }
    p.activity30 = buildActivity30(activityLog, now);
    p.originUrl = origin || null;
  } catch {
    // 坏仓库降级为 only-path 条目
  }
  p.aiSessionAt = aiSessionAt(projectPath);
  // 最后活动时间 = max(最后提交, AI 会话, 脏文件修改时间)
  p.lastActivityAt = [p.lastCommitAt, p.aiSessionAt, p.dirtyAt]
    .filter(Boolean)
    .sort()
    .pop() || null;
  p.band = bandOf(p.lastActivityAt, now);
  p.warnings = localWarnings(p, now);
  return p;
}

async function scan(roots, blacklist, extraPaths) {
  const now = new Date();
  const paths = discover(roots, blacklist, extraPaths);
  return Promise.all(paths.map((p) => scanProject(p, now)));
}

module.exports = { scan, discover, bandOf, localWarnings, emptyProject };
