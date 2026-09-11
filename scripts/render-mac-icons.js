// macOS 图标生成（issue #87）：托盘单色 Template Image（trayTemplate.png / @2x）+ 应用 icon.icns。
// 复用 render-logo.js 的 offscreen 渲染管线：draft-a.svg 1024 母版 → nativeImage.resize 各尺寸。
// Template 变体由定稿 SVG 派生：去纸底、九格全黑——macOS 菜单栏要求单色剪影，明暗由系统按主题适配。
// 用法：npm run logo:mac
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const LOGO_DIR = path.join(ROOT, 'assets', 'logo');
const BUILD_DIR = path.join(ROOT, 'build');
const SRC = fs.readFileSync(path.join(LOGO_DIR, 'draft-a.svg'), 'utf8');

// Template 剪影：与 draft-a 同构的 3x3 圆角格点阵，但去纸底、九格全黑——macOS 菜单栏要求单色剪影，
// 明暗由系统按主题适配。格间距从源图的 40/1024 放宽到 90/1024：母版直缩时 16pt 下间距仅 0.6px 会糊成实心块，
// 放宽后 16pt 约 1.4px、32pt 约 2.8px，网格意象仍可辨
const T = (x, y) => `<rect x="${x}" y="${y}" width="210" height="210" rx="46" fill="#000"/>`;
const SRC_TEMPLATE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
  T(107, 107), T(407, 107), T(707, 107),
  T(107, 407), T(407, 407), T(707, 407),
  T(107, 707), T(407, 707), T(707, 707),
  '</svg>',
].join('');

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

// icns 容器：'icns' + 总长（大端）+ 类型块（4cc + uint32 块长 + PNG payload），现代类型块允许 PNG 载荷
function buildIcns(entries) {
  const bufs = [];
  let total = 8;
  for (const { type, png } of entries) {
    const chunk = Buffer.alloc(8);
    chunk.write(type, 0, 'ascii');
    chunk.writeUInt32BE(png.length + 8, 4);
    bufs.push(chunk, png);
    total += png.length + 8;
  }
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...bufs]);
}

app.whenReady().then(async () => {
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
    const tpl = await renderMaster(win, SRC_TEMPLATE);

    // 应用图标：icns 覆盖 16-1024 全档（ic10 = 512@2x，Big Sur+ 菜单栏外全部场景够用）
    const icnsEntries = [
      ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ].map(([type, size]) => ({ type, png: paper.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
    const icns = buildIcns(icnsEntries);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.icns'), icns);
    console.log(`[logo:mac] build/icon.icns (${icns.length}B)`);

    // 托盘模板图：16pt（菜单栏标准尺寸）+ @2x；文件名以 Template 结尾，Electron 自动按模板图处理
    for (const [file, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
      const png = tpl.resize({ width: size, height: size, quality: 'best' }).toPNG();
      fs.writeFileSync(path.join(LOGO_DIR, file), png);
      console.log(`[logo:mac] assets/logo/${file} (${png.length}B)`);
    }

    const img = nativeImage.createFromPath(path.join(LOGO_DIR, 'trayTemplate.png'));
    console.log(`[logo:mac] trayTemplate isEmpty=${img.isEmpty()} isTemplate=${img.isTemplateImage()}`);
    if (img.isEmpty()) {
      console.error('[logo:mac] 模板图加载为空，渲染产物有问题');
      app.exit(1);
      return;
    }
    app.exit(0);
  } catch (err) {
    console.error('[logo:mac] 渲染失败:', err);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.exit(0));
