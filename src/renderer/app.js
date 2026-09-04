/* devboard 渲染层：主面板 + 设置视图 */
(function () {
  'use strict';

  var api = window.devboard;
  var BAND_LABEL = { hot: '热', active: '活跃', cooling: '冷却', stale: '搁浅' };
  var BAND_PILL = { hot: 'bp-hot', active: 'bp-active', cooling: 'bp-cool', stale: 'bp-stall' };

  var state = {
    board: null,
    settings: null,
    band: 'all',
    loading: true,
    expanded: {}, // path -> bool
  };

  var grid = document.getElementById('grid');
  var appEl = document.getElementById('app');

  /* ---------- 工具 ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function relTime(iso) {
    if (!iso) return '无提交';
    var diff = Date.now() - Date.parse(iso);
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    var h = Math.floor(min / 60);
    if (h < 24) return h + '小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + '天前';
    var m = Math.floor(d / 30);
    if (m < 12) return m + '个月前';
    return Math.floor(m / 12) + '年前';
  }

  function hhmm(iso) {
    var d = iso ? new Date(iso) : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------- 卡片 ---------- */
  function renderBars(parent, activity, mini) {
    var bars = el('div', 'bars' + (mini ? ' mini' : ''));
    var heights = [18, 38, 58, 80, 100]; // 零值浅灰短柱；1-2 近黑分级；3+ 明黄
    (activity || []).forEach(function (n) {
      var bar = document.createElement('i');
      bar.style.height = heights[Math.min(n, 4)] + '%';
      if (n === 0) bar.className = 'z';
      else if (n >= 3) bar.className = 'hi';
      bars.appendChild(bar);
    });
    parent.appendChild(bars);
  }

  function renderWarns(parent, warnings) {
    if (!warnings || !warnings.length) return;
    var box = el('div', 'warns');
    warnings.forEach(function (w) { box.appendChild(el('span', 'warn', w.label)); });
    parent.appendChild(box);
  }

  function bindMemoEdit(memoEl, p) {
    memoEl.addEventListener('click', function (e) {
      e.stopPropagation();
      var input = el('input', 'memo-input');
      input.type = 'text';
      input.value = p.memo || '';
      memoEl.replaceWith(input);
      input.focus();
      input.addEventListener('click', function (ev) { ev.stopPropagation(); });
      input.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = p.memo || ''; input.blur(); }
      });
      input.addEventListener('blur', function () {
        p.memo = input.value;
        api.setMemo(p.path, input.value);
        // 用新的 memo 元素替换 input，事件重新绑定
        var nm = el('p', 'memo' + (p.memo ? '' : ' empty'), p.memo || '暂无备忘');
        nm.title = '点击编辑备忘';
        input.replaceWith(nm);
        bindMemoEdit(nm, p);
      });
    });
  }

  function renderMemo(card, p) {
    var memo = el('p', 'memo' + (p.memo ? '' : ' empty'), p.memo || '暂无备忘');
    memo.title = '点击编辑备忘';
    bindMemoEdit(memo, p);
    card.appendChild(memo);
  }

  function kv(parent, label, value) {
    var s = el('span');
    s.appendChild(document.createTextNode(label + ' '));
    s.appendChild(el('b', null, value));
    parent.appendChild(s);
  }

  function renderGithub(detailPad, p) {
    detailPad.appendChild(el('div', 'sec-title', 'GitHub'));
    var gh = p.github;
    if (!gh) {
      var noToken = state.settings && (!state.settings.githubToken || !state.settings.githubUsername);
      detailPad.appendChild(el('div', 'gh-empty', noToken ? '未配置 GitHub' : '无 GitHub 数据（非本人仓库或尚未同步）'));
      return;
    }
    var summary = el('div', 'gh-empty', '开放 issue ' + gh.openIssues + ' · 开放 PR ' + gh.openPRs);
    detailPad.appendChild(summary);
    var box = el('div', 'gh');
    gh.items.forEach(function (it) {
      var row = el('div', 'gh-item');
      row.appendChild(el('span', 'tag' + (it.type === 'issue' ? ' issue' : ''), it.type === 'pr' ? 'PR' : 'ISS'));
      row.appendChild(el('span', 't', '#' + it.number + ' ' + it.title));
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        api.openExternal(it.url);
      });
      box.appendChild(row);
    });
    detailPad.appendChild(box);
  }

  function renderDetail(card, p) {
    var detail = el('div', 'detail');
    var din = el('div', 'detail-in');
    var pad = el('div', 'detail-pad');

    pad.appendChild(el('div', 'sec-title', '最近提交'));
    if (p.recentCommits.length === 0) {
      pad.appendChild(el('div', 'gh-empty', '暂无提交记录'));
    }
    p.recentCommits.forEach(function (c) {
      var row = el('div', 'commit');
      row.appendChild(el('span', 'msg', c.msg));
      row.appendChild(el('span', 'ago mono', c.rel));
      pad.appendChild(row);
    });

    if (p.dirtyFiles.length > 0) {
      var st = el('div', 'sec-title', '未提交文件');
      st.style.marginTop = '10px';
      pad.appendChild(st);
      var dirty = el('div', 'dirty mono');
      p.dirtyFiles.forEach(function (f) { dirty.appendChild(el('span', null, f)); });
      pad.appendChild(dirty);
    }

    var ghs = el('div');
    ghs.style.marginTop = '10px';
    pad.appendChild(ghs);
    renderGithub(ghs, p);

    var quick = el('div', 'quick');
    [['打开文件夹', 'folder'], ['编辑器', 'editor'], ['终端', 'terminal']].forEach(function (pair) {
      var b = el('button', null, pair[0]);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api.quickOpen(p.path, pair[1]);
        if (b.classList.contains('ok')) return;
        var orig = b.textContent;
        b.classList.add('ok');
        b.textContent = '已打开';
        setTimeout(function () { b.classList.remove('ok'); b.textContent = orig; }, 900);
      });
      quick.appendChild(b);
    });
    pad.appendChild(quick);

    din.appendChild(pad);
    detail.appendChild(din);
    card.appendChild(detail);
    card.appendChild(el('div', 'expand-hint mono', state.expanded[p.path] ? '- 收起' : '+ 展开'));
  }

  function projectCard(p, kind) {
    // kind: 'big' | 'mid' | 'compact'
    var card = el('article', 'card clickable' + (kind === 'compact' ? ' compact' : ''));
    card.setAttribute('data-band', p.band);
    if (state.expanded[p.path]) card.classList.add('open');

    card.appendChild(el('span', 'bp ' + BAND_PILL[p.band], BAND_LABEL[p.band]));
    card.appendChild(el('h2', 'proj-name mono', p.name));
    renderMemo(card, p, kind === 'compact');

    var kvRow = el('div', 'kv-row');
    kv(kvRow, '最后提交', relTime(p.lastCommitAt));
    kv(kvRow, '近7天', p.commits7d + ' 提交');
    if (kind !== 'compact') {
      if (p.branch) kv(kvRow, '分支', p.branch);
      if (p.aiSessionAt) kv(kvRow, 'AI 会话', relTime(p.aiSessionAt));
      if (p.github && p.github.openIssues > 0) kv(kvRow, '开放 issue', String(p.github.openIssues));
      if (p.hasUpstream && p.behind > 0) kv(kvRow, '落后远程', p.behind + ' 提交');
    }
    card.appendChild(kvRow);

    if (kind !== 'compact') renderBars(card, p.activity30, kind === 'mid');
    renderWarns(card, p.warnings);
    if (p.github === null && p.band === 'stale') { /* 占位保持简洁 */ }

    renderDetail(card, p);

    card.addEventListener('click', function () {
      var open = card.classList.toggle('open');
      state.expanded[p.path] = open;
      var hint = card.querySelector('.expand-hint');
      if (hint) hint.textContent = open ? '- 收起' : '+ 展开';
    });
    return card;
  }

  function attentionCard(board) {
    var aside = el('aside', 'attn');
    var head = el('div', 'attn-head');
    head.appendChild(el('span', 'attn-title', '需要关注'));
    head.appendChild(el('span', 'mono', board.attention.length + ' 个项目'));
    head.lastChild.style.fontSize = '10px';
    head.lastChild.style.color = 'var(--tile-ink2)';
    aside.appendChild(head);
    aside.appendChild(el('div', 'attn-num mono', board.stats.attentionCount + '/' + board.stats.total));
    aside.appendChild(el('div', 'attn-sub', board.attention.length ? '存在未推送提交或滞留改动' : '一切正常，暂无警示'));
    board.attention.forEach(function (a) {
      var item = el('div', 'attn-item');
      item.appendChild(el('span', 'ic'));
      item.appendChild(el('span', 'nm mono', a.name));
      item.appendChild(el('span', 'ds', a.label));
      item.appendChild(el('span', 'mk'));
      item.addEventListener('click', function () {
        // 跳到对应卡片并展开
        state.expanded[a.path] = true;
        renderAll();
        var target = grid.querySelector('[data-path="' + CSS.escape(a.path) + '"]');
        if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
      });
      aside.appendChild(item);
    });
    return aside;
  }

  /* ---------- 渲染 ---------- */
  function visible(p) { return state.band === 'all' || p.band === state.band; }

  // 与 demo 一致：先淡出动画，240ms 后移出布局
  function applyVisibility(card, p) {
    if (visible(p)) return;
    card.classList.add('gone');
    setTimeout(function () {
      if (card.classList.contains('gone')) card.style.display = 'none';
    }, 240);
  }

  function renderAll() {
    var board = state.board;
    grid.innerHTML = '';
    if (!board) return;

    document.getElementById('scanTime').textContent = hhmm(board.scannedAt);
    setStat('statTotal', board.stats.total, '个');
    setStat('statCommits', board.stats.commits7d, '次');
    setStat('statAttn', board.stats.attentionCount, '项');
    var badge = document.getElementById('attnBadge');
    badge.textContent = board.stats.attentionCount;
    badge.classList.toggle('hidden', board.stats.attentionCount === 0);

    if (board.projects.length === 0) {
      var empty = el('div', 'board-empty');
      empty.appendChild(el('div', 't', '还没有发现任何项目'));
      empty.appendChild(el('div', null, '在设置里添加扫描根目录，devboard 会自动找出其中含 .git 的项目'));
      var go = el('button', null, '去设置');
      go.addEventListener('click', showSettings);
      empty.appendChild(go);
      grid.appendChild(empty);
      return;
    }

    // 按最后提交时间倒序（无提交的排最后，path 兜底稳定）
    var byRecency = function (a, b) {
      var ta = a.lastCommitAt ? Date.parse(a.lastCommitAt) : 0;
      var tb = b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0;
      if (ta !== tb) return tb - ta;
      return a.path < b.path ? -1 : 1;
    };
    var sortedAll = board.projects.slice().sort(byRecency);
    var hotActive = sortedAll.filter(function (p) { return p.band === 'hot' || p.band === 'active'; });
    var rest = sortedAll.filter(function (p) { return p.band === 'cooling' || p.band === 'stale'; });

    // 左锚定：最近活跃的项目固定左侧大卡位（默认展开）；其余热/活跃在中列流式排布；
    // 右列为需要关注黑卡 + 冷却/搁浅紧凑卡。某分带为空则该区域自然收起。
    var bigProj, midList, compactList;
    if (hotActive.length > 0) {
      bigProj = hotActive[0];
      midList = hotActive.slice(1);
      compactList = rest;
    } else {
      // 全部冷却/搁浅时仍保证左大卡 + 右列的饱满布局
      bigProj = sortedAll[0];
      midList = sortedAll.slice(1, 3);
      compactList = sortedAll.slice(3);
    }

    // 左：大卡
    if (state.expanded[bigProj.path] === undefined) state.expanded[bigProj.path] = true;
    var colL = el('div', 'col big');
    var bigCard = projectCard(bigProj, 'big');
    bigCard.setAttribute('data-path', bigProj.path);
    if (!visible(bigProj)) applyVisibility(bigCard, bigProj);
    colL.appendChild(bigCard);
    grid.appendChild(colL);

    // 中列：无项目时整列收起，网格用 no-mid 加宽大卡与右列
    grid.classList.toggle('no-mid', midList.length === 0);
    if (midList.length > 0) {
      var colM = el('div', 'col col-mid');
      midList.forEach(function (p) {
        var c = projectCard(p, 'mid');
        c.setAttribute('data-path', p.path);
        if (!visible(p)) applyVisibility(c, p);
        colM.appendChild(c);
      });
      grid.appendChild(colM);
    }

    // 右列：需要关注黑卡 + 冷却/搁浅紧凑卡
    var colR = el('div', 'col col-right');
    colR.appendChild(attentionCard(board));
    compactList.forEach(function (p) {
      var c = projectCard(p, 'compact');
      c.setAttribute('data-path', p.path);
      if (!visible(p)) applyVisibility(c, p);
      colR.appendChild(c);
    });
    grid.appendChild(colR);
  }

  function setStat(id, n, unit) {
    var e = document.getElementById(id);
    e.innerHTML = '';
    e.appendChild(document.createTextNode(n));
    e.appendChild(el('span', 'unit', unit));
  }

  function renderSkeleton() {
    grid.innerHTML = '';
    [[5, 2], [4, 2], [3, 3]].forEach(function (pair) {
      var col = el('div', 'col');
      col.style.gridColumn = 'span ' + pair[0];
      for (var i = 0; i < pair[1]; i++) col.appendChild(el('div', 'skel'));
      grid.appendChild(col);
    });
  }

  /* ---------- 数据 ---------- */
  function load(force) {
    var promise = force ? api.rescan() : api.getBoard();
    return promise.then(function (board) {
      state.board = board;
      state.loading = false;
      renderAll();
      console.log('[devboard] rendered'); // 供 scripts/screenshot.js 等待
    }).catch(function (err) {
      console.error('board 加载失败', err);
      state.loading = false;
    });
  }

  function refresh(manual) {
    var btn = document.getElementById('refreshBtn');
    if (manual) btn.classList.add('spin');
    grid.classList.add('flash');
    load(manual).finally(function () {
      btn.classList.remove('spin');
      setTimeout(function () { grid.classList.remove('flash'); }, 200);
    });
  }

  /* ---------- 设置视图 ---------- */
  function showSettings() {
    appEl.classList.add('show-settings');
    api.getSettings().then(function (cfg) {
      state.settings = cfg;
      document.getElementById('fRoots').value = (cfg.roots || []).join('\n');
      document.getElementById('fBlacklist').value = (cfg.blacklist || []).join('\n');
      document.getElementById('fToken').value = cfg.githubToken || '';
      document.getElementById('fUsername').value = cfg.githubUsername || '';
      document.getElementById('fEditor').value = cfg.editorCmd || '';
      document.getElementById('fHotkey').value = cfg.hotkey || '';
      document.getElementById('fAutoStart').checked = !!cfg.autoStart;
      document.getElementById('settingsMsg').textContent = '';
    });
  }

  function hideSettings() {
    appEl.classList.remove('show-settings');
  }

  function saveSettings() {
    var lines = function (id) {
      return document.getElementById(id).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    };
    var patch = {
      roots: lines('fRoots'),
      blacklist: lines('fBlacklist'),
      githubToken: document.getElementById('fToken').value.trim(),
      githubUsername: document.getElementById('fUsername').value.trim(),
      editorCmd: document.getElementById('fEditor').value.trim() || 'code',
      hotkey: document.getElementById('fHotkey').value.trim(),
      autoStart: document.getElementById('fAutoStart').checked,
    };
    api.setSettings(patch).then(function (cfg) {
      state.settings = cfg;
      document.getElementById('settingsMsg').textContent = '已保存，热键与自启即时生效';
      refresh(false);
    });
  }

  /* ---------- 事件绑定 ---------- */
  document.getElementById('winMin').addEventListener('click', api.winMin);
  document.getElementById('winMax').addEventListener('click', api.winMax);
  document.getElementById('winClose').addEventListener('click', api.winClose);
  document.getElementById('refreshBtn').addEventListener('click', function () { refresh(true); });
  document.getElementById('settingsBtn').addEventListener('click', function () {
    if (appEl.classList.contains('show-settings')) hideSettings(); else showSettings();
  });
  document.getElementById('settingsBack').addEventListener('click', hideSettings);
  document.getElementById('settingsSave').addEventListener('click', saveSettings);
  document.getElementById('attnBadge').parentElement.addEventListener('click', function () {
    // 点击铃铛：切到全部并滚动到需要关注卡
    hideSettings();
    var attn = grid.querySelector('.attn');
    if (attn && attn.scrollIntoView) attn.scrollIntoView({ block: 'nearest' });
  });

  document.querySelectorAll('#nav button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#nav button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.band = btn.getAttribute('data-band');
      hideSettings();
      renderAll();
    });
  });

  api.onTick(function () { refresh(false); });

  /* ---------- 启动 ---------- */
  renderSkeleton();
  api.getSettings().then(function (cfg) { state.settings = cfg; });
  load(false);
})();
