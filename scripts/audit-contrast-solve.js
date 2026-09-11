// 对比度求解（issue #85）：把不达标的文字 token 朝主题墨色方向混合到 AA（≥4.55 留余量），输出新 hex
'use strict';
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const m = src.match(/var THEMES = (\{[\s\S]*?\n  \};)/);
const THEMES = eval('(' + m[1].replace(/;\s*$/, '') + ')');

function hexToRgb(h) { h = String(h).replace('#', ''); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(rgb) { return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mixRgb(a, b, t) { return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t); }
function parseRgba(s) { const p = String(s).match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; }
function over(fg, bg) { return fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a)); }
function lum(rgb) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); }
function ratio(fg, bg) { const l1 = lum(fg), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

// 每个主题需达标的 (ink × 表面) 组合
function surfaces(v) {
  const bgArt = hexToRgb(v['--bg-art']);
  const list = [over(parseRgba(v['--glass-card']), bgArt), hexToRgb(v['--well']), hexToRgb(v['--bg'])];
  for (const bk of ['--blob-2', '--blob-3', '--blob-4']) {
    const blob = parseRgba(v[bk]);
    if (blob) list.push(over(parseRgba(v['--glass-card']), over(blob, bgArt)));
  }
  return list;
}

const TARGET = 4.55;
for (const id of Object.keys(THEMES)) {
  const v = THEMES[id].vars;
  // --ink-3 朝 --ink 混合（保持色相），--tile-ink2 朝 --tile-ink 混合
  for (const [key, anchorKey, bgList] of [
    ['--ink-3', '--ink', surfaces(v)],
    ['--tile-ink2', '--tile-ink', [over(parseRgba(v['--glass-tile']), hexToRgb(v['--bg-art']))]],
  ]) {
    const fg = hexToRgb(v[key]);
    const anchor = hexToRgb(v[anchorKey]);
    const minR = Math.min(...bgList.map((bg) => ratio(fg, bg)));
    if (minR >= TARGET) { console.log(`${id} ${key}: 已达标 ${minR.toFixed(2)}`); continue; }
    let t = 0;
    while (t <= 1) {
      const cand = mixRgb(fg, anchor, t);
      if (Math.min(...bgList.map((bg) => ratio(cand, bg))) >= TARGET) break;
      t += 0.01;
    }
    const hex = rgbToHex(mixRgb(fg, anchor, t));
    const newR = Math.min(...bgList.map((bg) => ratio(mixRgb(fg, anchor, t), bg)));
    console.log(`${id} ${key}: ${v[key]} -> ${hex}  (t=${t.toFixed(2)}, ${minR.toFixed(2)} -> ${newR.toFixed(2)})`);
  }
}
