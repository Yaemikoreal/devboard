// 主进程入口：窗口 / 托盘 / 全局热键 / 开机自启 / 每日通知 / 定时刷新
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, Notification } = require('electron');
const { Store } = require('./store');
const { registerIpc } = require('./ipc');
const { TRAY_ICON_BASE64 } = require('./tray-icon');

let win = null;
let tray = null;
let store = null;
let buildBoard = null;
let quitting = false;
let tickTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    frame: false,
    show: false,
    backgroundColor: '#f5f2e8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault(); // 关闭即隐藏到托盘
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function updateTrayTooltip(attentionCount) {
  if (tray) tray.setToolTip(`devboard · ${attentionCount} 待关注`);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
  tray = new Tray(icon);
  tray.setToolTip('devboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

// 设置即时生效：重注册热键 + 开机自启
function applySettings(cfg) {
  globalShortcut.unregisterAll();
  if (cfg.hotkey) {
    try {
      globalShortcut.register(cfg.hotkey, toggleWindow);
    } catch (err) {
      console.error('[devboard] 热键注册失败:', cfg.hotkey, err.message);
    }
  }
  app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart });
}

// 每天首次启动且有待关注项目时弹一条摘要
async function maybeNotify() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (store.getLastNotifyDate() === today) return;
    const board = await buildBoard();
    updateTrayTooltip(board.stats.attentionCount);
    if (board.stats.attentionCount > 0 && Notification.isSupported()) {
      const names = board.attention.slice(0, 3).map((a) => a.name).join('、');
      new Notification({
        title: 'devboard',
        body: `${board.stats.attentionCount} 个项目需要关注：${names}${board.attention.length > 3 ? ' 等' : ''}`,
      }).show();
    }
    store.setLastNotifyDate(today);
  } catch (err) {
    console.error('[devboard] 启动通知失败:', err.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    ({ buildBoard } = registerIpc({
      store,
      getWindow: () => win,
      applySettings,
    }));

    applySettings(store.getConfig());
    createWindow();
    createTray();
    maybeNotify();

    // 每 10 分钟通知渲染层刷新
    tickTimer = setInterval(() => {
      if (win) win.webContents.send('board:tick');
    }, 10 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tickTimer) clearInterval(tickTimer);
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不因窗口关闭退出
  });

  app.on('before-quit', () => { quitting = true; });
}
