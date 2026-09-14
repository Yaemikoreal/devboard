// Logo 全尺寸渲染（issue #10；#89 切换为方向 D，按 前端设计参考/logo2.png 复原）：
// 用 Electron offscreen 窗口加载定稿 SVG，capturePage 出正方形母版后 nativeImage.resize 到各目标尺寸；
// ICO 用纯 Node 容器封装 PNG payload。托盘定稿主版统一（issue #113 讨论结论）：
// 托盘与 exe/任务栏图标同用带奶油底板的 logo2 样式，draft-d-tray 深浅变体退役（SVG 源留档）。
// 窗口只承担「等比画布」角色：512 逻辑尺寸任何屏幕工作区都容纳，SVG 以 100% 尺寸填满窗口，
// 母版恒为正方形（#113：原 1024 固定窗口在 150% 缩放屏被工作区钳成长方形，resize 非等比拉伸致产物变形）。
// 用法：npm run logo（electron scripts/render-logo.js）
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const LOGO_DIR = path.join(ROOT, 'assets', 'logo');
const BUILD_DIR = path.join(ROOT, 'build');
const SITE_ICON = path.join(ROOT, 'site', 'assets', 'icon.png');
const SRC = fs.readFileSync(path.join(LOGO_DIR, 'draft-d.svg'), 'utf8');
const RENDER_SIZE = 512; // 母版边长（逻辑像素）：256 产物的两倍超采样，远小于最低配工作区

function pageUrl(svg) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent}' +
    'svg{display:block;width:100vw;height:100vh}' +
    '</style></head><body>' + svg + '</body></html>');
}

async function renderMaster(svg) {
  // 独立窗口逐次创建销毁（#113）：复用窗口连续 loadURL 曾竞态失败，capturePage 捕到上一页内容
  const win = new BrowserWindow({
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadURL(pageUrl(svg));
    await new Promise((r) => setTimeout(r, 400)); // 等渲染稳定
    const img = await win.webContents.capturePage();
    // fail-fast（#113）：母版非正方形 = 窗口被屏幕工作区钳制，resize 会非等比拉伸，宁失败不产出变形图
    const s = img.getSize();
    if (s.width !== s.height) {
      throw new Error(`母版非正方形 ${s.width}x${s.height}（渲染窗口被屏幕工作区钳制），终止产出`);
    }
    return img;
  } finally {
    win.destroy();
  }
}

function saveResized(master, size, file) {
  const png = master.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(file, png);
  console.log(`[logo] ${path.relative(ROOT, file)} (${size}x${size}, ${png.length}B)`);
  return png;
}

// ICO 容器：ICONDIR + N * ICONDIRENTRY + PNG payloads（Vista+ 允许 256px 用 PNG 压缩）
function buildIco(entries) {
  // entries: [{ size, png }]
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  const dirSize = 6 + 16 * entries.length;
  let offset = dirSize;
  const dirs = entries.map(({ size, png }) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
    d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt8(0, 2); // palette
    d.writeUInt8(0, 3); // reserved
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += png.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  try {
    const paper = await renderMaster(SRC);

    // 窗口 / 任务栏 / 托盘 / README（#113 主版统一）：带奶油底板的定稿版
    for (const s of [16, 24, 32, 256]) {
      saveResized(paper, s, path.join(LOGO_DIR, `icon-${s}.png`));
    }
    for (const s of [16, 24, 32]) {
      saveResized(paper, s, path.join(LOGO_DIR, `tray-${s}.png`));
    }
    // 官网 favicon（site/assets/icon.png）
    saveResized(paper, 256, SITE_ICON);
    // 安装包 ICO：16/32/48/256 多尺寸
    const icoEntries = [16, 32, 48, 256].map((s) => ({
      size: s,
      png: paper.resize({ width: s, height: s, quality: 'best' }).toPNG(),
    }));
    const ico = buildIco(icoEntries);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
    console.log(`[logo] build/icon.ico (${ico.length}B, sizes: ${icoEntries.map((e) => e.size).join('/')})`);

    // 验收：确认 nativeImage 能从文件加载托盘图标且非空
    const trayImg = nativeImage.createFromPath(path.join(LOGO_DIR, 'tray-32.png'));
    console.log(`[logo] tray-32.png nativeImage.isEmpty() = ${trayImg.isEmpty()}, size = ${JSON.stringify(trayImg.getSize())}`);
    if (trayImg.isEmpty()) {
      console.error('[logo] 托盘图标加载为空，渲染产物有问题');
      app.exit(1);
      return;
    }
    app.exit(0);
  } catch (err) {
    console.error('[logo] 渲染失败:', err);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.exit(0));
