// WCAG 对比度审计（issue #85）：七套主题的文字 token × 玻璃卡合成底色
// 用法：node scripts/audit-contrast.js
'use strict';
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const m = src.match(/var THEMES = (\{[\s\S]*?\n  \};)/);
if (!m) { console.error('THEMES 字面量未匹配到'); process.exit(1); }
const THEMES = eval('(' + m[1].replace(/;\s*$/, '') + ')');

function hexToRgb(h) {
  h = String(h).replace('#', '');
  const n = parseInt(h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function parseRgba(s) {
  const m2 = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m2) return null;
  const p = m2[1].split(',').map(Number);
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
}
// 前景 rgba 叠在底色 rgb 上
function over(fg, bg) {
  return fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
}
function lum(rgb) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function ratio(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const rows = [];
for (const id of Object.keys(THEMES)) {
  const v = THEMES[id].vars;
  const bgArt = hexToRgb(v['--bg-art']);
  // 卡片表面最恶劣合成：玻璃卡叠在最亮光团（叠过 bg-art）上；另算直接叠 bg-art
  let worstBg = over(parseRgba(v['--glass-card']), bgArt);
  for (const bk of ['--blob-2', '--blob-3', '--blob-4']) {
    const blob = parseRgba(v[bk]);
    if (!blob) continue;
    const spot = over(blob, bgArt);
    const comp = over(parseRgba(v['--glass-card']), spot);
    // 浅色主题：更亮的底对白卡文字更恶劣；深色主题反之——直接两态都记，取每文字色较差者
    rows.push({ id, surf: 'card@' + bk.replace('--blob-', 'b'), bg: comp });
  }
  rows.push({ id, surf: 'card@bg-art', bg: worstBg });
  // 实底表面
  rows.push({ id, surf: 'well', bg: hexToRgb(v['--well']) });
  rows.push({ id, surf: 'bg', bg: hexToRgb(v['--bg']) });
  // 关注卡（tile）
  const tileBg = over(parseRgba(v['--glass-tile']), bgArt);
  rows.push({ id, surf: 'tile', bg: tileBg });
}

const inks = ['--ink', '--ink-2', '--ink-3'];
const tileInks = ['--tile-ink', '--tile-ink2'];
const out = [];
for (const id of Object.keys(THEMES)) {
  const v = THEMES[id].vars;
  for (const surf of rows.filter((r) => r.id === id)) {
    const isTile = surf.surf === 'tile';
    for (const ik of isTile ? tileInks : inks) {
      const fg = hexToRgb(v[ik]);
      if (!fg) continue;
      const r = ratio(fg, surf.bg);
      out.push({ theme: id, surf: surf.surf, ink: ik, ratio: r });
    }
  }
  // 警示 pill：--on-warn 文字 on --warn-pill 底（实色）
  out.push({ theme: id, surf: 'warn-pill', ink: '--on-warn', ratio: ratio(hexToRgb(v['--on-warn']), hexToRgb(v['--warn-pill'])) });
}

// 汇总：每 主题×ink 取最差值，标记 < 4.5（正文 AA）
const worst = {};
for (const o of out) {
  const k = o.theme + '|' + o.ink;
  if (!worst[k] || o.ratio < worst[k].ratio) worst[k] = o;
}
console.log('主题     文字 token    最差对比度  最差表面     判定');
let fails = 0;
for (const k of Object.keys(worst)) {
  const o = worst[k];
  const ok = o.ratio >= 4.5;
  if (!ok) fails++;
  console.log(
    (o.theme + '      ').slice(0, 9) +
    (o.ink + '           ').slice(0, 13) +
    o.ratio.toFixed(2).padStart(7) + '  ' +
    (o.surf + '          ').slice(0, 12) +
    (ok ? 'AA ✓' : 'AA ✗')
  );
}
console.log(fails ? `\n${fails} 项不达标` : '\n全部达标');
