// IPC 注册：board:get / board:rescan / memo:set / quickopen / settings:get / settings:set / win:*
'use strict';

const { ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const scanner = require('./scanner');
const github = require('./github');

function quickOpen({ path: projectPath, kind }, editorCmd) {
  if (kind === 'folder') return shell.openPath(projectPath).then(() => true);
  if (kind === 'editor') {
    // Windows 下 code 是 .cmd，需要 shell
    const child = spawn(editorCmd, [projectPath], { detached: true, stdio: 'ignore', shell: true });
    child.on('error', () => {});
    child.unref();
    return Promise.resolve(true);
  }
  if (kind === 'terminal') {
    // 优先 Windows Terminal，失败退回 cmd start
    try {
      const wt = spawn('wt', ['-d', projectPath], { detached: true, stdio: 'ignore', shell: true });
      wt.on('error', () => {
        const c = spawn('cmd', ['/c', 'start', 'cmd'], { cwd: projectPath, detached: true, stdio: 'ignore' });
        c.on('error', () => {});
        c.unref();
      });
      wt.unref();
    } catch {
      const c = spawn('cmd', ['/c', 'start', 'cmd'], { cwd: projectPath, detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
    }
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

function registerIpc({ store, getWindow, applySettings }) {
  let refreshInFlight = false;

  // 本地 git 实时扫 + GitHub 读缓存；缓存缺失/过期时后台异步刷新
  async function buildBoard(forceGithubRefresh) {
    const config = store.getConfig();
    const projects = await scanner.scan(config.roots, config.blacklist);
    const memos = store.getMemos();
    for (const p of projects) p.memo = memos[p.path] || '';

    const stale = github.attachFromCache(projects, config, store);
    github.applyPrWarnings(projects);

    if ((forceGithubRefresh || stale.length > 0) && !refreshInFlight) {
      refreshInFlight = true;
      const remotes = forceGithubRefresh
        ? projects
            .map((p) => github.parseGitHubRemote(p.originUrl))
            .filter((r) => r && r.owner === config.githubUsername)
        : stale;
      github.refreshCache(remotes, config, store).finally(() => { refreshInFlight = false; });
    }

    // originUrl 仅为内部解析用，不下发渲染层
    for (const p of projects) delete p.originUrl;

    const attention = projects
      .filter((p) => p.warnings.length > 0)
      .map((p) => ({ path: p.path, name: p.name, label: p.warnings.map((w) => w.label).join('，') }));

    return {
      scannedAt: new Date().toISOString(),
      stats: {
        total: projects.length,
        commits7d: projects.reduce((s, p) => s + p.commits7d, 0),
        attentionCount: attention.length,
      },
      attention,
      projects,
    };
  }

  ipcMain.handle('board:get', () => buildBoard(false));
  ipcMain.handle('board:rescan', () => buildBoard(true));

  ipcMain.handle('memo:set', (_e, projectPath, text) => {
    store.setMemo(projectPath, String(text || ''));
    return true;
  });

  ipcMain.handle('quickopen', (_e, payload) => {
    const config = store.getConfig();
    return quickOpen(payload || {}, config.editorCmd);
  });

  ipcMain.handle('settings:get', () => store.getConfig());

  ipcMain.handle('settings:set', (_e, patch) => {
    const cfg = store.setConfig(patch || {});
    applySettings(cfg); // 热键重注册 + 开机自启即时生效
    return cfg;
  });

  // GitHub 链接等外部打开，仅允许 http(s)
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  ipcMain.handle('win:min', () => { const w = getWindow(); if (w) w.minimize(); });
  ipcMain.handle('win:max', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.handle('win:close', () => { const w = getWindow(); if (w) w.close(); });

  return { buildBoard };
}

module.exports = { registerIpc };
