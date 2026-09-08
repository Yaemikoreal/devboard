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
    attnOpen: false, // 「需要关注」面板开合（issue #7）
    branchSel: {}, // path -> 选中分支名（issue #4，持久化在 prefs.branchSel）
    branchDetail: {}, // path + '' + branch -> { lastCommitAt, commits } | 'loading'
    suggestIdx: -1, // 搜索补全键盘选中项（issue #6）
  };

  // keyed DOM 复用：path -> { node, sig }，签名一致的卡片在重渲染时直接搬用（issue #8）
  var cardCache = {};

  var grid = document.getElementById('grid');
  var appEl = document.getElementById('app');
  var searchInput = document.getElementById('searchInput');
  var suggestEl = document.getElementById('suggest');
  var attnPanel = document.getElementById('attnPanel');
  var bellBtn = document.getElementById('bellBtn');

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

  // 命中片段高亮：返回 DocumentFragment，命中部分包 <b>
  function hlFrag(text, query) {
    var frag = document.createDocumentFragment();
    var lower = text.toLowerCase();
    var i = query ? lower.indexOf(query) : -1;
    if (i < 0) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    if (i > 0) frag.appendChild(document.createTextNode(text.slice(0, i)));
    var b = el('b', null, text.slice(i, i + query.length));
    frag.appendChild(b);
    if (i + query.length < text.length) frag.appendChild(document.createTextNode(text.slice(i + query.length)));
    return frag;
  }

  /* ---------- 通用浮层：下拉菜单 (.drop) 的开合 ---------- */
  // 分支下拉与搜索补全共用一套 .drop 样式与动效（issue #4/#6）
  function closeDrops() {
    document.querySelectorAll('.drop.open').forEach(function (d) { d.classList.remove('open'); });
  }

  function anyDropOpen() {
    return !!document.querySelector('.drop.open');
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

  /* ---------- 分支选择（issue #4） ---------- */
  function selBranch(p) {
    return state.branchSel[p.path] || p.branch;
  }

  function branchDetailOf(p) {
    var sel = selBranch(p);
    if (!sel || sel === p.branch) {
      return { lastCommitAt: p.lastCommitAt, commits: p.recentCommits };
    }
    var d = state.branchDetail[p.path + ' ' + sel];
    if (d === 'loading') return null; // 懒取中
    return d || null;
  }

  function isCurrentBranch(p) {
    return selBranch(p) === p.branch;
  }

  function selectBranch(p, name) {
    if (name === p.branch) delete state.branchSel[p.path];
    else state.branchSel[p.path] = name;
    api.setPrefs({ branchSel: state.branchSel });
    if (name !== p.branch && !state.branchDetail[p.path + ' ' + name]) {
      state.branchDetail[p.path + ' ' + name] = 'loading';
      api.branchCommits(p.path, name).then(function (d) {
        state.branchDetail[p.path + ' ' + name] = d || { lastCommitAt: null, commits: [] };
        renderAll();
      });
    }
    renderAll();
  }

  // 分支下拉：kv 区的「分支」改为可开合菜单，列出本地分支及各自最后提交时间
  function renderBranchKv(kvRow, p) {
    var branches = p.branches && p.branches.length
      ? p.branches
      : (p.branch ? [{ name: p.branch, at: p.lastCommitAt }] : []);
    if (!branches.length) return;

    var sel = selBranch(p);
    var wrap = el('span', 'bdrop');
    wrap.appendChild(document.createTextNode('分支 '));
    var btn = el('button', 'bdrop-btn mono', sel || '?');
    btn.type = 'button';
    btn.appendChild(el('span', 'caret', '▸'));
    wrap.appendChild(btn);
    if (!isCurrentBranch(p)) {
      var nc = el('span', 'outline-pill nc', '非当前分支');
      wrap.appendChild(nc);
    }

    var menu = el('div', 'drop bdrop-menu');
    branches.forEach(function (b) {
      var item = el('button', 'drop-item' + (b.name === sel ? ' active' : ''));
      item.type = 'button';
      item.appendChild(el('span', 'nm mono', b.name));
      item.appendChild(el('span', 'rt', relTime(b.at)));
      if (b.name === p.branch) item.appendChild(el('span', 'cur', '当前'));
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        closeDrops();
        selectBranch(p, b.name);
      });
      menu.appendChild(item);
    });
    wrap.appendChild(menu);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = !menu.classList.contains('open');
      closeDrops();
      if (willOpen) menu.classList.add('open');
    });
    kvRow.appendChild(wrap);
  }

  /* ---------- 卡片 ---------- */
  // 卡片高度粗估（px）：贪心填充三列时用，允许误差
  function estH(p, kind) {
    var h = kind === 'big' ? 250 : kind === 'mid' ? 205 : 118;
    if (p.warnings && p.warnings.length && isCurrentBranch(p)) h += kind === 'compact' ? 26 : 32;
    if (state.expanded[p.path]) {
      var bd = branchDetailOf(p);
      h += 24 + (bd && bd.commits ? bd.commits.length : 0) * 27; // 最近提交
      if (p.dirtyFiles && p.dirtyFiles.length && isCurrentBranch(p)) h += 26; // 未提交文件摘要行
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
      var lvl = n === 0 ? 0 : n < 4 ? 1 : n < 9 ? 2 : 3;
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
      var noToken = state.settings && !(state.settings.hasGithubToken || state.settings.githubToken);
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
    var current = isCurrentBranch(p);
    var bd = branchDetailOf(p);

    pad.appendChild(el('div', 'sec-title', current ? '最近提交' : '最近提交 · ' + selBranch(p)));
    if (!bd) {
      pad.appendChild(el('div', 'gh-empty', '加载分支数据…'));
    } else if (bd.commits.length === 0) {
      pad.appendChild(el('div', 'gh-empty', '暂无提交记录'));
    } else {
      bd.commits.forEach(function (c) {
        var row = el('div', 'commit');
        row.appendChild(el('span', 'msg', c.msg));
        row.appendChild(el('span', 'ago mono', c.rel));
        pad.appendChild(row);
      });
    }

    // 未提交文件默认收起：摘要行点击后展开为列表（issue #3）；工作区信息只对当前分支显示（issue #4）
    if (current && p.dirtyFiles.length > 0) {
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

    var bd = branchDetailOf(p);
    var kvRow = el('div', 'kv-row');
    // 切到非当前分支时，「最后提交」显示该分支的最后提交时间（issue #4）
    kv(kvRow, '最后提交', relTime(bd ? bd.lastCommitAt : p.lastCommitAt));
    // 分带依据是「最后活动时间」：与最后提交不一致时亮出原因，避免 pill 与提交时间打架
    if (p.lastActivityAt && p.lastActivityAt !== p.lastCommitAt) {
      kv(kvRow, '最近动静', relTime(p.lastActivityAt));
    }
    kv(kvRow, '近7天', p.commits7d + ' 提交');
    if (kind !== 'compact') {
      renderBranchKv(kvRow, p);
      if (p.aiSessionAt) kv(kvRow, 'AI 会话', relTime(p.aiSessionAt));
      if (p.github && p.github.openIssues > 0) kv(kvRow, '开放 issue', String(p.github.openIssues));
      if (p.hasUpstream && p.behind > 0) kv(kvRow, '落后远程', p.behind + ' 提交');
    }
    card.appendChild(kvRow);

    if (kind !== 'compact') renderActivity(card, p);
    // 工作区类信息（警示）只对当前分支显示（issue #4）
    if (isCurrentBranch(p)) renderWarns(card, p);

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

  // 卡片签名：影响 DOM 的输入全在里面，一致则重渲染时复用节点（issue #8）
  function cardSig(p, kind) {
    var sel = selBranch(p);
    var bd = sel !== p.branch ? (state.branchDetail[p.path + ' ' + sel] || null) : null;
    return JSON.stringify([
      kind,
      state.prefs && state.prefs.pinned === p.path,
      sel,
      bd,
      state.settings && (state.settings.hasGithubToken || state.settings.githubToken) ? 1 : 0,
      p,
    ]);
  }

  function getCard(p, kind) {
    var sig = cardSig(p, kind);
    var hit = cardCache[p.path];
    if (hit && hit.sig === sig) return hit.node;
    var node = projectCard(p, kind);
    node.setAttribute('data-path', p.path);
    cardCache[p.path] = { node: node, sig: sig };
    return node;
  }

  /* ---------- 「需要关注」面板（issue #7） ---------- */
  function renderAttnPanel() {
    attnPanel.innerHTML = '';
    var board = state.board;
    if (!board) return;
    var head = el('div', 'attn-head');
    head.appendChild(el('span', 'attn-title', '需要关注'));
    var cnt = el('span', 'mono', board.attention.length + ' 个项目');
    cnt.style.fontSize = '11px';
    cnt.style.color = 'var(--tile-ink2)';
    head.appendChild(cnt);
    attnPanel.appendChild(head);
    attnPanel.appendChild(el('div', 'attn-sub', board.attention.length ? '存在未推送提交或滞留改动' : '一切正常，暂无警示'));
    board.attention.forEach(function (a) {
      var item = el('div', 'attn-item');
      item.appendChild(el('span', 'ic'));
      item.appendChild(el('span', 'nm mono', a.name));
      item.appendChild(el('span', 'ds', a.label));
      item.appendChild(el('span', 'mk'));
      item.addEventListener('click', function () {
        jumpToProject(a.path);
      });
      attnPanel.appendChild(item);
    });
  }

  function setAttnOpen(open) {
    state.attnOpen = open;
    attnPanel.classList.toggle('hidden', !open);
    bellBtn.classList.toggle('on', open);
    if (open) renderAttnPanel();
  }

  // 面板/卡片跳转：切回「全部」、清搜索、展开目标卡片并滚动到位
  function jumpToProject(path) {
    state.band = 'all';
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-band') === 'all');
    });
    state.query = '';
    searchInput.value = '';
    closeSuggest();
    setAttnOpen(false);
    hideSettings();
    state.expanded[path] = true;
    renderAll();
    var target = grid.querySelector('[data-path="' + CSS.escape(path) + '"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 搜索自动补全（issue #6） ---------- */
  function suggestCandidates() {
    var q = state.query;
    if (!q || !state.board) return [];
    var nameHit = [];
    var memoHit = [];
    state.board.projects.forEach(function (p) {
      if (p.name.toLowerCase().indexOf(q) >= 0) nameHit.push(p);
      else if ((p.memo || '').toLowerCase().indexOf(q) >= 0) memoHit.push(p);
    });
    return nameHit.concat(memoHit).slice(0, 8);
  }

  function closeSuggest() {
    suggestEl.classList.add('hidden');
    suggestEl.classList.remove('open');
    state.suggestIdx = -1;
  }

  function renderSuggest() {
    var q = state.query;
    if (!q || document.activeElement !== searchInput) {
      closeSuggest();
      return;
    }
    var cands = suggestCandidates();
    suggestEl.innerHTML = '';
    if (!cands.length) {
      suggestEl.appendChild(el('div', 'drop-empty', '无匹配项目'));
    } else {
      cands.forEach(function (p, i) {
        var item = el('button', 'drop-item suggest-item' + (i === state.suggestIdx ? ' active' : ''));
        item.type = 'button';
        var nm = el('span', 'nm mono');
        nm.appendChild(hlFrag(p.name, q));
        item.appendChild(nm);
        var inName = p.name.toLowerCase().indexOf(q) >= 0;
        if (!inName && p.memo) {
          var sn = el('span', 'rt snip');
          sn.appendChild(hlFrag(p.memo.slice(0, 40), q));
          item.appendChild(sn);
        }
        // mousedown 抢先于 input blur，保证点击可选中
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          pickSuggestion(p);
        });
        suggestEl.appendChild(item);
      });
    }
    suggestEl.classList.remove('hidden');
    suggestEl.classList.add('open');
  }

  function pickSuggestion(p) {
    searchInput.value = p.name;
    state.query = p.name.toLowerCase();
    state.expanded[p.path] = true;
    closeSuggest();
    if (state.band !== 'all' && p.band !== state.band) {
      state.band = 'all';
      document.querySelectorAll('#nav button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-band') === 'all');
      });
    }
    renderAll();
    var target = grid.querySelector('[data-path="' + CSS.escape(p.path) + '"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
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
    bellBtn.classList.toggle('grey', board.stats.attentionCount === 0); // issue #7：为 0 置灰
    if (state.attnOpen) renderAttnPanel();

    // keyed 复用的缓存清理：已不在板上的卡片节点丢弃
    var alive = {};
    board.projects.forEach(function (p) { alive[p.path] = 1; });
    Object.keys(cardCache).forEach(function (k) { if (!alive[k]) delete cardCache[k]; });

    if (board.projects.length === 0) {
      var empty = el('div', 'board-empty');
      empty.appendChild(el('div', 't', '还没有发现任何项目'));
      empty.appendChild(el('div', null, '在设置里添加扫描根目录，devboard 会自动找出其中含 .git 的项目'));
      var go = el('button', 'btn solid', '去设置');
      go.addEventListener('click', showSettings);
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
        grid.appendChild(getCard(p, 'mid'));
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

    // 贪心填充三列：大卡固定左上，其余卡片进当前最矮列，优先充满（关注卡已移入铃铛面板，issue #7）
    var colL = el('div', 'col big');
    var colM = el('div', 'col col-mid');
    var colR = el('div', 'col col-right');
    var cols = [colL, colM, colR];
    var hs = [0, 0, 0];

    if (state.expanded[bigProj.path] === undefined) state.expanded[bigProj.path] = true;
    colL.appendChild(getCard(bigProj, 'big'));
    hs[0] = estH(bigProj, 'big');

    rest.forEach(function (p) {
      var kind = FOCUS_BANDS[p.band] ? 'mid' : 'compact';
      var i = hs[0] <= hs[1] && hs[0] <= hs[2] ? 0 : hs[1] <= hs[2] ? 1 : 2;
      cols[i].appendChild(getCard(p, kind));
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
  // 扫描指示：顶栏细 spinner +「扫描中…」，期间现有卡片保持不动（issue #8）
  function setScanning(on) {
    document.getElementById('scanSpin').classList.toggle('hidden', !on);
    document.getElementById('scanLabel').textContent = on ? '扫描中' : '最后扫描';
  }

  function load(force) {
    if (state.loading) return Promise.resolve(); // 唤出重扫与定时 tick 去重
    state.loading = true;
    state.awaitPatch = false;
    setScanning(true);
    var promise = force ? api.rescan() : api.getBoard();
    return promise.then(function (board) {
      state.board = board;
      renderAll();
      console.log('[devboard] rendered'); // 供 scripts/screenshot.js 等待
      // 缓存先出（issue #22）：陈旧数据已渲染，扫描指示保持，等后台重扫补丁到达再熄灭
      if (board && board.fromCache) state.awaitPatch = true;
    }).catch(function (err) {
      console.error('board 加载失败', err);
    }).finally(function () {
      state.loading = false;
      if (!state.awaitPatch) setScanning(false);
    });
  }

  // 后台重扫补丁（issue #22）：整板替换渲染；若期间用户又在手动刷新则丢弃
  api.onBoardPatch(function (board) {
    if (state.loading) return;
    state.awaitPatch = false;
    state.board = board;
    renderAll();
    setScanning(false);
    console.log('[devboard] patched'); // 供 scripts/screenshot.js 等待（DEVBOARD_WAIT_PATCH=1）
  });

  function refresh(manual) {
    var btn = document.getElementById('refreshBtn');
    if (manual) btn.classList.add('spin');
    load(manual).finally(function () {
      btn.classList.remove('spin');
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
  var deviceBox = document.getElementById('deviceBox');
  var deviceTimer = null;
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

  /* ----- GitHub 鉴权（issue #12） ----- */
  function ghStateText() {
    var e = document.getElementById('ghConnState');
    if (state.settings && state.settings.hasGithubToken) {
      e.textContent = '已连接 · token 经系统加密存储（输入新 token 可更换）';
    } else {
      e.textContent = '未连接 · 推荐「设备码授权」或「从 gh CLI 导入」';
    }
    fToken.placeholder = (state.settings && state.settings.hasGithubToken) ? '已保存（输入以更换）' : '粘贴 token';
  }

  function ghAuthResult(ok, text) {
    var res = document.getElementById('ghAuthRes');
    res.textContent = text;
    res.className = 'res ' + (ok ? 'ok' : 'bad');
  }

  function stopDeviceFlow() {
    if (deviceTimer) {
      clearTimeout(deviceTimer);
      deviceTimer = null;
    }
    deviceBox.classList.add('hidden');
  }

  function pollDevice(deviceCode, intervalSec, deadline) {
    deviceTimer = setTimeout(function () {
      api.githubDevicePoll(deviceCode).then(function (r) {
        if (r.status === 'success') {
          stopDeviceFlow();
          state.settings = Object.assign({}, state.settings, { hasGithubToken: true });
          if (!fUsername.value.trim()) fUsername.value = r.login || '';
          ghStateText();
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
        if (Date.now() < deadline) pollDevice(deviceCode, intervalSec, deadline);
      });
    }, intervalSec * 1000);
  }

  function startDeviceFlow() {
    var res = document.getElementById('ghAuthRes');
    res.textContent = '请求设备码…';
    res.className = 'res';
    api.githubDeviceStart().then(function (r) {
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
      fToken.value = ''; // token 不下发；留空 = 不改动（issue #12）
      fUsername.value = cfg.githubUsername || '';
      fEditor.value = cfg.editorCmd || '';
      fTerminal.value = cfg.terminalCmd || '';
      fHotkey.value = cfg.hotkey || '';
      fAutoStart.checked = !!cfg.autoStart;
      ghStateText();
      document.getElementById('settingsMsg').textContent = '';
      document.getElementById('hotkeyErr').textContent = '';
      ['previewRes', 'testGhRes', 'checkEditorRes', 'checkTerminalRes', 'ghAuthRes'].forEach(function (id) {
        var e = document.getElementById(id);
        e.textContent = '';
        e.className = 'res';
      });
      stopDeviceFlow();
      // 鉴权入口能力：设备码需应用配置 Client ID，gh 导入需本机 gh CLI
      api.githubAuthCaps().then(function (caps) {
        document.getElementById('ghDeviceBtn').style.display = caps.deviceFlow ? '' : 'none';
        document.getElementById('ghImportBtn').style.display = caps.ghCli ? '' : 'none';
      });
    });
  }

  function hideSettings() {
    appEl.classList.remove('show-settings');
    stopDeviceFlow();
  }

  function saveSettings() {
    var patch = {
      roots: collectPaths(rootsList),
      extraPaths: collectPaths(extraList),
      blacklist: lines('fBlacklist'),
      githubUsername: fUsername.value.trim(),
      editorCmd: fEditor.value.trim() || 'code',
      terminalCmd: fTerminal.value.trim(),
      hotkey: fHotkey.value.trim(),
      autoStart: fAutoStart.checked,
    };
    var typedToken = fToken.value.trim();
    if (typedToken) patch.githubToken = typedToken; // 留空 = 保持已存 token（issue #12）
    api.setSettings(patch).then(function (cfg) {
      state.settings = cfg;
      ghStateText();
      fToken.value = '';
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
        state.settings = Object.assign({}, state.settings, { hasGithubToken: true });
        if (!fUsername.value.trim() && r.login) fUsername.value = r.login;
        ghStateText();
        ghAuthResult(true, '已从 gh 导入 · 登录名 ' + (r.login || ''));
      } else {
        ghAuthResult(false, r.reason || '导入失败');
      }
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

  // 铃铛：开合「需要关注」面板（issue #7）
  bellBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    hideSettings();
    setAttnOpen(!state.attnOpen);
  });

  // 搜索框：输入即过滤 + 自动补全（issue #6）
  searchInput.addEventListener('input', function () {
    state.query = searchInput.value.trim().toLowerCase();
    state.suggestIdx = -1;
    renderAll();
    renderSuggest();
  });
  searchInput.addEventListener('focus', function () { renderSuggest(); });
  searchInput.addEventListener('blur', function () { closeSuggest(); });
  searchInput.addEventListener('keydown', function (e) {
    var cands = suggestCandidates();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!cands.length) return;
      e.preventDefault();
      var step = e.key === 'ArrowDown' ? 1 : -1;
      state.suggestIdx = (state.suggestIdx + step + cands.length) % cands.length;
      renderSuggest();
      return;
    }
    if (e.key === 'Enter') {
      var pick = state.suggestIdx >= 0 ? cands[state.suggestIdx] : cands[0];
      if (pick) {
        e.preventDefault();
        pickSuggestion(pick);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!suggestEl.classList.contains('hidden')) {
        closeSuggest();
      } else if (searchInput.value) {
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

  // 点击空白处：关闭浮层（分支下拉 / 补全 / 关注面板）
  document.addEventListener('click', function (e) {
    if (anyDropOpen() && !e.target.closest('.bdrop') && !e.target.closest('.search')) closeDrops();
    if (state.attnOpen && !e.target.closest('#attnPanel') && !e.target.closest('#bellBtn')) setAttnOpen(false);
  });

  // 键盘流：Esc 逐层关闭（补全/下拉 → 关注面板 → 设置 → 隐藏到托盘）；/ 聚焦搜索
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return; // 输入框内的 Esc 由各控件自理
      if (anyDropOpen()) { closeDrops(); return; }
      if (state.attnOpen) { setAttnOpen(false); return; }
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
  api.onShowSettings(function () { showSettings(); });

  /* ---------- 启动 ---------- */
  renderSkeleton();
  api.getSettings().then(function (cfg) { state.settings = cfg; });
  api.getPrefs().then(function (p) {
    state.prefs = p;
    state.branchSel = (p && p.branchSel) || {};
    if (state.board) renderAll();
  });
  load(false);
})();
