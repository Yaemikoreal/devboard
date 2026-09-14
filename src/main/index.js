// 主进程入口：窗口 / 托盘 / 全局热键 / 开机自启 / 每日通知 / 定时刷新
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, Notification, screen, dialog, ipcMain } = require('electron');
const { Store } = require('./store');
const { registerIpc } = require('./ipc');
const { migrateUserData } = require('./userdata-migrate');
const { bootThemePayload } = require('./boot-theme');

let win = null;
let tray = null;
let store = null;
let buildBoard = null;
let gitWatcher = null;
let quitting = false;
let tickTimer = null;
let lastHotkeyError = '';
let lastAutoStartError = ''; // 开机自启注册失败原因，设置页展示（issue #108）

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

// 更名 SignalBoard 后 userData 从 %APPDATA%/devboard 变为 %APPDATA%/SignalBoard（issue #11）。
// 旧目录候选按优先级排列：devboard（npm start 的旧名目录）优先，Electron（脚本入口的兜底名目录）次之。
function migrateUserDataIfNeeded() {
  migrateUserData(app.getPath('userData'), [
    path.join(app.getPath('appData'), 'devboard'),
    path.join(app.getPath('appData'), 'Electron'),
  ]);
}

function createWindow() {
  const opts = {
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    frame: false,
    show: false,
    backgroundColor: bootThemePayload(store.getConfig().theme).bgArt, // 按主题深浅定底色（issue #101）
    icon: path.join(__dirname, '..', '..', 'assets', 'logo', 'icon-256.png'),
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

  // 唤出即主动重扫（渲染层自己也做了防重入）；延迟一拍让窗口先绘制，避免托盘左键卡顿（issue #9）
  win.on('show', () => {
    setTimeout(() => {
      if (win) win.webContents.send('board:tick');
      if (win) win.webContents.send('win:shown'); // 唤出着陆视图（issue #86）：渲染层按偏好切视图
    }, 120);
    maybeNotify();
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

// 托盘 tooltip 计数可按设置显隐（issue #80）；lastAttentionCount 记录最近值，设置切换时即时重绘
let lastAttentionCount = 0;
function updateTrayTooltip(attentionCount) {
  lastAttentionCount = attentionCount;
  if (!tray) return;
  const show = store.getConfig().trayAttentionCount !== false;
  tray.setToolTip(show ? `SignalBoard · ${attentionCount} 个项目需要关注` : 'SignalBoard');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'logo', 'tray-32.png'));
  tray = new Tray(icon);
  tray.setToolTip('SignalBoard');
  const showPanel = () => {
    if (win) { win.show(); win.focus(); } else createWindow();
  };
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: showPanel },
    {
      label: '立即扫描',
      click: () => {
        showPanel();
        if (win) win.webContents.send('board:tick');
      },
    },
    {
      label: '设置',
      click: () => {
        showPanel();
        if (win) win.webContents.send('nav:settings');
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // 左键只做 显示/隐藏（show 后由渲染层异步触发重扫，不再同步卡住，issue #9）
  tray.on('click', toggleWindow);
  // Windows 右键兜底：显式弹出菜单，避免某些版本右键无响应（issue #9）
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

// 后台静默刷新定时器（issue #70）：间隔取 config.scanIntervalMin 预设档位（5/10/20/60），
// 非法值回落 20 分钟；唤出窗口时总会主动重扫一次，该间隔只影响后台静默刷新。
// 值未变时保持原定时器不动，避免每次设置落盘都重置计时相位
const TICK_INTERVALS = [5, 10, 20, 60];
let tickIntervalMin = 0;
function applyTickTimer(cfg) {
  const min = TICK_INTERVALS.indexOf(cfg.scanIntervalMin) >= 0 ? cfg.scanIntervalMin : 20;
  if (tickTimer && min === tickIntervalMin) return;
  tickIntervalMin = min;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (win) win.webContents.send('board:tick');
  }, min * 60 * 1000);
}

// 设置即时生效：重注册热键 + 开机自启 + 后台刷新间隔（issue #70）+ 托盘计数显隐（issue #80）；失败原因记录供设置页展示
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
  lastAutoStartError = '';
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart });
    // 回读验证（issue #108）：写入被系统策略/安全软件拦截时不静默，设置页展示原因
    if (!!cfg.autoStart !== app.getLoginItemSettings().openAtLogin) {
      lastAutoStartError = '开机自启未能生效（可能被系统策略或安全软件拦截）';
    }
  } catch (err) {
    lastAutoStartError = '开机自启设置失败：' + err.message;
  }
  applyTickTimer(cfg);
  updateTrayTooltip(lastAttentionCount);
}

// 每天首次启动或唤出窗口且有待关注项目时弹一条摘要（托盘常驻下进程很少重启，靠唤出兜底）
// 通知设置（issue #80）：notifyEnabled=false 整体关闭；notifyMode=newOnly 时仅当需要关注数
// 较昨日新增才打扰——每日评估都会把当时计数落盘为次日基线，无论当天是否弹窗
let notifyInFlight = false;
async function maybeNotify() {
  if (notifyInFlight) return;
  notifyInFlight = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (store.getLastNotifyDate() === today) return; // 每日评估一次，基线随之推进
    const cfg = store.getConfig();
    const board = await buildBoard();
    const count = board.stats.attentionCount;
    updateTrayTooltip(count);
    const baseline = store.getAttentionBaseline();
    store.setAttentionBaseline(count);
    store.setLastNotifyDate(today);
    if (cfg.notifyEnabled === false) return;
    if (count <= 0 || !Notification.isSupported()) return;
    // 「仅新增」时机：计数较昨日基线没有变多则不打扰（无基线的首日等同有新增）
    if (cfg.notifyMode === 'newOnly' && baseline !== null && count <= baseline) return;
    const names = board.attention.slice(0, 3).map((a) => a.name).join('、');
    const n = new Notification({
      title: 'SignalBoard',
      body: `${count} 个项目需要关注：${names}${board.attention.length > 3 ? ' 等' : ''}`,
    });
    n.on('click', () => {
      if (win) { win.show(); win.focus(); } else createWindow();
    });
    n.show();
  } catch (err) {
    console.error('[devboard] 启动通知失败:', err.message);
  } finally {
    notifyInFlight = false;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 全局兜底（issue #95）：托盘常驻进程不设崩溃重启，漏网异常只记日志不退出，
  // 避免单点 reject 直接带走整个常驻进程
  process.on('uncaughtException', (err) => {
    console.error('[devboard] uncaughtException:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[devboard] unhandledRejection:', err);
  });

  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  // 启动链断裂（目录被锁/权限拒绝等）时显式报错退出，不再无声挂起（issue #95）
  app.whenReady().then(() => {
    app.setAppUserModelId('com.yaemikoreal.signalboard'); // 与 build.appId 一致，通知才能正确归因与响应点击
    migrateUserDataIfNeeded();
    store = new Store(app.getPath('userData'), require('./token-vault'));
    ({ buildBoard, gitWatcher } = registerIpc({
      store,
      getWindow: () => win,
      applySettings,
      getHotkeyError: () => lastHotkeyError,
      getAutoStartError: () => lastAutoStartError, // 开机自启注册失败原因，设置页展示（issue #108）
      onAttentionCount: updateTrayTooltip, // 拼板后刷新托盘计数（显隐由 tooltip 函数按设置裁决，issue #80）
    }));

    // 冷启动防闪（issue #101）：preload 同步取首帧关键 token，head 内联脚本在样式生效前铺底
    ipcMain.on('boot:theme', (e) => { e.returnValue = bootThemePayload(store.getConfig().theme); });

    applySettings(store.getConfig()); // 含后台刷新定时器首次建立（applyTickTimer）
    createWindow();
    createTray();
    maybeNotify();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    console.error('[devboard] 启动失败:', err);
    dialog.showErrorBox('SignalBoard 启动失败', String((err && err.message) || err));
    app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tickTimer) clearInterval(tickTimer);
    if (gitWatcher) gitWatcher.closeAll();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不因窗口关闭退出
  });

  app.on('before-quit', () => { quitting = true; });
}
