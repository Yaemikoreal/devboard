// 截图脚本：隐藏窗口加载 renderer，触发真实 board:get 渲染后 capturePage。
// 独立入口：不经过 src/main/index.js，因此无单实例锁/托盘/热键/通知。
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Store } = require('../src/main/store');
const { registerIpc } = require('../src/main/ipc');
const { bootThemePayload } = require('../src/main/boot-theme');

// --gif：README 演示动图模式——主面板上七套主题轮播逐帧捕获，gifenc 合成；固定走 mock 数据保证画面可复现
const GIF = process.argv.includes('--gif');
if (GIF) process.env.DEVBOARD_MOCK = '1';
const MOCK = process.env.DEVBOARD_MOCK === '1';
// DEVBOARD_SHOT_OUT：自定义输出路径（官网素材批量出图用）；缺省维持仓库根目录固定名
const OUT = process.env.DEVBOARD_SHOT_OUT
  ? path.resolve(process.env.DEVBOARD_SHOT_OUT)
  : path.join(__dirname, '..', MOCK ? 'screenshot-mock.png' : 'screenshot.png');
let win = null;
let captured = false;

// 动图输出：site/assets/demo.gif（README「主题与个性化」演示用）
const GIF_OUT = path.join(__dirname, '..', 'site', 'assets', 'demo.gif');
const DEMO_THEMES = ['warm', 'mist', 'meadow', 'sakura', 'iris', 'dark', 'abyss'];

async function captureAnimated() {
  if (captured) return;
  captured = true;
  try {
    const sharp = require('sharp');
    const { GIFEncoder, quantize, applyPalette } = require('gifenc');
    const gif = GIFEncoder();
    const frames = [...DEMO_THEMES, 'warm']; // 首尾同为暖阳，GIF 循环播放无跳变
    let prev = 'warm'; // mock 启动即暖阳，后续逐帧切换
    for (const id of frames) {
      if (id !== prev) {
        // 主题色卡位于隐藏的设置页内；程序化 click 不依赖可见性，免开设置页直接切主题
        await win.webContents.executeJavaScript(
          `document.querySelector('#themeCards [data-theme="${id}"]').click(); void 0`);
        prev = id;
      }
      await new Promise((r) => setTimeout(r, 1000)); // 等切换过渡与重绘（离屏渲染需一拍落帧，issue #46）
      const shot = await win.webContents.capturePage();
      const { data, info } = await sharp(shot.toPNG())
        .resize({ width: 720 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // gifenc 需要 RGBA 四通道
      // 每帧独立 128 色量化：七套主题色域差异大，全局调色板会偏色
      const palette = quantize(data, 128);
      gif.writeFrame(applyPalette(data, palette), info.width, info.height, { palette, delay: 1000 });
      console.log(`[devboard] 动图帧 ${id} 已捕获 (${info.width}x${info.height})`);
    }
    gif.finish();
    const bytes = Buffer.from(gif.bytes());
    fs.writeFileSync(GIF_OUT, bytes);
    console.log(`[devboard] 演示动图已保存: ${GIF_OUT} (${(bytes.length / 1048576).toFixed(2)}MB, ${frames.length} 帧)`);
  } catch (err) {
    console.error('[devboard] 动图生成失败:', err.message);
  }
  app.exit(0);
}

async function capture() {
  if (GIF) return captureAnimated();
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
  let bootPayload = null; // 冷启动防闪（issue #101）：preload 同步桥取首帧关键 token
  if (MOCK) {    // 布局密度验证：注入 8 个 mock 项目，只注册渲染所需的最小 IPC
    const { mockBoard, mockProjectDetail } = require('./mock-board');
    bootPayload = bootThemePayload({ id: process.env.DEVBOARD_MOCK_THEME || 'warm' });
    ipcMain.on('boot:theme', (e) => { e.returnValue = bootPayload; });
    ipcMain.handle('board:get', () => mockBoard());
    ipcMain.handle('board:rescan', () => mockBoard());
    ipcMain.handle('memo:set', () => true);
    ipcMain.handle('quickopen', () => true);
    ipcMain.handle('shell:openExternal', () => true);
    ipcMain.handle('settings:get', () => ({
      roots: ['E:\\myproject'], extraPaths: [], blacklist: ['node_modules'],
      githubToken: '', hasGithubToken: true, githubUsername: 'me', editorCmd: 'code', terminalCmd: '',
      hotkey: 'Ctrl+Shift+D', autoStart: true, aiTools: [], aiEnabled: true, aiEngine: 'kimi',
      // DEVBOARD_MOCK_THEME=warm|mist|meadow|dark：指定整体主题出图（缺省暖阳，强调色取主题默认）
      theme: { id: process.env.DEVBOARD_MOCK_THEME || 'warm' },
    }));
    ipcMain.handle('settings:set', () => ({}));
    ipcMain.handle('settings:hotkeyError', () => '');
    ipcMain.handle('prefs:get', () => ({
      pinned: ['E:\\myproject\\wyy2qqmusic'], cardOrder: [], sortMode: 'manual',
      snoozes: {}, branchSel: {}, windowBounds: null,
      onboarded: true, // 避免首启自动打开设置页挡住主视图（设置页截图走 DEVBOARD_SHOT_SETTINGS=1）
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
          text: '近况概览：项目处于活跃推进期，近 7 天 14 次提交集中在歌单解析与批量导入；当前有 3 个文件未提交、2 个提交未推送，存在一定的现场丢失风险。\n- 先 commit 或 stash 收拢 3 个未提交文件，避免与迁移脚本联调互相污染\n- 尽快 push 领先的 2 个提交，降低单机风险\n- cookie 失效问题（issue #3）建议下一步处理，它阻塞自动刷新主流程',
        });
      }
      if (payload && payload.cachedOnly) return { ok: false, kind: 'weekly', reason: 'no-cache' };
      return delayed({
        ok: true, kind: 'weekly', engine, cached: false, at: atWeekly,
        text: '本周总览：近 7 天 8 个项目共 42 次提交，精力集中在 SignalBoard 的 AI 功能落地，其余项目低速推进。\n- **SignalBoard**：20 次提交，AI 周报/建议全链路打通并完成 UI 优化\n- **wyy2qqmusic**：14 次提交，歌单批量导入与登录模块拆分进入联调\n- **chat-analysis**：4 次提交，PDF 模板 v2 布局收尾，修复长图分页溢出\n- **kimi-skill-lab**：2 次提交，新增实验性 skill 骨架\n- **devboard**：2 次提交，设计方向与色彩规范落定\n本周建议关注：SignalBoard 的 AI 能力正沉淀为可复用底座，优先固化稳定性并补齐文档。',
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
    // GitHub 账户状态卡 mock（issue #45）：已连接 + 连通正常，头像用内联 SVG 圆
    ipcMain.handle('github:status', () => ({
      configured: true, ok: true, login: 'yaemikoreal', name: 'Yaemiko',
      avatarUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="%23f5d90a"/><text x="18" y="23" text-anchor="middle" font-size="14" font-weight="700" font-family="sans-serif" fill="%23181818">Y</text></svg>',
    }));
    ipcMain.handle('github:disconnect', () => true);
    ipcMain.handle('win:min', () => {});
    ipcMain.handle('win:max', () => {});
    ipcMain.handle('win:close', () => {});
  } else {
    // DEVBOARD_USERDATA：指向真实安装的 userData（如 %APPDATA%/SignalBoard），用真实配置/缓存验证（issue #44）
    if (process.env.DEVBOARD_USERDATA) app.setPath('userData', process.env.DEVBOARD_USERDATA);
    const store = new Store(app.getPath('userData'), require('../src/main/token-vault'));
    bootPayload = bootThemePayload(store.getConfig().theme);
    ipcMain.on('boot:theme', (e) => { e.returnValue = bootPayload; });
    registerIpc({ store, getWindow: () => win, applySettings: () => {} });
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // show:false + offscreen 渲染：无需显示窗口也能持续产帧，capturePage 拿到真实画面
    show: false,
    skipTaskbar: true,
    backgroundColor: bootPayload.bgArt, // 按主题深浅定底色（issue #101）
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 同 src/main/index.js：preload 需加载本地共享常量模块（issue-11 / #127），沙箱内不支持
      sandbox: false,
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
      // 延迟一拍再截：console-message 事件内立即 capturePage 会拿到上一帧（离屏渲染实测，issue #46 验证）
      setTimeout(capture, 400);
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
      // 设置页截图：展开设置视图再拍；SHOT_JS 可在其后追加前置操作（如切换到指定 pane）
      win.webContents.executeJavaScript(
        "document.getElementById('settingsBtn').click();" + (process.env.DEVBOARD_SHOT_JS || '') + '; void 0'
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
