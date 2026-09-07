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
    const { mockBoard } = require('./mock-board');
    ipcMain.handle('board:get', () => mockBoard());
    ipcMain.handle('board:rescan', () => mockBoard());
    ipcMain.handle('memo:set', () => true);
    ipcMain.handle('quickopen', () => true);
    ipcMain.handle('shell:openExternal', () => true);
    ipcMain.handle('settings:get', () => ({
      roots: ['E:\\myproject'], extraPaths: [], blacklist: ['node_modules'],
      githubToken: 'mock', githubUsername: 'me', editorCmd: 'code', terminalCmd: '',
      hotkey: 'Ctrl+Shift+D', autoStart: true,
    }));
    ipcMain.handle('settings:set', () => ({}));
    ipcMain.handle('settings:hotkeyError', () => '');
    ipcMain.handle('prefs:get', () => ({ pinned: null, cardOrder: [], snoozes: {}, windowBounds: null }));
    ipcMain.handle('prefs:set', () => ({}));
    ipcMain.handle('snooze:set', () => true);
    ipcMain.handle('dialog:pick', () => null);
    ipcMain.handle('util:checkCommand', () => ({ ok: true, reason: 'mock' }));
    ipcMain.handle('github:test', () => ({ ok: true, login: 'me' }));
    ipcMain.handle('scan:preview', () => ({ count: 8, names: [], invalidRoots: [], invalidExtra: [] }));
    ipcMain.handle('win:min', () => {});
    ipcMain.handle('win:max', () => {});
    ipcMain.handle('win:close', () => {});
  } else {
    const store = new Store(app.getPath('userData'));
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

  // 渲染层首次 board:get 渲染完成时会打标记
  win.webContents.on('console-message', (e) => {
    if (e.message && e.message.includes('[devboard] rendered')) {
      if (process.env.DEVBOARD_SHOT_SETTINGS === '1') {
        // 设置页截图：展开设置视图再拍
        win.webContents.executeJavaScript(
          "document.getElementById('settingsBtn').click(); void 0"
        ).then(() => setTimeout(capture, 1200));
        return;
      }
      if (process.env.DEVBOARD_SHOT_JS) {
        // 自定义前置脚本（如点击分带筛选）后再拍
        win.webContents.executeJavaScript(process.env.DEVBOARD_SHOT_JS + '; void 0')
          .then(() => setTimeout(capture, 1200));
        return;
      }
      setTimeout(capture, 1500); // 等展开动画与柱图稳定
    }
  });
  setTimeout(capture, 30000); // 兜底：30 秒未渲染完也截图退出
});

app.on('window-all-closed', () => app.exit(0));
