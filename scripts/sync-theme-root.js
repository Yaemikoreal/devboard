// :root 暖阳默认值生成（issue #122 单一 token 源）：CSS 无法 require JS，
// 本脚本从 src/shared/themes.js 取暖阳主题 token，重新生成 styles.css 顶部的 :root 生成块
// （BEGIN/END 标记之间，首跑会替换既有手写 :root 块）。
// 用法：npm run theme:sync —— 改主题色值后跑；幂等，重复运行输出一致。
'use strict';
const fs = require('fs');
const path = require('path');
const { THEMES, mixHex, hexToRgb } = require('../src/shared/themes');

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const BEGIN = '/* >>> theme-root：本 :root 块由 scripts/sync-theme-root.js 从 src/shared/themes.js 生成（issue #122），勿手改；改主题后跑 npm run theme:sync >>> */';
const END = '/* <<< theme-root 生成块结束 <<< */';

const warm = THEMES.warm;
const accent = warm.accentDefault;
const v = (k) => warm.vars[k];

// CSS 书写习惯：alpha 省略前导 0（.55 而非 0.55）；与运行时的 rgbaOf 仅格式差异、值相同
function cssRgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + String(alpha).replace(/^0\./, '.') + ')';
}
// 玻璃板一组的行内注释对齐到第 35 列（超出则留 1 空格）
function aligned(decl, comment) {
  return '  ' + decl + ' '.repeat(Math.max(1, 35 - 2 - decl.length)) + comment;
}

function buildRootBlock() {
  const lines = [
    ':root{',
    '  --bg:' + v('--bg') + ';',
    '  --card:' + v('--card') + ';',
    '  --well:' + v('--well') + ';',
    '  --ink:' + v('--ink') + ';',
    '  --ink-2:' + v('--ink-2') + ';',
    '  --ink-3:' + v('--ink-3') + '; /* AA 标定（issue #85）：原 #857d6b 对比度 3.36 不达标 */',
    '  --line:' + v('--line') + ';',
    '  --accent:' + accent + ';',
    '  /* 强调色派生阶梯：热力图 l1/l3、文本高亮、光晕、聚焦环（issue #27，由 JS 按 accent 动态生成） */',
    '  --accent-soft:#f8ea7c;',
    '  --accent-deep:' + mixHex(accent, '#000000', 0.12) + ';',
    '  --accent-hl:' + cssRgba(accent, 0.55) + ';',
    '  --accent-glow:' + cssRgba(accent, 0.45) + ';',
    '  --accent-ring:' + cssRgba(accent, 0.25) + ';',
    '  /* 强调色底上的文字色：浅色主题 = 深字；深色主题（tile 反浅）在 THEMES 覆写为深色（issue #68） */',
    '  --on-accent:var(--ink);',
    '  --tile:' + v('--tile') + ';',
    '  --tile-ink:' + v('--tile-ink') + ';',
    '  --tile-ink2:' + v('--tile-ink2') + '; /* AA 标定（issue #85）：原 #a89f8e 对比度 4.14 不达标 */',
    '  --close-red:#e81123;',
    '  --shadow-1:' + v('--shadow-1') + ';',
    '  --shadow-2:' + v('--shadow-2') + ';',
    '  --r-card:24px;',
    '  --r-chip:10px;',
    '  --r-pill:999px;',
    '',
    '  /* 字号阶梯（issue #84）：收敛为 展示26/英雄20/标题15/正文13/辅助11.5/印记10.5 六级，',
    '     相邻级差一眼可辨；图标字形（caret/图钉/关闭等）不参与阶梯 */',
    '  --fs-display:26px;',
    '  --fs-hero:20px;',
    '  --fs-title:15px;',
    '  --fs-body:13px;',
    '  --fs-aux:11.5px;',
    '  --fs-cap:10.5px;',
    '',
    '  /* 密度 token（issue #84）：此处为标准档；紧凑档由文末 body[data-density=compact] 整套覆写 */',
    '  --pad-card:20px 22px;',
    '  --pad-row:15px 20px 15px 24px;',
    '  --row-band-inset:9px;',
    '  --row-lh:1.5;',
    '  --gap-card:16px;',
    '  --stats-gap:48px;',
    '  --stats-pad:4px 0 14px;',
    '  --sec-mt:16px;',
    '  --heat-gap:4px;',
    '  --chip-pad:4px 13px;',
    '',
    '  /* 按钮族 token：详情面板操作、设置页共用（issue #2） */',
    '  --btn-line:' + v('--btn-line') + ';',
    '  --btn-ink:var(--ink-2);',
    '  --btn-hover-line:var(--ink-3);',
    '  --btn-hover-ink:var(--ink);',
    '  --btn-fail-bg:' + v('--btn-fail-bg') + ';',
    '',
    '  /* 警示语义色（issue #77）：独立于 accent，琥珀/橙系；accent 回归品牌与图钉。',
    '     --warn = 卡片底上的点/图形；--warn-tile = 深色关注卡（深色主题为浅色卡）上的点/图形；',
    '     --warn-pill/--on-warn = 警示 pill 底色/文字；--warn-ring 由 JS 按 --warn 派生 */',
    '  --warn:' + v('--warn') + ';',
    '  --warn-tile:' + v('--warn-tile') + ';',
    '  --warn-pill:' + v('--warn-pill') + ';',
    '  --on-warn:' + v('--on-warn') + ';',
    '  --warn-ring:' + cssRgba(v('--warn'), 0.25) + ';',
    '',
    '  /* 分带识别色：行左缘色条，同一明度纪律（issue #16） */',
    '  --band-hot:var(--accent);',
    '  --band-active:' + v('--band-active') + ';',
    '  --band-cool:' + v('--band-cool') + ';',
    '  --band-stale:' + v('--band-stale') + ';',
    '  --band-arch:' + v('--band-arch') + ';',
    '',
    '  /* 透玻璃背景板 token（参考案例的透玻璃设计；此处为暖阳默认值，其余主题在 THEMES（src/shared/themes.js）覆写） */',
    aligned('--bg-art:' + v('--bg-art') + ';', '/* 奶油底色：比 --bg 略深，衬出柔光 */'),
    aligned('--blob-1:' + cssRgba(accent, 0.55) + ';', '/* 右上光团：由 JS 跟随强调色派生 */'),
    aligned('--blob-2:' + v('--blob-2') + ';', '/* 左中 青 */'),
    aligned('--blob-3:' + v('--blob-3') + ';', '/* 左下 桃 */'),
    aligned('--blob-4:' + v('--blob-4') + ';', '/* 顶部 冷蓝 */'),
    '  --glass-card:' + v('--glass-card') + ';',
    '  --glass-line:' + v('--glass-line') + ';',
    '  --glass-shadow:' + v('--glass-shadow') + ';',
    aligned('--glass-tile:' + v('--glass-tile') + ';', '/* 深色关注卡：保留实色纪律，仅轻微透光 */'),
    '  --glass-tile-line:' + v('--glass-tile-line') + ';',
    '  --glass-tile-shadow:' + v('--glass-tile-shadow') + ';',
    '  --glass-well:' + v('--glass-well') + ';',
    aligned('--cell-empty:' + v('--cell-empty') + ';', '/* 热力图空格透出背景柔光 */'),
    aligned('--fade-rgb:' + v('--fade-rgb') + ';', '/* 顶栏过渡带的基底（与 --bg-art 同色） */'),
    aligned('--tile-line:rgba(253,252,248,.12);', '/* 深色关注卡内的分隔线（浅色 tile 主题在 THEMES 覆写） */'),
    '}',
  ];
  return lines.join('\n');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const src = fs.readFileSync(CSS_PATH, 'utf8');
  const block = BEGIN + '\n' + buildRootBlock() + '\n' + END;
  let out;
  if (src.includes(BEGIN)) {
    out = src.replace(new RegExp(escapeRegExp(BEGIN) + '[\\s\\S]*?' + escapeRegExp(END)), block);
  } else {
    // 首次迁移：整段替换既有手写 :root 块（:root 内无嵌套花括号，非贪婪到首个行尾 } 为止）
    out = src.replace(/:root\{[\s\S]*?\n\}/, block);
    if (out === src) { console.error('未找到 :root 块，未做改动'); process.exit(1); }
  }
  if (out === src) {
    console.log('styles.css :root 已是最新（与 src/shared/themes.js 一致），无改动');
    return;
  }
  fs.writeFileSync(CSS_PATH, out);
  console.log('styles.css :root 暖阳默认值已从 src/shared/themes.js 重新生成');
}

main();
