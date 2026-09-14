// IPC 注册：board:get / board:rescan / memo:set / quickopen / settings:* / prefs:* / snooze:set
// 设置页辅助：dialog:pick / util:checkCommand / github:test / scan:preview / win:*
// 分支详情按需懒取：branch:commits（issue #4）；GitHub 鉴权：github:authCaps / deviceStart / devicePoll / importGh（issue #12）
// AI 功能：ai:caps / ai:ask（issue #29）；ai:promptPreview 提示词预览（issue #78）
// 设置页「数据」组：data:openDir / data:export / data:import / data:reset（issue #79）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, shell, dialog, app } = require('electron');
const { spawn, execFile } = require('child_process');
const scanner = require('./scanner');
const github = require('./github');
const ai = require('./ai');
const { DEFAULT_CONFIG, DEFAULT_PREFS } = require('./store');
const { createGitWatcher } = require('./watcher');

// 启动子进程并给出真实结果：立即非零退出视为失败，存活超过 800ms 视为成功
// shell:true 时 Node 把 [cmd].concat(args).join(' ') 交给 cmd.exe 且不逐个加引号，
// 含空格路径会被拆碎、& | " 等元字符有注入面；这里对含空白/元字符的参数自行加引号并转义内嵌引号，
// 裸 token（如 start 后的 cmd）保持原样——start 会把首个带引号参数当作窗口标题
const SHELL_ARG_NEEDS_QUOTE = /[\s"&|<>^%()]/;
function quoteShellArg(a) {
  const s = String(a);
  return !s || SHELL_ARG_NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
function spawnResult(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args.map(quoteShellArg), Object.assign({ detached: true, stdio: 'ignore', shell: true }, opts));
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    setTimeout(() => done(true), 800);
    child.unref();
  });
}

async function quickOpen({ path: projectPath, kind }, config) {
  if (kind === 'folder') {
    const r = await shell.openPath(projectPath);
    return r === '';
  }
  if (kind === 'editor') {
    return spawnResult(config.editorCmd || 'code', [projectPath]);
  }
  if (kind === 'terminal') {
    const custom = (config.terminalCmd || '').trim();
    if (custom) return spawnResult(custom, [], { cwd: projectPath });
    const ok = await spawnResult('wt', ['-d', projectPath]);
    if (ok) return true;
    return spawnResult('cmd', ['/c', 'start', 'cmd'], { cwd: projectPath });
  }
  return false;
}

// 警示消音：签名（label）匹配的警示被过滤；状态变化导致 label 改变时自动复出
function applySnoozes(projects, snoozes) {
  for (const p of projects) {
    const s = snoozes[p.path];
    if (!s) continue;
    p.warnings = p.warnings.filter((w) => s[w.type] !== w.label);
  }
}

// 警示规则（issue #73）：config 已过 getConfig 归一化（天数限 1/3/7、开关补齐 true），这里只整形
function warningRulesOf(config) {
  const wt = config.warningTypes || {};
  return {
    dirtyDays: config.warningDirtyDays || 3,
    types: { dirty: wt.dirty !== false, unpushed: wt.unpushed !== false, pr: wt.pr !== false },
  };
}

// 命令可用性校验：含路径的查文件存在，否则用 where 查 PATH。
// 杀软扫描下本机进程创建可能需 1-3s，超时放宽到 10s 避免启动负载期误报未安装（issue #29 实测）
function checkCommand(cmd) {
  // 首 token 先匹配引号段："C:\Program Files\...\Code.exe" --flag 不应被解析成 C:\Program
  const m = String(cmd || '').trim().match(/^"([^"]+)"|^(\S+)/);
  const first = m ? m[1] || m[2] : '';
  if (!first) return Promise.resolve({ ok: false, reason: '命令为空' });
  if (/[\\/]/.test(first) || /\.(exe|cmd|bat)$/i.test(first)) {
    const exists = fs.existsSync(first);
    return Promise.resolve({ ok: exists, reason: exists ? '' : '文件不存在' });
  }
  return new Promise((resolve) => {
    execFile('where', [first], { timeout: 10000 }, (err, stdout) => {
      if (err) resolve({ ok: false, reason: 'PATH 中找不到该命令' });
      else resolve({ ok: true, reason: String(stdout).split('\n')[0].trim() });
    });
  });
}

// AI 工具品牌图标（issue #21）：内联单色 SVG 标识 + 品牌底色方块
// 来源：claude=simple-icons anthropic / codex=simple-icons openai(v13，新版已下架) / grok=simple-icons x；
// kimi 无官方条目（simple-icons 未收录 Moonshot），沿用 demos/demo-f-overview.html 的近似标（K 字）；
// terminal 为自定义工具的通用兜底图标
const AI_TOOL_ICONS = {
  claude: {
    bg: '#d97757',
    svg: '<path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" fill="#fff"/>',
  },
  codex: {
    bg: '#202020',
    svg: '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#fff"/>',
  },
  kimi: {
    bg: '#101010',
    svg: '<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="sans-serif">K</text>',
  },
  grok: {
    bg: '#000000',
    svg: '<path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" fill="#fff"/>',
  },
  terminal: {
    bg: '#322e27',
    svg: '<path d="M5.5 7l4.5 4-4.5 4M11.5 15H18" stroke="#f5d90a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  },
};

// 默认 AI 工具清单；设置页可增删自定义项（config.aiTools）与之合并（issue #15）
const DEFAULT_AI_TOOLS = [
  { id: 'claude', label: 'Claude Code', cmd: 'claude' },
  { id: 'codex', label: 'Codex', cmd: 'codex' },
  { id: 'kimi', label: 'Kimi Code', cmd: 'kimi' },
  { id: 'grok', label: 'Grok', cmd: 'grok' },
];

// 合并默认与自定义工具并逐项 where 探测；随发品牌图标（issue #21）。aitools:list 与 ai 引擎解析共用。
// 结果缓存 60s：启动负载期（扫描 + 探测并发）进程创建很慢，重复 spawn 会互相拖超时（issue #29 实测）；
// 缓存键含自定义清单，设置变更后立即重探
let aiToolsDetectCache = { at: 0, key: '', list: null };
async function detectAiTools(cfg) {
  const key = JSON.stringify(cfg.aiTools || []);
  if (aiToolsDetectCache.list && aiToolsDetectCache.key === key && Date.now() - aiToolsDetectCache.at < 60000) {
    return aiToolsDetectCache.list;
  }
  const custom = (cfg.aiTools || [])
    .map((t, i) => ({
      id: 'custom-' + i,
      label: String(t.label || t.cmd || ''),
      cmd: String(t.cmd || '').trim(),
      logoKey: typeof t.logo === 'string' ? t.logo : '',
    }))
    .filter((t) => t.cmd);
  const tools = DEFAULT_AI_TOOLS.concat(custom);
  const list = await Promise.all(
    tools.map(async (t) => {
      const icon = AI_TOOL_ICONS[t.logoKey] || AI_TOOL_ICONS[t.id] || AI_TOOL_ICONS.terminal;
      return {
        id: t.id,
        label: t.label,
        cmd: t.cmd,
        installed: (await checkCommand(t.cmd)).ok,
        logo: icon,
      };
    })
  );
  aiToolsDetectCache = { at: Date.now(), key, list };
  return list;
}

// AI 引擎解析（issue #29）：优先 config.aiEngine 指定项，其次最近成功引擎（issue #41），否则取第一个已安装工具
async function resolveEngine(cfg, lastGoodId) {
  const ordered = await resolveEngines(cfg, lastGoodId);
  return ordered[0] || null;
}

// 引擎候选排序：显式指定 > 最近成功 > 清单默认顺序（稳定排序）；供 ai:ask 链式回退（issue #41）
async function resolveEngines(cfg, lastGoodId) {
  const avail = (await detectAiTools(cfg)).filter((t) => t.installed);
  const pref = [cfg.aiEngine, lastGoodId].filter(Boolean);
  const rank = (t) => {
    const i = pref.indexOf(t.id);
    return i < 0 ? pref.length : i;
  };
  return avail.slice().sort((a, b) => rank(a) - rank(b));
}

// 缓存结果的引擎徽标信息：引擎可能已卸载，从完整探测清单（含未安装项）取 label，找不到就裸显 id
async function findToolInfo(cfg, engineId) {
  const t = (await detectAiTools(cfg)).find((x) => x.id === engineId);
  return { id: engineId || 'unknown', label: t ? t.label : String(engineId || 'AI'), cmd: t ? t.cmd : '' };
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 提示词模板内容哈希（issue #78）：AI 周报/建议的缓存键纳入模板哈希，
// 模板被自定义或恢复默认后旧缓存自动失效，不会被旧结果掩盖修改；
// 键基于实际生效的模板（默认模板亦如此：未来内置模板优化时旧缓存自然重建）
function promptTplKey(template) {
  return crypto.createHash('sha1').update(String(template)).digest('hex').slice(0, 10);
}

function registerIpc({ store, getWindow, applySettings, getHotkeyError, getAutoStartError, onAttentionCount }) {
  // IPC handler 统一兜底（issue #97）：handler 抛错（写盘 ENOSPC/EPERM 等）时给渲染层干净的中文消息，
  // 由渲染层 ipcErrText 剥掉 Electron 的「Error invoking remote method」包装后展示
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => rawHandle(channel, async function () {
    try {
      return await fn.apply(null, arguments);
    } catch (err) {
      throw new Error('操作失败：' + ((err && err.message) || err));
    }
  });

  let refreshInFlight = false;
  let scanInFlight = false;
  let scanPromise = null; // 在飞全量扫描：并发触发复用同一 Promise，避免重复双扫
  let scanGeneration = 0; // 扫描代次号：新扫描落地后，旧扫描迟到的最终补丁直接丢弃

  // .git 文件监听：项目有提交/暂存变化时自动增量重扫该项目并推补丁（issue #25）
  // 补丁载荷为单项目增量（issue #94）：拼板在内存里完成只为拿全局聚合与该项目装饰结果，
  // 下发仅 {project, stats, attention}，整板（含每项目 365 格热力数组）不再过 IPC
  const gitWatcher = createGitWatcher({
    scanProject: scanner.scanProject,
    getCached: (p) => store.getScanCache().projects[p] || null,
    onUpdate: (projectPath, fresh) => {
      const cur = store.getScanCache();
      cur.projects[projectPath] = fresh;
      cur.scannedAt = new Date().toISOString();
      store.setScanCache(cur);
      if (scanInFlight) return; // 全量扫描在飞，最终补丁由它统一发
      const config = store.getConfig();
      const { board } = assembleBoard(Object.values(cur.projects), config, false);
      const decorated = board.projects.find((p) => p.path === projectPath);
      if (!decorated) return;
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('board:patch', {
          project: decorated,
          stats: board.stats,
          attention: board.attention,
          scannedAt: board.scannedAt,
        });
      }
    },
  });

  // 拼装 board：memos + 警示按当前规则重算 + GitHub 缓存挂接 + 警示消音 + 统计（缓存路径与新鲜扫描共用）
  function assembleBoard(projects, config, fromCache) {
    const memos = store.getMemos();
    for (const p of projects) p.memo = memos[p.path] || '';

    // 警示按当前规则重算（issue #73）：缓存/降级条目里的 warnings 是旧规则产物，
    // 依赖的事实字段（dirtyCount/lastCommitAt/ahead/github.openPRs）都在，重算零 IO，
    // 设置改动后无需等重扫即反映到需要关注清单与行内警示点；消音签名按新 label 照常匹配
    const rules = warningRulesOf(config);
    const now = new Date();
    for (const p of projects) p.warnings = scanner.localWarnings(p, now, rules);

    const stale = github.attachFromCache(projects, config, store);
    github.applyPrWarnings(projects, rules.types.pr);
    applySnoozes(projects, store.getPrefs().snoozes);

    // originUrl 仅为内部解析用，不下发渲染层
    const out = projects.map((p) => {
      const q = Object.assign({}, p);
      delete q.originUrl;
      return q;
    });

    // 需要关注清单携带警示类型（issue #77 类型图标）并按严重度排序（issue #74）：
    // 未提交超期 > 未推送 > 开放 PR，同级按项目名稳定排序
    const WARN_SEVERITY = { dirty: 0, ahead: 1, pr: 2 };
    const severityOf = (types) => Math.min.apply(null, types.map((t) => (t in WARN_SEVERITY ? WARN_SEVERITY[t] : 9)));
    const attention = out
      .filter((p) => p.warnings.length > 0)
      .map((p) => ({
        path: p.path,
        name: p.name,
        label: p.warnings.map((w) => w.label).join('，'),
        types: p.warnings.map((w) => w.type),
      }))
      .sort((a, b) => severityOf(a.types) - severityOf(b.types) || a.name.localeCompare(b.name));

    // 托盘 tooltip 计数随每次拼板刷新（issue #80）；显隐由 onAttentionCount 实现方按设置裁决
    if (onAttentionCount) onAttentionCount(attention.length);

    return {
      board: {
        scannedAt: new Date().toISOString(),
        fromCache: !!fromCache,
        stats: {
          total: out.length,
          commits7d: out.reduce((s, p) => s + p.commits7d, 0),
          attentionCount: attention.length,
        },
        attention,
        projects: out,
      },
      stale,
    };
  }

  // 全量扫描入口：在飞时复用同一 Promise（首启 buildBoard 与渲染层 board:get 会并发触发）
  function scanAndCache() {
    if (scanPromise) return scanPromise;
    const gen = ++scanGeneration;
    scanPromise = doScanAndCache(gen).finally(() => { scanPromise = null; });
    return scanPromise;
  }

  // 全量扫描（HEAD 分档 + 3s 预算），成功后写磁盘缓存（issue #22/#23/#24）
  // 超预算的慢项目由 onLate 在真实扫描完成后回补缓存，避免永远拿不到数据
  async function doScanAndCache(gen) {
    const config = store.getConfig();
    const cache = store.getScanCache();
    gitWatcher.setScanning(true);
    let projects;
    try {
      projects = await scanner.scan(config.roots, config.blacklist, config.extraPaths, {
        cache,
        warningRules: warningRulesOf(config), // 警示规则参数化（issue #73）
        onLate: (projectPath, fresh) => {
          const cur = store.getScanCache();
          cur.projects[projectPath] = fresh;
          cur.scannedAt = new Date().toISOString();
          store.setScanCache(cur);
        },
      });
    } finally {
      gitWatcher.setScanning(false);
    }
    const next = { scannedAt: new Date().toISOString(), projects: {} };
    for (const p of projects) {
      // 降级条目保留旧缓存（迟到回补会覆盖）；originUrl 一并缓存以便重启后 GitHub 挂接
      next.projects[p.path] = p.degraded && cache.projects[p.path] ? cache.projects[p.path] : p;
    }
    store.setScanCache(next);
    gitWatcher.syncWatchers(projects.map((p) => p.path)); // 对齐监听清单，顺带重建失效 watcher
    return { projects, config, settled: projects.settled || Promise.resolve(), gen };
  }

  // 后台重扫：完成后给渲染层推补丁（issue #22）；在飞则去重
  function rescanInBackground() {
    if (scanInFlight) return;
    scanInFlight = true;
    const sendPatch = (board) => {
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('board:patch', board);
    };
    scanAndCache()
      .then(({ projects, config, settled, gen }) => {
        const { board, stale } = assembleBoard(projects, config, false);
        board.scanGeneration = gen; // 渲染层据此丢弃旧代次/重演补丁（issue #112）
        maybeRefreshGithub(false, stale, projects, config);
        sendPatch(board);
        // 有降级条目时，等迟到的真实扫描全部落地后再推一次最终补丁
        if (projects.some((p) => p.degraded)) {
          settled.then(() => {
            if (gen !== scanGeneration) return; // 已有更新扫描落地，过期补丁丢弃，避免盖回旧数据
            const cur = store.getScanCache();
            const finalProjects = projects.map((p) => (p.degraded && cur.projects[p.path]) || p);
            const { board: finalBoard } = assembleBoard(finalProjects, config, false);
            finalBoard.scanGeneration = gen;
            sendPatch(finalBoard);
          });
        }
      })
      .catch((err) => {
        console.error('[devboard] 后台重扫失败', err);
        // 告知渲染层扫描失败，熄灭「扫描中…」指示（issue #98）：否则 awaitPatch 永远等不到补丁
        const win = getWindow && getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('board:scanfail');
      })
      .finally(() => { scanInFlight = false; });
  }

  function maybeRefreshGithub(forceGithubRefresh, stale, projects, config) {
    if (!(forceGithubRefresh || stale.length > 0) || refreshInFlight) return;
    refreshInFlight = true;
    const me = String(config.githubUsername || '').toLowerCase();
    const remotes = forceGithubRefresh
      ? projects
          .map((p) => github.parseGitHubRemote(p.originUrl))
          .filter((r) => r && r.owner.toLowerCase() === me)
      : stale;
    github.refreshCache(remotes, config, store).then((changed) => {
      // GitHub 数据落地后立即重推整板补丁：此前补丁发出时数据未到，UI 只能等下次启动（issue #44）
      if (!changed) return;
      const cur = store.getScanCache();
      const projs = Object.values(cur.projects);
      if (!projs.length) return;
      const { board } = assembleBoard(projs, store.getConfig(), true);
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('board:patch', board);
    }).catch((err) => console.error('[devboard] GitHub 缓存刷新失败', err))
      .finally(() => { refreshInFlight = false; });
  }

  // 历史安装自愈：token 已配置但 username 为空（旧版导入不落登录名，issue #44）时，
  // 用 token 反查登录名落盘，GitHub 数据挂接随之恢复
  let ghHealTried = false;
  function healGithubUsername(config) {
    if (ghHealTried || !config.githubToken || config.githubUsername) return;
    ghHealTried = true;
    github.testConnection(config.githubToken).then((r) => {
      if (r && r.ok && r.login) store.setConfig({ githubUsername: r.login });
    }).catch(() => {});
  }

  // board:get：有磁盘缓存则陈旧数据先出 + 后台重扫补丁更新（issue #22）；无缓存走全量
  let cachedBoardInFlight = null; // 缓存路径拼板在飞（issue #105）：唤出 tick 与 maybeNotify 并发触发时共享同一结果，不再重复拼板
  async function buildBoard(forceGithubRefresh) {
    healGithubUsername(store.getConfig()); // 见函数注释：token 在而 username 空的历史安装自愈（issue #44）
    if (!forceGithubRefresh) {
      const cache = store.getScanCache();
      const cachedProjects = Object.values(cache.projects);
      if (cachedProjects.length > 0) {
        if (cachedBoardInFlight) return cachedBoardInFlight;
        cachedBoardInFlight = Promise.resolve().then(() => {
          const config = store.getConfig();
          const { board, stale } = assembleBoard(cachedProjects, config, true);
          // GitHub 拉取与重扫并行：不再等全量扫描结束才开始取数（详情页「同步中」停留过久，issue #46）
          maybeRefreshGithub(false, stale, cachedProjects, config);
          rescanInBackground();
          board.scanGeneration = scanGeneration; // 渲染层据此丢弃旧代次补丁（issue #112）
          return board;
        }).finally(() => { cachedBoardInFlight = null; });
        return cachedBoardInFlight;
      }
    }
    const { projects, config, gen } = await scanAndCache();
    const { board, stale } = assembleBoard(projects, config, false);
    board.scanGeneration = gen;
    maybeRefreshGithub(forceGithubRefresh, stale, projects, config);
    return board;
  }

  ipcMain.handle('board:get', () => buildBoard(false));
  ipcMain.handle('board:rescan', () => buildBoard(true));

  // 分支详情懒取：切分支时才跑 git log，不进全量扫描（issue #4）
  ipcMain.handle('branch:commits', (_e, projectPath, branch) => {
    const p = String(projectPath || '');
    if (!p || !fs.existsSync(path.join(p, '.git'))) return null;
    return scanner.branchDetail(p, branch);
  });

  ipcMain.handle('memo:set', (_e, projectPath, text) => {
    store.setMemo(projectPath, String(text || ''));
    return true;
  });

  ipcMain.handle('quickopen', (_e, payload) => {
    return quickOpen(payload || {}, store.getConfig());
  });

  // AI 工具清单：默认四项 + config.aiTools 自定义项，逐项 where 探测安装情况（issue #15）
  ipcMain.handle('aitools:list', () => detectAiTools(store.getConfig()));

  // 在所选项目目录开终端执行 AI 工具命令：优先 wt -d，回退 cmd /c start（issue #15）
  ipcMain.handle('aitools:open', async (_e, cmd, projectPath) => {
    const c = String(cmd || '').trim();
    const p = String(projectPath || '');
    if (!c || !p || !fs.existsSync(p)) return false;
    const ok = await spawnResult('wt', ['-d', p, 'cmd', '/k', c]);
    if (ok) return true;
    return spawnResult('cmd', ['/c', 'start', 'cmd', '/k', c], { cwd: p });
  });

  // AI 能力探测（issue #29）：渲染层据此显隐 AI 入口；engine 为空 = 无可用工具
  ipcMain.handle('ai:caps', async () => {
    const cfg = store.getConfig();
    const enabled = cfg.aiEnabled !== false;
    const engine = enabled ? await resolveEngine(cfg, store.getAiCache().lastGoodEngine) : null;
    return {
      enabled,
      engine: engine ? { id: engine.id, label: engine.label, cmd: engine.cmd } : null,
    };
  });

  // 在飞 AI 任务：同 kind+目标 的请求共享同一 Promise，切页后重复触发不会再起 CLI 进程（issue #40）
  const aiInFlight = new Map();
  // 会话级引擎黑名单：本进程内已失败过的引擎不再重复尝试（配额/挂起类故障在会话内不会自愈，issue #41）
  const sessionBadEngines = new Set();

  // AI 统一调用入口（issue #29）：prompt 组装 / 90s 超时 / 失败降级 / 结果缓存
  // kind: weekly（按当天缓存）| advice（按 项目+HEAD 缓存）| filter（不缓存）
  // 引擎链式回退：首选失败后自动尝试其余已安装引擎，成功则记为最近可用（issue #41）
  async function doAiAsk(payload) {
    const cfg = store.getConfig();
    if (cfg.aiEnabled === false) return { ok: false, reason: 'AI 功能已在设置中关闭' };
    const cache = store.getAiCache();
    let engines = await resolveEngines(cfg, cache.lastGoodEngine);
    if (!engines.length) return { ok: false, reason: '未检测到可用的 AI 命令行工具' };
    const healthy = engines.filter((t) => !sessionBadEngines.has(t.id));
    if (healthy.length) engines = healthy; // 全灭时也照旧全试一遍（可能已恢复）
    const kind = payload && payload.kind;
    const now = new Date();

    let prompt = '';
    let cacheWrite = null;
    if (kind === 'weekly') {
      const today = localDateStr(now);
      const tplKey = promptTplKey(cfg.aiPromptWeekly || ai.DEFAULT_WEEKLY_TEMPLATE); // 模板哈希入缓存键（issue #78）
      const hit = cache.weekly;
      if (hit && hit.date === today && hit.text && hit.tpl === tplKey) {
        const eng = await findToolInfo(cfg, hit.engine);
        return { ok: true, kind, text: hit.text, engine: eng, cached: true, at: hit.at || null };
      }
      if (payload.cachedOnly) return { ok: false, kind, reason: 'no-cache' };
      const projects = Object.values(store.getScanCache().projects);
      if (!projects.some((p) => p.commits7d > 0)) {
        return { ok: false, reason: '近 7 天没有提交活动，暂无可摘要的内容' };
      }
      prompt = ai.buildWeeklyPrompt(projects, now, cfg.aiPromptWeekly);
      cacheWrite = (text, engineId) => {
        const cur = store.getAiCache();
        cur.weekly = { date: today, engine: engineId, text, at: now.toISOString(), tpl: tplKey };
        cur.lastGoodEngine = engineId;
        store.setAiCache(cur);
      };
    } else if (kind === 'advice') {
      const p = store.getScanCache().projects[String((payload && payload.path) || '')];
      if (!p) return { ok: false, reason: '项目不在扫描缓存中' };
      const head = p.headSha || 'nohead';
      const tplKey = promptTplKey(cfg.aiPromptAdvice || ai.DEFAULT_ADVICE_TEMPLATE); // 模板哈希入缓存键（issue #78）
      const hit = cache.advice[p.path];
      if (hit && hit.head === head && hit.text && hit.tpl === tplKey) {
        const eng = await findToolInfo(cfg, hit.engine);
        return { ok: true, kind, text: hit.text, engine: eng, cached: true, at: hit.at || null };
      }
      if (payload.cachedOnly) return { ok: false, kind, reason: 'no-cache' };
      prompt = ai.buildAdvicePrompt(p, now, cfg.aiPromptAdvice);
      cacheWrite = (text, engineId) => {
        const cur = store.getAiCache();
        cur.advice[p.path] = { head, engine: engineId, text, at: now.toISOString(), tpl: tplKey };
        cur.lastGoodEngine = engineId;
        store.setAiCache(cur);
      };
    } else if (kind === 'filter') {
      const query = String((payload && payload.query) || '').trim().slice(0, 100);
      if (!query) return { ok: false, reason: '查询为空' };
      prompt = ai.buildFilterPrompt(query);
    } else {
      return { ok: false, reason: '未知的 AI 请求类型' };
    }

    const fails = [];
    for (const engine of engines) {
      const engineInfo = { id: engine.id, label: engine.label, cmd: engine.cmd };
      const r = await ai.runCli(engine.cmd, prompt, { toolId: engine.id });
      if (!r.ok) {
        sessionBadEngines.add(engine.id);
        fails.push(engine.label + '：' + r.reason);
        continue;
      }
      if (kind === 'filter') {
        const filter = ai.parseFilter(r.text);
        if (!filter) {
          fails.push(engine.label + '：输出无法解析');
          continue;
        }
        return { ok: true, kind, filter, engine: engineInfo };
      }
      if (cacheWrite) cacheWrite(r.text, engine.id);
      return { ok: true, kind, text: r.text, engine: engineInfo, cached: false, at: now.toISOString() };
    }
    return { ok: false, kind, reason: fails.join('；') || '所有可用 AI 引擎均调用失败' };
  }

  ipcMain.handle('ai:ask', (_e, payload) => {
    const kind = String((payload && payload.kind) || '');
    const key = kind + '|' + String((payload && (payload.path || payload.query)) || '');
    if (payload && payload.cachedOnly) {
      // 只读缓存不进在飞表；若同任务在飞则回 pending，渲染层据此转为正式请求并入该任务（issue #40）
      return doAiAsk(payload).then((r) => {
        if (!r.ok && r.reason === 'no-cache' && aiInFlight.has(key)) return { ok: false, kind, reason: 'pending' };
        return r;
      });
    }
    if (aiInFlight.has(key)) return aiInFlight.get(key);
    const job = doAiAsk(payload).finally(() => aiInFlight.delete(key));
    aiInFlight.set(key, job);
    return job;
  });

  // 提示词模板预览（issue #78）：用真实数据组装完整 prompt 展示给设置页，眼见为实地编辑；
  // 只组装不调用引擎。渲染层可传当前草稿模板（template 字段），未传则用已落盘配置；
  // 自然语言筛选 prompt 不开放（parseFilter 严格 JSON 契约）
  ipcMain.handle('ai:promptPreview', (_e, payload) => {
    const kind = String((payload && payload.kind) || '');
    const cfg = store.getConfig();
    const now = new Date();
    const projects = Object.values(store.getScanCache().projects);
    // 草稿优先：payload 显式带 template 字段时（含 null = 恢复默认）用草稿，否则用已存配置
    const hasDraft = payload && Object.prototype.hasOwnProperty.call(payload, 'template');
    const draft = hasDraft
      ? ((typeof payload.template === 'string' && payload.template.trim()) ? payload.template.slice(0, 10000) : null)
      : undefined;
    if (kind === 'weekly') {
      if (!projects.some((p) => p.commits7d > 0)) {
        return { ok: false, reason: '近 7 天没有提交活动，暂无事实可组装（先完成一次扫描）' };
      }
      return { ok: true, prompt: ai.buildWeeklyPrompt(projects, now, draft === undefined ? cfg.aiPromptWeekly : draft) };
    }
    if (kind === 'advice') {
      if (!projects.length) return { ok: false, reason: '扫描缓存为空，请先完成一次扫描' };
      // 无指定项目时取近 7 天最活跃的项目作示例
      const sample = projects.slice().sort((a, b) => (b.commits7d || 0) - (a.commits7d || 0))[0];
      return { ok: true, sample: sample.name, prompt: ai.buildAdvicePrompt(sample, now, draft === undefined ? cfg.aiPromptAdvice : draft) };
    }
    return { ok: false, reason: '未知的预览类型' };
  });

  // 详情面板深区数据：README 首段摘要 + AI 会话痕迹明细（issue #17）
  ipcMain.handle('project:detail', (_e, projectPath) => {
    const p = String(projectPath || '');
    if (!p || !fs.existsSync(p)) return { readme: '', aiSessions: [] };
    return scanner.projectDetail(p);
  });

  // token 不下发渲染层：只给「是否已配置」，磁盘与 IPC 全程无明文（issue #12）；
  // tokenEncrypted 标记系统加密能力，false 时 token 以明文落盘，设置页给出提示（issue #65）；
  // aiPromptDefaults 附带内置提示词默认模板，供设置页预填/「恢复默认」（issue #78，非配置字段不落盘）
  function settingsView(cfg) {
    return Object.assign({}, cfg, {
      githubToken: '',
      hasGithubToken: !!cfg.githubToken,
      tokenEncrypted: store.cryptoAvailable(),
      aiPromptDefaults: { weekly: ai.DEFAULT_WEEKLY_TEMPLATE, advice: ai.DEFAULT_ADVICE_TEMPLATE },
    });
  }

  ipcMain.handle('settings:get', () => settingsView(store.getConfig()));

  // settings:set 白名单：仅 DEFAULT_CONFIG 已知字段可落盘，renderer 传入的未知 key 直接忽略；
  // 数组字段拒绝非数组值（roots 另拒空数组，与 getConfig 有效性口径一致）——非法值保持原值，
  // 避免经 setConfig 回写时被 getConfig 重置为默认 roots 而误清用户配置
  const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
  const CONFIG_ARRAY_KEYS = new Set(['roots', 'extraPaths', 'blacklist', 'aiTools']);
  // 提示词模板字段（issue #78）：null/空白 = 恢复内置默认；字符串限长截断
  const CONFIG_PROMPT_KEYS = new Set(['aiPromptWeekly', 'aiPromptAdvice']);
  ipcMain.handle('settings:set', (_e, patch) => {
    const raw = Object.assign({}, patch || {});
    const p = {};
    for (const k of Object.keys(raw)) {
      if (!CONFIG_KEYS.has(k)) continue;
      if (CONFIG_ARRAY_KEYS.has(k)) {
        if (!Array.isArray(raw[k])) continue;
        if (k === 'roots' && raw[k].length === 0) continue;
      }
      if (CONFIG_PROMPT_KEYS.has(k)) {
        const v = raw[k];
        p[k] = (typeof v === 'string' && v.trim()) ? v.slice(0, 10000) : null;
        continue;
      }
      p[k] = raw[k];
    }
    if (!p.githubToken) delete p.githubToken; // 空值 = 不改动已存 token（清空走 github:importGh 失败态外的显式入口）
    const cfg = store.setConfig(p);
    applySettings(cfg); // 热键重注册 + 开机自启即时生效
    return settingsView(cfg);
  });

  // 保存设置后由渲染层查询热键注册结果（空串 = 成功）
  ipcMain.handle('settings:hotkeyError', () => (getHotkeyError ? getHotkeyError() : ''));

  // 开机自启注册失败原因（issue #108）：仿热键错误链，设置页保存后与打开时查询展示
  ipcMain.handle('settings:autoStartError', () => (getAutoStartError ? getAutoStartError() : ''));

  ipcMain.handle('prefs:get', () => store.getPrefs());
  ipcMain.handle('prefs:set', (_e, patch) => store.setPrefs(patch || {}));

  ipcMain.handle('snooze:set', (_e, projectPath, type, label) => {
    const prefs = store.getPrefs();
    const mine = Object.assign({}, prefs.snoozes[projectPath], { [type]: String(label || '') });
    store.setPrefs({ snoozes: Object.assign({}, prefs.snoozes, { [projectPath]: mine }) });
    return true;
  });

  // 设置页辅助：目录/文件选择
  ipcMain.handle('dialog:pick', async (_e, kind) => {
    const opts = kind === 'file'
      ? { properties: ['openFile'] }
      : { properties: ['openDirectory', 'createDirectory'] };
    const r = await dialog.showOpenDialog(getWindow(), opts);
    return r.canceled ? null : r.filePaths[0];
  });

  // 设置页辅助：命令可用性校验
  ipcMain.handle('util:checkCommand', (_e, cmd) => checkCommand(cmd));

  // 设置页辅助：GitHub Token 测试连接，并校验登录名与填写用户名一致
  ipcMain.handle('github:test', async (_e, token, username) => {
    const cfg = store.getConfig();
    const t = String(token || '').trim() || cfg.githubToken;
    const u = String(username || '').trim() || cfg.githubUsername;
    if (!t) return { ok: false, reason: 'Token 为空' };
    const r = await github.testConnection(t);
    if (!r.ok) return r;
    if (u && r.login.toLowerCase() !== u.toLowerCase()) {
      return { ok: false, reason: `Token 有效，但登录名是 ${r.login}，与填写的不一致` };
    }
    return r;
  });

  // 鉴权入口能力探测：设备码授权需已配置 Client ID；gh 导入需本机 gh CLI 可用（issue #12）
  ipcMain.handle('github:authCaps', async () => ({
    deviceFlow: !!github.DEVICE_FLOW_CLIENT_ID,
    ghCli: await github.ghCliAvailable(),
  }));

  ipcMain.handle('github:deviceStart', () => github.deviceStart());

  // 设备码轮询；成功即加密落盘 token + 登录名（username 缺失会导致 GitHub 数据永不挂接，issue #44）
  ipcMain.handle('github:devicePoll', async (_e, deviceCode) => {
    const r = await github.devicePoll(String(deviceCode || ''));
    if (r.status !== 'success') return r;
    const t = await github.testConnection(r.token);
    if (!t.ok) return { status: 'error', reason: t.reason };
    store.setConfig({ githubToken: r.token, githubUsername: t.login });
    return { status: 'success', login: t.login };
  });

  // 从 gh CLI 导入 token：验证有效后加密落盘 token + 登录名（issue #44）
  ipcMain.handle('github:importGh', async () => {
    const token = await github.importGhToken();
    if (!token) return { ok: false, reason: '未检测到 gh CLI 登录（gh auth login 后重试）' };
    const t = await github.testConnection(token);
    if (!t.ok) return { ok: false, reason: t.reason };
    store.setConfig({ githubToken: token, githubUsername: t.login });
    return { ok: true, login: t.login };
  });

  // 账户状态卡（issue #45）：已配置 token 时在线验证并返回头像/显示名/连通性
  ipcMain.handle('github:status', async () => {
    const cfg = store.getConfig();
    if (!cfg.githubToken) return { configured: false };
    const r = await github.testConnection(cfg.githubToken);
    if (!r.ok) return { configured: true, ok: false, login: cfg.githubUsername || '', reason: r.reason };
    return { configured: true, ok: true, login: r.login, name: r.name, avatarUrl: r.avatarUrl };
  });

  // 断开连接：清除 token 与登录名（GitHub 数据挂接随之停止）
  ipcMain.handle('github:disconnect', () => {
    store.setConfig({ githubToken: '', githubUsername: '' });
    return true;
  });

  // 设置页辅助：扫描预览（用未保存的草稿值跑 discover，不落盘；附带无效路径清单）
  ipcMain.handle('scan:preview', async (_e, draft) => {
    const cfg = store.getConfig();
    const d = draft || {};
    const roots = Array.isArray(d.roots) ? d.roots : cfg.roots;
    const blacklist = Array.isArray(d.blacklist) ? d.blacklist : cfg.blacklist;
    const extraPaths = Array.isArray(d.extraPaths) ? d.extraPaths : cfg.extraPaths;
    const paths = await scanner.discover(roots, blacklist, extraPaths);
    return {
      count: paths.length,
      names: paths.map((p) => path.basename(p)).slice(0, 60),
      invalidRoots: roots.filter((r) => r && !fs.existsSync(r)),
      invalidExtra: extraPaths.filter((p) => p && (!fs.existsSync(p) || !fs.existsSync(path.join(p, '.git')))),
    };
  });

  // GitHub 链接等外部打开，仅允许 http(s)
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  /* ----- 设置页「数据」组（issue #79）：打开数据目录 + 导出/导入 + 重置 ----- */
  ipcMain.handle('data:openDir', () => shell.openPath(app.getPath('userData')));

  // 导出：memos + prefs + config 打包单 JSON；config 剔除 githubToken/githubTokenEnc（token 不随导出迁移）；
  // 各类缓存（scan/AI/GitHub/meta）可再生，不进包
  ipcMain.handle('data:export', async () => {
    const r = await dialog.showSaveDialog(getWindow(), {
      title: '导出数据',
      defaultPath: 'signalboard-backup-' + localDateStr(new Date()) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    const cfgOut = Object.assign({}, store.getConfig());
    delete cfgOut.githubToken;
    delete cfgOut.githubTokenEnc;
    const payload = {
      app: 'SignalBoard',
      version: 1,
      exportedAt: new Date().toISOString(),
      memos: store.getMemos(),
      prefs: store.getPrefs(),
      config: cfgOut,
    };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, reason: '写入失败：' + err.message };
    }
  });

  // 导入：结构校验后写回 memos/prefs/config；导入的 config 不接收 token 字段（token 不迁移），
  // 经 setConfig 与现有配置合并——本机已配置的 token 导入后保留；写回后由渲染层触发全量刷新
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '导入数据',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, reason: '文件不是有效的 JSON' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '文件结构不符（应为 SignalBoard 导出的备份文件）' };
    }
    const memos = data.memos;
    const prefs = data.prefs;
    const config = data.config;
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(memos) && !isObj(prefs) && !isObj(config)) {
      return { ok: false, reason: '文件中找不到可导入的数据（需要 memos/prefs/config 字段）' };
    }
    if (isObj(memos)) {
      // 备忘：path -> 纯文本，过滤非字符串脏值
      const clean = {};
      for (const k of Object.keys(memos)) {
        if (typeof memos[k] === 'string') clean[k] = memos[k];
      }
      store.writeJson('memos.json', clean);
    }
    if (isObj(prefs)) store.writeJson('prefs.json', prefs); // 读取时 getPrefs 归一化兜底
    if (isObj(config)) {
      const patch = Object.assign({}, config);
      delete patch.githubToken; // 防御：即使导出文件被手工塞入 token 也不接收
      delete patch.githubTokenEnc;
      applySettings(store.setConfig(patch)); // 热键/自启/刷新间隔等即时生效
    }
    return { ok: true };
  });

  // 重置（issue #79）：prefs = 位序/图钉/消音/分支选择等偏好回默认；all = 清空全部本地数据并重启，
  // 重启后 onboarded 标记缺失回到首启引导态
  ipcMain.handle('data:reset', (_e, scope) => {
    if (scope === 'prefs') {
      store.writeJson('prefs.json', Object.assign({}, DEFAULT_PREFS));
      return { ok: true };
    }
    if (scope === 'all') {
      const files = ['memos.json', 'prefs.json', 'config.json', 'ai-cache.json', 'scan-cache.json', 'github-cache.json', 'meta.json'];
      for (const f of files) {
        try { fs.unlinkSync(path.join(store.baseDir, f)); } catch { /* 不存在则跳过 */ }
      }
      app.relaunch();
      app.quit(); // before-quit 置 quitting 标记，窗口正常关闭后重启
      return { ok: true };
    }
    return { ok: false, reason: '未知的重置范围' };
  });

  ipcMain.handle('win:min', () => { const w = getWindow(); if (w) w.minimize(); });
  ipcMain.handle('win:max', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.handle('win:close', () => { const w = getWindow(); if (w) w.close(); });

  return { buildBoard, gitWatcher };
}

module.exports = { registerIpc, AI_TOOL_ICONS };
