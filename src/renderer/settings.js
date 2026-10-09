/* devboard 渲染层设置域（issue #124 渲染层拆分）：外观/主题域 + 设置页全域——
   分段控件、子模块导航、GitHub 账户与设备码流、AI 工具行与引擎下拉、提示词模板、
   数据组、自动保存链、热键录入。原 app.js 单 IIFE 共享 state、无模块系统，
   本文件以经典脚本挂工厂（window.DevboardSettings），由 app.js 注入 ctx 挂载：
   跨域引用（板/渲染/AI 入口）一律经 ctx，通道与行为零变更。
   ctx: { state, api, el, ipcErrText, closeDrops, switchView, syncTbName, refresh,
          loadAiTools, loadAiCaps, renderAiWeeklyEntry, onPromptChanged, renderSortUi } */
(function (root) {
  'use strict';

  root.DevboardSettings = function initSettingsDomain(ctx) {
    var state = ctx.state;
    var api = ctx.api;
    var el = ctx.el;
    var ipcErrText = ctx.ipcErrText;
    var closeDrops = ctx.closeDrops;
    var switchView = ctx.switchView;
    var syncTbName = ctx.syncTbName;
    var refresh = ctx.refresh;
    var loadAiTools = ctx.loadAiTools;
    var loadAiCaps = ctx.loadAiCaps;
    var renderAiWeeklyEntry = ctx.renderAiWeeklyEntry;
    var appEl = document.getElementById('app');
    // AI 工具注册表派生（issue #123）：与 app.js 同源（preload rendererConsts 单一派生点）。
    // AI_ENGINE_LABELS（issue #141）：引擎可调用档 label——AI 入口显隐按有 spec 的工具判定，
    // 提示文案若列全部注册工具会误导（可启动档不进引擎候选）
    var AI_TOOL_LABEL = root.devboardConsts.AI_TOOL_LABELS;
    var AI_ENGINE_LABEL = root.devboardConsts.AI_ENGINE_LABELS;
    var AI_ICON_CHOICES = [['', '默认（终端）']].concat(root.devboardConsts.AI_ICON_CHOICES);

    /* ---------- 主题（issue #27）：整体主题预设 + 强调色派生阶梯 ---------- */
    var DEFAULT_ACCENT = '#f5d90a';
    var THEME_PRESETS = ['#f5d90a', '#e8850c', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
    var CUSTOM_COLORS = [
      '#e5484d', '#f76b15', '#eab308', '#46a758', '#12a594', '#3b82f6',
      '#c0392b', '#d98e32', '#b8a60a', '#2e7d32', '#0e8074', '#1d4ed8',
      '#ef4444', '#f59e0b', '#f5d90a', '#10b981', '#14b8a6', '#60a5fa',
      '#6e56cf', '#d6409f', '#8b5cf6', '#ec4899', '#64748b', '#181818',
    ];
    // 整体主题：一套完整 token（背景/卡片/文字/深色块/分带/阴影），强调色在其上派生。
    // 权威定义在 src/shared/themes.js（issue #122 单一 token 源），经 preload window.devboardThemes 暴露；
    // 冷启动四色（boot-theme.js）与 styles.css :root 暖阳默认值均从同一模块派生，新增主题只改它
    var THEMES = root.devboardThemes.THEMES;
    // 颜色工具同样来自共享模块：与 :root 生成器（scripts/sync-theme-root.js）同一份实现，派生阶梯两处一致
    var hexToRgb = root.devboardThemes.hexToRgb;
    var mixHex = root.devboardThemes.mixHex;
    var rgbaOf = root.devboardThemes.rgbaOf;
    // 应用整体主题：先铺主题 token，再从强调色派生阶梯（热力图/高亮/光晕/聚焦环）。
    // 只覆写不清理会让上一主题的私有 token（如深色主题的 --tile-line）残留（issue #68）：
    // 切主题前先撤掉上一套里有、新套里没有的内联属性，回落至 :root 默认值
    var appliedThemeKeys = [];
    function applyTheme(themeId, accent) {
      var t = THEMES[themeId] || THEMES.warm;
      if (!hexToRgb(accent)) accent = t.accentDefault;
      var st = document.documentElement.style;
      appliedThemeKeys.forEach(function (k) {
        if (!(k in t.vars)) st.removeProperty(k);
      });
      Object.keys(t.vars).forEach(function (k) { st.setProperty(k, t.vars[k]); });
      appliedThemeKeys = Object.keys(t.vars);
      st.setProperty('--accent', accent);
      // 深色主题（dimBlob）降荧光：accent-soft 少掺白，避免热力图浅格/高亮块在深底上发荧（issue #81）
      st.setProperty('--accent-soft', mixHex(accent, '#ffffff', t.dimBlob ? 0.32 : 0.55));
      st.setProperty('--accent-deep', mixHex(accent, '#000000', 0.12));
      st.setProperty('--accent-hl', rgbaOf(accent, 0.55));
      st.setProperty('--accent-glow', rgbaOf(accent, 0.45));
      st.setProperty('--accent-ring', rgbaOf(accent, 0.25));
      // 警示色派生（issue #77）：晕环跟随主题 --warn
      st.setProperty('--warn-ring', rgbaOf(t.vars['--warn'] || '#c4650a', 0.25));
      // 右上光团跟随强调色；深色主题降低明度避免糊成一片
      st.setProperty('--blob-1', rgbaOf(accent, t.dimBlob ? 0.45 : 0.55));
    }
    function savedTheme() {
      var t = (state.settings && state.settings.theme) || {};
      var id = THEMES[t.id] ? t.id : 'warm';
      return {
        id: id,
        accent: hexToRgb(t.accent) ? t.accent : THEMES[id].accentDefault,
        // 跟随系统（issue #81）：浅/深主题对限同明暗组，脏数据回落默认 暖阳↔暗夜
        mode: t.mode === 'auto' ? 'auto' : 'manual',
        lightId: THEMES[t.lightId] && !isDarkTheme(t.lightId) ? t.lightId : 'warm',
        darkId: isDarkTheme(t.darkId) ? t.darkId : 'dark',
      };
    }

    /* ---------- 设置视图 ---------- */
    var rootsList = document.getElementById('rootsList');
    var extraList = document.getElementById('extraList');
    var aiToolsListEl = document.getElementById('aiToolsList');
    var fToken = document.getElementById('fToken');
    var fUsername = document.getElementById('fUsername');
    var fEditor = document.getElementById('fEditor');
    var fTerminal = document.getElementById('fTerminal');
    var fHotkey = document.getElementById('fHotkey');
    var fAutoStart = document.getElementById('fAutoStart');
    var fAiEnabled = document.getElementById('fAiEnabled');
    var fAiEngine = document.getElementById('fAiEngine');
    var scanIntervalSeg = document.getElementById('scanIntervalSeg');
    var warnDirtyDaysSeg = document.getElementById('warnDirtyDaysSeg');
    var fWarnDirty = document.getElementById('fWarnDirty');
    var fWarnUnpushed = document.getElementById('fWarnUnpushed');
    var fWarnCi = document.getElementById('fWarnCi');
    var fWarnReview = document.getElementById('fWarnReview');
    var fWarnPr = document.getElementById('fWarnPr');
    var fReduceMotion = document.getElementById('fReduceMotion'); // 降低动效（issue #82）
    var fNotifyEnabled = document.getElementById('fNotifyEnabled');
    var notifyModeSeg = document.getElementById('notifyModeSeg');
    var fTrayCount = document.getElementById('fTrayCount');
    var fPromptWeekly = document.getElementById('fPromptWeekly'); // 提示词模板自定义（issue #78）
    var fPromptAdvice = document.getElementById('fPromptAdvice');
    var deviceBox = document.getElementById('deviceBox');
    var deviceTimer = null;
    var deviceGen = 0; // 轮询代次号：stopDeviceFlow 递增，作废旧轮询链上在飞的回调
    fHotkey.readOnly = true; // 热键通过按键捕捉录入

    /* ----- 分段控件通用设施（issue #128）：render（active 标记）/ value（读取活动项）/ click→scheduleSave 收敛一处；
       差异经 opts 注入：numeric 数值转换、fallback 空选兜底、renderExtra 每钮附加渲染、onChange 点击副作用 ----- */
    function bindSeg(segEl, attr, opts) {
      opts = opts || {};
      function render(v) {
        Array.prototype.forEach.call(segEl.querySelectorAll('button'), function (b) {
          b.classList.toggle('active', b.getAttribute(attr) === String(v));
          if (opts.renderExtra) opts.renderExtra(b);
        });
      }
      function value() {
        var b = segEl.querySelector('button.active');
        var raw = b ? b.getAttribute(attr) : null;
        if (raw === null) return opts.fallback;
        return opts.numeric ? Number(raw) : raw;
      }
      segEl.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        render(b.getAttribute(attr));
        if (opts.onChange) opts.onChange(opts.numeric ? Number(b.getAttribute(attr)) : b.getAttribute(attr));
        scheduleSave();
      });
      return { render: render, value: value };
    }

    /* ----- 后台刷新间隔（issue #70）：预设 5/10/20/60 四档分段选择，改动随自动保存落盘、主进程即时重设定时器 ----- */
    var SCAN_INTERVALS = [5, 10, 20, 60];
    var scanIntervalCtl = bindSeg(scanIntervalSeg, 'data-min', { numeric: true, fallback: 20 });
    var renderScanInterval = scanIntervalCtl.render;
    var scanIntervalValue = scanIntervalCtl.value;

    /* ----- 警示规则（issue #73）：超期天数 1/3/7 三档分段 + 三类开关；改动随自动保存落盘并触发重算 ----- */
    var WARN_DIRTY_DAYS = [1, 3, 7];
    var warnDirtyDaysCtl = bindSeg(warnDirtyDaysSeg, 'data-days', { numeric: true, fallback: 3 });
    var renderWarnDirtyDays = warnDirtyDaysCtl.render;
    var warnDirtyDaysValue = warnDirtyDaysCtl.value;

    /* ----- 通知（issue #80）：警示摘要开关 + 时机分段 + 托盘计数显隐；总开关关闭时时机分段禁用 ----- */
    var NOTIFY_MODES = ['daily', 'newOnly'];
    var notifyModeCtl = bindSeg(notifyModeSeg, 'data-mode', {
      fallback: 'daily',
      renderExtra: function (b) { b.disabled = !fNotifyEnabled.checked; },
    });
    var renderNotifyMode = notifyModeCtl.render;
    var notifyModeValue = notifyModeCtl.value;
    fNotifyEnabled.addEventListener('change', function () { renderNotifyMode(notifyModeValue()); });

    /* ----- 密度档位（issue #84）：标准/紧凑两档分段，改动即生效并随自动保存落盘 ----- */
    var DENSITIES = ['standard', 'compact'];
    var densitySeg = document.getElementById('densitySeg');
    function applyDensity(d) {
      document.body.dataset.density = DENSITIES.indexOf(d) >= 0 ? d : 'standard';
    }
    var densityCtl = bindSeg(densitySeg, 'data-density', { fallback: 'standard', onChange: applyDensity });
    var renderDensity = densityCtl.render;
    var densityValue = densityCtl.value;

    /* ----- 降低动效（issue #82）：手动开关与系统偏好任一命中即停动效、玻璃退化为实底 ----- */
    var motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    function applyMotion() {
      document.body.dataset.motion = (fReduceMotion.checked || motionMq.matches) ? 'reduced' : '';
    }
    fReduceMotion.addEventListener('change', function () { applyMotion(); }); // 落盘走设置页委托 change
    if (motionMq.addEventListener) motionMq.addEventListener('change', applyMotion);
    else if (motionMq.addListener) motionMq.addListener(applyMotion); // 旧内核兜底

    /* ----- 唤出着陆视图（issue #86）：总览/项目/上次停留；启动与 win:shown 时应用，设置页开着不动 ----- */
    var LANDINGS = ['overview', 'projects', 'last'];
    var landingViewSeg = document.getElementById('landingViewSeg');
    var landingCtl = bindSeg(landingViewSeg, 'data-landing', { fallback: 'overview' });
    var landingValue = landingCtl.value;
    var renderLanding = landingCtl.render;
    function applyLanding() {
      var lv = (state.settings && state.settings.landingView) || 'overview';
      if (LANDINGS.indexOf(lv) < 0) lv = 'overview';
      var view = lv === 'last' ? ((state.prefs && state.prefs.lastView) || 'overview') : lv;
      if (appEl.classList.contains('show-settings')) return;
      if (view !== state.view) switchView(view);
    }
    api.onWinShown(function () { applyLanding(); });

    /* ----- 提示词模板自定义（issue #78）：编辑单位 = 模板 + {{事实}} 插入点 ----- */
    // 默认模板由主进程随 settings:get 下发（aiPromptDefaults）；文本域预填当前生效模板（自定义值或默认）
    function aiPromptDefaults() {
      return (state.settings && state.settings.aiPromptDefaults) || { weekly: '', advice: '' };
    }
    // 落盘值：内容与内置默认一致（或空白）时存 null——未自定义不落盘，未来默认模板优化仍惠及未改过的用户
    function promptDraftOf(textarea, defTpl) {
      var v = textarea.value.replace(/\r\n/g, '\n').trim();
      return v && v !== String(defTpl || '').trim() ? v : null;
    }
    function fillPromptTemplates(cfg) {
      var pd = aiPromptDefaults();
      fPromptWeekly.value = cfg.aiPromptWeekly || pd.weekly || '';
      fPromptAdvice.value = cfg.aiPromptAdvice || pd.advice || '';
    }

    /* ----- 子模块导航（issue #26）：面板常驻 DOM 仅切换显隐，未保存输入不丢 ----- */
    /* 组级锚点：sn-subs 跟随当前 pane 显隐，子项点击滚动直达分组 */
    function syncNavSubs(pane) {
      Array.prototype.forEach.call(document.querySelectorAll('.sn-subs'), function (s) {
        s.classList.toggle('show', s.dataset.pane === pane);
      });
    }
    document.getElementById('settingsNav').addEventListener('click', function (e) {
      var sub = e.target.closest('.sn-subs button');
      if (sub) {
        var target = document.getElementById(sub.dataset.target);
        // 降低动效时平滑滚动一并停（issue #111）
        if (target) target.scrollIntoView({ behavior: document.body.dataset.motion === 'reduced' ? 'auto' : 'smooth', block: 'start' });
        return;
      }
      var btn = e.target.closest('.sn-item');
      if (!btn) return;
      Array.prototype.forEach.call(document.querySelectorAll('.sn-item'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.set-pane'), function (p) {
        p.classList.toggle('active', p.id === 'pane-' + btn.dataset.pane);
      });
      syncNavSubs(btn.dataset.pane);
    });

    /* ----- 外观：整体主题 + 强调色（issue #27），更改即生效并自动保存 ----- */
    /* 跟随系统（issue #81）：mode=auto 时按系统明暗在浅/深主题对间切换；纯渲染层解析，主进程只存配置 */
    var themeId = 'warm';
    var themeAccent = DEFAULT_ACCENT;
    var themeMode = 'manual';
    var themeLightId = 'warm';
    var themeDarkId = 'dark';
    var schemeMq = window.matchMedia('(prefers-color-scheme: dark)');
    function isDarkTheme(id) { return !!(THEMES[id] && THEMES[id].dimBlob); }
    function resolvedThemeId() { return themeMode === 'auto' ? (schemeMq.matches ? themeDarkId : themeLightId) : themeId; }
    function applyCurrentTheme() {
      applyTheme(resolvedThemeId(), themeAccent); // 强调色浅/深共用
      renderThemeCards();
    }
    function onSchemeChange() { if (themeMode === 'auto') applyCurrentTheme(); }
    if (schemeMq.addEventListener) schemeMq.addEventListener('change', onSchemeChange);
    else if (schemeMq.addListener) schemeMq.addListener(onSchemeChange); // 旧内核兜底
    function setTheme(id, accent) {
      themeMode = 'manual';
      themeId = THEMES[id] ? id : 'warm';
      themeAccent = hexToRgb(accent) ? accent : THEMES[themeId].accentDefault;
      applyCurrentTheme();
      renderSwatches();
      scheduleSave();
    }
    function setThemeAuto() {
      themeMode = 'auto';
      applyCurrentTheme();
      renderSwatches();
      scheduleSave();
    }
    function setThemeAccent(hex) {
      // 强调色浅/深共用（issue #81）：自动模式下换色不退出跟随系统
      themeAccent = hexToRgb(hex) ? hex : THEMES[resolvedThemeId()].accentDefault;
      if (themeMode === 'auto') {
        applyCurrentTheme();
        renderSwatches();
        scheduleSave();
      } else {
        setTheme(themeId, themeAccent);
      }
    }
    function renderThemeCards() {
      var box = document.getElementById('themeCards');
      if (!box || box.childElementCount === 0) {
        // 首次构建：首张为「自动」（半明半暗预览），其后 mini 预览 = 主题底色 + 卡片色 + 默认强调色点
        box.innerHTML = '';
        var auto = el('button', 'theme-card');
        auto.type = 'button';
        auto.dataset.theme = 'auto';
        var aprev = el('span', 'tc-preview tc-split');
        aprev.appendChild(el('i', 'tc-card'));
        aprev.appendChild(el('i', 'tc-dot'));
        auto.appendChild(aprev);
        auto.appendChild(el('span', null, '自动'));
        auto.addEventListener('click', function () { setThemeAuto(); });
        box.appendChild(auto);
        Object.keys(THEMES).forEach(function (id) {
          var t = THEMES[id];
          var b = el('button', 'theme-card');
          b.type = 'button';
          b.dataset.theme = id;
          var prev = el('span', 'tc-preview');
          prev.style.background = t.vars['--bg'];
          var card = el('i', 'tc-card');
          card.style.background = t.vars['--card'];
          var dot = el('i', 'tc-dot');
          dot.style.background = t.accentDefault;
          prev.appendChild(card);
          prev.appendChild(dot);
          b.appendChild(prev);
          b.appendChild(el('span', null, t.label));
          b.addEventListener('click', function () { setTheme(id, THEMES[id].accentDefault); });
          box.appendChild(b);
        });
      }
      // 「自动」卡预览按当前浅/深主题对实时着色（issue #151）：原先 tc-split 的四个色值硬编码在
      // styles.css（暖阳/暗夜的第四处拷贝），调主题 token 不会跟随；改由 themes.js token 生成
      // inline style，每次渲染都按 lightId/darkId 现算——调整暖阳或暗夜底色后预览同步变化
      Array.prototype.forEach.call(box.children, function (b) {
        if (b.dataset.theme !== 'auto') return;
        var prev = b.querySelector('.tc-preview');
        if (!prev) return;
        var light = THEMES[themeLightId] || THEMES.warm;
        var dark = THEMES[themeDarkId] || THEMES.dark;
        prev.style.background = 'linear-gradient(105deg,' + light.vars['--bg'] + ' 50%,' + dark.vars['--bg'] + ' 50%)';
        var card = prev.querySelector('.tc-card');
        if (card) card.style.background = light.vars['--card'];
        var dot = prev.querySelector('.tc-dot');
        if (dot) dot.style.background = light.accentDefault;
      });
      Array.prototype.forEach.call(box.children, function (b) {
        b.classList.toggle('active', b.dataset.theme === (themeMode === 'auto' ? 'auto' : themeId));
      });
      renderThemeAutoPair();
    }
    // 浅/深主题对（issue #81）：选项按 dimBlob 标记分深色/浅色两组填充
    var fThemeLight = document.getElementById('fThemeLight');
    var fThemeDark = document.getElementById('fThemeDark');
    Object.keys(THEMES).forEach(function (id) {
      var o = el('option', null, THEMES[id].label);
      o.value = id;
      (isDarkTheme(id) ? fThemeDark : fThemeLight).appendChild(o);
    });
    function renderThemeAutoPair() {
      document.getElementById('themeAutoPair').classList.toggle('hidden', themeMode !== 'auto');
      fThemeLight.value = themeLightId;
      fThemeDark.value = themeDarkId;
    }
    fThemeLight.addEventListener('change', function () { themeLightId = fThemeLight.value; setThemeAuto(); });
    fThemeDark.addEventListener('change', function () { themeDarkId = fThemeDark.value; setThemeAuto(); });
    function renderSwatches() {
      var box = document.getElementById('swatches');
      if (!box) return;
      box.innerHTML = '';
      THEME_PRESETS.forEach(function (hex) {
        var b = el('button', 'swatch' + (hex.toLowerCase() === themeAccent.toLowerCase() ? ' active' : ''));
        b.type = 'button';
        b.style.background = hex;
        b.title = hex;
        b.addEventListener('click', function () { setThemeAccent(hex); });
        box.appendChild(b);
      });
      var hexIn = document.getElementById('fAccentHex');
      hexIn.value = themeAccent.replace('#', '');
    }
    // 自定义调色板浮层（替代原生取色器）
    var colorPop = document.getElementById('colorPop');
    var colorGrid = document.getElementById('colorGrid');
    CUSTOM_COLORS.forEach(function (hex) {
      var c = el('button', 'color-cell');
      c.type = 'button';
      c.style.background = hex;
      c.title = hex;
      c.addEventListener('click', function () {
        setThemeAccent(hex);
        colorPop.classList.remove('open');
      });
      colorGrid.appendChild(c);
    });
    document.getElementById('customColorBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      closeDrops();
      colorPop.classList.toggle('open');
    });
    document.getElementById('fAccentHex').addEventListener('change', function (e) {
      var v = e.target.value.trim().replace('#', '');
      if (/^[0-9a-fA-F]{6}$/.test(v)) {
        setThemeAccent('#' + v);
        colorPop.classList.remove('open');
      } else {
        e.target.value = themeAccent.replace('#', '');
      }
    });
    document.getElementById('themeReset').addEventListener('click', function () { setTheme('warm', DEFAULT_ACCENT); });

    function lines(id) {
      return document.getElementById(id).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    }

    // 开机自启注册失败原因展示（issue #108）：仿热键错误链，保存后与打开设置页时各查一次
    function refreshAutoStartErr() {
      api.getAutoStartError().then(function (msg) {
        document.getElementById('autoStartErr').textContent = msg || '';
      }).catch(function () {});
    }

    function pathRow(listEl, value) {
      var row = el('div', 'path-row');
      var input = el('input');
      input.type = 'text';
      input.value = value || '';
      input.spellcheck = false;
      row.appendChild(input);
      var browse = el('button', 'browse', '浏览…');
      browse.type = 'button';
      browse.addEventListener('click', function () {
        api.pickPath('directory').then(function (p) { if (p) { input.value = p; scheduleSave(); } })
          .catch(function (err) { showHint('选择目录失败：' + ipcErrText(err), true); });
      });
      row.appendChild(browse);
      var del = el('button', 'del', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { row.remove(); scheduleSave(); });
      row.appendChild(del);
      listEl.appendChild(row);
    }

    // AI 工具自定义清单行（label + cmd + 图标选择，issue #15/#21，存 config.aiTools）；图标选项见文件头注册表派生
    function aiToolRow(label, cmd, logoKey) {
      var row = el('div', 'path-row');
      var l = el('input');
      l.type = 'text';
      l.value = label || '';
      l.placeholder = '名称（如 Kimi Code）';
      l.spellcheck = false;
      var c = el('input');
      c.type = 'text';
      c.value = cmd || '';
      c.placeholder = '命令（如 kimi）';
      c.spellcheck = false;
      var sel = el('select');
      AI_ICON_CHOICES.forEach(function (pair) {
        var o = el('option', null, pair[1]);
        o.value = pair[0];
        sel.appendChild(o);
      });
      sel.value = logoKey || '';
      var del = el('button', 'del', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { row.remove(); scheduleSave(); });
      row.appendChild(l);
      row.appendChild(c);
      row.appendChild(sel);
      row.appendChild(del);
      aiToolsListEl.appendChild(row);
    }

    function collectAiTools() {
      var out = [];
      Array.prototype.forEach.call(aiToolsListEl.querySelectorAll('.path-row'), function (row) {
        var inputs = row.querySelectorAll('input');
        var cmd = inputs[1].value.trim();
        if (!cmd) return;
        var item = { label: inputs[0].value.trim() || cmd, cmd: cmd };
        var logo = row.querySelector('select').value;
        if (logo) item.logo = logo;
        out.push(item);
      });
      return out;
    }

    function collectPaths(listEl) {
      return Array.prototype.map.call(listEl.querySelectorAll('input'), function (i) { return i.value.trim(); }).filter(Boolean);
    }

    // 默认 AI 引擎下拉（issue #29）：「自动（推荐）」为首档（值 ''，保留缺省语义：lastGood 优先、其次第一个可用，issue #41）；
    // 空配置选中自动档而不物化成 avail[0]（issue #134）；无可用工具时禁用并给提示
    function renderAiEngineSelect(cfg) {
      var hint = document.getElementById('aiEngineHint');
      fAiEngine.innerHTML = '';
      var avail = (state.aiTools || []).filter(function (t) { return t.installed; });
      if (!avail.length) {
        var o = el('option', null, '未检测到已安装的 AI 工具');
        o.value = '';
        fAiEngine.appendChild(o);
        fAiEngine.disabled = true;
        // 提示文案随注册表派生（issue #168 第 5 条）：新登记的工具自动出现在这里，不再手写四个工具名。
        // 按引擎可调用档派生（issue #141）：可启动档工具不进引擎候选，不在此列
        hint.textContent = '安装并登录 ' + Object.keys(AI_ENGINE_LABEL).map(function (k) { return AI_ENGINE_LABEL[k]; }).join(' / ') + ' 任一工具后，AI 功能入口才会出现';
        return;
      }
      fAiEngine.disabled = false;
      var auto = el('option', null, '自动（推荐）');
      auto.value = '';
      fAiEngine.appendChild(auto);
      var best = state.aiCaps && state.aiCaps.engine; // 引擎链实际首选（含 lastGood 排序），标注让 UI 与行为对齐（issue #134）
      avail.forEach(function (t) {
        var o = el('option', null, t.label + '（' + t.cmd + '）' + (best && best.id === t.id ? ' · 当前首选' : ''));
        o.value = t.id;
        fAiEngine.appendChild(o);
      });
      var wanted = cfg && cfg.aiEngine;
      fAiEngine.value = wanted && avail.some(function (t) { return t.id === wanted; }) ? wanted : '';
      hint.textContent = '候选为本机已探测可用的工具；「自动」优先记忆的上次可用引擎';
    }

    function markRows(listEl, invalid) {
      Array.prototype.forEach.call(listEl.querySelectorAll('.path-row'), function (row) {
        var v = row.querySelector('input').value.trim();
        row.querySelector('input').classList.toggle('bad-input', invalid.indexOf(v) >= 0);
      });
    }

    function runCheck(cmd, resEl) {
      resEl.textContent = '校验中…';
      resEl.className = 'res';
      api.checkCommand(cmd).then(function (r) {
        resEl.textContent = r.ok ? ('可用' + (r.reason ? ' · ' + r.reason : '')) : r.reason;
        resEl.classList.add(r.ok ? 'ok' : 'bad');
      }).catch(function (err) {
        resEl.textContent = '校验失败：' + ipcErrText(err);
        resEl.classList.add('bad');
      });
    }

    // 扫描发现数常驻（issue #75）：「扫描」分组标题旁小字，随自动保存的预览回调与手动预览更新
    function updateScanStat(r) {
      var bad = r.invalidRoots.length + r.invalidExtra.length;
      document.getElementById('scanStat').textContent =
        '当前配置可发现 ' + r.count + ' 个项目' + (bad ? ' · ' + bad + ' 条路径无效' : '');
    }

    // 终端命令校验（issue #76：手动「重新校验」按钮与停顿后自动校验共用）；留空 = Windows Terminal / cmd 兜底
    function checkTerminalCmd() {
      var res = document.getElementById('checkTerminalRes');
      if (!fTerminal.value.trim()) {
        res.textContent = '留空：使用 Windows Terminal / cmd 兜底';
        res.className = 'res ok';
        return;
      }
      runCheck(fTerminal.value, res);
    }

    /* ----- GitHub 鉴权（issue #12） ----- */
    function ghStateText() {
      var e = document.getElementById('ghConnState');
      // 无 safeStorage 能力的环境（典型如无 keyring 的 Linux）token 明文落盘，如实告知（issue #65）
      var enc = !state.settings || state.settings.tokenEncrypted !== false;
      if (state.settings && state.settings.hasGithubToken) {
        e.textContent = enc
          ? '已连接 · token 经系统加密存储（输入新 token 可更换）'
          : '已连接 · 当前环境无法加密存储，token 以明文保存在本地配置文件中（输入新 token 可更换）';
      } else {
        e.textContent = enc
          ? '未连接 · 推荐「设备码授权」或「从 gh CLI 导入」'
          : '未连接 · 注意：当前环境无法加密存储，授权后 token 将以明文保存在本地配置文件中';
      }
      fToken.placeholder = (state.settings && state.settings.hasGithubToken) ? '已保存（输入以更换）' : '粘贴 token';
    }

    // 账户状态卡（issue #45）：已连接时展示头像 / 用户名 / 连通性，未连接时隐藏
    function renderGhAccount() {
      var card = document.getElementById('ghAccount');
      var conn = document.getElementById('ghConn');
      if (!state.settings || !state.settings.hasGithubToken) {
        card.classList.add('hidden');
        return;
      }
      card.classList.remove('hidden');
      conn.textContent = '正在验证连接…';
      conn.className = 'gh-conn';
      api.githubStatus().then(function (r) {
        if (!r || !r.configured) { card.classList.add('hidden'); return; }
        var avatar = document.getElementById('ghAvatar');
        if (r.avatarUrl) {
          avatar.src = r.avatarUrl;
          avatar.classList.remove('hidden');
        } else {
          avatar.classList.add('hidden');
        }
        document.getElementById('ghName').textContent =
          r.name ? (r.name + '（@' + r.login + '）') : ('@' + (r.login || '未知'));
        conn.textContent = r.ok ? '连接正常' : ('连接失败：' + (r.reason || '未知错误'));
        conn.classList.add(r.ok ? 'ok' : 'bad');
      }).catch(function () {
        conn.textContent = '连接失败：网络错误';
        conn.classList.add('bad');
      });
    }

    function ghAuthResult(ok, text) {
      var res = document.getElementById('ghAuthRes');
      res.textContent = text;
      res.className = 'res ' + (ok ? 'ok' : 'bad');
    }

    function stopDeviceFlow() {
      deviceGen += 1;
      if (deviceTimer) {
        clearTimeout(deviceTimer);
        deviceTimer = null;
      }
      deviceBox.classList.add('hidden');
    }

    function pollDevice(deviceCode, intervalSec, deadline) {
      var gen = deviceGen;
      deviceTimer = setTimeout(function () {
        if (gen !== deviceGen) return;
        api.githubDevicePoll(deviceCode).then(function (r) {
          if (gen !== deviceGen) return;
          if (r.status === 'success') {
            stopDeviceFlow();
            state.settings = Object.assign({}, state.settings, { hasGithubToken: true, githubUsername: r.login || '' });
            if (!fUsername.value.trim()) fUsername.value = r.login || '';
            ghStateText();
            renderGhAccount();
            ghAuthResult(true, '授权成功 · 登录名 ' + (r.login || ''));
            return;
          }
          if (r.status === 'error') {
            stopDeviceFlow();
            ghAuthResult(false, r.reason || '授权失败');
            return;
          }
          var next = intervalSec + (r.status === 'slow_down' ? 5 : 0);
          document.getElementById('dcStatus').textContent = '等待授权…（' + Math.max(0, Math.round((deadline - Date.now()) / 1000)) + 's 后过期）';
          if (Date.now() < deadline) pollDevice(deviceCode, next, deadline);
          else {
            stopDeviceFlow();
            ghAuthResult(false, '设备码已过期，请重新开始');
          }
        }).catch(function () {
          if (gen !== deviceGen) return;
          if (Date.now() < deadline) pollDevice(deviceCode, intervalSec, deadline);
        });
      }, intervalSec * 1000);
    }

    function startDeviceFlow() {
      stopDeviceFlow(); // 先作废旧轮询链，避免连点产生并行轮询
      var gen = deviceGen; // 在飞启动请求同样受代次保护（issue #62）：关设置页后回调直接丢弃
      var res = document.getElementById('ghAuthRes');
      res.textContent = '请求设备码…';
      res.className = 'res';
      api.githubDeviceStart().then(function (r) {
        if (gen !== deviceGen) return;
        if (!r.ok) {
          ghAuthResult(false, r.reason || '无法开始设备码授权');
          return;
        }
        res.textContent = '';
        document.getElementById('dcCode').textContent = r.userCode;
        document.getElementById('dcStatus').textContent = '等待授权…';
        deviceBox.classList.remove('hidden');
        document.getElementById('dcOpen').onclick = function () { api.openExternal(r.verificationUri); };
        api.openExternal(r.verificationUri);
        pollDevice(r.deviceCode, r.interval + 1, Date.now() + r.expiresIn * 1000);
      }).catch(function (err) {
        // 补 catch（issue #168 第 12 条）：原链路无失败处理，请求被拒时状态行会永远停在「请求设备码…」，
        // 只能靠用户再点一次；这里把失败落到结果位
        if (gen !== deviceGen) return;
        ghAuthResult(false, ipcErrText(err) || '设备码请求失败');
      });
    }

    var firstRun = false; // 首次启动标记：自动打开设置并展示一次性欢迎提示

    function showSettings() {
      appEl.classList.add('show-settings');
      syncTbName(); // 标题栏状态字（issue #86）
      var activeNav = document.querySelector('.sn-item.active');
      syncNavSubs(activeNav ? activeNav.dataset.pane : 'general');
      document.getElementById('welcomeNote').classList.toggle('hidden', !firstRun);
      firstRun = false;
      api.getSettings().then(function (cfg) {
        state.settings = cfg;
        rootsList.innerHTML = '';
        (cfg.roots || []).forEach(function (r) { pathRow(rootsList, r); });
        extraList.innerHTML = '';
        (cfg.extraPaths || []).forEach(function (r) { pathRow(extraList, r); });
        aiToolsListEl.innerHTML = '';
        (cfg.aiTools || []).forEach(function (t) { aiToolRow(t.label, t.cmd, t.logo); });
        document.getElementById('fBlacklist').value = (cfg.blacklist || []).join('\n');
        fToken.value = ''; // token 不下发；留空 = 不改动（issue #12）
        fUsername.value = cfg.githubUsername || '';
        fEditor.value = cfg.editorCmd || '';
        fTerminal.value = cfg.terminalCmd || '';
        fHotkey.value = cfg.hotkey || '';
        fAutoStart.checked = !!cfg.autoStart;
        renderScanInterval(SCAN_INTERVALS.indexOf(cfg.scanIntervalMin) >= 0 ? cfg.scanIntervalMin : 20); // issue #70
        renderWarnDirtyDays(WARN_DIRTY_DAYS.indexOf(cfg.warningDirtyDays) >= 0 ? cfg.warningDirtyDays : 3); // 警示超期天数（issue #73）
        var wt = cfg.warningTypes || {}; // 警示开关（issue #73，CI 失败扩编 issue #143）
        fWarnDirty.checked = wt.dirty !== false;
        fWarnUnpushed.checked = wt.unpushed !== false;
        fWarnCi.checked = wt.ci !== false;
        fWarnReview.checked = wt.review !== false;
        fWarnPr.checked = wt.pr !== false;
        fNotifyEnabled.checked = cfg.notifyEnabled !== false; // 警示摘要通知（issue #80）；先置开关再渲染时机分段（禁用态依赖它）
        renderNotifyMode(NOTIFY_MODES.indexOf(cfg.notifyMode) >= 0 ? cfg.notifyMode : 'daily');
        fTrayCount.checked = cfg.trayAttentionCount !== false; // 托盘计数显隐（issue #80）
        renderDensity(cfg.density === 'compact' ? 'compact' : 'standard'); // 密度档位（issue #84）
        applyDensity(cfg.density);
        fReduceMotion.checked = !!cfg.reduceMotion; // 降低动效（issue #82）：先置开关再按「开关∪系统偏好」落 body 态
        applyMotion();
        renderLanding(LANDINGS.indexOf(cfg.landingView) >= 0 ? cfg.landingView : 'overview'); // 唤出着陆视图（issue #86）
        fAiEnabled.checked = cfg.aiEnabled !== false; // AI 功能总开关（issue #29）
        fillPromptTemplates(cfg); // 提示词模板（issue #78）：预填自定义值或内置默认
        loadAiTools().then(function () { renderAiEngineSelect(cfg); });
        var th = savedTheme();
        themeId = th.id;
        themeAccent = th.accent;
        themeMode = th.mode; // 跟随系统（issue #81）：恢复模式与浅/深主题对
        themeLightId = th.lightId;
        themeDarkId = th.darkId;
        renderThemeCards();
        renderSwatches();
        ghStateText();
        refreshAutoStartErr(); // 自启注册失败原因（issue #108）：打开设置页即展示存量错误
        renderGhAccount();
        // 自动保存默认静默（issue #71）：hint 平时留空，仅出错时亮起；「更改即时生效、自动保存」由首启欢迎提示承担
        clearTimeout(hintTimer);
        var hintEl = document.getElementById('settingsHint');
        hintEl.textContent = '';
        hintEl.classList.remove('err');
        document.getElementById('hotkeyErr').textContent = '';
        ['previewRes', 'testGhRes', 'checkEditorRes', 'checkTerminalRes', 'ghAuthRes'].forEach(function (id) {
          var e = document.getElementById(id);
          e.textContent = '';
          e.className = 'res';
        });
        api.scanPreview({}).then(updateScanStat).catch(function () {}); // 扫描发现数常驻（issue #75）：进设置即按当前已存配置统计一次；失败静默（环境性统计，下次开设置重试）
        stopDeviceFlow();
        // 鉴权入口能力：设备码需应用配置 Client ID，gh 导入需本机 gh CLI
        api.githubAuthCaps().then(function (caps) {
          document.getElementById('ghDeviceBtn').style.display = caps.deviceFlow ? '' : 'none';
          document.getElementById('ghImportBtn').style.display = caps.ghCli ? '' : 'none';
        });
      }).catch(function (err) {
        // 设置读取失败不再静默留空面板（issue #168 第 12 条）：给出可行动的提示
        showHint('设置读取失败：' + ipcErrText(err), true);
      });
    }

    function hideSettings() {
      appEl.classList.remove('show-settings');
      syncTbName(); // 标题栏状态字（issue #86）
      stopDeviceFlow();
      flushSave(); // 关闭前把停顿中的未落盘改动立即保存（自动保存，issue #27 反馈）
      renderAiWeeklyEntry(); // 提示词模板改动后回到总览即按新模板重生成（issue #78）；无改动时走缓存重展，无副作用
    }

    /* ----- 自动保存：更改即生效，无保存按钮；输入停顿 700ms 静默落盘，按改动域触发副作用 ----- */
    /* 成功静默、出错出声（issue #71）：仅热键冲突 / 路径无效等需用户行动的结果才让 hint 亮 err 态 */
    var saveTimer = null;
    var hintTimer = null;
    function showHint(text, isErr) {
      var h = document.getElementById('settingsHint');
      h.textContent = text;
      h.classList.toggle('err', !!isErr);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        h.textContent = '';
        h.classList.remove('err');
      }, 3000);
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; silentSave(); }, 700);
    }
    function flushSave() { // 关闭设置页前把未落盘的改动立即保存
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      silentSave();
    }
    function silentSave() {
      // 扫描域三键（issue #12 第 8 条）：改动域检测只比较这三键，提取一处消除三数组重复
      function scanScopeOf(o) {
        return { roots: o.roots || [], blacklist: o.blacklist || [], extraPaths: o.extraPaths || [] };
      }
      var prev = state.settings || {};
      var patch = {
        roots: collectPaths(rootsList),
        extraPaths: collectPaths(extraList),
        blacklist: lines('fBlacklist'),
        aiTools: collectAiTools(),
        githubUsername: fUsername.value.trim(),
        editorCmd: fEditor.value.trim() || 'code',
        terminalCmd: fTerminal.value.trim(),
        hotkey: fHotkey.value.trim(),
        autoStart: fAutoStart.checked,
        scanIntervalMin: scanIntervalValue(), // 后台刷新间隔（issue #70）
        warningDirtyDays: warnDirtyDaysValue(), // 警示规则（issue #73）
        warningTypes: { dirty: fWarnDirty.checked, unpushed: fWarnUnpushed.checked, ci: fWarnCi.checked, review: fWarnReview.checked, pr: fWarnPr.checked },
        notifyEnabled: fNotifyEnabled.checked, // 通知（issue #80）：主进程读配置即时生效，无需重拉板数据
        notifyMode: notifyModeValue(),
        trayAttentionCount: fTrayCount.checked,
        density: densityValue(), // 密度档位（issue #84）：渲染层即时生效，此处随自动保存落盘
        reduceMotion: fReduceMotion.checked, // 降低动效（issue #82）：同上，渲染层即时生效
        landingView: landingValue(), // 唤出着陆视图（issue #86）
        aiEnabled: fAiEnabled.checked, // AI 功能开关（issue #29）
        aiPromptWeekly: promptDraftOf(fPromptWeekly, aiPromptDefaults().weekly), // 提示词模板（issue #78）：与默认一致存 null
        aiPromptAdvice: promptDraftOf(fPromptAdvice, aiPromptDefaults().advice),
        theme: { id: themeId, accent: themeAccent, mode: themeMode, lightId: themeLightId, darkId: themeDarkId }, // 外观（issue #27）+ 跟随系统（issue #81）
      };
      var typedToken = fToken.value.trim();
      if (typedToken) patch.githubToken = typedToken; // 留空 = 保持已存 token（issue #12）
      // 无可用引擎时下拉禁用：不物化 aiEngine，保留原显式偏好待工具回归（issue #134）
      if (!fAiEngine.disabled) patch.aiEngine = fAiEngine.value;
      // 改动域检测：避免每次击键都重扫 PATH / 重扫磁盘 / 重渲染
      var pathsChanged = JSON.stringify(scanScopeOf(patch)) !== JSON.stringify(scanScopeOf(prev));
      var toolsChanged = JSON.stringify(patch.aiTools) !== JSON.stringify(prev.aiTools || []);
      var hotkeyChanged = patch.hotkey !== (prev.hotkey || '');
      // 编辑器/终端命令改动随停顿自动校验（issue #76），结果显示在原校验按钮旁的 res 位
      var editorChanged = patch.editorCmd !== (prev.editorCmd || 'code');
      var terminalChanged = patch.terminalCmd !== (prev.terminalCmd || '');
      // 警示规则改动需重算警示（issue #73）：天数或开关变化后重拉板数据，
      // 主进程拼板按新规则即时重算（缓存事实字段足够，不等重扫）
      var prevWt = prev.warningTypes || {};
      var warnChanged = patch.warningDirtyDays !== (prev.warningDirtyDays || 3) ||
        JSON.stringify(patch.warningTypes) !==
          JSON.stringify({ dirty: prevWt.dirty !== false, unpushed: prevWt.unpushed !== false, ci: prevWt.ci !== false, review: prevWt.review !== false, pr: prevWt.pr !== false });
      var autoStartChanged = patch.autoStart !== !!prev.autoStart; // 自启开关变化后回读注册结果（issue #108）
      // AI 开关/引擎变化需重估能力（issue #29）；自定义工具清单变化同时影响两者；
      // aiEngine 字段被剔除时（无可用引擎）不参与比较（issue #134）
      var aiChanged = patch.aiEnabled !== (prev.aiEnabled !== false) ||
        (('aiEngine' in patch) && patch.aiEngine !== (prev.aiEngine || ''));
      // 提示词模板改动（issue #78）：缓存键已含模板哈希，旧结果不会掩盖修改；
      // 周报自动生成标记复位，回到总览即按新模板自动重生成一次
      var promptChanged = patch.aiPromptWeekly !== (prev.aiPromptWeekly || null) ||
        patch.aiPromptAdvice !== (prev.aiPromptAdvice || null);
      api.setSettings(patch).then(function (cfg) {
        state.settings = cfg;
        ghStateText();
        if (typedToken) fToken.value = '';
        if (autoStartChanged) refreshAutoStartErr(); // 自启注册结果回读（issue #108）
        var jobs = [];
        if (hotkeyChanged) jobs.push(api.getHotkeyError());
        if (pathsChanged) jobs.push(api.scanPreview({}));
        return Promise.all(jobs);
      }).then(function (rs) {
        // 成功路径不改写 hint（保持低调默认态，issue #71）；字段旁反馈（hotkeyErr、路径标红、校验结果）维持原位
        if (hotkeyChanged) {
          var hkErr = rs.shift();
          document.getElementById('hotkeyErr').textContent = hkErr || '';
          if (hkErr) showHint('已保存，但' + hkErr, true);
        }
        if (pathsChanged) {
          var pv = rs.shift();
          markRows(rootsList, pv.invalidRoots);
          markRows(extraList, pv.invalidExtra);
          updateScanStat(pv); // 扫描发现数常驻（issue #75）
          var badN = pv.invalidRoots.length + pv.invalidExtra.length;
          if (badN) showHint('已保存 · ' + badN + ' 条路径无效', true);
        }
        if (editorChanged) runCheck(patch.editorCmd, document.getElementById('checkEditorRes'));
        if (terminalChanged) checkTerminalCmd();
        // 工具清单变化后重扫 PATH 并重建引擎下拉（issue #168 第 3 条）：原实现只调 loadAiTools()，
        // 而 renderAiEngineSelect 只在打开设置页时调用一次——新增工具后下拉仍显示
        // 「未检测到已安装的 AI 工具」且一直禁用，要关掉再打开设置才恢复
        if (toolsChanged) {
          loadAiTools().then(function () {
            if (state.settings) renderAiEngineSelect(state.settings);
          });
        }
        if (aiChanged || toolsChanged) loadAiCaps(); // AI 引擎/开关或可用工具集已变（issue #29）
        // 模板已改（issue #78）：复位周报自动生成标记；缓存键含模板哈希，旧结果已不会展出。
        // 设置页开着时不主动重生成（避免编辑途中反复起 AI 生成）；已关闭（hideSettings 触发 flushSave 的回调）则立即重估。
        // weeklyAutoDay 属 AI 渲染域（app.js），经 ctx.onPromptChanged 复位与按需重估
        if (promptChanged) ctx.onPromptChanged();
      }).catch(function (err) {
        // 写盘失败（ENOSPC/EPERM 等）：明确告知「未保存」，不再静默丢保存（issue #97）
        showHint('保存失败：' + ipcErrText(err), true);
      });
    }

    // 设置即输即存：文本输入停顿落盘；勾选/下拉/色板选择立即；token 失焦才提交（避免半段 token 落盘）
    var settingsBody = document.querySelector('.settings-body');
    settingsBody.addEventListener('input', function (e) {
      if (e.target === fToken || e.target.id === 'fAccentHex') return;
      scheduleSave();
    });
    settingsBody.addEventListener('change', function (e) {
      if (e.target === fToken && !fToken.value.trim()) return;
      if (e.target.id === 'fAccentHex') return; // hex 输入在自身 change 校验里处理
      scheduleSave();
    });

    /* ---------- 设置页事件绑定（issue #124：板域的 win/refresh/streamMore 绑定留在 app.js） ---------- */
    document.getElementById('settingsBtn').addEventListener('click', function () {
      if (appEl.classList.contains('show-settings')) hideSettings(); else showSettings();
    });
    document.getElementById('addRoot').addEventListener('click', function () { pathRow(rootsList, ''); });
    document.getElementById('addExtra').addEventListener('click', function () { pathRow(extraList, ''); });
    document.getElementById('addAiTool').addEventListener('click', function () { aiToolRow('', ''); });
    document.getElementById('browseEditor').addEventListener('click', function () {
      api.pickPath('file').then(function (p) { if (p) { fEditor.value = p; scheduleSave(); } })
        .catch(function (err) { showHint('选择文件失败：' + ipcErrText(err), true); });
    });
    document.getElementById('previewBtn').addEventListener('click', function () {
      var res = document.getElementById('previewRes');
      res.textContent = '扫描中…';
      res.className = 'res';
      api.scanPreview({
        roots: collectPaths(rootsList),
        blacklist: lines('fBlacklist'),
        extraPaths: collectPaths(extraList),
      }).then(function (r) {
        var bad = r.invalidRoots.length + r.invalidExtra.length;
        res.textContent = '发现 ' + r.count + ' 个项目' + (bad ? ' · ' + bad + ' 条路径无效' : '');
        res.classList.add(bad ? 'bad' : 'ok');
        markRows(rootsList, r.invalidRoots);
        markRows(extraList, r.invalidExtra);
        updateScanStat(r); // 常驻小字与手动预览结果保持一致（issue #75）
      }).catch(function (err) {
        res.textContent = '预览失败：' + ipcErrText(err);
        res.classList.add('bad');
      });
    });
    document.getElementById('testGhBtn').addEventListener('click', function () {
      var res = document.getElementById('testGhRes');
      res.textContent = '测试中…';
      res.className = 'res';
      api.testGithub(fToken.value, fUsername.value).then(function (r) {
        res.textContent = r.ok ? ('连接成功 · 登录名 ' + r.login) : r.reason;
        res.classList.add(r.ok ? 'ok' : 'bad');
      }).catch(function (err) {
        res.textContent = '测试失败：' + ipcErrText(err);
        res.classList.add('bad');
      });
    });
    document.getElementById('ghDeviceBtn').addEventListener('click', startDeviceFlow);
    document.getElementById('dcCancel').addEventListener('click', function () {
      stopDeviceFlow();
      ghAuthResult(false, '已取消授权');
    });
    document.getElementById('ghImportBtn').addEventListener('click', function () {
      var res = document.getElementById('ghAuthRes');
      res.textContent = '导入中…';
      res.className = 'res';
      api.githubImportGh().then(function (r) {
        if (r.ok) {
          state.settings = Object.assign({}, state.settings, { hasGithubToken: true, githubUsername: r.login || '' });
          if (!fUsername.value.trim() && r.login) fUsername.value = r.login;
          ghStateText();
          renderGhAccount();
          ghAuthResult(true, '已从 gh 导入 · 登录名 ' + (r.login || ''));
        } else {
          ghAuthResult(false, r.reason || '导入失败');
        }
      }).catch(function (err) { ghAuthResult(false, '导入失败：' + ipcErrText(err)); });
    });
    // 账户状态卡操作（issue #45）：重新验证 / 断开连接（两段确认走通用 armConfirm，issue #121）
    document.getElementById('ghRecheckBtn').addEventListener('click', renderGhAccount);
    document.getElementById('ghDisconnectBtn').addEventListener('click', function () {
      armConfirm(document.getElementById('ghDisconnectBtn'), '断开连接', function () {
        api.githubDisconnect().then(function () {
          state.settings = Object.assign({}, state.settings, { hasGithubToken: false, githubUsername: '' });
          fUsername.value = '';
          document.getElementById('ghAccount').classList.add('hidden');
          ghStateText();
          ghAuthResult(true, '已断开 GitHub 连接');
        }).catch(function (err) { ghAuthResult(false, '断开失败：' + ipcErrText(err)); });
      }, '再点一次确认断开');
    });
    document.getElementById('checkEditor').addEventListener('click', function () {
      runCheck(fEditor.value || 'code', document.getElementById('checkEditorRes'));
    });
    // 终端「重新校验」按钮（issue #76）：停顿后已自动校验，按钮降级为手动重试
    document.getElementById('checkTerminal').addEventListener('click', checkTerminalCmd);

    // 提示词模板（issue #78）：恢复默认 / 预览实际发送内容（预览带上当前草稿，不等自动保存落盘）
    function bindPromptTpl(kind, textarea, resetBtnId, previewBtnId, previewBoxId) {
      document.getElementById(resetBtnId).addEventListener('click', function () {
        textarea.value = aiPromptDefaults()[kind] || '';
        scheduleSave();
      });
      var box = document.getElementById(previewBoxId);
      document.getElementById(previewBtnId).addEventListener('click', function () {
        box.classList.remove('hidden');
        box.textContent = '正在用当前真实数据组装…';
        var draft = promptDraftOf(textarea, aiPromptDefaults()[kind]);
        api.aiPromptPreview({ kind: kind, template: draft }).then(function (r) {
          box.textContent = r && r.ok
            ? (r.sample ? '（以项目「' + r.sample + '」为例）\n' : '') + r.prompt
            : '预览失败：' + ((r && r.reason) || '未知错误');
        }).catch(function () { box.textContent = '预览失败：通信错误'; });
      });
    }
    bindPromptTpl('weekly', fPromptWeekly, 'promptWeeklyReset', 'promptWeeklyPreview', 'promptWeeklyPreviewBox');
    bindPromptTpl('advice', fPromptAdvice, 'promptAdviceReset', 'promptAdvicePreview', 'promptAdvicePreviewBox');

    /* ----- 数据组（issue #79）：打开数据目录 / 导出 / 导入 / 重置（二次确认沿用「再点一次确认」模式） ----- */
    document.getElementById('openDataDir').addEventListener('click', function () { api.openDataDir(); });

    document.getElementById('exportDataBtn').addEventListener('click', function () {
      var res = document.getElementById('dataIoRes');
      res.textContent = '导出中…';
      res.className = 'res';
      api.exportData().then(function (r) {
        if (r && r.ok) { res.textContent = '已导出：' + r.path; res.classList.add('ok'); }
        else if (r && r.reason === 'canceled') { res.textContent = ''; }
        else { res.textContent = (r && r.reason) || '导出失败'; res.classList.add('bad'); }
      }).catch(function () { res.textContent = '导出失败'; res.classList.add('bad'); });
    });

    // 导入后重新拉取并重填：导入覆盖了 config/prefs/memos，设置字段与板数据都需按新值重展。
    // sortLabel/排序下拉属板域，经 ctx.renderSortUi 重展（issue #124）
    function applyImportedData() {
      showSettings();
      api.getPrefs().then(function (p) {
        state.prefs = p;
        state.branchSel = (p && p.branchSel) || {};
        state.sortMode = (p && p.sortMode) || 'manual';
        ctx.renderSortUi();
      });
      loadAiCaps();
      refresh(false);
    }

    document.getElementById('importDataBtn').addEventListener('click', function () {
      var res = document.getElementById('dataIoRes');
      res.textContent = '导入中…';
      res.className = 'res';
      api.importData().then(function (r) {
        if (!r || !r.ok) {
          if (r && r.reason === 'canceled') { res.textContent = ''; return; }
          res.textContent = (r && r.reason) || '导入失败';
          res.classList.add('bad');
          return;
        }
        res.textContent = '已导入，正在刷新…';
        res.classList.add('ok');
        applyImportedData();
      }).catch(function () { res.textContent = '导入失败'; res.classList.add('bad'); });
    });

    // 「再点一次确认」通用模式（issue #45 引入，#121 收敛为唯一实现）：首次点击武装 2 秒，二次点击才执行；armedLabel 自定义武装期文案
    function armConfirm(btn, label, fn, armedLabel) {
      if (!btn.dataset.confirm) {
        btn.dataset.confirm = '1';
        btn.textContent = armedLabel || '再点一次确认';
        setTimeout(function () {
          delete btn.dataset.confirm;
          btn.textContent = label;
        }, 2000);
        return;
      }
      delete btn.dataset.confirm;
      btn.textContent = label;
      fn();
    }

    document.getElementById('resetPrefsBtn').addEventListener('click', function () {
      armConfirm(document.getElementById('resetPrefsBtn'), '清空偏好', function () {
        api.resetData('prefs').then(function (r) {
          var res = document.getElementById('resetRes');
          if (!r || !r.ok) { res.textContent = (r && r.reason) || '重置失败'; res.className = 'res bad'; return; }
          res.textContent = '已清空偏好';
          res.className = 'res ok';
          api.getPrefs().then(function (p) {
            state.prefs = p;
            state.branchSel = (p && p.branchSel) || {};
            state.sortMode = (p && p.sortMode) || 'manual';
            ctx.renderSortUi();
            refresh(false);
          });
        }).catch(function () { // 写盘失败结果位亮错（issue #119）
          var res = document.getElementById('resetRes');
          res.textContent = '重置失败：通信或写盘错误';
          res.className = 'res bad';
        });
      });
    });

    document.getElementById('resetAllBtn').addEventListener('click', function () {
      armConfirm(document.getElementById('resetAllBtn'), '清空全部数据', function () {
        var res = document.getElementById('resetRes');
        res.textContent = '已清空，正在重启…';
        res.className = 'res ok';
        // 主进程清空全部数据文件后 relaunch，重启回首启引导态；reject 时亮错（issue #119）
        api.resetData('all').catch(function () {
          res.textContent = '重置失败：通信或写盘错误';
          res.className = 'res bad';
        });
      });
    });

    // 热键录入器：聚焦后按组合键录入；Backspace/Delete 清空；Esc 取消；Tab 放行让焦点正常移走
    fHotkey.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { fHotkey.blur(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { fHotkey.value = ''; scheduleSave(); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(e.key) >= 0) return;
      var parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      var k = e.key === ' ' ? 'Space' : e.key;
      if (k.length === 1) k = k.toUpperCase();
      if (parts.length === 0 && !/^F\d{1,2}$/.test(k)) return; // 至少一个修饰键（F 功能键除外）
      parts.push(k);
      fHotkey.value = parts.join('+');
      scheduleSave();
    });

    function applyStartupTheme() {
      var th = savedTheme();
      themeId = th.id;
      themeAccent = th.accent;
      themeMode = th.mode;
      themeLightId = th.lightId;
      themeDarkId = th.darkId;
      applyCurrentTheme();
    }
    // 启动外观一处挂：主题恢复 + 密度/动效/着陆 seg，顺序与原启动序列逐句一致
    function applyStartupAppearance(cfg) {
      applyStartupTheme();
      applyDensity(cfg.density); // 密度档位（issue #84）
      fReduceMotion.checked = !!cfg.reduceMotion; // 降低动效（issue #82）：开关∪系统偏好
      applyMotion();
      renderLanding(LANDINGS.indexOf(cfg.landingView) >= 0 ? cfg.landingView : 'overview'); // 着陆视图 seg（issue #86）
    }

    return {
      showSettings: showSettings,
      hideSettings: hideSettings,
      applyDensity: applyDensity,
      applyMotion: applyMotion,
      applyLanding: applyLanding,
      renderLanding: renderLanding,
      applyCurrentTheme: applyCurrentTheme,
      applyStartupTheme: applyStartupTheme, // 启动主题恢复（原启动序列逐句搬迁，issue #124 仅代码迁移）
      applyStartupAppearance: applyStartupAppearance,
      markFirstRun: function () { firstRun = true; },
    };
  };
})(window);
