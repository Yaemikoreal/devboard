// 官网页面截图（issue #69 验证用）：离屏加载 site/index.html，支持整页/定位/切主题/移动宽度。
// 用法：npx electron scripts/shot-site-page.js
//   SHOT_OUT=path.png        输出路径（默认 site/shot-page.png）
//   SHOT_WIDTH=1440          视口宽（移动验证用 390）
//   SHOT_SCROLL=full|数字px  整页或滚动到指定位置（默认 0，只拍首屏）
//   SHOT_THEME=dark          加载后点击对应主题卡
//   SHOT_JS='...'            额外前置脚本
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const OUT = path.resolve(process.env.SHOT_OUT || path.join(__dirname, '..', 'site', 'shot-page.png'));
const WIDTH = Number(process.env.SHOT_WIDTH || 1440);
const SCROLL = process.env.SHOT_SCROLL || '0';
const THEME = process.env.SHOT_THEME || '';
const EXTRA_JS = process.env.SHOT_JS || '';

if (process.env.SHOT_REDUCED === '1') {
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
}

let win = null;
async function capture() {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(OUT, img.toPNG());
    const size = img.getSize();
    console.log(`[site-shot] 已保存: ${OUT} (${size.width}x${size.height})`);
  } catch (err) {
    console.error('[site-shot] 失败:', err.message);
  }
  app.exit(0);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: WIDTH,
    height: 900,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#f5f2e8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  win.loadFile(path.join(__dirname, '..', 'site', 'index.html'));

  win.webContents.on('console-message', (e) => {
    const msg = e.message || '';
    if (msg.startsWith('[site]')) console.log('[renderer]', msg);
  });

  win.webContents.on('did-finish-load', async () => {
    try {
      // 等 Hero 进场动画播完
      await new Promise((r) => setTimeout(r, 1600));
      if (THEME) {
        await win.webContents.executeJavaScript(
          `var c=document.querySelector('.theme-card[data-theme="${THEME}"]'); if(c) c.click(); void 0`
        );
        await new Promise((r) => setTimeout(r, 900));
      }
      if (EXTRA_JS) {
        await win.webContents.executeJavaScript(EXTRA_JS + '; void 0');
        await new Promise((r) => setTimeout(r, 900));
      }
      if (SCROLL === 'full') {
        const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
        win.setContentSize(WIDTH, Math.min(h, 12000));
        // 整页验收照：强制懒图立即解码、强制 reveal 到位（进场行为已在定位截图里单独验证；
        // 整页窗口下 IO 的 -6% 底部 rootMargin 会盖住页尾 355px，不强制会漏拍）
        await win.webContents.executeJavaScript(
          "document.querySelectorAll('img[loading=lazy]').forEach(function(i){i.loading='eager'});" +
          "document.querySelectorAll('.reveal:not(.in)').forEach(function(e){e.classList.add('in')}); void 0"
        );
        await new Promise((r) => setTimeout(r, 3200));
        await win.webContents.executeJavaScript('window.scrollTo(0,0); void 0');
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const y = Number(SCROLL);
        if (y > 0) {
          // instant 跳滚，避免平滑滚动途中 IO 触发的进场过渡落在截图时刻
          await win.webContents.executeJavaScript(`window.scrollTo({top:${y},behavior:'instant'}); void 0`);
          await new Promise((r) => setTimeout(r, 1600));
        }
      }
    } catch (err) {
      console.error('[site-shot] 前置脚本失败:', err.message);
    }
    capture();
  });

  setTimeout(capture, 30000); // 兜底
});

app.on('window-all-closed', () => app.exit(0));
