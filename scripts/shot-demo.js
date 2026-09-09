// 通用 demo 截图：渲染任意静态 html 并 capturePage，用于 demos/ 下设计稿的视觉验证。
// 用法：electron scripts/shot-demo.js <html文件> [输出png] [宽] [高]
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const file = process.argv[2];
if (!file) {
  console.error('用法: electron scripts/shot-demo.js <html文件> [输出png] [宽] [高]');
  app.exit(1);
}
const out = process.argv[3] || file.replace(/\.html$/, '.png');
const W = parseInt(process.argv[4] || '1440', 10);
const H = parseInt(process.argv[5] || '900', 10);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    skipTaskbar: true,
    useContentSize: true,
    enableLargerThanScreen: true, // 离屏渲染允许窗口超过屏幕尺寸，拍全高页面
    webPreferences: { offscreen: true },
  });
  win.loadFile(path.resolve(file));
  win.webContents.once('did-finish-load', () => {
    // SHOT_ZOOM：缩小页面以在受限窗口高度内看到完整内容（如 0.78）
    const zoom = parseFloat(process.env.SHOT_ZOOM || '1');
    if (zoom !== 1) win.webContents.setZoomFactor(zoom);
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
        console.log('[shot-demo] 截图已保存:', out);
      } catch (err) {
        console.error('[shot-demo] 截图失败:', err.message);
      }
      app.exit(0);
    }, 1200);
  });
  setTimeout(() => app.exit(1), 20000); // 兜底
});

app.on('window-all-closed', () => app.exit(0));
