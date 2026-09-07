// IPC 注册：board:get / board:rescan / memo:set / quickopen / settings:* / prefs:* / snooze:set
// 设置页辅助：dialog:pick / util:checkCommand / github:test / scan:preview / win:*
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, shell, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const scanner = require('./scanner');
const github = require('./github');

// 启动子进程并给出真实结果：立即非零退出视为失败，存活超过 800ms 视为成功
function spawnResult(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', shell: true }, opts));
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

function registerIpc({ store, getWindow, applySettings, getHotkeyError }) {
  let refreshInFlight = false;

  // 本地 git 实时扫 + GitHub 读缓存；缓存缺失/过期时后台异步刷新
  async function buildBoard(forceGithubRefresh) {
    const config = store.getConfig();
    const projects = await scanner.scan(config.roots, config.blacklist, config.extraPaths);
    const memos = store.getMemos();
    for (const p of projects) p.memo = memos[p.path] || '';

    const stale = github.attachFromCache(projects, config, store);
    github.applyPrWarnings(projects);
    applySnoozes(projects, store.getPrefs().snoozes);

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
    return quickOpen(payload || {}, store.getConfig());
  });

  ipcMain.handle('settings:get', () => store.getConfig());

  ipcMain.handle('settings:set', (_e, patch) => {
    const cfg = store.setConfig(patch || {});
    applySettings(cfg); // 热键重注册 + 开机自启即时生效
    return cfg;
  });

  // 保存设置后由渲染层查询热键注册结果（空串 = 成功）
  ipcMain.handle('settings:hotkeyError', () => (getHotkeyError ? getHotkeyError() : ''));

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

  // 设置页辅助：命令可用性校验（含路径的查文件存在，否则用 where 查 PATH）
  ipcMain.handle('util:checkCommand', (_e, cmd) => {
    const first = String(cmd || '').trim().split(/\s+/)[0].replace(/^"|"$/g, '');
    if (!first) return { ok: false, reason: '命令为空' };
    if (/[\\/]/.test(first) || /\.(exe|cmd|bat)$/i.test(first)) {
      const exists = fs.existsSync(first);
      return { ok: exists, reason: exists ? '' : '文件不存在' };
    }
    return new Promise((resolve) => {
      execFile('where', [first], { timeout: 5000 }, (err, stdout) => {
        if (err) resolve({ ok: false, reason: 'PATH 中找不到该命令' });
        else resolve({ ok: true, reason: String(stdout).split('\n')[0].trim() });
      });
    });
  });

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

  // 设置页辅助：扫描预览（用未保存的草稿值跑 discover，不落盘；附带无效路径清单）
  ipcMain.handle('scan:preview', (_e, draft) => {
    const cfg = store.getConfig();
    const d = draft || {};
    const roots = Array.isArray(d.roots) ? d.roots : cfg.roots;
    const blacklist = Array.isArray(d.blacklist) ? d.blacklist : cfg.blacklist;
    const extraPaths = Array.isArray(d.extraPaths) ? d.extraPaths : cfg.extraPaths;
    const paths = scanner.discover(roots, blacklist, extraPaths);
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
