// 主题 token 单一事实源（issue #122）：七套整体主题（全量 token）的权威定义。
// 原先同一套色值在三处手工对齐（app.js THEMES / boot-theme.js BOOT_COLORS / styles.css :root），
// 现在全部从本模块派生，新增或调整主题只改这里：
//   - 渲染层 app.js 经 preload（window.devboardThemes）消费 THEMES 全量 token；
//   - 主进程 boot-theme.js 的冷启动首帧四色（issue #101）= BOOT_COLORS，由全量 token 派生；
//   - styles.css 的 :root 暖阳默认值由 scripts/sync-theme-root.js 从本模块生成（npm run theme:sync）。
// 纯 Node，不依赖 Electron（与 constants.js 同一纪律，issue-11 / #127）。
'use strict';

/* ---------- 颜色工具：渲染层 applyTheme 与 :root 生成器（sync-theme-root.js）共用，保证派生阶梯两处一致 ---------- */
function hexToRgb(h) {
  h = String(h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var n = parseInt(h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function rgbToHex(rgb) {
  return '#' + rgb.map(function (v) {
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  }).join('');
}
function mixHex(a, b, t) {
  var ca = hexToRgb(a), cb = hexToRgb(b);
  if (!ca || !cb) return a;
  return rgbToHex([0, 1, 2].map(function (i) { return ca[i] + (cb[i] - ca[i]) * t; }));
}
function rgbaOf(hex, alpha) {
  var c = hexToRgb(hex);
  return c ? 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')' : hex;
}

/* ---------- 整体主题（issue #27）：一套完整 token（背景/卡片/文字/深色块/分带/阴影），强调色在其上派生 ---------- */
var THEMES = {
  warm: {
    label: '暖阳', accentDefault: '#f5d90a',
    vars: {
      '--bg': '#f5f2e8', '--card': '#fdfcf8', '--well': '#ece9dd',
      '--ink': '#181818', '--ink-2': '#4d463c', '--ink-3': '#6e685a', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(24,24,24,.09)', '--tile': '#322e27', '--tile-ink': '#fdfcf8', '--tile-ink2': '#b0a798', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(24,24,24,.04),0 14px 34px rgba(24,24,24,.05)',
      '--shadow-2': '0 2px 6px rgba(24,24,24,.06),0 22px 48px rgba(24,24,24,.09)',
      '--btn-line': 'rgba(24,24,24,.16)', '--btn-fail-bg': '#e8b4b0',
      '--band-active': '#d98e32', '--band-cool': '#7d94a8', '--band-stale': '#b3ac9a', '--band-arch': '#d8d3c2',
      /* 警示语义色（issue #77）：卡片底深橙 / 深色关注卡上亮琥珀 / pill 底色与文字 */
      '--warn': '#c4650a', '--warn-tile': '#f0ab4b', '--warn-pill': '#a85407', '--on-warn': '#fff8f0',
      /* 透玻璃背景板：奶油底 + 柔光配色（--blob-1 由 applyTheme 跟随强调色派生） */
      '--bg-art': '#f2eee2',
      '--blob-2': 'rgba(158,196,167,.55)', '--blob-3': 'rgba(223,205,189,.85)', '--blob-4': 'rgba(179,199,216,.4)',
      '--glass-card': 'rgba(253,252,248,.6)', '--glass-line': 'rgba(255,255,255,.62)',
      '--glass-shadow': '0 1px 2px rgba(24,24,24,.05),0 22px 52px rgba(24,24,24,.09),inset 0 1px 0 rgba(255,255,255,.7)',
      '--glass-tile': 'rgba(45,41,34,.9)', '--glass-tile-line': 'rgba(255,255,255,.13)',
      '--glass-tile-shadow': '0 24px 56px rgba(24,24,24,.3),inset 0 1px 0 rgba(255,255,255,.1)',
      '--glass-well': 'rgba(253,252,248,.5)',
      '--cell-empty': 'rgba(24,24,24,.06)', '--fade-rgb': '242,238,226',
    },
  },
  mist: {
    label: '雾蓝', accentDefault: '#3b82f6',
    vars: {
      '--bg': '#edf0f4', '--card': '#fbfcfd', '--well': '#e2e7ed',
      '--ink': '#181c22', '--ink-2': '#47505b', '--ink-3': '#606771', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(24,28,34,.09)', '--tile': '#2b313a', '--tile-ink': '#fbfcfd', '--tile-ink2': '#aab1bb', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(24,28,34,.04),0 14px 34px rgba(24,28,34,.05)',
      '--shadow-2': '0 2px 6px rgba(24,28,34,.06),0 22px 48px rgba(24,28,34,.09)',
      '--btn-line': 'rgba(24,28,34,.16)', '--btn-fail-bg': '#e8b4b0',
      '--band-active': '#d98e32', '--band-cool': '#7d94a8', '--band-stale': '#a8b0b8', '--band-arch': '#d3d8de',
      '--warn': '#c4650a', '--warn-tile': '#f0ab4b', '--warn-pill': '#a85407', '--on-warn': '#fff8f0',
      /* 透玻璃背景板：冷灰蓝底，青/桃光团收敛、冷蓝加重 */
      '--bg-art': '#e9edf3',
      '--blob-2': 'rgba(158,196,167,.45)', '--blob-3': 'rgba(219,208,196,.7)', '--blob-4': 'rgba(179,199,216,.55)',
      '--glass-card': 'rgba(251,252,253,.62)', '--glass-line': 'rgba(255,255,255,.66)',
      '--glass-shadow': '0 1px 2px rgba(24,28,34,.05),0 22px 52px rgba(24,28,34,.09),inset 0 1px 0 rgba(255,255,255,.72)',
      '--glass-tile': 'rgba(43,49,58,.9)', '--glass-tile-line': 'rgba(255,255,255,.13)',
      '--glass-tile-shadow': '0 24px 56px rgba(24,28,34,.3),inset 0 1px 0 rgba(255,255,255,.1)',
      '--glass-well': 'rgba(251,252,253,.5)',
      '--cell-empty': 'rgba(24,28,34,.06)', '--fade-rgb': '233,237,243',
    },
  },
  meadow: {
    label: '青野', accentDefault: '#10b981',
    vars: {
      '--bg': '#eef3ec', '--card': '#fcfdfb', '--well': '#e1e9df',
      '--ink': '#17201a', '--ink-2': '#45544a', '--ink-3': '#5e6a61', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(23,32,26,.09)', '--tile': '#28332b', '--tile-ink': '#fcfdfb', '--tile-ink2': '#a6b4a8', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(23,32,26,.04),0 14px 34px rgba(23,32,26,.05)',
      '--shadow-2': '0 2px 6px rgba(23,32,26,.06),0 22px 48px rgba(23,32,26,.09)',
      '--btn-line': 'rgba(23,32,26,.16)', '--btn-fail-bg': '#e8b4b0',
      '--band-active': '#d98e32', '--band-cool': '#7d94a8', '--band-stale': '#a9b1a4', '--band-arch': '#d5dcd0',
      '--warn': '#c4650a', '--warn-tile': '#f0ab4b', '--warn-pill': '#a85407', '--on-warn': '#fff8f0',
      /* 透玻璃背景板：青绿底，青光团加重、冷蓝收敛 */
      '--bg-art': '#e9efe5',
      '--blob-2': 'rgba(158,196,167,.6)', '--blob-3': 'rgba(223,205,189,.7)', '--blob-4': 'rgba(179,199,216,.35)',
      '--glass-card': 'rgba(252,253,251,.6)', '--glass-line': 'rgba(255,255,255,.62)',
      '--glass-shadow': '0 1px 2px rgba(23,32,26,.05),0 22px 52px rgba(23,32,26,.09),inset 0 1px 0 rgba(255,255,255,.7)',
      '--glass-tile': 'rgba(40,51,43,.9)', '--glass-tile-line': 'rgba(255,255,255,.13)',
      '--glass-tile-shadow': '0 24px 56px rgba(23,32,26,.3),inset 0 1px 0 rgba(255,255,255,.1)',
      '--glass-well': 'rgba(252,253,251,.5)',
      '--cell-empty': 'rgba(23,32,26,.06)', '--fade-rgb': '233,239,229',
    },
  },
  sakura: {
    label: '樱粉', accentDefault: '#ec4899',
    vars: {
      '--bg': '#f6eff0', '--card': '#fdfbf9', '--well': '#eee2e3',
      '--ink': '#211a1c', '--ink-2': '#53474b', '--ink-3': '#706266', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(33,26,28,.09)', '--tile': '#382d31', '--tile-ink': '#fdfbf9', '--tile-ink2': '#baacaf', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(33,26,28,.04),0 14px 34px rgba(33,26,28,.05)',
      '--shadow-2': '0 2px 6px rgba(33,26,28,.06),0 22px 48px rgba(33,26,28,.09)',
      '--btn-line': 'rgba(33,26,28,.16)', '--btn-fail-bg': '#e8b4b0',
      '--band-active': '#d98e32', '--band-cool': '#7d94a8', '--band-stale': '#b3a9a4', '--band-arch': '#ddd2d0',
      '--warn': '#c4650a', '--warn-tile': '#f0ab4b', '--warn-pill': '#a85407', '--on-warn': '#fff8f0',
      /* 透玻璃背景板：玫瑰灰底，桃光团转粉、青光收敛 */
      '--bg-art': '#f3e9ea',
      '--blob-2': 'rgba(158,196,167,.4)', '--blob-3': 'rgba(238,203,200,.8)', '--blob-4': 'rgba(179,199,216,.4)',
      '--glass-card': 'rgba(253,251,249,.6)', '--glass-line': 'rgba(255,255,255,.62)',
      '--glass-shadow': '0 1px 2px rgba(33,26,28,.05),0 22px 52px rgba(33,26,28,.09),inset 0 1px 0 rgba(255,255,255,.7)',
      '--glass-tile': 'rgba(56,45,49,.9)', '--glass-tile-line': 'rgba(255,255,255,.13)',
      '--glass-tile-shadow': '0 24px 56px rgba(33,26,28,.3),inset 0 1px 0 rgba(255,255,255,.1)',
      '--glass-well': 'rgba(253,251,249,.5)',
      '--cell-empty': 'rgba(33,26,28,.06)', '--fade-rgb': '243,233,234',
    },
  },
  iris: {
    label: '紫藤', accentDefault: '#8b5cf6',
    vars: {
      '--bg': '#f1f0f6', '--card': '#fbfbfd', '--well': '#e4e3ee',
      '--ink': '#1e1b26', '--ink-2': '#4a4656', '--ink-3': '#676374', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(30,27,38,.09)', '--tile': '#302c3d', '--tile-ink': '#fbfbfd', '--tile-ink2': '#b0abbb', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(30,27,38,.04),0 14px 34px rgba(30,27,38,.05)',
      '--shadow-2': '0 2px 6px rgba(30,27,38,.06),0 22px 48px rgba(30,27,38,.09)',
      '--btn-line': 'rgba(30,27,38,.16)', '--btn-fail-bg': '#e8b4b0',
      '--band-active': '#d98e32', '--band-cool': '#7d94a8', '--band-stale': '#aca7b5', '--band-arch': '#d8d6e0',
      '--warn': '#c4650a', '--warn-tile': '#f0ab4b', '--warn-pill': '#a85407', '--on-warn': '#fff8f0',
      /* 透玻璃背景板：薰衣草灰底，顶部光团转紫 */
      '--bg-art': '#eceaf2',
      '--blob-2': 'rgba(158,196,167,.4)', '--blob-3': 'rgba(223,205,189,.6)', '--blob-4': 'rgba(190,183,220,.5)',
      '--glass-card': 'rgba(251,251,253,.6)', '--glass-line': 'rgba(255,255,255,.64)',
      '--glass-shadow': '0 1px 2px rgba(30,27,38,.05),0 22px 52px rgba(30,27,38,.09),inset 0 1px 0 rgba(255,255,255,.72)',
      '--glass-tile': 'rgba(48,44,61,.9)', '--glass-tile-line': 'rgba(255,255,255,.13)',
      '--glass-tile-shadow': '0 24px 56px rgba(30,27,38,.3),inset 0 1px 0 rgba(255,255,255,.1)',
      '--glass-well': 'rgba(251,251,253,.5)',
      '--cell-empty': 'rgba(30,27,38,.06)', '--fade-rgb': '236,234,242',
    },
  },
  dark: {
    label: '暗夜', accentDefault: '#f5d90a', dimBlob: true,
    vars: {
      '--bg': '#1b1915', '--card': '#26231d', '--well': '#353126',
      '--ink': '#f0ece1', '--ink-2': '#c8c2b2', '--ink-3': '#9e998a', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(240,236,225,.10)', '--tile': '#ece7d8', '--tile-ink': '#1b1915', '--tile-ink2': '#5b574b', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(0,0,0,.30),0 14px 34px rgba(0,0,0,.35)',
      '--shadow-2': '0 2px 6px rgba(0,0,0,.35),0 22px 48px rgba(0,0,0,.45)',
      '--btn-line': 'rgba(240,236,225,.18)', '--btn-fail-bg': '#7a3d3a',
      '--band-active': '#d98e32', '--band-cool': '#6b8296', '--band-stale': '#6f695b', '--band-arch': '#4a463e',
      /* 警示语义色（issue #77）：深底卡片上亮琥珀；关注卡反浅，卡上图形用回深橙 */
      '--warn': '#f0a53c', '--warn-tile': '#b25a08', '--warn-pill': '#f0a53c', '--on-warn': '#23180a',
      /* 透玻璃背景板：深棕黑底 + 低明度光团；卡片用深色玻璃，关注卡（浅色 tile）用浅色玻璃 */
      '--bg-art': '#16140f',
      '--blob-2': 'rgba(158,196,167,.18)', '--blob-3': 'rgba(223,205,189,.12)', '--blob-4': 'rgba(179,199,216,.15)', /* 深色专项标定（issue #81）：光团降不透明度，避免深底糊亮 */
      '--glass-card': 'rgba(38,35,29,.55)', '--glass-line': 'rgba(255,255,255,.09)',
      '--glass-shadow': '0 1px 2px rgba(0,0,0,.3),0 22px 52px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06)',
      '--glass-tile': 'rgba(236,231,216,.88)', '--glass-tile-line': 'rgba(24,24,24,.12)',
      '--glass-tile-shadow': '0 24px 56px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.35)',
      '--glass-well': 'rgba(38,35,29,.5)',
      '--cell-empty': 'rgba(240,236,225,.08)', '--fade-rgb': '22,20,15',
      '--tile-line': 'rgba(24,24,24,.1)',
      '--on-accent': '#1b1915',
    },
  },
  abyss: {
    label: '夜幕', accentDefault: '#60a5fa', dimBlob: true,
    vars: {
      '--bg': '#151a21', '--card': '#1e242e', '--well': '#2c333f',
      '--ink': '#e9edf3', '--ink-2': '#c2c9d4', '--ink-3': '#949ca7', /* ink-3 AA 标定（issue #85） */
      '--line': 'rgba(233,237,243,.10)', '--tile': '#e4e9f0', '--tile-ink': '#151a21', '--tile-ink2': '#515963', /* tile-ink2 AA 标定（issue #85） */
      '--shadow-1': '0 1px 2px rgba(0,0,0,.30),0 14px 34px rgba(0,0,0,.35)',
      '--shadow-2': '0 2px 6px rgba(0,0,0,.35),0 22px 48px rgba(0,0,0,.45)',
      '--btn-line': 'rgba(233,237,243,.18)', '--btn-fail-bg': '#7a3d3a',
      '--band-active': '#d98e32', '--band-cool': '#6b8296', '--band-stale': '#5b6470', '--band-arch': '#414a56',
      '--warn': '#f2ab4a', '--warn-tile': '#b25a08', '--warn-pill': '#f2ab4a', '--on-warn': '#231a0b',
      /* 透玻璃背景板：藏青黑底 + 低明度光团，冷蓝加重；关注卡（浅色 tile）用浅色玻璃 */
      '--bg-art': '#10141a',
      '--blob-2': 'rgba(158,196,167,.14)', '--blob-3': 'rgba(223,205,189,.09)', '--blob-4': 'rgba(120,160,220,.17)', /* 深色专项标定（issue #81）：光团降不透明度，避免深底糊亮 */
      '--glass-card': 'rgba(30,36,46,.55)', '--glass-line': 'rgba(255,255,255,.09)',
      '--glass-shadow': '0 1px 2px rgba(0,0,0,.3),0 22px 52px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06)',
      '--glass-tile': 'rgba(228,233,240,.88)', '--glass-tile-line': 'rgba(24,24,24,.12)',
      '--glass-tile-shadow': '0 24px 56px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.35)',
      '--glass-well': 'rgba(30,36,46,.5)',
      '--cell-empty': 'rgba(233,237,243,.08)', '--fade-rgb': '16,20,26',
      '--tile-line': 'rgba(24,24,24,.1)',
      '--on-accent': '#151a21',
    },
  },
};

// 主题 id 顺序（设置页主题卡、demo GIF 轮播共用）：对象字面量插入序即展示序
var THEME_IDS = Object.keys(THEMES);

// 冷启动首帧关键色（issue #101）：从全量 token 派生 bg/card/ink/bgArt 四色子集，
// 主进程建窗定底色 + preload 同步桥共用；与 THEMES 同源，不再手工对齐
var BOOT_COLORS = {};
THEME_IDS.forEach(function (id) {
  var v = THEMES[id].vars;
  BOOT_COLORS[id] = { bg: v['--bg'], card: v['--card'], ink: v['--ink'], bgArt: v['--bg-art'] };
});

module.exports = { THEMES, THEME_IDS, BOOT_COLORS, hexToRgb, rgbToHex, mixHex, rgbaOf };
