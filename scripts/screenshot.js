// 截图脚本：隐藏窗口加载 renderer，触发真实 board:get 渲染后 capturePage。
// 独立入口：不经过 src/main/index.js，因此无单实例锁/托盘/热键/通知。
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Store } = require('../src/main/store');
const { registerIpc } = require('../src/main/ipc');

const MOCK = process.env.DEVBOARD_MOCK === '1';
const OUT = path.join(__dirname, '..', MOCK ? 'screenshot-mock.png' : 'screenshot.png');
let win = null;
let captured = false;

async function capture() {
  if (captured) return;
  captured = true;
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(OUT, img.toPNG());
    const size = img.getSize();
    console.log(`[devboard] 截图已保存: ${OUT} (${size.width}x${size.height})`);
  } catch (err) {
    console.error('[devboard] 截图失败:', err.message);
  }
  app.exit(0);
}

app.whenReady().then(() => {
  if (MOCK) {
    // 布局密度验证：注入 8 个 mock 项目，只注册渲染所需的最小 IPC
    const { mockBoard, mockProjectDetail } = require('./mock-board');
    ipcMain.handle('board:get', () => mockBoard());
    ipcMain.handle('board:rescan', () => mockBoard());
    ipcMain.handle('memo:set', () => true);
    ipcMain.handle('quickopen', () => true);
    ipcMain.handle('shell:openExternal', () => true);
    ipcMain.handle('settings:get', () => ({
      roots: ['E:\\myproject'], extraPaths: [], blacklist: ['node_modules'],
      githubToken: '', hasGithubToken: true, githubUsername: 'me', editorCmd: 'code', terminalCmd: '',
      hotkey: 'Ctrl+Shift+D', autoStart: true, aiTools: [], aiEnabled: true, aiEngine: 'kimi',
    }));
    ipcMain.handle('settings:set', () => ({}));
    ipcMain.handle('settings:hotkeyError', () => '');
    ipcMain.handle('prefs:get', () => ({
      pinned: ['E:\\myproject\\wyy2qqmusic'], cardOrder: [], sortMode: 'manual',
      snoozes: {}, branchSel: {}, windowBounds: null,
    }));
    ipcMain.handle('prefs:set', () => ({}));
    ipcMain.handle('snooze:set', () => true);
    // AI 工具（issue #15 mock）：claude / kimi 已安装，codex / grok 未安装；logo 复用真实注册表（issue #21）
    const { AI_TOOL_ICONS } = require('../src/main/ipc');
    ipcMain.handle('aitools:list', () => [
      { id: 'claude', label: 'Claude Code', cmd: 'claude', installed: true, logo: AI_TOOL_ICONS.claude },
      { id: 'codex', label: 'Codex', cmd: 'codex', installed: false, logo: AI_TOOL_ICONS.codex },
      { id: 'kimi', label: 'Kimi Code', cmd: 'kimi', installed: true, logo: AI_TOOL_ICONS.kimi },
      { id: 'grok', label: 'Grok', cmd: 'grok', installed: false, logo: AI_TOOL_ICONS.grok },
    ]);
    ipcMain.handle('aitools:open', () => true);
    // AI 功能（issue #29 mock）：引擎可用；周报/建议给罐装文本，筛选给结构化结果
    // DEVBOARD_MOCK_AI=off 时返回无引擎，验证「未装工具时入口隐藏」
    const aiOff = process.env.DEVBOARD_MOCK_AI === 'off';
    ipcMain.handle('ai:caps', () => (aiOff
      ? { enabled: true, engine: null }
      : { enabled: true, engine: { id: 'kimi', label: 'Kimi Code', cmd: 'kimi' } }));
    const atWeekly = new Date(Date.now() - 47 * 60000).toISOString();
    const atAdvice = new Date(Date.now() - 2 * 3600000).toISOString();
    // DEVBOARD_MOCK_AI_DELAY=毫秒：模拟真实 CLI 耗时，验证生成任务后台执行与切页恢复（issue #40）
    const aiDelay = Number(process.env.DEVBOARD_MOCK_AI_DELAY || 0);
    const delayed = (v) => (aiDelay && !(v && v.cached)
      ? new Promise((res) => setTimeout(() => res(v), aiDelay))
      : v);
    ipcMain.handle('ai:ask', (_e, payload) => {
      const engine = { id: 'kimi', label: 'Kimi Code', cmd: 'kimi' };
      if (payload && payload.kind === 'filter') {
        return { ok: true, kind: 'filter', filter: { band: null, keyword: null, days: 7 }, engine };
      }
      if (payload && payload.kind === 'advice') {
        return delayed({
          ok: true, kind: 'advice', engine, cached: !!(payload && payload.cachedOnly), at: atAdvice,
          text: '- 18 个文件未提交超 3 天，建议先 commit 或 stash 收拢现场\n- 3 个提交领先远程，尽快 push 避免单机风险\n- 本周提交集中在设置页重构，可为下个小版本收尾',
        });
      }
      if (payload && payload.cachedOnly) return { ok: false, kind: 'weekly', reason: 'no-cache' };
      return delayed({
        ok: true, kind: 'weekly', engine, cached: false, at: atWeekly,
        text: '近 7 天 8 个项目共 42 次提交，重心明显偏向 SignalBoard 的 AI 功能落地与截图工具链；wyy2qqmusic 有一次热修复，其余项目维持低速推进。\n本周建议关注：SignalBoard 的 AI 功能收尾与真实 CLI 联调。',
      });
    });
    // 详情面板深区数据（issue #17 mock）：README 摘要 + AI 会话痕迹明细
    ipcMain.handle('project:detail', (_e, projectPath) => mockProjectDetail(projectPath));
    ipcMain.handle('dialog:pick', () => null);
    ipcMain.handle('util:checkCommand', () => ({ ok: true, reason: 'mock' }));
    ipcMain.handle('github:test', () => ({ ok: true, login: 'me' }));
    ipcMain.handle('scan:preview', () => ({ count: 8, names: [], invalidRoots: [], invalidExtra: [] }));
    ipcMain.handle('branch:commits', () => ({ lastCommitAt: new Date().toISOString(), commits: [{ msg: 'mock 分支提交', rel: '2 天前' }] }));
    ipcMain.handle('github:authCaps', () => ({ deviceFlow: false, ghCli: false }));
    ipcMain.handle('github:deviceStart', () => ({ ok: false, reason: 'mock' }));
    ipcMain.handle('github:devicePoll', () => ({ status: 'error', reason: 'mock' }));
    ipcMain.handle('github:importGh', () => ({ ok: false, reason: 'mock' }));
    ipcMain.handle('win:min', () => {});
    ipcMain.handle('win:max', () => {});
    ipcMain.handle('win:close', () => {});
  } else {
    const store = new Store(app.getPath('userData'), require('../src/main/token-vault'));
    registerIpc({ store, getWindow: () => win, applySettings: () => {} });
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // show:false + offscreen 渲染：无需显示窗口也能持续产帧，capturePage 拿到真实画面
    show: false,
    skipTaskbar: true,
    backgroundColor: '#f5f2e8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  let rendered = false;
  // 渲染层首次 board:get 渲染完成时会打标记；DEVBOARD_WAIT_PATCH=1 时继续等后台重扫补丁（issue #22 验证）
  win.webContents.on('console-message', (e) => {
    const msg = e.message || '';
    if (process.env.DEVBOARD_DEBUG === '1') console.log('[renderer]', msg);
    if (msg.includes('[devboard] shot-ready')) {
      capture(); // SHOT_JS 前置脚本声明就绪（如等待 AI 结果），立即截图
      return;
    }
    if (msg.includes('[devboard] rendered')) {
      rendered = true;
      if (process.env.DEVBOARD_WAIT_PATCH === '1') return; // 等 patched
      afterRender();
    } else if (msg.includes('[devboard] patched') && rendered && process.env.DEVBOARD_WAIT_PATCH === '1') {
      afterRender();
    }
  });

  function afterRender() {
    if (process.env.DEVBOARD_SHOT_SETTINGS === '1') {
      // 设置页截图：展开设置视图再拍
      win.webContents.executeJavaScript(
        "document.getElementById('settingsBtn').click(); void 0"
      ).then(() => setTimeout(capture, 1200));
      return;
    }
    if (process.env.DEVBOARD_SHOT_JS) {
      // 自定义前置脚本（如点击分带筛选）后再拍；
      // DEVBOARD_SHOT_WAIT=signal 时改为等待页面 console.log('[devboard] shot-ready')（AI 等异步结果场景）
      win.webContents.executeJavaScript(process.env.DEVBOARD_SHOT_JS + '; void 0')
        .then(() => {
          if (process.env.DEVBOARD_SHOT_WAIT !== 'signal') setTimeout(capture, 1200);
        });
      return;
    }
    setTimeout(capture, 1500); // 等展开动画与柱图稳定
  }
  // 兜底：超时未就绪也截图退出；DEVBOARD_SHOT_TIMEOUT 可覆盖（真实 AI 回退链可能超过 75s，issue #41 验证）
  setTimeout(capture, Number(process.env.DEVBOARD_SHOT_TIMEOUT || (process.env.DEVBOARD_SHOT_WAIT === 'signal' ? 75000 : 30000)));
});

app.on('window-all-closed', () => app.exit(0));
