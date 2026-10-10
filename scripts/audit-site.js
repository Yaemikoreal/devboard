// 官网护栏（issue #69 阶段 2）：把验收标准里「一次性核对」的项变成「持续成立」的断言——
// 动效只走 transform/opacity/filter（无 layout 抖动面）、prefers-reduced-motion 降级块在、
// 非 Hero 图全量懒加载、webp 预算不偷跑。零依赖，pages.yml 在 deploy 前跑（打红即不上线）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');

async function main() {
  const styles = fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

  // --- 1. 动效演技边界（硬性条款）：动画只准动合成属性与颜色类 paint 属性，layout 属性一律打红 ---
  // transform/opacity/filter = 合成器线程；color/background(-color)/border-color/box-shadow/opacity
  // 类 paint 属性 = 只重绘不重排（「主题切换丝滑」验收项本身就要求颜色过渡，见 #69 验收）。
  // 真正要拦的是 layout 面：width/height/top/left/margin/padding 等一出现即打红。
  const ANIM_ALLOWED = [
    'transform', 'opacity', 'filter', 'none', 'inherit', 'initial', 'unset',
    'background-position', 'background', 'background-color', 'background-image',
    'color', 'border-color', 'border', 'box-shadow', 'fill', 'stroke', 'stroke-dashoffset',
  ];

  function checkAnimValue(value, where) {
    // 去掉缓动函数与可选 BFC，逐词检查：数字/时长/延迟/百分比直接放行
    const cleaned = value.replace(/cubic-bezier\([^)]*\)/g, '');
    const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
    for (const tk of tokens) {
      const t = tk.toLowerCase().replace(/;$/, '');
      if (!t) continue;
      if (ANIM_ALLOWED.includes(t)) continue;
      if (/^(ease|linear|steps|infinite|alternate|forwards|backwards|both|running|paused|normal|reverse)/.test(t)) continue;
      if (t === '!important') continue;
      if (/^-?\.?\d/.test(t)) continue; // 数字/时长（.35s、300ms、0.5、1.2s…）
      // 剩余的应是「被动画的属性」或 keyframes 名——不在白名单即打红
      assert.ok(ANIM_ALLOWED.includes(t),
        where + ' 动效属性越界：「' + tk + '」（layout 属性一律打红；颜色类 paint 属性已入白名单）');
    }
  }

  // 1a. animation / transition 声明
  const declRe = /(?:animation|transition)\s*:\s*([^;{}]+)[;}]/g;
  let m;
  while ((m = declRe.exec(styles))) {
    // 跳过 keyframes 选择器内的 animation-name 定义行（animation: name … 的 name 无法静态判属性）
    // ——真正的属性检查在 keyframes 块内做（见 1b）
    const value = m[1].trim();
    if (/^\s*(none|inherit|initial|unset)\s*;?$/i.test(value)) continue;
    // animation-name 若与 @keyframes 定义对得上，动画的属性由块内决定，这里只查 transition 的属性部分
    if (/^animation\b/i.test(m[0].trim())) continue;
    checkAnimValue(value, 'styles.css ' + m[0].trim().slice(0, 60));
  }

  // 1b. @keyframes 块内被动画的属性（平衡花括号扫描——单行/嵌套 from-to 都正确截块）
  const kfStart = /@keyframes\s+([\w-]+)\s*\{/g;
  while ((m = kfStart.exec(styles))) {
    let depth = 1;
    let i = kfStart.lastIndex;
    while (i < styles.length && depth > 0) {
      if (styles[i] === '{') depth += 1;
      else if (styles[i] === '}') depth -= 1;
      i += 1;
    }
    const body = styles.slice(kfStart.lastIndex, i - 1);
    const propRe = /([a-z-]+)\s*:/g;
    let pm;
    while ((pm = propRe.exec(body))) {
      const prop = pm[1].trim().toLowerCase();
      if (['from', 'to'].includes(prop)) continue;
      assert.ok(ANIM_ALLOWED.includes(prop),
        '@keyframes ' + m[1] + ' 动画了「' + prop + '」——layout 属性一律打红；颜色类 paint 属性已入白名单');
    }
  }

  // --- 2. prefers-reduced-motion 降级块存在（动效全停 + 玻璃退化实底，与应用 #82 同口径）---
  assert.ok(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(styles),
    'styles.css 缺 prefers-reduced-motion 降级块');
  const rmIdx = styles.indexOf('prefers-reduced-motion');
  const rmBlock = styles.slice(rmIdx, rmIdx + 4000);
  assert.ok(/animation[^;]*:\s*none|animation-play-state\s*:\s*paused/.test(rmBlock),
    'reduced-motion 块内应停掉动画');
  assert.ok(rmBlock.includes('backdrop-filter'), 'reduced-motion 块内玻璃应退化为实底（backdrop-filter 处理）');

  // --- 3. main.js 的动效同样只写 transform/opacity/filter/背景变量（rAF 写 CSS 变量的纪律）---
  // background 等颜色赋值属主题卡预览的静态着色（paint-only 非动画）；transitionDelay/
  // animationDelay 是进场错峰编排，都不是 layout 面
  const mainjs = fs.readFileSync(path.join(SITE, 'main.js'), 'utf8');
  const styleWrites = mainjs.match(/\.style\.[a-zA-Z]+\s*=/g) || [];
  for (const w of styleWrites) {
    const prop = w.replace('.style.', '').replace('=', '').trim();
    assert.ok(/^(transform|opacity|filter|background|transitionDelay|animationDelay)$/.test(prop) || prop.startsWith('--'),
      'main.js 直接写 style.' + prop + '——滚动/交互动效只准写 transform/opacity/filter 与 CSS 变量');
  }

  // --- 4. 非 Hero 图全量懒加载 + 显式宽高（防 CLS）---
  const imgRe = /<img\s+([^>]+)>/g;
  let im;
  let heroSeen = 0;
  while ((im = imgRe.exec(html))) {
    const tag = im[1];
    const src = (tag.match(/src="([^"]+)"/) || [])[1] || '';
    const isHero = /fetchpriority="high"/i.test(tag) || /overview-warm\.webp$/.test(src);
    if (isHero) {
      heroSeen += 1;
      assert.ok(/fetchpriority="high"/i.test(tag), 'Hero 图应带 fetchpriority=high: ' + src);
      continue;
    }
    assert.ok(/\bloading="lazy"/i.test(tag), '非 Hero 图应懒加载: ' + src);
    assert.ok(/\bwidth="/i.test(tag) && /\bheight="/i.test(tag), '懒加载图应带显式 width/height（防 CLS）: ' + src);
  }
  assert.strictEqual(heroSeen, 1, '应有且仅有一张 Hero 图（fetchpriority=high）');

  // --- 5. 引用的图片必须存在 + webp 预算（当前全套 ~632KB + 裕量）---
  const WEBP_BUDGET = 900 * 1024; // 632KB 现状 + 重拍裕量；超预算说明有人偷跑全尺寸图
  let webpTotal = 0;
  const refRe = /(?:src|href)="(assets\/[^"]+)"/g;
  const refs = new Set();
  while ((m = refRe.exec(html))) refs.add(m[1]);
  for (const rel of refs) {
    const file = path.join(SITE, rel);
    assert.ok(fs.existsSync(file), 'index.html 引用的资源缺失: ' + rel);
    if (rel.endsWith('.webp')) webpTotal += fs.statSync(file).size;
  }
  assert.ok(webpTotal <= WEBP_BUDGET, 'webp 总量 ' + Math.round(webpTotal / 1024) + 'KB 超预算 ' + Math.round(WEBP_BUDGET / 1024) + 'KB——请先过 optimize-site-shots.py 再入库');

  // --- 6. 部署面体积：site/ 整目录（pages 上传的是整个目录）不含未引用的大目录 ---
  // raw/ 源 PNG 是出图链路中间产物，不应混进部署面
  const rawDir = path.join(SITE, 'assets', 'raw');
  if (fs.existsSync(rawDir)) {
    const referenced = [...refs].some((rel) => rel.startsWith('assets/raw/'));
    assert.ok(!referenced, 'index.html 引用了 assets/raw/ 下的源图——部署面应只含优化后的 webp');
    const rawKB = fs.readdirSync(rawDir).reduce((s, f) => s + fs.statSync(path.join(rawDir, f)).size, 0) / 1024;
    console.log('提示：site/assets/raw/（' + Math.round(rawKB) + 'KB 源 PNG）未被页面引用，但会随 site/ 整目录部署。建议加入 .deployignore 或移出 site/。');
  }

  console.log('audit-site: 全部断言通过');
}

main().catch((err) => {
  console.error('audit-site 失败:', (err && err.message) || err);
  process.exit(1);
});
