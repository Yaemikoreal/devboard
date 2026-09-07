/* devboard 渲染层：主面板 + 设置视图 */
(function () {
  'use strict';

  var api = window.devboard;
  var BAND_LABEL = { hot: '活跃', active: '近期', cooling: '渐冷', stale: '沉睡', archive: '归档' };
  var BAND_PILL = { hot: 'bp-hot', active: 'bp-active', cooling: 'bp-cool', stale: 'bp-stall', archive: 'bp-arch' };
  var FOCUS_BANDS = { hot: 1, active: 1 };

  var state = {
    board: null,
    settings: null,
    prefs: null,
    band: 'all',
    query: '',
    loading: false,
    expanded: {}, // path -> bool
    dragPath: null,
    lastLayout: [], // 当前视觉顺序（大卡 → 中列 → 右列）
    attnFull: false, // 关注卡是否展开全部条目
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

  function flashBtn(b, text, ok) {
    if (b.dataset.busy) return;
    var orig = b.textContent;
    b.dataset.busy = '1';
    b.classList.add(ok ? 'ok' : 'fail');
    b.textContent = text;
    setTimeout(function () {
      b.classList.remove('ok', 'fail');
      b.textContent = orig;
      delete b.dataset.busy;
    }, 900);
  }

  /* ---------- 排序与过滤 ---------- */
  // 卡片位序：自由重排结果优先，未记录的按项目名稳定排序（不随时间漂移）
  function projectOrder(projects) {
    var order = (state.prefs && state.prefs.cardOrder) || [];
    var idx = {};
    order.forEach(function (p, i) { idx[p] = i; });
    return projects.slice().sort(function (a, b) {
      var ia = a.path in idx ? idx[a.path] : Infinity;
      var ib = b.path in idx ? idx[b.path] : Infinity;
      if (ia !== ib) return ia - ib;
      var n = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (n !== 0) return n;
      return a.path < b.path ? -1 : 1;
    });
  }

  function byActivityDesc(a, b) {
    var ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    var tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  }

  // 卡片高度粗估（px）：贪心填充三列时用，允许误差
  function estH(p, kind) {
    var h = kind === 'big' ? 250 : kind === 'mid' ? 205 : 118;
    if (p.warnings && p.warnings.length) h += kind === 'compact' ? 26 : 32;
    if (state.expanded[p.path]) {
      h += 24 + (p.recentCommits ? p.recentCommits.length : 0) * 27; // 最近提交
      if (p.dirtyFiles && p.dirtyFiles.length) h += 26; // 未提交文件摘要行
      h += p.github ? 44 + p.github.items.length * 27 : 26; // GitHub 区
      h += 48; // 快捷按钮行
    }
    return h;
  }

  function queryMatch(p) {
    if (!state.query) return true;
    return (p.name + ' ' + (p.memo || '')).toLowerCase().indexOf(state.query) >= 0;
  }

  function visible(p) {
    return (state.band === 'all' || p.band === state.band) && queryMatch(p);
  }

  function canDrag() { return state.band === 'all' && !state.query; }

  /* ---------- 卡片 ---------- */
  // 近一年活跃：GitHub 风格全年贡献热力图，默认收起，点击展开
  function renderActivity(parent, p) {
    var activity = p.activity365 || [];
    var total = activity.reduce(function (s, n) { return s + n; }, 0);
    var tog = el('button', 'sec-title dirty-toggle');
    tog.type = 'button';
    tog.appendChild(el('span', 'caret', '▸'));
    tog.appendChild(document.createTextNode('近一年活跃 · ' + total + ' 次提交'));
    var wrap = el('div', 'dirty-wrap');
    var din = el('div', 'dirty-in');
    din.appendChild(buildHeatmap(activity));
    wrap.appendChild(din);
    tog.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle('open');
      tog.classList.toggle('open', open);
    });
    parent.appendChild(tog);
    parent.appendChild(wrap);
  }

  // activity 末位 = 今天；周一在最上一行，周列 × 周日行，占满卡片宽度
  function buildHeatmap(activity) {
    var DAY = 86400000;
    var days = activity.length;
    var box = el('div', 'heat');
    var gridEl = el('div', 'heat-grid');
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var first = today.getTime() - (days - 1) * DAY;
    var lead = (new Date(first).getDay() + 6) % 7; // 窗口第一天距周一的偏移
    var b;
    for (b = 0; b < lead; b++) gridEl.appendChild(el('i', 'cell blank'));
    activity.forEach(function (n, i) {
      var d = new Date(first + i * DAY);
      var lvl = n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4;
      var cell = el('i', 'cell l' + lvl);
      cell.title = (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + (n ? n + ' 次提交' : '无提交');
      gridEl.appendChild(cell);
    });
    box.appendChild(gridEl);

    // 底部轴：每月首列标注「X 月」，右端标注「今天」（按列百分比定位）
    var cols = Math.ceil((lead + days) / 7);
    var axis = el('div', 'heat-axis');
    var prevMonth = -1;
    for (var cix = 0; cix < cols; cix++) {
      var dayIdx = Math.max(0, cix * 7 - lead);
      if (dayIdx >= days) break;
      var dd = new Date(first + dayIdx * DAY);
      if (dd.getMonth() !== prevMonth) {
        var m = el('span', 'mon', (dd.getMonth() + 1) + '月');
        m.style.left = (cix / cols * 100) + '%';
        axis.appendChild(m);
        prevMonth = dd.getMonth();
      }
    }
    axis.appendChild(el('span', 'today', '今天'));
    box.appendChild(axis);
    return box;
  }

  function renderWarns(parent, p) {
    if (!p.warnings || !p.warnings.length) return;
    var box = el('div', 'warns');
    p.warnings.forEach(function (w) {
      var s = el('span', 'warn', w.label);
      var x = el('button', 'x', '×');
      x.title = '忽略此警示（状态变化后自动复出）';
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        api.snooze(p.path, w.type, w.label).then(function () { refresh(false); });
      });
      s.appendChild(x);
      box.appendChild(s);
    });
    parent.appendChild(box);
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function bindMemoEdit(memoEl, p) {
    memoEl.addEventListener('click', function (e) {
      e.stopPropagation();
      var ta = el('textarea', 'memo-input');
      ta.value = p.memo || '';
      ta.rows = 1;
      memoEl.replaceWith(ta);
      ta.focus();
      autosize(ta);
      ta.addEventListener('input', function () { autosize(ta); });
      ta.addEventListener('click', function (ev) { ev.stopPropagation(); });
      ta.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
        if (ev.key === 'Escape') { ta.value = p.memo || ''; ta.blur(); }
      });
      ta.addEventListener('blur', function () {
        p.memo = ta.value.replace(/\s+$/, '');
        api.setMemo(p.path, p.memo);
        var nm = el('p', 'memo' + (p.memo ? '' : ' empty'), p.memo || '暂无备忘');
        nm.title = '点击编辑备忘（Enter 保存，Shift+Enter 换行）';
        ta.replaceWith(nm);
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

    // 未提交文件默认收起：摘要行点击后展开为列表（issue #3）
    if (p.dirtyFiles.length > 0) {
      var dt = el('button', 'sec-title dirty-toggle');
      dt.type = 'button';
      dt.appendChild(el('span', 'caret', '▸'));
      dt.appendChild(document.createTextNode('未提交文件 · ' + p.dirtyFiles.length));
      var wrap = el('div', 'dirty-wrap');
      var din2 = el('div', 'dirty-in');
      var list = el('div', 'dirty-list');
      p.dirtyFiles.forEach(function (f) { list.appendChild(el('span', 'f mono', f)); });
      din2.appendChild(list);
      wrap.appendChild(din2);
      dt.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = wrap.classList.toggle('open');
        dt.classList.toggle('open', open);
      });
      pad.appendChild(dt);
      pad.appendChild(wrap);
    }

    var ghs = el('div');
    ghs.style.marginTop = '8px';
    pad.appendChild(ghs);
    renderGithub(ghs, p);

    var quick = el('div', 'quick');
    // 主操作实心，其余幽灵（issue #2 按钮族）
    [['打开文件夹', 'folder', 1], ['编辑器', 'editor'], ['终端', 'terminal']].forEach(function (pair) {
      var b = el('button', 'btn' + (pair[2] ? ' solid' : ''), pair[0]);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api.quickOpen(p.path, pair[1]).then(function (ok) {
          flashBtn(b, ok ? '已打开' : '打开失败', ok);
        });
      });
      quick.appendChild(b);
    });

    var copy = el('button', 'btn', '复制路径');
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(p.path).then(
        function () { flashBtn(copy, '已复制', true); },
        function () { flashBtn(copy, '复制失败', false); }
      );
    });
    quick.appendChild(copy);

    var isPinned = state.prefs && state.prefs.pinned === p.path;
    var pin = el('button', 'btn pin' + (isPinned ? ' on' : ''), isPinned ? '取消主攻' : '设为主攻');
    pin.title = '主攻项目固定占据左侧大卡位';
    pin.addEventListener('click', function (e) {
      e.stopPropagation();
      var next = isPinned ? null : p.path;
      state.prefs = Object.assign({}, state.prefs, { pinned: next });
      api.setPrefs({ pinned: next });
      renderAll();
    });
    quick.appendChild(pin);

    pad.appendChild(quick);
    din.appendChild(pad);
    detail.appendChild(din);
    card.appendChild(detail);
    card.appendChild(el('div', 'expand-hint mono', state.expanded[p.path] ? '- 收起' : '+ 展开'));
  }

  /* ---------- 拖拽重排 ---------- */
  function bindDrag(card, p) {
    card.addEventListener('dragstart', function (e) {
      state.dragPath = p.path;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.path);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', function () {
      state.dragPath = null;
      card.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(function (c) { c.classList.remove('drag-over'); });
    });
    card.addEventListener('dragover', function (e) {
      if (!state.dragPath || state.dragPath === p.path) return;
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', function () { card.classList.remove('drag-over'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (state.dragPath && state.dragPath !== p.path) reorderCard(state.dragPath, p.path);
    });
  }

  function reorderCard(dragPath, targetPath) {
    var disp = state.lastLayout.slice();
    var from = disp.indexOf(dragPath);
    var to = disp.indexOf(targetPath);
    if (from < 0 || to < 0) return;
    disp.splice(to, 0, disp.splice(from, 1)[0]);
    var shown = {};
    disp.forEach(function (p) { shown[p] = 1; });
    // 当前未显示的（理论上拖拽只在「全部」无搜索时可用，这里兜底）按原名序排在后面
    var rest = state.board.projects
      .map(function (p) { return p.path; })
      .filter(function (p) { return !shown[p]; });
    var cardOrder = disp.concat(rest);
    state.prefs = Object.assign({}, state.prefs, { cardOrder: cardOrder });
    api.setPrefs({ cardOrder: cardOrder });
    renderAll();
  }

  function projectCard(p, kind) {
    // kind: 'big' | 'mid' | 'compact'
    var card = el('article', 'card clickable' + (kind === 'compact' ? ' compact' : ''));
    card.setAttribute('data-band', p.band);
    if (state.expanded[p.path]) card.classList.add('open');

    if (state.prefs && state.prefs.pinned === p.path) {
      var flag = el('span', 'pin-flag on');
      flag.appendChild(el('i'));
      flag.appendChild(document.createTextNode('主攻'));
      card.appendChild(flag);
    }
    card.appendChild(el('span', 'bp ' + BAND_PILL[p.band], BAND_LABEL[p.band]));
    card.appendChild(el('h2', 'proj-name mono', p.name));
    renderMemo(card, p);

    var kvRow = el('div', 'kv-row');
    kv(kvRow, '最后提交', relTime(p.lastCommitAt));
    // 分带依据是「最后活动时间」：与最后提交不一致时亮出原因，避免 pill 与提交时间打架
    if (p.lastActivityAt && p.lastActivityAt !== p.lastCommitAt) {
      kv(kvRow, '最近动静', relTime(p.lastActivityAt));
    }
    kv(kvRow, '近7天', p.commits7d + ' 提交');
    if (kind !== 'compact') {
      if (p.branch) kv(kvRow, '分支', p.branch);
      if (p.aiSessionAt) kv(kvRow, 'AI 会话', relTime(p.aiSessionAt));
      if (p.github && p.github.openIssues > 0) kv(kvRow, '开放 issue', String(p.github.openIssues));
      if (p.hasUpstream && p.behind > 0) kv(kvRow, '落后远程', p.behind + ' 提交');
    }
    card.appendChild(kvRow);

    if (kind !== 'compact') renderActivity(card, p);
    renderWarns(card, p);

    renderDetail(card, p);

    card.draggable = canDrag() && !state.expanded[p.path];
    if (card.draggable) card.title = '拖拽可重排卡片';
    bindDrag(card, p);

    card.addEventListener('click', function () {
      var open = card.classList.toggle('open');
      state.expanded[p.path] = open;
      card.draggable = canDrag() && !open;
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
    head.lastChild.style.fontSize = '11px';
    head.lastChild.style.color = 'var(--tile-ink2)';
    aside.appendChild(head);
    aside.appendChild(el('div', 'attn-num mono', board.stats.attentionCount + '/' + board.stats.total));
    aside.appendChild(el('div', 'attn-sub', board.attention.length ? '存在未推送提交或滞留改动' : '一切正常，暂无警示'));
    // 列表上限 5 条，避免长列表把右列顶穿；点击「展开全部」查看剩余
    var CAP = 5;
    var items = state.attnFull ? board.attention : board.attention.slice(0, CAP);
    items.forEach(function (a) {
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
    if (board.attention.length > CAP) {
      var more = el('button', 'attn-more', state.attnFull ? '收起' : '展开全部 ' + board.attention.length + ' 条');
      more.type = 'button';
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        state.attnFull = !state.attnFull;
        renderAll();
      });
      aside.appendChild(more);
    }
    return aside;
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    var board = state.board;
    grid.innerHTML = '';
    if (!board) return;

    document.getElementById('scanTime').textContent = hhmm(board.scannedAt);
    setStat('statTotal', board.stats.total, '个');
    setStat('statCommits', board.stats.commits7d, '次');
    var badge = document.getElementById('attnBadge');
    badge.textContent = board.stats.attentionCount;
    badge.classList.toggle('hidden', board.stats.attentionCount === 0);

    if (board.projects.length === 0) {
      var empty = el('div', 'board-empty');
      empty.appendChild(el('div', 't', '还没有发现任何项目'));
      empty.appendChild(el('div', null, '在设置里添加扫描根目录，devboard 会自动找出其中含 .git 的项目'));
      var go = el('button', 'btn solid', '去设置');
      go.addEventListener('click', showSettings);
      empty.appendChild(go);
      grid.appendChild(empty);
      return;
    }

    var filtering = state.band !== 'all' || !!state.query;
    grid.classList.toggle('flat', filtering);

    if (filtering) {
      // 筛选/搜索态：平铺统一尺寸卡片，从第一排第一列起排（issue #5）
      grid.classList.remove('no-mid', 'sparse');
      var vlist = projectOrder(board.projects).filter(visible);
      state.lastLayout = vlist.map(function (p) { return p.path; });
      if (vlist.length === 0) {
        var none = el('div', 'board-empty');
        none.appendChild(el('div', 't', '该分类下暂无项目'));
        grid.appendChild(none);
        return;
      }
      vlist.forEach(function (p) {
        var c = projectCard(p, 'mid');
        c.setAttribute('data-path', p.path);
        grid.appendChild(c);
      });
      return;
    }

    var all = projectOrder(board.projects);
    var pinnedPath = state.prefs && state.prefs.pinned;
    var pinned = pinnedPath ? all.filter(function (p) { return p.path === pinnedPath; })[0] : null;

    // 左锚定大卡：主攻项目（图钉）；未图钉时由最近活跃者顶替
    var hotActive = all.filter(function (p) { return FOCUS_BANDS[p.band]; });
    var bigProj = pinned || hotActive.slice().sort(byActivityDesc)[0] || all.slice().sort(byActivityDesc)[0];
    var rest = all.filter(function (p) { return p !== bigProj; });

    state.lastLayout = [bigProj.path].concat(rest.map(function (p) { return p.path; }));

    // 贪心填充三列：大卡固定左上、关注卡固定右上，其余卡片进当前最矮列，优先充满
    var colL = el('div', 'col big');
    var colM = el('div', 'col col-mid');
    var colR = el('div', 'col col-right');
    var cols = [colL, colM, colR];
    var hs = [0, 0, 0];

    if (state.expanded[bigProj.path] === undefined) state.expanded[bigProj.path] = true;
    var bigCard = projectCard(bigProj, 'big');
    bigCard.setAttribute('data-path', bigProj.path);
    colL.appendChild(bigCard);
    hs[0] = estH(bigProj, 'big');

    colR.appendChild(attentionCard(board));
    hs[2] = 130 + Math.min(board.attention.length, 5) * 31 + (board.attention.length > 5 ? 32 : 0);

    rest.forEach(function (p) {
      var kind = FOCUS_BANDS[p.band] ? 'mid' : 'compact';
      var c = projectCard(p, kind);
      c.setAttribute('data-path', p.path);
      var i = hs[0] <= hs[1] && hs[0] <= hs[2] ? 0 : hs[1] <= hs[2] ? 1 : 2;
      cols[i].appendChild(c);
      hs[i] += estH(p, kind) + 12;
    });
    grid.appendChild(colL);
    grid.appendChild(colM);
    grid.appendChild(colR);

    // 内容不足一屏时垂直居中，避免重心上浮
    requestAnimationFrame(function () {
      grid.classList.toggle('sparse', grid.scrollHeight <= grid.clientHeight + 4);
    });
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
    if (state.loading) return Promise.resolve(); // 唤出重扫与定时 tick 去重
    state.loading = true;
    var promise = force ? api.rescan() : api.getBoard();
    return promise.then(function (board) {
      state.board = board;
      renderAll();
      console.log('[devboard] rendered'); // 供 scripts/screenshot.js 等待
    }).catch(function (err) {
      console.error('board 加载失败', err);
    }).finally(function () {
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
  var rootsList = document.getElementById('rootsList');
  var extraList = document.getElementById('extraList');
  var fToken = document.getElementById('fToken');
  var fUsername = document.getElementById('fUsername');
  var fEditor = document.getElementById('fEditor');
  var fTerminal = document.getElementById('fTerminal');
  var fHotkey = document.getElementById('fHotkey');
  var fAutoStart = document.getElementById('fAutoStart');
  fHotkey.readOnly = true; // 热键通过按键捕捉录入

  function lines(id) {
    return document.getElementById(id).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
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
      api.pickPath('directory').then(function (p) { if (p) input.value = p; });
    });
    row.appendChild(browse);
    var del = el('button', 'del', '删除');
    del.type = 'button';
    del.addEventListener('click', function () { row.remove(); });
    row.appendChild(del);
    listEl.appendChild(row);
  }

  function collectPaths(listEl) {
    return Array.prototype.map.call(listEl.querySelectorAll('input'), function (i) { return i.value.trim(); }).filter(Boolean);
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
    });
  }

  function showSettings() {
    appEl.classList.add('show-settings');
    api.getSettings().then(function (cfg) {
      state.settings = cfg;
      rootsList.innerHTML = '';
      (cfg.roots || []).forEach(function (r) { pathRow(rootsList, r); });
      extraList.innerHTML = '';
      (cfg.extraPaths || []).forEach(function (r) { pathRow(extraList, r); });
      document.getElementById('fBlacklist').value = (cfg.blacklist || []).join('\n');
      fToken.value = cfg.githubToken || '';
      fUsername.value = cfg.githubUsername || '';
      fEditor.value = cfg.editorCmd || '';
      fTerminal.value = cfg.terminalCmd || '';
      fHotkey.value = cfg.hotkey || '';
      fAutoStart.checked = !!cfg.autoStart;
      document.getElementById('settingsMsg').textContent = '';
      document.getElementById('hotkeyErr').textContent = '';
      ['previewRes', 'testGhRes', 'checkEditorRes', 'checkTerminalRes'].forEach(function (id) {
        var e = document.getElementById(id);
        e.textContent = '';
        e.className = 'res';
      });
    });
  }

  function hideSettings() {
    appEl.classList.remove('show-settings');
  }

  function saveSettings() {
    var patch = {
      roots: collectPaths(rootsList),
      extraPaths: collectPaths(extraList),
      blacklist: lines('fBlacklist'),
      githubToken: fToken.value.trim(),
      githubUsername: fUsername.value.trim(),
      editorCmd: fEditor.value.trim() || 'code',
      terminalCmd: fTerminal.value.trim(),
      hotkey: fHotkey.value.trim(),
      autoStart: fAutoStart.checked,
    };
    api.setSettings(patch).then(function (cfg) {
      state.settings = cfg;
      return Promise.all([api.getHotkeyError(), api.scanPreview({})]);
    }).then(function (rs) {
      var hkErr = rs[0];
      var prev = rs[1];
      var msg = document.getElementById('settingsMsg');
      if (hkErr) {
        msg.textContent = '已保存，但' + hkErr;
        msg.classList.add('err');
      } else {
        msg.textContent = '已保存，热键与自启即时生效 · 扫描发现 ' + prev.count + ' 个项目';
        msg.classList.remove('err');
      }
      document.getElementById('hotkeyErr').textContent = hkErr || '';
      markRows(rootsList, prev.invalidRoots);
      markRows(extraList, prev.invalidExtra);
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
  document.getElementById('addRoot').addEventListener('click', function () { pathRow(rootsList, ''); });
  document.getElementById('addExtra').addEventListener('click', function () { pathRow(extraList, ''); });
  document.getElementById('browseEditor').addEventListener('click', function () {
    api.pickPath('file').then(function (p) { if (p) fEditor.value = p; });
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
    });
  });
  document.getElementById('testGhBtn').addEventListener('click', function () {
    var res = document.getElementById('testGhRes');
    res.textContent = '测试中…';
    res.className = 'res';
    api.testGithub(fToken.value, fUsername.value).then(function (r) {
      res.textContent = r.ok ? ('连接成功 · 登录名 ' + r.login) : r.reason;
      res.classList.add(r.ok ? 'ok' : 'bad');
    });
  });
  document.getElementById('checkEditor').addEventListener('click', function () {
    runCheck(fEditor.value || 'code', document.getElementById('checkEditorRes'));
  });
  document.getElementById('checkTerminal').addEventListener('click', function () {
    var res = document.getElementById('checkTerminalRes');
    if (!fTerminal.value.trim()) {
      res.textContent = '留空：使用 Windows Terminal / cmd 兜底';
      res.className = 'res ok';
      return;
    }
    runCheck(fTerminal.value, res);
  });

  // 热键录入器：聚焦后按组合键录入；Backspace/Delete 清空；Esc 取消
  fHotkey.addEventListener('keydown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { fHotkey.blur(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { fHotkey.value = ''; return; }
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
  });

  document.getElementById('attnBadge').parentElement.addEventListener('click', function () {
    // 点击铃铛：切到全部并滚动到需要关注卡
    hideSettings();
    var attn = grid.querySelector('.attn');
    if (attn && attn.scrollIntoView) attn.scrollIntoView({ block: 'nearest' });
  });

  // 搜索框
  var searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', function () {
    state.query = searchInput.value.trim().toLowerCase();
    renderAll();
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (searchInput.value) {
        searchInput.value = '';
        state.query = '';
        renderAll();
      } else {
        searchInput.blur();
      }
    }
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

  // 键盘流：Esc 隐藏到托盘；/ 聚焦搜索（输入框内不劫持）
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return; // 输入框内的 Esc 由各控件自理
      if (appEl.classList.contains('show-settings')) hideSettings();
      else api.winClose();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  api.onTick(function () { refresh(false); });

  /* ---------- 启动 ---------- */
  renderSkeleton();
  api.getSettings().then(function (cfg) { state.settings = cfg; });
  api.getPrefs().then(function (p) {
    state.prefs = p;
    if (state.board) renderAll();
  });
  load(false);
})();
