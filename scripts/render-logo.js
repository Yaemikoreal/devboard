// Logo 全尺寸渲染（issue #10）：用 Electron offscreen 窗口加载定稿 SVG（方向 A），
// capturePage 出 1024 母版后 nativeImage.resize 到各目标尺寸；ICO 用纯 Node 容器封装 PNG payload。
// 用法：npm run logo（electron scripts/render-logo.js）
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const LOGO_DIR = path.join(ROOT, 'assets', 'logo');
const BUILD_DIR = path.join(ROOT, 'build');
const SRC = fs.readFileSync(path.join(LOGO_DIR, 'draft-a.svg'), 'utf8');

// 墨底纸纹变体（托盘用，深色任务栏可辨）：纸底 <-> 墨黑互换，明黄信号格保持不变
const SRC_DARK = SRC
  .split('#f5f2e8').join('#__PAPER__')
  .split('#322e27').join('#f5f2e8')
  .split('#__PAPER__').join('#322e27');

function pageUrl(svg) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent}' +
    'svg{display:block;width:1024px;height:1024px}' +
    '</style></head><body>' + svg + '</body></html>');
}

async function renderMaster(win, svg) {
  await win.loadURL(pageUrl(svg));
  await new Promise((r) => setTimeout(r, 400)); // 等渲染稳定
  return win.webContents.capturePage();
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

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });

  try {
    const paper = await renderMaster(win, SRC);
    const dark = await renderMaster(win, SRC_DARK);

    // 窗口 / 任务栏 / README：纸底深纹版
    for (const s of [16, 24, 32, 256]) {
      saveResized(paper, s, path.join(LOGO_DIR, `icon-${s}.png`));
    }
    // 托盘：墨底纸纹版
    for (const s of [16, 24, 32]) {
      saveResized(dark, s, path.join(LOGO_DIR, `tray-${s}.png`));
    }
    // 安装包 ICO：16/32/48/256 多尺寸
    const icoEntries = [16, 32, 48, 256].map((s) => ({
      size: s,
      png: paper.resize({ width: s, height: s, quality: 'best' }).toPNG(),
    }));
    const ico = buildIco(icoEntries);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
    console.log(`[logo] build/icon.ico (${ico.length}B, sizes: ${icoEntries.map((e) => e.size).join('/')})`);

    // 验收 4：确认 nativeImage 能从文件加载托盘图标且非空
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
