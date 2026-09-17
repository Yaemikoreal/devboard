// .git 文件监听驱动的单项目增量刷新（issue #25）。纯 Node，不依赖 Electron，可单测。
// 监听各项目 gitdir 的 HEAD 与 index；变化去抖后仅重扫该项目（HEAD 分档由 scanner 自理），
// 完成后经 onUpdate(path, project) 回调。同步/休眠后由 syncWatchers 重建失效 watcher。
'use strict';

const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 800; // 一次 git 操作常连写 HEAD/index，合并为一次重扫
const COOLDOWN_MS = 2000; // 重扫自身的 git status 可能刷新 index，冷却防自触发循环
const MAX_WATCHED = 100; // watcher 数量上限，超出部分不监听（手动刷新兜底）

// .git 可能是目录，也可能是 worktree/submodule 的 gitdir 指针文件
function resolveGitdir(projectPath) {
  const dot = path.join(projectPath, '.git');
  try {
    const st = fs.statSync(dot);
    if (st.isDirectory()) return dot;
    const m = fs.readFileSync(dot, 'utf8').match(/gitdir:\s*(.+)/);
    if (m) return path.resolve(projectPath, m[1].trim());
  } catch { /* 不可读 */ }
  return null;
}

function createGitWatcher({ scanProject, getCached, onUpdate }) {
  const watchers = new Map(); // resolvedPath -> fs.FSWatcher[]
  const timers = new Map(); // resolvedPath -> timeoutId
  const cooldownUntil = new Map(); // resolvedPath -> ts
  let scanning = false; // 全量扫描在飞时跳过（全量会覆盖变化）

  function close(projectPath) {
    const ws = watchers.get(projectPath);
    if (ws) for (const w of ws) { try { w.close(); } catch { /* 已关闭 */ } }
    watchers.delete(projectPath);
  }

  async function rescan(projectPath) {
    cooldownUntil.set(projectPath, Date.now() + COOLDOWN_MS);
    try {
      const fresh = await scanProject(projectPath, new Date(), { cached: getCached(projectPath) });
      onUpdate(projectPath, fresh);
    } catch { /* 单项目失败静默，等下次变化或手动刷新 */ }
  }

  function onChange(projectPath) {
    if (scanning) return;
    if (Date.now() < (cooldownUntil.get(projectPath) || 0)) return;
    clearTimeout(timers.get(projectPath));
    timers.set(projectPath, setTimeout(() => rescan(projectPath), DEBOUNCE_MS));
  }

  function watchOne(projectPath) {
    const gitdir = resolveGitdir(projectPath);
    if (!gitdir) return;
    const ws = [];
    for (const f of ['HEAD', 'index', 'COMMIT_EDITMSG']) {
      const target = path.join(gitdir, f);
      try {
        const w = fs.watch(target, { persistent: false }, () => onChange(projectPath));
        w.on('error', () => close(projectPath)); // 网络盘/休眠唤醒失效时摘除，下次 sync 重建
        ws.push(w);
      } catch { /* 文件不存在或不可监听则跳过 */ }
    }
    if (ws.length) watchers.set(projectPath, ws);
  }

  // 与当前项目清单对齐：移除消失的、补建新增的、超上限截断
  function syncWatchers(projectPaths) {
    const keep = new Set(projectPaths.slice(0, MAX_WATCHED).map((p) => path.resolve(p)));
    for (const p of [...watchers.keys()]) if (!keep.has(p)) close(p);
    for (const p of keep) if (!watchers.has(p)) watchOne(p);
  }

  function closeAll() {
    for (const p of [...watchers.keys()]) close(p);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return {
    syncWatchers,
    closeAll,
    setScanning: (v) => { scanning = !!v; },
    watchedCount: () => watchers.size,
  };
}

// 导出收窄（issue #12 第 6 条）：resolveGitdir/DEBOUNCE_MS/COOLDOWN_MS/MAX_WATCHED 全仓无消费方，不再导出
module.exports = { createGitWatcher };
