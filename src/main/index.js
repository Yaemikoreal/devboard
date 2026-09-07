// 主进程入口：窗口 / 托盘 / 全局热键 / 开机自启 / 每日通知 / 定时刷新
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, Notification, screen } = require('electron');
const { Store } = require('./store');
const { registerIpc } = require('./ipc');
const { TRAY_ICON_BASE64 } = require('./tray-icon');

let win = null;
let tray = null;
let store = null;
let buildBoard = null;
let quitting = false;
let tickTimer = null;
let lastHotkeyError = '';

function debounce(fn, ms) {
  let t = null;
  return function () {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

// 记住的窗口位置至少要有 50px 落在某块显示器工作区内，否则丢弃（防拔显示器后窗口丢失）
function boundsVisible(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50;
  });
}

function createWindow() {
  const opts = {
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
  };
  const b = store.getPrefs().windowBounds;
  if (b && b.width >= 1280 && b.height >= 800 && boundsVisible(b)) {
    opts.width = b.width;
    opts.height = b.height;
    opts.x = b.x;
    opts.y = b.y;
  }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const saveBounds = debounce(() => {
    if (win && !win.isMaximized() && !win.isMinimized()) {
      store.setPrefs({ windowBounds: win.getBounds() });
    }
  }, 500);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // 唤出即主动重扫（渲染层自己也做了防重入）
  win.on('show', () => {
    if (win) win.webContents.send('board:tick');
  });

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
    {
      label: '立即扫描',
      click: () => {
        if (win) {
          win.show();
          win.focus();
          win.webContents.send('board:tick');
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

// 设置即时生效：重注册热键 + 开机自启；失败原因记录供设置页展示
function applySettings(cfg) {
  globalShortcut.unregisterAll();
  lastHotkeyError = '';
  if (cfg.hotkey) {
    try {
      const ok = globalShortcut.register(cfg.hotkey, toggleWindow);
      if (!ok) lastHotkeyError = '热键注册失败：格式无效或已被其他程序占用';
    } catch (err) {
      lastHotkeyError = '热键注册失败：' + err.message;
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
      getHotkeyError: () => lastHotkeyError,
    }));

    applySettings(store.getConfig());
    createWindow();
    createTray();
    maybeNotify();

    // 每 20 分钟静默刷新一次（唤出窗口时另有主动重扫）
    tickTimer = setInterval(() => {
      if (win) win.webContents.send('board:tick');
    }, 20 * 60 * 1000);

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
