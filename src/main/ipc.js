// IPC 注册：board:get / board:rescan / memo:set / quickopen / settings:* / prefs:* / snooze:set
// 设置页辅助：dialog:pick / util:checkCommand / scan:preview / win:*
// 分支详情按需懒取：branch:commits（issue #4）。GitHub 鉴权域已拆 ipc-github.js、AI 域已拆 ipc-ai.js（issue #124）
// 设置页「数据」组：data:openDir / data:export / data:import / data:reset（issue #79）
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ipcMain, shell, dialog, app, net } = require('electron');
const { spawn, execFile } = require('child_process');
const scanner = require('./scanner');
const github = require('./github');
const ai = require('./ai');
const registerGithub = require('./ipc-github'); // GitHub 鉴权/账号域 handler（issue #124 第一刀）
const registerAi = require('./ipc-ai'); // AI 调度域 handler（issue #124 第二刀）
const { DEFAULT_CONFIG, DEFAULT_PREFS } = require('./store');
const { localDateStr, WARN_SEVERITY } = require('../shared/constants'); // 共享常量（issue-11 / #127）；localDateStr 第三刀随 data 域移出后可只留 WARN_SEVERITY
const { createGitWatcher } = require('./watcher');

// shell:true 时 Node 把 [cmd].concat(args).join(' ') 交给 cmd.exe 且不逐个加引号，
// 含空格路径会被拆碎、& | " 等元字符有注入面；这里对含空白/元字符的参数自行加引号并转义内嵌引号，
// 裸 token（如 start 后的 cmd）保持原样——start 会把首个带引号参数当作窗口标题
const SHELL_ARG_NEEDS_QUOTE = /[\s"&|<>^%()]/;
function quoteShellArg(a) {
  const s = String(a);
  return !s || SHELL_ARG_NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
// 启动子进程并给出真实结果：立即非零退出视为失败，存活超过 SPAWN_ALIVE_MS 视为成功。
// 存活窗口按本机实测放宽到 3s（issue #168 第 4 条）：杀软扫描下进程创建就要 1-3s（见下方 checkCommand 注释），
// 40 并发坏命令实测 33/40 要超过 800ms 才退出——800ms 窗口会把「命令不存在」判成「已打开」的误导性成功。
// 代价是真正失败时提示晚 3s，优于报成功却什么都没发生。
const SPAWN_ALIVE_MS = 3000;
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
    let aliveTimer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (aliveTimer) clearTimeout(aliveTimer); // 定案即撤定时器，不留游离 timer
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    aliveTimer = setTimeout(() => done(true), SPAWN_ALIVE_MS);
    if (aliveTimer.unref) aliveTimer.unref();
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
    types: { dirty: wt.dirty !== false, unpushed: wt.unpushed !== false, ci: wt.ci !== false, review: wt.review !== false, pr: wt.pr !== false },
  };
}

// 扫描域（issue #12 第 8 条）：roots/blacklist/extraPaths 三键永远同行，收敛一处构造 scope 对象；
// draft 中合法（数组）的键优先，其余回退已存配置（scan:preview 的草稿语义）
function scanScopeOf(cfg, draft) {
  const d = draft || {};
  return {
    roots: Array.isArray(d.roots) ? d.roots : cfg.roots,
    blacklist: Array.isArray(d.blacklist) ? d.blacklist : cfg.blacklist,
    extraPaths: Array.isArray(d.extraPaths) ? d.extraPaths : cfg.extraPaths,
  };
}

// 命令可用性校验：含路径的查文件存在，否则用 where 查 PATH。
// 杀软扫描下本机进程创建可能需 1-3s，超时放宽到 10s 避免启动负载期误报未安装（issue #29 实测）
async function checkCommand(cmd) {
  // 首 token 先匹配引号段："C:\Program Files\...\Code.exe" --flag 不应被解析成 C:\Program
  const m = String(cmd || '').trim().match(/^"([^"]+)"|^(\S+)/);
  const first = m ? m[1] || m[2] : '';
  if (!first) return { ok: false, reason: '命令为空' };
  if (/[\\/]/.test(first) || /\.(exe|cmd|bat)$/i.test(first)) {
    // 用户可在此填任意路径（含 UNC）：异步探测，别让掉线网络盘把主线程钉住（issue #168 第 5 条）
    const exists = await pathExists(first);
    return { ok: exists, reason: exists ? '' : '文件不存在' };
  }
  return new Promise((resolve) => {
    execFile('where', [first], { timeout: 10000 }, (err, stdout) => {
      if (err) resolve({ ok: false, reason: 'PATH 中找不到该命令' });
      else resolve({ ok: true, reason: String(stdout).split('\n')[0].trim() });
    });
  });
}

// AI 帮手（工具探测/引擎排序/模板哈希/事实签名）已随 AI 域拆至 ipc-ai.js（issue #124 第二刀）

// 异步存在性检查（issue #168 第 5 条）：设置页预览原先用 fs.existsSync 同步探路径，
// 指向掉线网络盘/休眠 NAS 时会阻塞主线程到 SMB 超时（可达数十秒），期间窗口不重绘、托盘与全局热键全哑；
// scanner 对同一件事用的是 async 版本，这里对齐，把等待交回事件循环
async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function registerIpc({ store, getWindow, applySettings, getHotkeyError, getAutoStartError, onAttentionCount }) {
  // GitHub 网络出口换 Chromium 网络栈（issue #153）：net.fetch 读系统证书库，
  // Watt Toolkit（Steam++）等加速工具本地自签接管 TLS 时不再被 Node 内置 CA 拒之门外。
  // registerIpc 在 app ready 后调用，net.fetch 此时可用
  github.setFetchImpl(net.fetch);
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

  // 各域 handler 挂载点（issue #124）：先装上面的包错 patch 再 register，域内 handler 自动获得包错。
  // GitHub 鉴权/账号域已拆至 ipc-github.js：八个 github:* handler + 通知快照清理 + 登录名自愈；
  // refreshGithubNow 以 onAuthChanged 回调注入，保住「连接/导入后立即拉一轮、断开立即重推拼板」
  // （issue #118）语义；healGithubUsername 由 buildBoard（板域）调用，经返回值取回
  const { healGithubUsername } = registerGithub({ store, onAuthChanged: refreshGithubNow });
  // AI 调度域已拆至 ipc-ai.js（issue #124 第二刀）：五个 ai/aitools handler + 工具探测/引擎排序等
  // 帮手 + 在飞表与引擎黑名单；checkCommand/pathExists/spawnResult 跨域系统助手经 deps 注入，
  // 会话级黑名单清空口经返回值暴露（settings:set 调用，issue #138）
  const { clearSessionBadEngines } = registerAi({ store, checkCommand, pathExists, spawnResult });

  let refreshInFlight = false;
  let refreshQueued = false; // 在飞期间的强制刷新请求：本轮收尾后补跑一次（issue #168 第 10 条）
  let scanInFlight = false;
  let scanPromise = null; // 在飞全量扫描：并发触发复用同一 Promise，避免重复双扫
  let scanGeneration = 0; // 扫描代次号：新扫描落地后，旧扫描迟到的最终补丁直接丢弃
  // 全量扫描期间发生变化的项目（issue #168 第 7 条）：这次扫描的 git 快照读取早于该变化，
  // 收尾整体覆盖缓存时会把真实变化盖回旧数据。记下来，落盘后逐项重扫回补。
  const changedDuringScan = new Set();

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
      if (scanInFlight) { changedDuringScan.add(projectPath); return; } // 全量扫描在飞：记下待回补，最终补丁由它统一发
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
    github.applyCiWarnings(projects, rules.types.ci); // 默认分支 CI 失败（issue #143）
    github.applyReviewWarnings(projects, rules.types.review); // PR 有待处理 review（issue #144）
    applySnoozes(projects, store.getPrefs().snoozes);

    // originUrl 仅为内部解析用，不下发渲染层
    const out = projects.map((p) => {
      const q = Object.assign({}, p);
      delete q.originUrl;
      return q;
    });

    // 需要关注清单携带警示类型（issue #77 类型图标）并按严重度排序（issue #74）：
    // 未提交超期 > 未推送 > 开放 PR，同级按项目名稳定排序；WARN_SEVERITY 见共享常量模块
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
        // GitHub 通知快照（issue #145）：未读事件跨项目注意力流，TTL 过期照发（刷新落地后推补丁）；
        // 增量补丁（单项目）不带此字段，渲染层保留旧值
        notifications: store.getGithubCache().notifications || { fetchedAt: 0, data: [], error: null },
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
      projects = await scanner.scan(scanScopeOf(config), {
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
    // 扫描期间变化的项目重扫回补（issue #168 第 7 条）：上面这次整体覆盖用的是扫描开始时的快照，
    // 会把 watcher 期间写入的真实变化盖回旧状态，且全程无补丁发出；这里逐项重扫并把结果同时写回
    // 缓存与返回给调用方的 projects 数组，让本次拼板就能反映变化
    if (changedDuringScan.size) {
      // 只回补本次扫描仍然发现的项目：扫描期间被删除/移出的项目若也重扫，会产出一个全 0 空壳
      // 并被写回缓存，等于把已删除的项目「复活」成僵尸卡片（与 issue #168 第 6 条同源）
      const touched = [...changedDuringScan].filter((p) => next.projects[p]);
      changedDuringScan.clear();
      await Promise.all(touched.map(async (p) => {
        try {
          const fresh = await scanner.scanProject(p, new Date(), { cached: store.getScanCache().projects[p] || null });
          const cur = store.getScanCache();
          cur.projects[p] = fresh;
          store.setScanCache(cur);
          const i = projects.findIndex((x) => x.path === p);
          if (i >= 0) projects[i] = fresh;
          else projects.push(fresh);
        } catch { /* 单项目失败静默，等下次变化或手动刷新 */ }
      }));
    }
    // advice 缓存尸体裁剪（issue #139）：按现存项目集删掉已消失项目的缓存键，
    // 项目删除/改根目录后 ai-cache.json 不再永久累积尸体条目
    const aiCache = store.getAiCache();
    const deadAdviceKeys = Object.keys(aiCache.advice).filter((k) => !next.projects[k]);
    if (deadAdviceKeys.length) {
      for (const k of deadAdviceKeys) delete aiCache.advice[k];
      store.setAiCache(aiCache);
    }
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
    if (!forceGithubRefresh && stale.length === 0) return;
    if (refreshInFlight) {
      // 在飞刷新不能吞掉「连接/导入后立即拉一轮」（issue #168 第 10 条）：那次在飞刷新是在 token
      // 写入之前发起的，其 remotes/鉴权都基于旧状态；直接 return 会让刚连上的用户最长等一个刷新
      // 周期（默认 20 分钟）才看到 GitHub 数据。改为记一个待办，本轮收尾后补跑。
      if (forceGithubRefresh) refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    const me = String(config.githubUsername || '').toLowerCase();
    const remotes = forceGithubRefresh
      ? projects
          .map((p) => github.parseGitHubRemote(p.originUrl))
          .filter((r) => r && r.owner.toLowerCase() === me)
      : stale;
    // 通知（issue #145）与 per-repo 缓存同触发点并行刷：TTL 内跳过，落地有变化并入补丁判断
    const notifyChanged = github.refreshNotifications(config, store).catch((err) => {
      console.error('[devboard] GitHub 通知刷新失败', err);
      return false;
    });
    github.refreshCache(remotes, config, store).then(async (changed) => {
      if (await notifyChanged) changed = true;
      // GitHub 数据落地后立即重推整板补丁：此前补丁发出时数据未到，UI 只能等下次启动（issue #44）
      if (!changed) return;
      const cur = store.getScanCache();
      const projs = Object.values(cur.projects);
      if (!projs.length) return;
      const { board } = assembleBoard(projs, store.getConfig(), true);
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('board:patch', board);
    }).catch((err) => console.error('[devboard] GitHub 缓存刷新失败', err))
      .finally(() => {
        refreshInFlight = false;
        // 补跑在飞期间被挡下的强制刷新（issue #168 第 10 条）：此刻 token/remotes 已是新状态
        if (refreshQueued) {
          refreshQueued = false;
          maybeRefreshGithub(true, [], Object.values(store.getScanCache().projects), store.getConfig());
        }
      });
  }

  // GitHub 连接/导入/断开后的即时处理（issue #118）：不再等下一个刷新触发点（后台定时默认最长 20 分钟）。
  // 连接/导入：复用 maybeRefreshGithub「落地即推补丁」链路（issue #44）立即拉一轮本人仓库；
  // 断开：token 已清、拉取无意义，直接重推一次拼板，渲染层即时清掉 GitHub 区块
  function refreshGithubNow(connected) {
    const projs = Object.values(store.getScanCache().projects);
    if (!projs.length) return;
    if (!connected) {
      const { board } = assembleBoard(projs, store.getConfig(), true);
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('board:patch', board);
      return;
    }
    maybeRefreshGithub(true, [], projs, store.getConfig());
  }

  // 通知快照清理与登录名自愈已随 GitHub 域拆至 ipc-github.js（issue #124 第一刀）

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
  ipcMain.handle('branch:commits', async (_e, projectPath, branch) => {
    const p = String(projectPath || '');
    // 项目路径可能落在已掉线的网络盘上：异步探 .git，避免主线程同步等待（issue #168 第 5 条）
    if (!p || !(await pathExists(path.join(p, '.git')))) return null;
    return scanner.branchDetail(p, branch);
  });

  ipcMain.handle('memo:set', (_e, projectPath, text) => {
    store.setMemo(projectPath, String(text || ''));
    return true;
  });

  ipcMain.handle('quickopen', (_e, payload) => {
    return quickOpen(payload || {}, store.getConfig());
  });

  // AI 调度域（issue #124 第二刀）已拆至 ipc-ai.js：aitools:list/aitools:open/ai:caps/ai:ask/
  // ai:promptPreview 五个 handler + 工具探测/引擎排序/模板哈希/事实签名等帮手 + 在飞表与引擎黑名单。
  // checkCommand/pathExists/spawnResult 等跨域系统助手留主干，经 deps 注入；会话级黑名单的
  // 清空口经返回值暴露（settings:set 调用，issue #138）

  // 详情面板深区数据：README 首段摘要 + AI 会话痕迹明细（issue #17）
  ipcMain.handle('project:detail', async (_e, projectPath) => {
    const p = String(projectPath || '');
    // 异步探盘（issue #168 第 5 条）：详情面板打开时不因掉线网络盘冻结主线程
    if (!p || !(await pathExists(p))) return { readme: '', aiSessions: [] };
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
    // AI 配置变更清空会话级引擎黑名单（issue #138，黑名单在 ipc-ai.js 域内，经返回值清空口调用）：
    // aiEngine/aiTools/aiEnabled 任一变化，被偶发故障拉黑的引擎立即可再试，修好登录/配额后不再整会话雪藏
    if (['aiEngine', 'aiTools', 'aiEnabled'].some((k) => Object.prototype.hasOwnProperty.call(p, k))) {
      clearSessionBadEngines();
    }
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

  // 设置页辅助：扫描预览（用未保存的草稿值跑 discover，不落盘；附带无效路径清单）
  // 无效路径一律经异步 pathExists 探测（issue #168 第 5 条），不再在主线程同步 existsSync
  ipcMain.handle('scan:preview', async (_e, draft) => {
    const cfg = store.getConfig();
    const scope = scanScopeOf(cfg, draft);
    const paths = await scanner.discover(scope);
    const invalidRoots = (await Promise.all(
      scope.roots.map(async (r) => (r && !(await pathExists(r)) ? r : null))
    )).filter(Boolean);
    const invalidExtra = (await Promise.all(
      scope.extraPaths.map(async (p) => {
        if (!p) return null;
        return (!(await pathExists(p)) || !(await pathExists(path.join(p, '.git')))) ? p : null;
      })
    )).filter(Boolean);
    return {
      count: paths.length,
      names: paths.map((p) => path.basename(p)).slice(0, 60),
      invalidRoots,
      invalidExtra,
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

module.exports = { registerIpc };
