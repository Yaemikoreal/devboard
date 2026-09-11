/* SignalBoard 官网交互（issue #69）
   主题引擎与应用 applyTheme 同算法：七套整体主题切换 + 强调色派生阶梯；
   滚动进场用 IntersectionObserver，尊重 prefers-reduced-motion。 */
(function () {
  'use strict';

  /* ---------- 主题数据：与 src/renderer/app.js THEMES 对应（站点只取展示所需字段） ---------- */
  var THEMES = {
    warm:   { label: '暖阳', accentDefault: '#f5d90a', bg: '#f5f2e8', card: '#fdfcf8', dark: false },
    mist:   { label: '雾蓝', accentDefault: '#3b82f6', bg: '#edf0f4', card: '#fbfcfd', dark: false },
    meadow: { label: '青野', accentDefault: '#10b981', bg: '#eef3ec', card: '#fcfdfb', dark: false },
    sakura: { label: '樱粉', accentDefault: '#ec4899', bg: '#f6eff0', card: '#fdfbf9', dark: false },
    iris:   { label: '紫藤', accentDefault: '#8b5cf6', bg: '#f1f0f6', card: '#fbfbfd', dark: false },
    dark:   { label: '暗夜', accentDefault: '#f5d90a', bg: '#1b1915', card: '#26231d', dark: true },
    abyss:  { label: '夜幕', accentDefault: '#60a5fa', bg: '#151a21', card: '#1e242e', dark: true },
  };
  // 强调色预设色板：与应用 THEME_PRESETS 一致
  var ACCENTS = ['#f5d90a', '#e8850c', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
  var STORE_KEY = 'sb-site-theme';

  var themeId = 'warm';
  var accent = THEMES.warm.accentDefault;

  /* ---------- 颜色换算：与应用 hexToRgb / mixHex / rgbaOf 同算法 ---------- */
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

  // 强调色派生阶梯：热力图色阶 / 高亮 / 光晕 / 聚焦环，比例与应用 applyTheme 一致
  function applyAccent(hex) {
    var st = document.documentElement.style;
    st.setProperty('--accent', hex);
    st.setProperty('--accent-soft', mixHex(hex, '#ffffff', 0.55));
    st.setProperty('--accent-deep', mixHex(hex, '#000000', 0.12));
    st.setProperty('--accent-hl', rgbaOf(hex, 0.55));
    st.setProperty('--accent-glow', rgbaOf(hex, 0.45));
    st.setProperty('--accent-ring', rgbaOf(hex, 0.25));
    // 右上光团跟随强调色；深色主题降低明度避免糊成一片
    st.setProperty('--blob-1', rgbaOf(hex, THEMES[themeId].dark ? 0.45 : 0.55));
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ id: themeId, accent: accent }));
    } catch (e) { /* 隐私模式等场景静默跳过 */ }
  }

  function setTheme(id, accentHex) {
    if (!THEMES[id]) id = 'warm';
    themeId = id;
    accent = hexToRgb(accentHex) ? accentHex : THEMES[id].accentDefault;
    document.documentElement.dataset.theme = id;
    applyAccent(accent);
    syncThemeUI();
    persist();
  }

  /* ---------- 主题卡与色板（结构与应用设置页「外观」一致） ---------- */
  var cardsBox = document.getElementById('themeCards');
  var swatchBox = document.getElementById('swatches');

  function buildThemeCards() {
    Object.keys(THEMES).forEach(function (id) {
      var t = THEMES[id];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-card';
      b.dataset.theme = id;
      b.setAttribute('aria-pressed', 'false');
      var prev = document.createElement('span');
      prev.className = 'tc-preview';
      prev.style.background = t.bg;
      var card = document.createElement('i');
      card.className = 'tc-card';
      card.style.background = t.card;
      var dot = document.createElement('i');
      dot.className = 'tc-dot';
      dot.style.background = t.accentDefault;
      prev.appendChild(card);
      prev.appendChild(dot);
      b.appendChild(prev);
      var nm = document.createElement('span');
      nm.textContent = t.label;
      b.appendChild(nm);
      b.addEventListener('click', function () { setTheme(id, THEMES[id].accentDefault); });
      cardsBox.appendChild(b);
    });
  }

  function buildSwatches() {
    ACCENTS.forEach(function (hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = hex;
      b.dataset.accent = hex;
      b.title = hex;
      b.setAttribute('aria-label', '强调色 ' + hex);
      b.addEventListener('click', function () { setTheme(themeId, hex); });
      swatchBox.appendChild(b);
    });
  }

  function syncThemeUI() {
    Array.prototype.forEach.call(cardsBox.children, function (b) {
      var on = b.dataset.theme === themeId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(swatchBox.children, function (b) {
      b.classList.toggle('active', b.dataset.accent.toLowerCase() === accent.toLowerCase());
    });
  }

  /* ---------- 初始主题：localStorage > prefers-color-scheme > 暖阳（与 head 内联脚本同口径） ---------- */
  function pickInitial() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && THEMES[saved.id]) return { id: saved.id, accent: saved.accent };
    } catch (e) { /* 忽略损坏的存档 */ }
    if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) {
      return { id: 'dark', accent: THEMES.dark.accentDefault };
    }
    return { id: 'warm', accent: THEMES.warm.accentDefault };
  }

  buildThemeCards();
  buildSwatches();
  var init = pickInitial();
  setTheme(init.id, init.accent);

  /* ---------- 主题网格：点某张主题截图，整页切到该主题（与「选择即生效」同一体验） ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-shot]'), function (fig) {
    var id = fig.getAttribute('data-theme-shot');
    fig.setAttribute('title', '整页切换到「' + THEMES[id].label + '」');
    fig.addEventListener('click', function () {
      setTheme(id, THEMES[id].accentDefault);
      // 同步主题卡状态后给一个锚点反馈：滚回主题实验室看整页效果
      document.getElementById('themes').scrollIntoView({ block: 'start' });
    });
  });

  /* ---------- 顶栏滚动态：滚过顶后出现细分隔线（与应用 top-fade 同一语言） ---------- */
  var nav = document.getElementById('topnav');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 滚动进场：进入视口一次淡入，同屏元素串行 70ms ---------- */
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var revealEls = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealEls, function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      var batch = [];
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          batch.push(en.target);
          io.unobserve(en.target);
        }
      });
      batch.forEach(function (el, i) {
        el.style.transitionDelay = (Math.min(i, 8) * 70) + 'ms'; // 封顶 560ms，大批量同屏不至于久等
        el.classList.add('in');
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    Array.prototype.forEach.call(revealEls, function (el) { io.observe(el); });
  }

  /* ============ v2 动感升级（issue #69）：全部 transform/opacity 合成，scroll 只写 CSS 变量 ============ */
  var finePointer = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---- 顶栏滚动进度 + 背景光斑视差（rAF 合并写，passive 监听） ---- */
  var progressEl = document.getElementById('navProgress');
  var blobsEl = document.querySelector('.blobs');
  var scrollTick = false;
  function onScrollV2() {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(function () {
      scrollTick = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (progressEl) {
        progressEl.style.setProperty('--p', (max > 0 ? window.scrollY / max : 0).toFixed(4));
      }
      if (blobsEl && !reduceMotion) {
        blobsEl.style.transform = 'translateY(' + (window.scrollY * 0.05).toFixed(1) + 'px)';
      }
    });
  }
  window.addEventListener('scroll', onScrollV2, { passive: true });
  onScrollV2();

  /* ---- 分区色彩过渡：滚动经过的分区决定 tint 光斑颜色（CSS 侧 background-color 渐变 1.2s） ---- */
  var tintSections = document.querySelectorAll('[data-tint]');
  if (tintSections.length && 'IntersectionObserver' in window) {
    var tintIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          document.documentElement.style.setProperty('--sectint', en.target.getAttribute('data-tint'));
        }
      });
    }, { rootMargin: '-42% 0px -42% 0px' });
    Array.prototype.forEach.call(tintSections, function (el) { tintIO.observe(el); });
  }

  /* ---- 按钮磁吸 + 光晕跟随指针：仅桌面精细指针启用，触屏自然降级 ---- */
  if (finePointer && !reduceMotion) {
    Array.prototype.forEach.call(document.querySelectorAll('.btn.big'), function (btn) {
      btn.classList.add('magnetic');
      var raf = null;
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        var x = e.clientX - r.left, y = e.clientY - r.top;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = null;
          btn.style.setProperty('--mx', x.toFixed(1) + 'px');
          btn.style.setProperty('--my', y.toFixed(1) + 'px');
          btn.style.transform = 'translate(' + ((x / r.width - .5) * 8).toFixed(1) + 'px,' + ((y / r.height - .5) * 6).toFixed(1) + 'px)';
        });
      });
      btn.addEventListener('pointerleave', function () { btn.style.transform = ''; });
    });
  }

  /* ---- Hero 截图：进场动画播完后撤掉 fill 态，恢复悬停抬升等自身变换 ---- */
  var heroShot = document.querySelector('.hero-shot');
  if (heroShot) {
    heroShot.addEventListener('animationend', function () { heroShot.classList.remove('h-anim'); }, { once: true });
  }

  /* ---- 装饰热力图：确定性伪随机（种子固定，每次访问同一图案），逐列错峰呼吸 ---- */
  var hm = document.getElementById('hmDeco');
  if (hm) {
    var seed = 7;
    for (var i = 0; i < 78; i++) {
      seed = (seed * 16807) % 2147483647;
      var v = seed / 2147483647;
      var cell = document.createElement('i');
      if (v > .78) cell.className = 'l3';
      else if (v > .58) cell.className = 'l2';
      else if (v > .38) cell.className = 'l1';
      cell.style.animationDelay = ((i % 26) * .09 + Math.floor(i / 26) * .4).toFixed(2) + 's';
      hm.appendChild(cell);
    }
  }

  /* ---- 省心特性 marquee：复制一份轨道做无缝循环，副本对读屏隐藏 ---- */
  var mqBelt = document.getElementById('mqBelt');
  if (mqBelt && mqBelt.firstElementChild) {
    var dup = mqBelt.firstElementChild.cloneNode(true);
    dup.setAttribute('aria-hidden', 'true');
    mqBelt.appendChild(dup);
  }

  /* ---- 品牌艺术字：逐字拆分子元素，错落进场（reduced-motion 下动画全停、文字完整） ---- */
  var bmWord = document.querySelector('.bm-word[data-split]');
  if (bmWord) {
    var letters = bmWord.textContent.split('');
    bmWord.textContent = '';
    letters.forEach(function (ch, i) {
      var s = document.createElement('span');
      s.className = 'bm-l';
      s.textContent = ch;
      s.style.animationDelay = (0.1 + i * 0.05).toFixed(2) + 's';
      bmWord.appendChild(s);
    });
  }
})();
