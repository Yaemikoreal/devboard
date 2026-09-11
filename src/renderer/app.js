/* devboard 渲染层：总览 | 项目 双视图 + 右侧推出详情面板 + 设置视图 */
/* 设计定稿：demos/demo-f-overview.html（issue #14/#15/#16/#17/#18） */
(function () {
  'use strict';

  var api = window.devboard;
  var BAND_LABEL = { hot: '活跃', active: '近期', cooling: '渐冷', stale: '沉睡', archive: '归档' };
  var BAND_PILL = { hot: 'bp-hot', active: 'bp-active', cooling: 'bp-cool', stale: 'bp-stall', archive: 'bp-arch' };
  var SORT_MODES = ['manual', 'activity', 'name'];
  var SORT_LABEL = { manual: '手动', activity: '最近活跃', name: '名称' };
  var AI_TOOL_LABEL = { kimi: 'Kimi Code', claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
  // 警示类型（issue #77）：严重度排序（与主进程一致）+ 类型图形 class；未知类型回退 dirty 图形
  var WARN_SEVERITY = { dirty: 0, ahead: 1, pr: 2 };
  var WARN_GLYPH = { dirty: 'wg-dirty', ahead: 'wg-ahead', pr: 'wg-pr' };
  function warnGlyphClass(type) { return WARN_GLYPH[type] || WARN_GLYPH.dirty; }
  function warnTypesOf(list) {
    var seen = {};
    return (list || []).map(function (w) { return typeof w === 'string' ? w : w.type; }).filter(function (t) {
      if (seen[t]) return false;
      seen[t] = 1;
      return true;
    }).sort(function (a, b) {
      return (a in WARN_SEVERITY ? WARN_SEVERITY[a] : 9) - (b in WARN_SEVERITY ? WARN_SEVERITY[b] : 9);
    });
  }
  var DAY_MS = 86400000;

  var state = {
    board: null,
    settings: null,
    prefs: null,
    view: 'overview', // 顶层导航：overview | projects（issue #14）
    band: 'all', // 项目页内分带筛选（issue #16）
    sortMode: 'manual', // manual / activity / name（issue #18，持久化在 prefs.sortMode）
    selectedPath: null, // 详情面板当前项目（issue #17）
    loading: false,
    loadPromise: null, // 在飞 load 的 Promise：去重时复用，refresh spinner 不提前熄灭
    awaitPatch: false,
    branchSel: {}, // path -> 选中分支名（issue #4，持久化在 prefs.branchSel）
    branchDetail: {}, // path + ' ' + branch -> { lastCommitAt, commits } | 'loading'
    suggestIdx: -1, // 搜索补全键盘选中项（issue #6）
    aiTools: null, // aitools:list 结果（含 installed 标记，issue #15）
    aiCaps: null, // ai:caps 结果 { enabled, engine }（issue #29）
    aiFilter: null, // AI 自然语言筛选 { raw, keyword, days }（issue #29，band 并入 state.band）
    aiJobs: {}, // AI 后台任务注册表 'kind|path' -> { status, startAt, result }（issue #40，切页不中断）
    details: {}, // path -> { readme, aiSessions } | 'loading'（issue #17 懒取）
    streamShown: 3, // 活动流默认展示近 3 个月，「显示更早的活动」展开
    attnExpanded: false, // 需要关注「还有 N 条」展开态（issue #74），不持久化
    heatMonth: {}, // path -> 详情面板月份热力图翻页偏移（0 = 当月，-1 上一月；issue #34）
    panelPath: null, // 详情面板上次渲染的项目 path：仅同项目重渲染时恢复滚动位置（issue #63）
  };

  var appEl = document.getElementById('app');
  var searchInput = document.getElementById('searchInput');
  var suggestEl = document.getElementById('suggest');
  var viewOverview = document.getElementById('viewOverview');
  var viewProjects = document.getElementById('viewProjects');
  var rowsEl = document.getElementById('rows');
  var splitEl = document.getElementById('split');
  var panelIn = document.getElementById('panelIn');
  var toolsCard = document.getElementById('toolsCard');
  var sortDrop = document.getElementById('sortDrop');

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
    if (d < 30) return d + ' 天前';
    var m = Math.floor(d / 30);
    if (m < 12) return m + ' 个月前';
    return Math.floor(m / 12) + ' 年前';
  }

  function hhmm(iso) {
    var d = iso ? new Date(iso) : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 与主进程 localDateStr 一致：AI 周报缓存的当天日期键
  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
    frag.appendChild(el('b', null, text.slice(i, i + query.length)));
    if (i + query.length < text.length) frag.appendChild(document.createTextNode(text.slice(i + query.length)));
    return frag;
  }

  function findProject(path) {
    if (!state.board) return null;
    var hit = null;
    state.board.projects.forEach(function (p) { if (p.path === path) hit = p; });
    return hit;
  }

  /* ---------- 通用浮层：下拉菜单 (.drop) 的开合 ---------- */
  // 分支下拉 / 搜索补全 / 排序下拉共用一套 .drop 样式与动效；工具项目选择器单独管理
  function closeDrops() {
    document.querySelectorAll('.drop.open').forEach(function (d) {
      if (!d.classList.contains('tool-pick')) d.classList.remove('open');
    });
  }

  function anyDropOpen() {
    return !!document.querySelector('.drop.open:not(.tool-pick)');
  }

  /* ---------- 图钉（主攻项目，多路径集合，issue #16） ---------- */
  function pinnedList() {
    return (state.prefs && state.prefs.pinned) || [];
  }

  function isPinned(path) {
    return pinnedList().indexOf(path) >= 0;
  }

  function togglePin(path) {
    var list = pinnedList().slice();
    var i = list.indexOf(path);
    if (i >= 0) list.splice(i, 1);
    else list.push(path);
    state.prefs = Object.assign({}, state.prefs, { pinned: list });
    api.setPrefs({ pinned: list });
    renderRows();
  }

  /* ---------- 排序与过滤（issue #18） ---------- */
  // 手动位序：cardOrder 优先，未记录的按项目名稳定排序（不随时间漂移）
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

  // 最近活跃 / 名称仅作视图覆盖，不写回 cardOrder；图钉在任意方式下置顶
  function sortedProjects() {
    if (!state.board) return [];
    var list = state.board.projects.filter(function (p) {
      return (state.band === 'all' || p.band === state.band) && aiFilterPass(p);
    });
    if (state.sortMode === 'activity') list = list.slice().sort(byActivityDesc);
    else if (state.sortMode === 'name') {
      list = list.slice().sort(function (a, b) {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
    } else list = projectOrder(list);
    var pinned = [];
    var rest = [];
    list.forEach(function (p) { (isPinned(p.path) ? pinned : rest).push(p); });
    return pinned.concat(rest);
  }

  // 拖拽只在手动位序 + 全部分带 + 无 AI 筛选下可用（筛选子集上重排会破坏位序语义）
  function canDrag() { return state.sortMode === 'manual' && state.band === 'all' && !state.aiFilter; }

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

  // 分支提交懒取：选中非当前分支时才跑 git log（issue #4）；缓存失效后再次调用即重新拉取
  function ensureBranchDetail(p, name) {
    if (!name || name === p.branch || state.branchDetail[p.path + ' ' + name]) return;
    state.branchDetail[p.path + ' ' + name] = 'loading';
    api.branchCommits(p.path, name).then(function (d) {
      state.branchDetail[p.path + ' ' + name] = d || { lastCommitAt: null, commits: [] };
      renderAll();
    });
  }

  function selectBranch(p, name) {
    if (name === p.branch) delete state.branchSel[p.path];
    else state.branchSel[p.path] = name;
    api.setPrefs({ branchSel: state.branchSel });
    ensureBranchDetail(p, name);
    renderAll();
  }

  // 分支下拉：详情面板「近况信号」区内，列出本地分支及各自最后提交时间
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
      wrap.appendChild(el('span', 'outline-pill nc', '非当前分支'));
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

  /* ---------- 全年热力图：正方形格、3 级单色黄渐深 ---------- */
  // activity 末位 = 今天；周一在最上一行，周列 × 周日行，占满容器宽度
  function renderHeatInto(container, activity, gridCls, withAxis) {
    container.innerHTML = '';
    var days = activity.length;
    var gridEl = el('div', gridCls);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var first = today.getTime() - (days - 1) * DAY_MS;
    var lead = (new Date(first).getDay() + 6) % 7; // 窗口第一天距周一的偏移
    var b;
    for (b = 0; b < lead; b++) gridEl.appendChild(el('i', 'cell blank'));
    activity.forEach(function (n, i) {
      var d = new Date(first + i * DAY_MS);
      var lvl = n === 0 ? 0 : n < 3 ? 1 : n < 7 ? 2 : 3;
      var cell = el('i', 'cell' + (lvl ? ' l' + lvl : ''));
      // 悬停气泡（issue #19）：样式化深色气泡替代原生 title，空白占位格不写 tip
      cell.dataset.tip = (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + (n ? n + ' 次提交' : '无提交');
      gridEl.appendChild(cell);
    });
    container.appendChild(gridEl);
    if (!withAxis) return;

    // 底部轴：每月首列标注「X 月」，右端标注「今天」（按列百分比定位）
    var cols = Math.ceil((lead + days) / 7);
    var axis = el('div', 'heat-axis');
    var prevMonth = -1;
    for (var cix = 0; cix < cols; cix++) {
      var dayIdx = Math.max(0, cix * 7 - lead);
      if (dayIdx >= days) break;
      var dd = new Date(first + dayIdx * DAY_MS);
      if (dd.getMonth() !== prevMonth && cix < cols - 1) {
        var m = el('span', 'mon', (dd.getMonth() + 1) + '月');
        m.style.left = (cix / cols * 100) + '%';
        axis.appendChild(m);
        prevMonth = dd.getMonth();
      }
    }
    axis.appendChild(el('span', 'today', '今天'));
    container.appendChild(axis);
  }

  /* ---------- 月份热力图（issue #34）：单月份日历格，标题行标明月份并可左右翻页 ---------- */
  // activity365 末位 = 今天；窗口之外的月份（早于 365 天前）不给翻页
  function renderMonthHeat(box, headEl, p) {
    var offset = state.heatMonth[p.path] || 0;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var view = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    var y = view.getFullYear();
    var m = view.getMonth();

    var nav = el('div', 'mheat-nav');
    var prev = el('button', null, '‹');
    prev.type = 'button';
    prev.title = '上一月';
    var windowStart = new Date(today.getTime() - 364 * DAY_MS);
    prev.disabled = y * 12 + m <= windowStart.getFullYear() * 12 + windowStart.getMonth();
    var next = el('button', null, '›');
    next.type = 'button';
    next.title = '下一月';
    next.disabled = offset >= 0;
    prev.addEventListener('click', function (e) {
      e.stopPropagation();
      state.heatMonth[p.path] = offset - 1;
      renderPanel(p);
    });
    next.addEventListener('click', function (e) {
      e.stopPropagation();
      state.heatMonth[p.path] = offset + 1;
      renderPanel(p);
    });
    nav.appendChild(prev);
    nav.appendChild(el('span', 'mheat-label', y + ' 年 ' + (m + 1) + ' 月'));
    nav.appendChild(next);
    headEl.appendChild(nav);

    box.innerHTML = '';
    var dow = el('div', 'mheat-dow');
    ['一', '二', '三', '四', '五', '六', '日'].forEach(function (w) { dow.appendChild(el('span', null, w)); });
    box.appendChild(dow);
    var grid = el('div', 'mheat');
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var lead = (new Date(y, m, 1).getDay() + 6) % 7; // 周一在最左列
    var b;
    for (b = 0; b < lead; b++) grid.appendChild(el('i', 'cell blank'));
    var act = p.activity365 || [];
    for (var day = 1; day <= daysInMonth; day++) {
      var d = new Date(y, m, day);
      var idx = 364 - Math.round((today - d) / DAY_MS);
      var n = (idx >= 0 && idx < 365) ? (act[idx] || 0) : 0;
      var lvl = n === 0 ? 0 : n < 3 ? 1 : n < 7 ? 2 : 3;
      var cell = el('i', 'cell' + (lvl ? ' l' + lvl : ''));
      if (d.getTime() > today.getTime()) cell.classList.add('future');
      else if (d.getTime() === today.getTime()) cell.classList.add('today');
      cell.dataset.tip = (m + 1) + '月' + day + '日 · ' + (n ? n + ' 次提交' : '无提交');
      cell.appendChild(el('span', 'd', String(day)));
      grid.appendChild(cell);
    }
    box.appendChild(grid);
  }

  /* ---------- 总览页（issue #14） ---------- */
  function setStat(id, n, unit) {
    var e = document.getElementById(id);
    e.innerHTML = '';
    e.appendChild(document.createTextNode(n));
    e.appendChild(el('span', 'unit', unit));
  }

  // 全局全年热力图：各项目 activity365 跨项目求和
  function globalActivity() {
    var sum = new Array(365).fill(0);
    state.board.projects.forEach(function (p) {
      (p.activity365 || []).forEach(function (n, i) { sum[i] += n; });
    });
    return sum;
  }

  // 按月活动流：activity365 按月聚合（每月总提交 + 每项目月提交数）
  function buildStreamMonths() {
    var months = {};
    var order = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    state.board.projects.forEach(function (p) {
      (p.activity365 || []).forEach(function (n, i) {
        if (!n) return;
        var d = new Date(today.getTime() - (364 - i) * DAY_MS);
        var key = d.getFullYear() * 12 + d.getMonth();
        var m = months[key];
        if (!m) {
          m = months[key] = {
            sortKey: key,
            label: d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月',
            total: 0,
            byPath: {},
          };
          order.push(m);
        }
        m.total += n;
        m.byPath[p.path] = (m.byPath[p.path] || 0) + n;
      });
    });
    order.sort(function (a, b) { return b.sortKey - a.sortKey; });
    return order.map(function (m) {
      var rows = Object.keys(m.byPath)
        .map(function (path) { return { p: findProject(path), count: m.byPath[path] }; })
        .filter(function (r) { return r.p; })
        .sort(function (a, b) { return b.count - a.count; });
      return { label: m.label, total: m.total, rows: rows };
    });
  }

  function renderStream() {
    var box = document.getElementById('stream');
    box.innerHTML = '';
    var months = buildStreamMonths();
    var shown = Math.min(state.streamShown, months.length);
    for (var i = 0; i < shown; i++) box.appendChild(streamMonth(months[i]));
    var more = document.getElementById('streamMore');
    more.classList.toggle('hidden', shown >= months.length);
    if (!months.length) box.appendChild(el('div', 'stream-empty', '近一年暂无提交活动'));
  }

  function streamMonth(m) {
    var wrap = el('div', 'stream-month');
    wrap.appendChild(el('h4', null, m.label));
    var block = el('div', 'stream-block');
    var head = el('div', 'head', '在 ' + m.rows.length + ' 个项目中产生了 ' + m.total + ' 次提交');
    block.appendChild(head);
    var max = m.rows.length ? m.rows[0].count : 1;
    m.rows.forEach(function (r) {
      var row = el('div', 'stream-proj');
      var nm = el('span', 'nm', r.p.name);
      nm.title = r.p.name;
      row.appendChild(nm);
      row.appendChild(el('span', 'ct', r.count + ' 次提交'));
      var bar = el('span', 'bar');
      bar.style.width = Math.max(8, Math.round(r.count / max * 160)) + 'px';
      row.appendChild(bar);
      row.addEventListener('click', function () { jumpToProject(r.p.path); });
      block.appendChild(row);
    });
    wrap.appendChild(block);
    return wrap;
  }

  // 需要关注：首屏主角（issue #74）；条目主进程已按严重度排序（未提交超期 > 未推送 > 开放 PR）
  var ATTN_TOP = 5; // 分级截断：默认展 Top 5，其余收进「还有 N 条」，避免警报疲劳
  function renderAttn() {
    var board = state.board;
    var sub = document.getElementById('attnSub');
    var list = document.getElementById('attnList');
    list.innerHTML = '';
    var items = board.attention;
    sub.textContent = items.length
      ? items.length + ' 个项目有警示标记'
      : '一切正常，暂无警示';
    if (!items.length) {
      // 平静态（issue #74）：「没事发生」正是这个工具最想传达的好消息，给正向反馈 + 最近活跃锚点
      var calm = el('div', 'attn-calm');
      var ct = el('div', 'calm-t');
      ct.appendChild(el('i', 'calm-ic'));
      ct.appendChild(document.createTextNode('都在正轨上'));
      calm.appendChild(ct);
      calm.appendChild(el('div', 'calm-sub', '没有待处理的警示，最近活跃：'));
      board.projects
        .filter(function (p) { return p.lastActivityAt; })
        .sort(function (a, b) { return a.lastActivityAt < b.lastActivityAt ? 1 : -1; })
        .slice(0, 2)
        .forEach(function (p) {
          var r = el('div', 'calm-proj');
          var nm = el('span', 'nm', p.name);
          nm.title = p.name;
          r.appendChild(nm);
          r.appendChild(el('span', 'ago', relTime(p.lastActivityAt)));
          r.addEventListener('click', function () { jumpToProject(p.path); });
          calm.appendChild(r);
        });
      list.appendChild(calm);
      return;
    }
    var shown = state.attnExpanded ? items : items.slice(0, ATTN_TOP);
    shown.forEach(function (a) {
      var item = el('div', 'attn-item');
      // 类型图形（issue #77）：最严重一类的图形 + 警示色，不读文字即可区分
      var types = warnTypesOf(a.types);
      var ic = el('span', 'ic');
      ic.appendChild(el('i', 'wg ' + warnGlyphClass(types[0])));
      item.appendChild(ic);
      var nm = el('span', 'nm mono', a.name);
      nm.title = a.name;
      item.appendChild(nm);
      item.appendChild(el('span', 'ds', a.label));
      item.appendChild(el('span', 'mk'));
      item.addEventListener('click', function () { jumpToProject(a.path); });
      list.appendChild(item);
    });
    if (!state.attnExpanded && items.length > ATTN_TOP) {
      var more = el('button', 'attn-more', '还有 ' + (items.length - ATTN_TOP) + ' 条，点击展开');
      more.type = 'button';
      more.addEventListener('click', function () {
        state.attnExpanded = true;
        renderAttn();
      });
      list.appendChild(more);
    }
  }

  function renderOverview() {
    var board = state.board;
    // 统计行重排（issue #74）：需要关注大字号居首（>0 染警示色），项目总数降为小字
    setStat('statAttn', board.stats.attentionCount, '项');
    document.getElementById('statAttn').classList.toggle('alert', board.stats.attentionCount > 0);
    setStat('statCommits', board.stats.commits7d, '次');
    document.getElementById('statTotal').textContent = board.stats.total;

    var act = globalActivity();
    var total = act.reduce(function (s, n) { return s + n; }, 0);
    var heatHead = document.getElementById('heatHead');
    heatHead.innerHTML = '';
    heatHead.appendChild(el('b', null, String(total)));
    heatHead.appendChild(document.createTextNode('次提交 · 过去一年 · ' + board.stats.total + ' 个项目'));
    renderHeatInto(document.getElementById('globalHeat'), act, 'gheat', true);

    renderStream();
    renderAttn();
    renderTools();
  }

  /* ---------- 热力图悬停气泡（issue #19）：总览全年图与详情面板月份日历共用（issue #34） ---------- */
  var heatTip = el('div', 'heat-tip');
  document.body.appendChild(heatTip);
  document.addEventListener('mouseover', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('.cell') : null;
    if (!c || c.classList.contains('blank') || !c.dataset.tip || !c.closest('.gheat,.p-heat,.mheat')) {
      heatTip.style.opacity = 0;
      return;
    }
    heatTip.textContent = c.dataset.tip;
    heatTip.style.opacity = 1;
    // 气泡 fixed 定位跟随格子；贴窗口左右缘时钳制内收（面板滚动经 scroll 捕获隐藏）
    var r = c.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var half = heatTip.offsetWidth / 2 + 8;
    if (cx + half > window.innerWidth) cx = window.innerWidth - half;
    else if (cx < half) cx = half;
    heatTip.style.left = cx + 'px';
    heatTip.style.top = (r.top - 8) + 'px';
  });
  document.addEventListener('mouseleave', function () { heatTip.style.opacity = 0; }, true);
  document.addEventListener('scroll', function () { heatTip.style.opacity = 0; }, true);

  /* ---------- 工作台 · AI 工具（issue #15） ---------- */
  function installedTools() {
    return (state.aiTools || []).filter(function (t) { return t.installed; });
  }

  function loadAiTools() {
    return api.aiToolsList().then(function (tools) {
      state.aiTools = tools || [];
      renderTools();
      // 详情面板开着时也刷新「AI 工具启动」区
      if (state.selectedPath) {
        var p = findProject(state.selectedPath);
        if (p) renderPanel(p);
      }
    }).catch(function () { state.aiTools = []; });
  }

  // 工具按钮：左侧 22px 品牌徽章 + 名称 + 命令（issue #21，工作台与详情面板共用）
  function toolButton(t, onPick) {
    var b = el('button', 'tool-btn');
    b.type = 'button';
    b.title = '在终端启动 ' + t.cmd;
    var logo = el('span', 'tool-logo');
    var icon = t.logo || { bg: '#322e27', svg: '' };
    logo.style.background = icon.bg;
    logo.innerHTML = '<svg viewBox="0 0 24 24">' + icon.svg + '</svg>';
    b.appendChild(logo);
    b.appendChild(el('span', 'nm', t.label));
    b.appendChild(el('span', 'cmd', t.cmd));
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onPick(b);
    });
    return b;
  }

  function renderTools() {
    var gridEl = document.getElementById('toolsGrid');
    if (!gridEl) return;
    gridEl.innerHTML = '';
    if (state.aiTools === null) return; // 探测中
    var tools = installedTools();
    if (!tools.length) {
      gridEl.appendChild(el('div', 'tools-empty', '未在 PATH 中检测到已安装的 AI 工具'));
      return;
    }
    tools.forEach(function (t) {
      gridEl.appendChild(toolButton(t, function (btn) { openToolPicker(t, btn); }));
    });
  }

  /* ---------- 工具项目选择器：复用搜索补全的 .drop 组件（issue #15） ---------- */
  var toolPickEl = null;

  function closeToolPicker() {
    if (toolPickEl) {
      toolPickEl.remove();
      toolPickEl = null;
    }
  }

  function openToolPicker(tool, btn) {
    if (toolPickEl && toolPickEl.dataset.cmd === tool.cmd) {
      closeToolPicker();
      return;
    }
    closeToolPicker();
    if (!state.board || !state.board.projects.length) return;

    var drop = el('div', 'drop tool-pick open');
    drop.dataset.cmd = tool.cmd;
    var inWrap = el('div', 'tp-in');
    var input = el('input');
    input.type = 'text';
    input.placeholder = '选择项目，在其目录启动 ' + tool.cmd;
    input.spellcheck = false;
    inWrap.appendChild(input);
    drop.appendChild(inWrap);
    var list = el('div');
    drop.appendChild(list);

    var cands = projectOrder(state.board.projects);
    var idx = 0;
    // 默认预选主攻项目（图钉集合中的第一个仍在板上的）
    var pre = pinnedList().filter(function (path) { return findProject(path); })[0];
    if (pre) {
      var pi = cands.map(function (p) { return p.path; }).indexOf(pre);
      if (pi >= 0) idx = pi;
    }

    function renderList() {
      list.innerHTML = '';
      if (!cands.length) {
        list.appendChild(el('div', 'drop-empty', '无匹配项目'));
        return;
      }
      cands.forEach(function (p, i) {
        var item = el('button', 'drop-item' + (i === idx ? ' active' : ''));
        item.type = 'button';
        item.appendChild(el('span', 'nm mono', p.name));
        item.appendChild(el('span', 'rt', p.memo || BAND_LABEL[p.band]));
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          pick(p);
        });
        list.appendChild(item);
      });
      var active = list.querySelector('.drop-item.active');
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }

    function pick(p) {
      closeToolPicker();
      api.aiToolsOpen(tool.cmd, p.path).then(function (ok) {
        flashBtn(btn, ok ? '已启动' : '启动失败', ok);
        setTimeout(renderTools, 950);
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      cands = projectOrder(state.board.projects).filter(function (p) {
        return !q || (p.name + ' ' + (p.memo || '')).toLowerCase().indexOf(q) >= 0;
      });
      idx = 0;
      renderList();
    });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!cands.length) return;
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + cands.length) % cands.length;
        renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (cands[idx]) pick(cands[idx]);
      } else if (e.key === 'Escape') {
        closeToolPicker();
      }
    });

    toolsCard.appendChild(drop);
    toolPickEl = drop;
    renderList();
    input.focus();
  }

  /* ---------- AI 功能（issue #29）：能力探测 + 周报 + 详情建议 + 自然语言筛选 ---------- */
  // 入口显隐总闸：开关关闭或未探测到可用引擎时，所有 AI 入口隐藏
  function aiReady() {
    return !!(state.aiCaps && state.aiCaps.enabled && state.aiCaps.engine);
  }

  function loadAiCaps() {
    return api.aiCaps().then(function (caps) {
      state.aiCaps = caps || { enabled: false, engine: null };
      renderAiWeeklyEntry();
      if (state.selectedPath) {
        var p = findProject(state.selectedPath);
        if (p) renderPanel(p);
      }
    }).catch(function () { state.aiCaps = { enabled: false, engine: null }; });
  }

  // AI 正文结构化渲染（issue #47/#48）：识别小标题 / 列表行 / **加粗**，把 markdown-lite 排成可读版式；
  // 引擎输出不守约定时退化为普通段落，不会渲染出原始符号噪声
  function aiInline(node, text) {
    String(text).split(/(\*\*[^*\n]+\*\*)/g).forEach(function (pt) {
      var b = pt.match(/^\*\*([^*\n]+)\*\*$/);
      if (b) node.appendChild(el('b', null, b[1]));
      else if (pt) node.appendChild(document.createTextNode(pt));
    });
    return node;
  }

  function appendAiRich(container, text) {
    var list = null;
    String(text || '').split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) { list = null; return; }
      var m = line.charAt(0) === '#'
        ? line.match(/^#{1,4}\s*(.+?)\s*#*$/)
        : line.match(/^【(.{1,30})】$/);
      if (m) {
        list = null;
        container.appendChild(aiInline(el('div', 'ai-h'), m[1]));
        return;
      }
      var b = line.match(/^[-*•·]\s+(.+)$/) || line.match(/^\d{1,2}[.、)]\s*(.+)$/);
      if (b) {
        if (!list) { list = el('ul', 'ai-list'); container.appendChild(list); }
        list.appendChild(aiInline(el('li'), b[1]));
        return;
      }
      list = null;
      var key = /^(本周总览|本周建议关注|近况概览|下周建议|建议关注)[:：]/.test(line);
      container.appendChild(aiInline(el('div', key ? 'ai-p ai-key' : 'ai-p'), line));
    });
  }

  // AI 结果区：徽标（引擎 + 生成时间，issue #43 精简）+ 结构化正文/错误；box 内重建
  function fillAiBox(box, r) {
    box.innerHTML = '';
    if (!r || !r.ok) {
      box.appendChild(el('div', 'ai-err', (r && r.reason) ? 'AI 生成失败：' + r.reason : 'AI 生成失败，可稍后重试'));
      return;
    }
    var body = el('div', 'ai-text');
    appendAiRich(body, r.text);
    box.appendChild(body);
    var meta = el('div', 'ai-meta');
    meta.appendChild(el('span', 'ai-badge', r.engine.label + ' 生成'));
    if (r.at) meta.appendChild(el('span', 'ai-badge', relTime(r.at))); // 时效性（issue #32）
    box.appendChild(meta);
  }

  /* ----- AI 后台任务（issue #40）：任务注册表 + 切页恢复 ----- */
  // 任务一旦发起即在后台执行：切换项目/视图不中断、不重复发起；回来恢复「生成中」进度或展出结果
  function aiJobKey(kind, path) { return kind + '|' + (path || ''); }

  function startAiJob(kind, payload) {
    var key = aiJobKey(kind, payload.path);
    var job = state.aiJobs[key];
    if (job && job.status === 'running') return job; // 在飞任务复用（主进程侧同样有在飞去重）
    job = state.aiJobs[key] = { status: 'running', startAt: Date.now(), result: null };
    api.aiAsk(payload).then(function (r) {
      job.status = r && r.ok ? 'done' : 'error';
      job.result = r || null;
    }).catch(function () {
      job.status = 'error';
      job.result = null;
    }).finally(function () {
      refreshAiJobViews(key);
      // 注册表只承担「在飞态 + 一次性交接结果」：重绘后即清除，
      // 之后各视图统一走主进程 ai-cache 展出（单一事实源，HEAD 变化后不会出现陈旧建议）
      delete state.aiJobs[key];
    });
    return job;
  }

  // 任务落幕后重绘受影响视图：周报卡 / 当前打开的详情面板
  function refreshAiJobViews(key) {
    var kind = key.split('|')[0];
    if (kind === 'weekly') { renderAiWeeklyEntry(); return; }
    if (kind === 'advice') {
      var path = key.slice('advice|'.length);
      if (state.selectedPath === path) {
        var p = findProject(path);
        if (p) renderPanel(p);
      }
    }
  }

  // 「生成中」进行态：已等待秒数每秒刷新；行被重绘移除后定时器自清
  function paintAiRunning(box, btn, job) {
    box.classList.remove('hidden');
    box.innerHTML = '';
    // 注意：渲染分支调用时所在 section 可能尚未挂上 DOM，首帧文案必须无条件写入，
    // 定时器只在「曾挂载后被移除」时自清（issue #40 实测 bug）
    var line = el('div', 'ai-err', '');
    var makeText = function () {
      return 'AI 生成中…（本机 ' + state.aiCaps.engine.label + '，已等待 ' +
        Math.max(0, Math.round((Date.now() - job.startAt) / 1000)) + ' 秒；可切换到别处，完成后回来查看）';
    };
    line.textContent = makeText();
    box.appendChild(line);
    var timer = setInterval(function () {
      if (!line.isConnected) { clearInterval(timer); return; }
      line.textContent = makeText();
    }, 1000);
    btn.dataset.busy = '1';
    btn.textContent = '生成中…';
  }

  /* ----- P0 · AI 周报（总览页独立模块，issue #32；手动触发，当天缓存；后台执行 issue #40） ----- */
  // 打开应用即有周报（issue #42）：今日无缓存时启动后自动生成一次（后台执行）；
  // 自动生成失败保持安静（不展示错误条），用户仍可手动点「生成周报」
  var weeklyAutoDay = ''; // 自动生成标记与当天日期绑定：应用常驻跨天后复位，第二天无缓存时再自动生成一次

  function renderAiWeeklyEntry() {
    var card = document.getElementById('aiWeeklyCard');
    if (!card) return;
    card.classList.toggle('hidden', !aiReady());
    if (!aiReady()) return;
    var btn = document.getElementById('aiWeeklyBtn');
    var box = document.getElementById('aiWeeklyBox');
    var job = state.aiJobs[aiJobKey('weekly')];
    if (job && job.status === 'running') { paintAiRunning(box, btn, job); return; }
    delete btn.dataset.busy;
    btn.textContent = '✦ 生成周报';
    if (job) {
      if (job.status === 'error' && job.auto) return; // 自动生成失败保持安静（issue #42）
      // 刚完成的后台任务：直接展出交接结果
      box.classList.remove('hidden');
      fillAiBox(box, job.result);
      return;
    }
    // 今日已生成过的周报直接展出（只读缓存，不触发新生成），模块内标明模型与生成时间；
    // 主进程有同任务在飞时回 pending（如页面重载后）→ 转为正式请求并入该任务；
    // 今日无缓存 → 启动后自动后台生成一次（issue #42）
    api.aiAsk({ kind: 'weekly', cachedOnly: true }).then(function (r) {
      if (r && r.ok) {
        box.classList.remove('hidden');
        fillAiBox(box, r);
      } else if (r && r.reason === 'pending') {
        startAiJob('weekly', { kind: 'weekly' });
        renderAiWeeklyEntry();
      } else if (r && r.reason === 'no-cache' && weeklyAutoDay !== localDateStr(new Date())) {
        weeklyAutoDay = localDateStr(new Date());
        var j = startAiJob('weekly', { kind: 'weekly' });
        j.auto = true;
        renderAiWeeklyEntry();
      }
    }).catch(function () {});
  }

  function bindAiWeekly() {
    var btn = document.getElementById('aiWeeklyBtn');
    btn.addEventListener('click', function () {
      if (btn.dataset.busy) return;
      startAiJob('weekly', { kind: 'weekly' });
      renderAiWeeklyEntry();
    });
  }

  /* ----- P0 · 项目 AI 建议（详情面板，按 项目+HEAD 缓存；后台执行 issue #40） ----- */
  // 生成按钮收进标题行（issue #38）；已缓存的建议打开面板即默认展开，不再多点一次
  function renderAiAdviceSec(p) {
    if (!aiReady()) return null;
    var s = sec('AI 建议');
    var btn = el('button', 'ai-btn', '✦ 生成建议');
    btn.type = 'button';
    btn.title = '用本机 ' + state.aiCaps.engine.label + ' 分析该项目 git 信号';
    s.firstChild.appendChild(btn);
    var box = el('div', 'ai-box hidden');
    s.appendChild(box);
    var key = aiJobKey('advice', p.path);
    var job = state.aiJobs[key];
    if (job && job.status === 'running') {
      paintAiRunning(box, btn, job); // 后台任务在飞：切出去再回来恢复进行态
    } else if (job) {
      box.classList.remove('hidden');
      fillAiBox(box, job.result); // 刚完成的后台任务：直接展出交接结果
      if (job.result && job.result.ok) btn.textContent = '✦ 重新生成';
    } else {
      // 默认展开：只取缓存（不触发生成），命中即展示并标明生成时间；pending = 主进程在飞，并入
      api.aiAsk({ kind: 'advice', path: p.path, cachedOnly: true }).then(function (r) {
        if (r && r.ok) {
          box.classList.remove('hidden');
          fillAiBox(box, r);
          btn.textContent = '✦ 重新生成';
        } else if (r && r.reason === 'pending') {
          startAiJob('advice', { kind: 'advice', path: p.path });
          if (box.isConnected && state.aiJobs[key]) paintAiRunning(box, btn, state.aiJobs[key]);
        }
      }).catch(function () {});
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.dataset.busy) return;
      var j = startAiJob('advice', { kind: 'advice', path: p.path });
      paintAiRunning(box, btn, j);
    });
    return s;
  }

  /* ----- P1 · 自然语言筛选（搜索框 Enter，无补全选中项时触发；失败回退普通关键字） ----- */
  function applyAiFilter(query) {
    suggestEl.innerHTML = '';
    suggestEl.appendChild(el('div', 'drop-empty', 'AI 解析筛选条件中…'));
    suggestEl.classList.remove('hidden');
    suggestEl.classList.add('open');
    api.aiAsk({ kind: 'filter', query: query }).then(function (r) {
      closeSuggest();
      if (r && r.ok && r.filter) {
        state.aiFilter = { raw: query, keyword: r.filter.keyword, days: r.filter.days };
        if (r.filter.band) {
          state.band = r.filter.band;
        }
        switchView('projects');
        syncChips();
        renderFilterChip();
        renderRows();
      } else {
        // 回退：按普通关键字搜索（跳第一个命中项），不阻断
        var cands = suggestCandidates();
        if (cands[0]) jumpToProject(cands[0].path);
      }
    }).catch(function () {
      closeSuggest();
      var cands = suggestCandidates();
      if (cands[0]) jumpToProject(cands[0].path);
    });
  }

  function renderFilterChip() {
    var chip = document.getElementById('aiFilterChip');
    chip.innerHTML = '';
    if (!state.aiFilter) {
      chip.classList.add('hidden');
      return;
    }
    chip.classList.remove('hidden');
    chip.appendChild(el('span', null, 'AI 筛选：' + state.aiFilter.raw));
    var x = el('button', 'x', '×');
    x.type = 'button';
    x.title = '清除筛选';
    x.addEventListener('click', function () {
      clearAiFilter();
      renderRows();
    });
    chip.appendChild(x);
  }

  function clearAiFilter() {
    state.aiFilter = null;
    state.band = 'all';
    syncChips();
    renderFilterChip();
  }

  // 筛选应用于行列表：band 走既有 chips 状态，keyword/days 由此叠加
  function aiFilterPass(p) {
    var f = state.aiFilter;
    if (!f) return true;
    if (f.days) {
      if (!p.lastActivityAt) return false;
      if (Date.now() - Date.parse(p.lastActivityAt) > f.days * DAY_MS) return false;
    }
    if (f.keyword) {
      var hay = (p.name + ' ' + (p.memo || '')).toLowerCase();
      if (hay.indexOf(f.keyword.toLowerCase()) < 0) return false;
    }
    return true;
  }

  /* ---------- 项目页：行列表（issue #16） ---------- */

  function projectRow(p) {
    var row = el('div', 'row' + (state.selectedPath === p.path ? ' selected' : ''));
    row.setAttribute('data-band', p.band);
    row.dataset.path = p.path;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (canDrag()) row.draggable = true;

    var main = el('div', 'r-main');
    var top = el('div', 'r-top');
    var name = el('span', 'r-name mono', p.name);
    name.title = p.name;
    top.appendChild(name);
    if (p.branch) top.appendChild(el('span', 'r-branch mono', p.branch));
    main.appendChild(top);
    main.appendChild(el('div', 'r-sub' + (p.memo ? '' : ' empty'), p.memo || '无备忘'));
    row.appendChild(main);

    var right = el('div', 'r-right');
    if (p.warnings && p.warnings.length) {
      // 行内警示（issue #77）：每类一个小图形，替代单一警示点 + 计数
      var w = el('span', 'r-warn');
      warnTypesOf(p.warnings).forEach(function (t) {
        w.appendChild(el('i', 'wg ' + warnGlyphClass(t)));
      });
      w.title = p.warnings.map(function (x) { return x.label; }).join('，');
      right.appendChild(w);
    }
    right.appendChild(el('span', 'r-upd', relTime(p.lastActivityAt)));

    var pin = el('button', 'r-pin' + (isPinned(p.path) ? ' on' : ''), isPinned(p.path) ? '★' : '☆');
    pin.type = 'button';
    pin.title = '图钉：主攻项目任意排序下置顶';
    pin.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePin(p.path);
    });
    right.appendChild(pin);

    var open = el('button', 'r-open', '›');
    open.type = 'button';
    open.title = '展开详情';
    right.appendChild(open);
    row.appendChild(right);

    row.addEventListener('click', function () {
      selectProject(state.selectedPath === p.path ? null : p.path);
    });
    // 键盘打开详情：焦点在行内控件（图钉/展开钮）时不触发行切换
    row.addEventListener('keydown', function (e) {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectProject(state.selectedPath === p.path ? null : p.path);
      }
    });

    // 手动位序下拖拽重排（issue #18）
    row.addEventListener('dragstart', function (e) {
      if (!canDrag()) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.path);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      persistRowOrder();
    });
    row.addEventListener('dragover', function (e) {
      if (!canDrag()) return;
      e.preventDefault();
      var dragging = rowsEl.querySelector('.dragging');
      if (!dragging || dragging === row) return;
      var all = Array.prototype.slice.call(rowsEl.querySelectorAll('.row'));
      if (all.indexOf(dragging) < all.indexOf(row)) row.after(dragging);
      else row.before(dragging);
    });
    return row;
  }

  // 拖拽结束后按当前 DOM 顺序持久化 cardOrder（仅手动位序可达）
  function persistRowOrder() {
    var order = Array.prototype.map.call(rowsEl.querySelectorAll('.row'), function (r) {
      return r.dataset.path;
    });
    state.prefs = Object.assign({}, state.prefs, { cardOrder: order });
    api.setPrefs({ cardOrder: order });
    renderRows();
  }

  function renderRows() {
    rowsEl.innerHTML = '';
    if (!state.board) return;
    var list = sortedProjects();
    if (!list.length) {
      if (state.board.projects.length) rowsEl.appendChild(el('div', 'rows-empty', '该分带下没有项目'));
      else rowsEl.appendChild(emptyGuide());
      return;
    }
    list.forEach(function (p) { rowsEl.appendChild(projectRow(p)); });
  }

  // 空项目引导卡：一句话简介 + 三步指引 + 打开设置主按钮
  function emptyGuide() {
    var box = el('div', 'board-empty');
    box.appendChild(el('div', 't', '还没有发现任何项目'));
    box.appendChild(el('div', 'be-desc', 'SignalBoard 自动聚合各项目的近况信号：提交、未提交改动、AI 会话痕迹、GitHub issues/PR，帮你一眼回忆起每个项目做到哪了。'));
    var steps = el('ol', 'be-steps');
    ['打开设置，添加扫描根目录', '用「扫描预览」确认能发现项目', '保存后自动开始扫描，项目随即展出'].forEach(function (s) {
      steps.appendChild(el('li', null, s));
    });
    box.appendChild(steps);
    var btn = el('button', 'btn solid', '打开设置');
    btn.type = 'button';
    btn.addEventListener('click', function () { showSettings(); });
    box.appendChild(btn);
    return box;
  }

  /* ---------- 详情面板（issue #17） ---------- */
  function updateSplit() {
    splitEl.classList.toggle('open', !!state.selectedPath);
  }

  function selectProject(path) {
    state.selectedPath = path || null;
    updateSplit();
    Array.prototype.forEach.call(rowsEl.querySelectorAll('.row'), function (r) {
      r.classList.toggle('selected', r.dataset.path === state.selectedPath);
    });
    if (!state.selectedPath) return;
    var p = findProject(state.selectedPath);
    if (!p) {
      state.selectedPath = null;
      updateSplit();
      return;
    }
    renderPanel(p);
    ensureDetail(p);
  }

  // README 摘要 / AI 会话痕迹明细按需懒取；缓存失效后再次调用即重新拉取
  function ensureDetail(p) {
    if (state.details[p.path]) return;
    state.details[p.path] = 'loading';
    api.projectDetail(p.path).then(function (d) {
      state.details[p.path] = d || { readme: '', aiSessions: [] };
      if (state.selectedPath === p.path) {
        var cur = findProject(p.path);
        if (cur) renderPanel(cur);
      }
    }).catch(function () { state.details[p.path] = { readme: '', aiSessions: [] }; });
  }

  function sec(title) {
    var s = el('div', 'p-sec');
    var head = el('div', 'sec-head'); // 标题行：左侧标题，右侧可挂控件（issue #37/#38/#34）
    head.appendChild(el('h4', null, title));
    s.appendChild(head);
    return s;
  }

  function kv(parent, label, value) {
    var s = el('span');
    s.appendChild(document.createTextNode(label + ' '));
    s.appendChild(el('b', null, value));
    parent.appendChild(s);
  }

  function renderWarns(parent, p) {
    if (!p.warnings || !p.warnings.length) return;
    var box = el('div', 'warns');
    p.warnings.forEach(function (w) {
      var s = el('span', 'warn', w.label);
      s.insertBefore(el('i', 'wg ' + warnGlyphClass(w.type)), s.firstChild); // 类型图形（issue #77）
      var x = el('button', 'x', '×');
      x.title = '消音此警示（状态变化后自动复出）';
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        api.snooze(p.path, w.type, w.label).then(function () { refresh(false); });
      });
      s.appendChild(x);
      box.appendChild(s);
    });
    parent.appendChild(box);
  }

  function renderGithub(parent, p) {
    var gh = p.github;
    if (!gh) {
      var noToken = state.settings && !(state.settings.hasGithubToken || state.settings.githubToken);
      // 区分空态原因（issue #44/#46）：未配置 / 上次同步失败（短 TTL 后自动重试）/ 本人仓库同步中 / 非本人仓库
      var msg = noToken ? '未配置 GitHub'
        : p.githubError ? '同步失败：' + p.githubError + '（稍后自动重试）'
        : p.githubOwned ? 'GitHub 数据同步中…（完成后自动展示）'
        : '非本人项目，不拉取 GitHub 数据';
      parent.appendChild(el('div', 'gh-empty' + (p.githubError ? ' bad' : ''), msg));
      return;
    }
    parent.appendChild(el('div', 'gh-empty', '开放 issue ' + gh.openIssues + ' · 开放 PR ' + gh.openPRs));
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
    parent.appendChild(box);
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function renderPanel(p) {
    // 后台补丁重渲染时保住备忘编辑中的内容/焦点/光标与面板滚动位置
    var memoLive = document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains('memo-input') && panelIn.contains(document.activeElement);
    var memoTa = memoLive ? document.activeElement : null; // 旧 textarea：编辑会话基准随其 dataset 交接（issue #64）
    var memoVal = memoLive ? memoTa.value : null;
    var memoSel = memoLive ? [memoTa.selectionStart, memoTa.selectionEnd] : null;
    // 换项目时面板从顶部开始；同一项目的后台补丁重渲染才保留滚动位置（issue #63）
    var scrollTop = state.panelPath === p.path ? panelIn.scrollTop : 0;
    panelIn.innerHTML = '';
    var current = isCurrentBranch(p);
    var bd = branchDetailOf(p);

    // 面板头：分带 pill + 项目名 + 关闭钮
    var head = el('div', 'p-head');
    head.appendChild(el('span', 'bp ' + BAND_PILL[p.band], BAND_LABEL[p.band]));
    head.appendChild(el('span', 'nm', p.name));
    var close = el('button', 'p-close', '✕');
    close.type = 'button';
    close.title = '关闭 (Esc)';
    close.addEventListener('click', function () { selectProject(null); });
    head.appendChild(close);
    panelIn.appendChild(head);

    // 路径行：路径全文 + 复制按钮（issue #36）
    var pathRow = el('div', 'p-path mono');
    pathRow.appendChild(el('span', 'txt', p.path));
    var copyPath = el('button', 'p-copy');
    copyPath.type = 'button';
    copyPath.title = '复制路径';
    copyPath.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><path d="M8 4V2.6A1.6 1.6 0 0 0 6.4 1H2.6A1.6 1.6 0 0 0 1 2.6v3.8A1.6 1.6 0 0 0 2.6 8H4"/></svg>';
    copyPath.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(p.path).then(function () {
        copyPath.classList.add('ok');
        setTimeout(function () { copyPath.classList.remove('ok'); }, 900);
      }, function () {});
    });
    pathRow.appendChild(copyPath);
    panelIn.appendChild(pathRow);

    // 备忘：可编辑，保存回填行（Enter / 失焦保存，Esc 还原）
    var ta = el('textarea', 'memo-input');
    // Esc 还原基准 = 本次编辑会话起点（issue #64）：编辑中途的后台重绘会即时回填 p.memo，
    // 不能再以 p.memo 为基准；会话起点挂在旧 textarea 的 dataset 上随重绘交接
    // （须在面板清空前捕获旧节点，innerHTML 清空后 activeElement 已落到 body）
    var origMemo = (memoTa && typeof memoTa.dataset.memoOrig === 'string') ? memoTa.dataset.memoOrig : (p.memo || '');
    ta.dataset.memoOrig = origMemo;
    ta.value = origMemo;
    ta.placeholder = '写点备忘…';
    ta.rows = 1;
    ta.addEventListener('input', function () {
      autosize(ta);
      p.memo = ta.value; // 行上备忘随输入即时回填
      var rowEl = rowsEl.querySelector('.row[data-path="' + CSS.escape(p.path) + '"] .r-sub');
      if (rowEl) {
        rowEl.textContent = ta.value || '无备忘';
        rowEl.classList.toggle('empty', !ta.value);
      }
    });
    ta.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
      if (ev.key === 'Escape') { p.memo = origMemo; ta.value = origMemo; ta.blur(); }
    });
    ta.addEventListener('blur', function () {
      p.memo = ta.value.replace(/\s+$/, '');
      api.setMemo(p.path, p.memo);
      renderRows();
    });
    panelIn.appendChild(ta);
    if (memoVal !== null) {
      ta.value = memoVal;
      ta.focus();
      if (memoSel) ta.setSelectionRange(memoSel[0], memoSel[1]);
    }
    autosize(ta);

    // 快捷打开（issue #36：高频操作上移至头部区；AI 工具启动并入本节，issue #39）
    var qSec = sec('快捷打开');
    var quick = el('div', 'quick');
    [['打开文件夹', 'folder', 1], ['编辑器', 'editor'], ['终端', 'terminal']].forEach(function (pair) {
      var b = el('button', 'btn' + (pair[2] ? ' solid' : ''), pair[0]);
      b.type = 'button';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api.quickOpen(p.path, pair[1]).then(function (ok) {
          flashBtn(b, ok ? '已打开' : '打开失败', ok);
        });
      });
      quick.appendChild(b);
    });
    var copy = el('button', 'btn', '复制路径');
    copy.type = 'button';
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(p.path).then(
        function () { flashBtn(copy, '已复制', true); },
        function () { flashBtn(copy, '复制失败', false); }
      );
    });
    quick.appendChild(copy);
    qSec.appendChild(quick);
    // AI 工具启动：该项目目录一键直达（issue #15/#17，并入快捷打开）
    var tools = installedTools();
    if (tools.length) {
      var tRow = el('div', 'tools-row');
      tools.forEach(function (t) {
        tRow.appendChild(toolButton(t, function (btn) {
          api.aiToolsOpen(t.cmd, p.path).then(function (ok) {
            flashBtn(btn, ok ? '已启动' : '启动失败', ok);
            setTimeout(function () {
              if (state.selectedPath === p.path) {
                var cur = findProject(p.path);
                if (cur) renderPanel(cur);
              }
            }, 950);
          });
        }));
      });
      qSec.appendChild(tRow);
    }
    panelIn.appendChild(qSec);

    // 近况信号：分支下拉（懒取 branch:commits）、近7天提交、领先/落后远程、未提交数
    var sigSec = sec('近况信号');
    var kvRow = el('div', 'kv-row');
    renderBranchKv(kvRow, p);
    kv(kvRow, '近7天', p.commits7d + ' 提交');
    if (p.ahead > 0) kv(kvRow, '领先远程', String(p.ahead));
    if (p.hasUpstream && p.behind > 0) kv(kvRow, '落后远程', p.behind + ' 提交');
    if (current && p.dirtyCount > 0) kv(kvRow, '未提交', p.dirtyCount + ' 文件');
    sigSec.appendChild(kvRow);
    panelIn.appendChild(sigSec);

    // 警示 pill 全文案 + 消音 ×（工作区类信息只对当前分支显示）
    if (current && p.warnings && p.warnings.length) {
      var warnSec = sec('警示');
      renderWarns(warnSec, p);
      panelIn.appendChild(warnSec);
    }

    // AI 建议（issue #29）：按需调用本机 CLI，按 项目+HEAD 缓存；无可用引擎时整段隐藏
    var adviceSec = renderAiAdviceSec(p);
    if (adviceSec) panelIn.appendChild(adviceSec);

    // 本项目热力图：单月份日历视图，标题行标明月份并可翻页（issue #34）
    var heatSec = sec('热力图');
    var heatBox = el('div');
    heatSec.appendChild(heatBox);
    renderMonthHeat(heatBox, heatSec.firstChild, p);
    panelIn.appendChild(heatSec);

    // 近期提交（随分支下拉切换）
    var cSec = sec(current ? '近期提交' : '近期提交 · ' + selBranch(p));
    if (!bd) {
      cSec.appendChild(el('div', 'gh-empty', '加载分支数据…'));
    } else if (!bd.commits.length) {
      cSec.appendChild(el('div', 'gh-empty', '暂无提交记录'));
    } else {
      bd.commits.forEach(function (c) {
        var row = el('div', 'line-item');
        row.appendChild(el('span', 'msg', c.msg));
        row.appendChild(el('span', 'ago mono', c.rel));
        cSec.appendChild(row);
      });
    }
    panelIn.appendChild(cSec);

    // 未提交文件：默认收起（仅当前分支）
    if (current && p.dirtyFiles.length > 0) {
      var dSec = sec('未提交文件');
      var dt = el('button', 'dirty-toggle');
      dt.type = 'button';
      dt.appendChild(el('span', 'caret', '▶'));
      dt.appendChild(document.createTextNode(p.dirtyFiles.length + ' 个文件，点击展开'));
      var wrap = el('div', 'dirty-wrap');
      var din = el('div', 'dirty-in');
      var dl = el('div', 'dirty-list');
      p.dirtyFiles.forEach(function (f) { dl.appendChild(el('span', 'f mono', f)); });
      din.appendChild(dl);
      wrap.appendChild(din);
      dt.addEventListener('click', function () {
        var open = wrap.classList.toggle('open');
        dt.classList.toggle('open', open);
      });
      dSec.appendChild(dt);
      dSec.appendChild(wrap);
      panelIn.appendChild(dSec);
    }

    // 更多事实（issue #83）：低频区块（README 摘要 / AI 会话痕迹明细 / GitHub issues/PR）
    // 默认折叠为一组，进详情一屏内可见 备忘 + 快捷打开 + 近况信号 + 警示
    var detail = state.details[p.path];
    var moreParts = [];
    if (detail && detail !== 'loading' && detail.readme) {
      var rBlock = el('div', 'p-sub-block');
      rBlock.appendChild(el('h5', 'p-sub', 'README 摘要'));
      rBlock.appendChild(el('div', 'readme-s', detail.readme));
      moreParts.push({ t: 'README 摘要', node: rBlock });
    }
    if (detail && detail !== 'loading' && detail.aiSessions && detail.aiSessions.length) {
      var aBlock = el('div', 'p-sub-block');
      aBlock.appendChild(el('h5', 'p-sub', 'AI 会话痕迹'));
      detail.aiSessions.forEach(function (s) {
        var item = el('div', 'ai-item');
        item.appendChild(el('span', 'tool', AI_TOOL_LABEL[s.tool] || s.tool));
        item.appendChild(el('span', 'ago', relTime(s.at)));
        aBlock.appendChild(item);
      });
      moreParts.push({ t: 'AI 会话痕迹', node: aBlock });
    }
    var gBlock = el('div', 'p-sub-block');
    gBlock.appendChild(el('h5', 'p-sub', 'GitHub'));
    renderGithub(gBlock, p);
    moreParts.push({ t: 'GitHub', node: gBlock });

    var moreSec = sec('更多事实');
    var mToggle = el('button', 'dirty-toggle'); // 与未提交文件同款的收起/展开交互
    mToggle.type = 'button';
    mToggle.appendChild(el('span', 'caret', '▶'));
    mToggle.appendChild(document.createTextNode(moreParts.map(function (x) { return x.t; }).join(' · ') + '，点击展开'));
    var mWrap = el('div', 'dirty-wrap');
    var mIn = el('div', 'dirty-in');
    moreParts.forEach(function (x) { mIn.appendChild(x.node); });
    mWrap.appendChild(mIn);
    mToggle.addEventListener('click', function () {
      var open = mWrap.classList.toggle('open');
      mToggle.classList.toggle('open', open);
    });
    moreSec.appendChild(mToggle);
    moreSec.appendChild(mWrap);
    panelIn.appendChild(moreSec);
    state.panelPath = p.path;
    panelIn.scrollTop = scrollTop;
  }

  /* ---------- 视图切换与跳转 ---------- */
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    viewOverview.classList.toggle('hidden', view !== 'overview');
    viewProjects.classList.toggle('hidden', view !== 'projects');
    hideSettings();
    syncScrolled(); // 切换视图后按当前视图滚动位置重算过渡带状态（issue #28）
  }

  // 关注清单 / 活动流 / 搜索 → 跳项目页并推出该项目详情
  function jumpToProject(path) {
    var p = findProject(path);
    if (!p) return;
    switchView('projects');
    closeToolPicker();
    closeSuggest();
    searchInput.value = '';
    state.query = '';
    if (state.band !== 'all' && p.band !== state.band) {
      state.band = 'all';
      syncChips();
    }
    renderRows();
    selectProject(path);
    var target = rowsEl.querySelector('.row[data-path="' + CSS.escape(path) + '"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
  }

  function syncChips() {
    document.querySelectorAll('#bandChips button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-band') === state.band);
    });
  }

  /* ---------- 搜索自动补全（issue #6，命中即跳项目详情） ---------- */
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
        var rt = el('span', 'rt snip');
        if (!inName && p.memo) rt.appendChild(hlFrag(p.memo.slice(0, 40), q));
        else rt.textContent = BAND_LABEL[p.band];
        item.appendChild(rt);
        // mousedown 抢先于 input blur，保证点击可选中
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          jumpToProject(p.path);
        });
        suggestEl.appendChild(item);
      });
    }
    suggestEl.classList.remove('hidden');
    suggestEl.classList.add('open');
  }

  /* ---------- 排序下拉（issue #18） ---------- */
  function renderSortDrop() {
    sortDrop.innerHTML = '';
    SORT_MODES.forEach(function (m) {
      var item = el('button', 'drop-item');
      item.type = 'button';
      item.appendChild(el('span', 'nm', m === 'manual' ? '手动（可拖拽）' : SORT_LABEL[m]));
      if (m === state.sortMode) item.appendChild(el('span', 'cur', '当前'));
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        state.sortMode = m;
        api.setPrefs({ sortMode: m });
        document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[m];
        closeDrops();
        renderRows();
        renderSortDrop();
      });
      sortDrop.appendChild(item);
    });
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    var board = state.board;
    if (!board) return;
    document.getElementById('scanTime').textContent = hhmm(board.scannedAt);
    renderOverview();
    renderRows();
    // 选中项目仍在板上则刷新面板，否则收起
    if (state.selectedPath) {
      var p = findProject(state.selectedPath);
      if (p && (state.band === 'all' || p.band === state.band)) renderPanel(p);
      else selectProject(null);
    }
  }

  function renderSkeleton() {
    rowsEl.innerHTML = '';
    for (var i = 0; i < 6; i++) rowsEl.appendChild(el('div', 'skel'));
    // 总览统计在首次成功加载前显示占位，避免误导性的 0
    setStat('statAttn', '--', '项');
    setStat('statCommits', '--', '次');
    document.getElementById('statTotal').textContent = '--';
  }

  // 首屏加载失败：项目区骨架替换为错误条，重试按钮重新调 load
  function renderLoadError() {
    rowsEl.innerHTML = '';
    var box = el('div', 'board-empty');
    box.appendChild(el('div', 't', '加载失败'));
    box.appendChild(el('div', null, '项目数据加载出错，请稍后重试'));
    var retry = el('button', 'btn', '重试');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      renderSkeleton();
      load(false);
    });
    box.appendChild(retry);
    rowsEl.appendChild(box);
  }

  /* ---------- 数据 ---------- */
  // 扫描指示：顶栏细 spinner +「扫描中…」（issue #8）
  function setScanning(on) {
    document.getElementById('scanSpin').classList.toggle('hidden', !on);
    document.getElementById('scanLabel').textContent = on ? '扫描中' : '最后扫描';
  }

  // 缓存失效：新板数据到达时，HEAD 已变的项目清掉 README 摘要/AI 会话明细与分支提交缓存，
  // 否则旧内容会一直展到重启；面板正开在被清项目上时随即重新懒取
  function invalidateDetailCaches(board) {
    if (!state.board || !board) return;
    var prevHead = {};
    state.board.projects.forEach(function (p) { prevHead[p.path] = p.headSha; });
    board.projects.forEach(function (p) {
      if (!(p.path in prevHead) || prevHead[p.path] === p.headSha) return;
      delete state.details[p.path];
      Object.keys(state.branchDetail).forEach(function (k) {
        if (k.indexOf(p.path + ' ') === 0) delete state.branchDetail[k];
      });
      if (state.selectedPath === p.path) {
        ensureDetail(p);
        ensureBranchDetail(p, selBranch(p));
      }
    });
  }

  function load(force) {
    if (state.loading) return state.loadPromise; // 唤出重扫与定时 tick 去重，调用方挂在同一次在飞加载上
    state.loading = true;
    state.awaitPatch = false;
    setScanning(true);
    var promise = force ? api.rescan() : api.getBoard();
    var p = promise.then(function (board) {
      invalidateDetailCaches(board);
      state.board = board;
      renderAll();
      console.log('[devboard] rendered'); // 供 scripts/screenshot.js 等待
      // 缓存先出（issue #22）：陈旧数据已渲染，扫描指示保持，等后台重扫补丁到达再熄灭
      if (board && board.fromCache) state.awaitPatch = true;
    }).catch(function (err) {
      console.error('board 加载失败', err);
      // 首屏没有数据时骨架会永远停驻，换成可重试的错误条；已有旧板则保留
      if (!state.board) renderLoadError();
    }).finally(function () {
      state.loading = false;
      state.loadPromise = null;
      if (!state.awaitPatch) setScanning(false);
    });
    state.loadPromise = p;
    return p;
  }

  // 后台重扫补丁（issue #22）：整板替换渲染；若期间用户又在手动刷新则丢弃
  api.onBoardPatch(function (board) {
    if (state.loading) return;
    state.awaitPatch = false;
    invalidateDetailCaches(board);
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

  /* ---------- 主题（issue #27）：整体主题预设 + 强调色派生阶梯 ---------- */
  var DEFAULT_ACCENT = '#f5d90a';
  var THEME_PRESETS = ['#f5d90a', '#e8850c', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
  var CUSTOM_COLORS = [
    '#e5484d', '#f76b15', '#eab308', '#46a758', '#12a594', '#3b82f6',
    '#c0392b', '#d98e32', '#b8a60a', '#2e7d32', '#0e8074', '#1d4ed8',
    '#ef4444', '#f59e0b', '#f5d90a', '#10b981', '#14b8a6', '#60a5fa',
    '#6e56cf', '#d6409f', '#8b5cf6', '#ec4899', '#64748b', '#181818',
  ];
  // 整体主题：一套完整 token（背景/卡片/文字/深色块/分带/阴影），强调色在其上派生
  var THEMES = {
    warm: {
      label: '暖阳', accentDefault: '#f5d90a',
      vars: {
        '--bg': '#f5f2e8', '--card': '#fdfcf8', '--well': '#ece9dd',
        '--ink': '#181818', '--ink-2': '#4d463c', '--ink-3': '#857d6b',
        '--line': 'rgba(24,24,24,.09)', '--tile': '#322e27', '--tile-ink': '#fdfcf8', '--tile-ink2': '#a89f8e',
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
        '--ink': '#181c22', '--ink-2': '#47505b', '--ink-3': '#828b96',
        '--line': 'rgba(24,28,34,.09)', '--tile': '#2b313a', '--tile-ink': '#fbfcfd', '--tile-ink2': '#98a1ac',
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
        '--ink': '#17201a', '--ink-2': '#45544a', '--ink-3': '#7f8d82',
        '--line': 'rgba(23,32,26,.09)', '--tile': '#28332b', '--tile-ink': '#fcfdfb', '--tile-ink2': '#9aaa9d',
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
        '--ink': '#211a1c', '--ink-2': '#53474b', '--ink-3': '#8d7d81',
        '--line': 'rgba(33,26,28,.09)', '--tile': '#382d31', '--tile-ink': '#fdfbf9', '--tile-ink2': '#b1a1a5',
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
        '--ink': '#1e1b26', '--ink-2': '#4a4656', '--ink-3': '#847f92',
        '--line': 'rgba(30,27,38,.09)', '--tile': '#302c3d', '--tile-ink': '#fbfbfd', '--tile-ink2': '#a29cae',
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
        '--ink': '#f0ece1', '--ink-2': '#c8c2b2', '--ink-3': '#8a8474',
        '--line': 'rgba(240,236,225,.10)', '--tile': '#ece7d8', '--tile-ink': '#1b1915', '--tile-ink2': '#6e695b',
        '--shadow-1': '0 1px 2px rgba(0,0,0,.30),0 14px 34px rgba(0,0,0,.35)',
        '--shadow-2': '0 2px 6px rgba(0,0,0,.35),0 22px 48px rgba(0,0,0,.45)',
        '--btn-line': 'rgba(240,236,225,.18)', '--btn-fail-bg': '#7a3d3a',
        '--band-active': '#d98e32', '--band-cool': '#6b8296', '--band-stale': '#6f695b', '--band-arch': '#4a463e',
        /* 警示语义色（issue #77）：深底卡片上亮琥珀；关注卡反浅，卡上图形用回深橙 */
        '--warn': '#f0a53c', '--warn-tile': '#b25a08', '--warn-pill': '#f0a53c', '--on-warn': '#23180a',
        /* 透玻璃背景板：深棕黑底 + 低明度光团；卡片用深色玻璃，关注卡（浅色 tile）用浅色玻璃 */
        '--bg-art': '#16140f',
        '--blob-2': 'rgba(158,196,167,.25)', '--blob-3': 'rgba(223,205,189,.18)', '--blob-4': 'rgba(179,199,216,.22)',
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
        '--ink': '#e9edf3', '--ink-2': '#c2c9d4', '--ink-3': '#7f8894',
        '--line': 'rgba(233,237,243,.10)', '--tile': '#e4e9f0', '--tile-ink': '#151a21', '--tile-ink2': '#5c6570',
        '--shadow-1': '0 1px 2px rgba(0,0,0,.30),0 14px 34px rgba(0,0,0,.35)',
        '--shadow-2': '0 2px 6px rgba(0,0,0,.35),0 22px 48px rgba(0,0,0,.45)',
        '--btn-line': 'rgba(233,237,243,.18)', '--btn-fail-bg': '#7a3d3a',
        '--band-active': '#d98e32', '--band-cool': '#6b8296', '--band-stale': '#5b6470', '--band-arch': '#414a56',
        '--warn': '#f2ab4a', '--warn-tile': '#b25a08', '--warn-pill': '#f2ab4a', '--on-warn': '#231a0b',
        /* 透玻璃背景板：藏青黑底 + 低明度光团，冷蓝加重；关注卡（浅色 tile）用浅色玻璃 */
        '--bg-art': '#10141a',
        '--blob-2': 'rgba(158,196,167,.2)', '--blob-3': 'rgba(223,205,189,.12)', '--blob-4': 'rgba(120,160,220,.25)',
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
    st.setProperty('--accent-soft', mixHex(accent, '#ffffff', 0.55));
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
    return { id: id, accent: hexToRgb(t.accent) ? t.accent : THEMES[id].accentDefault };
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
  var fWarnPr = document.getElementById('fWarnPr');
  var fNotifyEnabled = document.getElementById('fNotifyEnabled');
  var notifyModeSeg = document.getElementById('notifyModeSeg');
  var fTrayCount = document.getElementById('fTrayCount');
  var fPromptWeekly = document.getElementById('fPromptWeekly'); // 提示词模板自定义（issue #78）
  var fPromptAdvice = document.getElementById('fPromptAdvice');
  var deviceBox = document.getElementById('deviceBox');
  var deviceTimer = null;
  var deviceGen = 0; // 轮询代次号：stopDeviceFlow 递增，作废旧轮询链上在飞的回调
  fHotkey.readOnly = true; // 热键通过按键捕捉录入

  /* ----- 后台刷新间隔（issue #70）：预设 5/10/20/60 四档分段选择，改动随自动保存落盘、主进程即时重设定时器 ----- */
  var SCAN_INTERVALS = [5, 10, 20, 60];
  function renderScanInterval(min) {
    Array.prototype.forEach.call(scanIntervalSeg.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-min')) === min);
    });
  }
  function scanIntervalValue() {
    var b = scanIntervalSeg.querySelector('button.active');
    return b ? Number(b.getAttribute('data-min')) : 20;
  }
  scanIntervalSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    renderScanInterval(Number(b.getAttribute('data-min')));
    scheduleSave();
  });

  /* ----- 警示规则（issue #73）：超期天数 1/3/7 三档分段 + 三类开关；改动随自动保存落盘并触发重算 ----- */
  var WARN_DIRTY_DAYS = [1, 3, 7];
  function renderWarnDirtyDays(days) {
    Array.prototype.forEach.call(warnDirtyDaysSeg.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-days')) === days);
    });
  }
  function warnDirtyDaysValue() {
    var b = warnDirtyDaysSeg.querySelector('button.active');
    return b ? Number(b.getAttribute('data-days')) : 3;
  }
  warnDirtyDaysSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    renderWarnDirtyDays(Number(b.getAttribute('data-days')));
    scheduleSave();
  });

  /* ----- 通知（issue #80）：警示摘要开关 + 时机分段 + 托盘计数显隐；总开关关闭时时机分段禁用 ----- */
  var NOTIFY_MODES = ['daily', 'newOnly'];
  function renderNotifyMode(mode) {
    Array.prototype.forEach.call(notifyModeSeg.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      b.disabled = !fNotifyEnabled.checked;
    });
  }
  function notifyModeValue() {
    var b = notifyModeSeg.querySelector('button.active');
    return b ? b.getAttribute('data-mode') : 'daily';
  }
  notifyModeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    renderNotifyMode(b.getAttribute('data-mode'));
    scheduleSave();
  });
  fNotifyEnabled.addEventListener('change', function () { renderNotifyMode(notifyModeValue()); });

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
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  var themeId = 'warm';
  var themeAccent = DEFAULT_ACCENT;
  function setTheme(id, accent) {
    themeId = THEMES[id] ? id : 'warm';
    themeAccent = hexToRgb(accent) ? accent : THEMES[themeId].accentDefault;
    applyTheme(themeId, themeAccent);
    renderThemeCards();
    renderSwatches();
    scheduleSave();
  }
  function setThemeAccent(hex) { setTheme(themeId, hex); }
  function renderThemeCards() {
    var box = document.getElementById('themeCards');
    if (!box || box.childElementCount === 0) {
      // 首次构建：mini 预览 = 主题底色 + 卡片色 + 默认强调色点
      box.innerHTML = '';
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
    Array.prototype.forEach.call(box.children, function (b) {
      b.classList.toggle('active', b.dataset.theme === themeId);
    });
  }
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
      api.pickPath('directory').then(function (p) { if (p) { input.value = p; scheduleSave(); } });
    });
    row.appendChild(browse);
    var del = el('button', 'del', '删除');
    del.type = 'button';
    del.addEventListener('click', function () { row.remove(); scheduleSave(); });
    row.appendChild(del);
    listEl.appendChild(row);
  }

  // AI 工具自定义清单行（label + cmd + 图标选择，issue #15/#21，存 config.aiTools）
  var AI_ICON_CHOICES = [['', '默认（终端）'], ['claude', 'Claude'], ['codex', 'Codex'], ['kimi', 'Kimi'], ['grok', 'Grok']];
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

  // 默认 AI 引擎下拉（issue #29）：候选 = 已探测可用的工具；无可用工具时禁用并给提示
  function renderAiEngineSelect(cfg) {
    var hint = document.getElementById('aiEngineHint');
    fAiEngine.innerHTML = '';
    var avail = (state.aiTools || []).filter(function (t) { return t.installed; });
    if (!avail.length) {
      var o = el('option', null, '未检测到已安装的 AI 工具');
      o.value = '';
      fAiEngine.appendChild(o);
      fAiEngine.disabled = true;
      hint.textContent = '安装并登录 claude / codex / kimi / grok 任一工具后，AI 功能入口才会出现';
      return;
    }
    fAiEngine.disabled = false;
    avail.forEach(function (t) {
      var o = el('option', null, t.label + '（' + t.cmd + '）');
      o.value = t.id;
      fAiEngine.appendChild(o);
    });
    var wanted = cfg && cfg.aiEngine;
    fAiEngine.value = avail.some(function (t) { return t.id === wanted; }) ? wanted : avail[0].id;
    hint.textContent = '候选为本机已探测可用的工具';
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
    });
  }

  var firstRun = false; // 首次启动标记：自动打开设置并展示一次性欢迎提示

  function showSettings() {
    appEl.classList.add('show-settings');
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
      var wt = cfg.warningTypes || {}; // 三类警示开关（issue #73）
      fWarnDirty.checked = wt.dirty !== false;
      fWarnUnpushed.checked = wt.unpushed !== false;
      fWarnPr.checked = wt.pr !== false;
      fNotifyEnabled.checked = cfg.notifyEnabled !== false; // 警示摘要通知（issue #80）；先置开关再渲染时机分段（禁用态依赖它）
      renderNotifyMode(NOTIFY_MODES.indexOf(cfg.notifyMode) >= 0 ? cfg.notifyMode : 'daily');
      fTrayCount.checked = cfg.trayAttentionCount !== false; // 托盘计数显隐（issue #80）
      fAiEnabled.checked = cfg.aiEnabled !== false; // AI 功能总开关（issue #29）
      fillPromptTemplates(cfg); // 提示词模板（issue #78）：预填自定义值或内置默认
      loadAiTools().then(function () { renderAiEngineSelect(cfg); });
      var th = savedTheme();
      themeId = th.id;
      themeAccent = th.accent;
      renderThemeCards();
      renderSwatches();
      ghStateText();
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
      api.scanPreview({}).then(updateScanStat); // 扫描发现数常驻（issue #75）：进设置即按当前已存配置统计一次
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
      warningTypes: { dirty: fWarnDirty.checked, unpushed: fWarnUnpushed.checked, pr: fWarnPr.checked },
      notifyEnabled: fNotifyEnabled.checked, // 通知（issue #80）：主进程读配置即时生效，无需重拉板数据
      notifyMode: notifyModeValue(),
      trayAttentionCount: fTrayCount.checked,
      aiEnabled: fAiEnabled.checked, // AI 功能开关（issue #29）
      aiEngine: fAiEngine.disabled ? '' : fAiEngine.value,
      aiPromptWeekly: promptDraftOf(fPromptWeekly, aiPromptDefaults().weekly), // 提示词模板（issue #78）：与默认一致存 null
      aiPromptAdvice: promptDraftOf(fPromptAdvice, aiPromptDefaults().advice),
      theme: { id: themeId, accent: themeAccent }, // 外观（issue #27）
    };
    var typedToken = fToken.value.trim();
    if (typedToken) patch.githubToken = typedToken; // 留空 = 保持已存 token（issue #12）
    // 改动域检测：避免每次击键都重扫 PATH / 重扫磁盘 / 重渲染
    var pathsChanged = JSON.stringify([patch.roots, patch.extraPaths, patch.blacklist]) !==
      JSON.stringify([prev.roots || [], prev.extraPaths || [], prev.blacklist || []]);
    var toolsChanged = JSON.stringify(patch.aiTools) !== JSON.stringify(prev.aiTools || []);
    var hotkeyChanged = patch.hotkey !== (prev.hotkey || '');
    // 编辑器/终端命令改动随停顿自动校验（issue #76），结果显示在原校验按钮旁的 res 位
    var editorChanged = patch.editorCmd !== (prev.editorCmd || 'code');
    var terminalChanged = patch.terminalCmd !== (prev.terminalCmd || '');
    // 警示规则改动需重算警示（issue #73）：天数或三类开关变化后重拉板数据，
    // 主进程拼板按新规则即时重算（缓存事实字段足够，不等重扫）
    var prevWt = prev.warningTypes || {};
    var warnChanged = patch.warningDirtyDays !== (prev.warningDirtyDays || 3) ||
      JSON.stringify(patch.warningTypes) !==
        JSON.stringify({ dirty: prevWt.dirty !== false, unpushed: prevWt.unpushed !== false, pr: prevWt.pr !== false });
    // AI 开关/引擎变化需重估能力（issue #29）；自定义工具清单变化同时影响两者
    var aiChanged = patch.aiEnabled !== (prev.aiEnabled !== false) || patch.aiEngine !== (prev.aiEngine || '');
    // 提示词模板改动（issue #78）：缓存键已含模板哈希，旧结果不会掩盖修改；
    // 周报自动生成标记复位，回到总览即按新模板自动重生成一次
    var promptChanged = patch.aiPromptWeekly !== (prev.aiPromptWeekly || null) ||
      patch.aiPromptAdvice !== (prev.aiPromptAdvice || null);
    api.setSettings(patch).then(function (cfg) {
      state.settings = cfg;
      ghStateText();
      if (typedToken) fToken.value = '';
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
      if (toolsChanged) loadAiTools(); // 自定义工具清单已变，重扫 PATH
      if (aiChanged || toolsChanged) loadAiCaps(); // AI 引擎/开关或可用工具集已变（issue #29）
      // 模板已改（issue #78）：复位周报自动生成标记；缓存键含模板哈希，旧结果已不会展出。
      // 设置页开着时不主动重生成（避免编辑途中反复起 AI 生成）；已关闭（hideSettings 触发 flushSave 的回调）则立即重估
      if (promptChanged) {
        weeklyAutoDay = '';
        if (!appEl.classList.contains('show-settings')) renderAiWeeklyEntry();
      }
      if (pathsChanged || toolsChanged || warnChanged) refresh(false);
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

  /* ---------- 事件绑定 ---------- */
  document.getElementById('winMin').addEventListener('click', api.winMin);
  document.getElementById('winMax').addEventListener('click', api.winMax);
  document.getElementById('winClose').addEventListener('click', api.winClose);
  document.getElementById('refreshBtn').addEventListener('click', function () { refresh(true); });
  document.getElementById('settingsBtn').addEventListener('click', function () {
    if (appEl.classList.contains('show-settings')) hideSettings(); else showSettings();
  });
  document.getElementById('addRoot').addEventListener('click', function () { pathRow(rootsList, ''); });
  document.getElementById('addExtra').addEventListener('click', function () { pathRow(extraList, ''); });
  document.getElementById('addAiTool').addEventListener('click', function () { aiToolRow('', ''); });
  document.getElementById('streamMore').addEventListener('click', function () {
    state.streamShown = Infinity;
    renderStream();
  });
  document.getElementById('browseEditor').addEventListener('click', function () {
    api.pickPath('file').then(function (p) { if (p) { fEditor.value = p; scheduleSave(); } });
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
        state.settings = Object.assign({}, state.settings, { hasGithubToken: true, githubUsername: r.login || '' });
        if (!fUsername.value.trim() && r.login) fUsername.value = r.login;
        ghStateText();
        renderGhAccount();
        ghAuthResult(true, '已从 gh 导入 · 登录名 ' + (r.login || ''));
      } else {
        ghAuthResult(false, r.reason || '导入失败');
      }
    });
  });
  // 账户状态卡操作（issue #45）：重新验证 / 断开连接
  document.getElementById('ghRecheckBtn').addEventListener('click', renderGhAccount);
  document.getElementById('ghDisconnectBtn').addEventListener('click', function () {
    var btn = document.getElementById('ghDisconnectBtn');
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      btn.textContent = '再点一次确认断开';
      setTimeout(function () {
        delete btn.dataset.confirm;
        btn.textContent = '断开连接';
      }, 2000);
      return;
    }
    delete btn.dataset.confirm;
    btn.textContent = '断开连接';
    api.githubDisconnect().then(function () {
      state.settings = Object.assign({}, state.settings, { hasGithubToken: false, githubUsername: '' });
      fUsername.value = '';
      document.getElementById('ghAccount').classList.add('hidden');
      ghStateText();
      ghAuthResult(true, '已断开 GitHub 连接');
    });
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

  // 导入后重新拉取并重填：导入覆盖了 config/prefs/memos，设置字段与板数据都需按新值重展
  function applyImportedData() {
    showSettings();
    api.getPrefs().then(function (p) {
      state.prefs = p;
      state.branchSel = (p && p.branchSel) || {};
      state.sortMode = (p && p.sortMode) || 'manual';
      document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[state.sortMode];
      renderSortDrop();
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

  // 「再点一次确认」模式（沿用断开连接，issue #45）：首次点击武装 2 秒，二次点击才执行
  function armConfirm(btn, label, fn) {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      btn.textContent = '再点一次确认';
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
          document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[state.sortMode];
          renderSortDrop();
          refresh(false);
        });
      });
    });
  });

  document.getElementById('resetAllBtn').addEventListener('click', function () {
    armConfirm(document.getElementById('resetAllBtn'), '清空全部数据', function () {
      var res = document.getElementById('resetRes');
      res.textContent = '已清空，正在重启…';
      res.className = 'res ok';
      api.resetData('all'); // 主进程清空全部数据文件后 relaunch，重启回首启引导态
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

  // 顶层导航：总览 | 项目（issue #14）
  document.querySelectorAll('#nav button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchView(btn.getAttribute('data-view'));
    });
  });

  // 顶栏过渡带（issue #28）：内容滚动后浮现细分隔线
  function syncScrolled() {
    var v = state.view === 'projects' ? viewProjects : viewOverview;
    appEl.classList.toggle('scrolled', v.scrollTop > 8);
  }
  [viewOverview, viewProjects].forEach(function (v) {
    v.addEventListener('scroll', syncScrolled, { passive: true });
  });

  // 项目页分带筛选 chips（issue #16）；手动切换分带即退出 AI 筛选（issue #29）
  document.querySelectorAll('#bandChips button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.band = btn.getAttribute('data-band');
      if (state.aiFilter) {
        state.aiFilter = null;
        renderFilterChip();
      }
      syncChips();
      selectProject(null);
      renderRows();
    });
  });

  // 排序下拉（issue #18）
  document.getElementById('sortBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var willOpen = !sortDrop.classList.contains('open');
    closeDrops();
    if (willOpen) sortDrop.classList.add('open');
  });

  // 搜索框：输入即补全，选中跳项目详情（issue #6）
  searchInput.addEventListener('input', function () {
    state.query = searchInput.value.trim().toLowerCase();
    state.suggestIdx = -1;
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
      var pick = state.suggestIdx >= 0 ? cands[state.suggestIdx] : null;
      if (pick) {
        e.preventDefault();
        jumpToProject(pick.path);
        return;
      }
      // 无补全选中项：AI 可用时按自然语言筛选项目列表（issue #29），否则回退首个命中
      if (state.query && aiReady()) {
        e.preventDefault();
        applyAiFilter(state.query);
        return;
      }
      if (cands[0]) {
        e.preventDefault();
        jumpToProject(cands[0].path);
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
      } else {
        searchInput.blur();
      }
    }
  });

  // 点击空白处：关闭浮层（分支下拉 / 补全 / 排序 / 工具项目选择器）
  document.addEventListener('click', function (e) {
    if (anyDropOpen() && !e.target.closest('.bdrop') && !e.target.closest('.search') && !e.target.closest('.sort-wrap') && !e.target.closest('.custom-color')) closeDrops();
    if (toolPickEl && !e.target.closest('.tool-pick') && !e.target.closest('.tool-btn')) closeToolPicker();
  });

  // 键盘流：Esc 逐层关闭（选择器/补全/下拉 → 设置 → 详情面板 → 隐藏到托盘）；/ 聚焦搜索
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return; // 输入框内的 Esc 由各控件自理
      if (toolPickEl) { closeToolPicker(); return; }
      if (anyDropOpen()) { closeDrops(); return; }
      if (appEl.classList.contains('show-settings')) { hideSettings(); return; }
      if (state.selectedPath) { selectProject(null); return; }
      api.winClose();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  api.onTick(function () { refresh(false); renderAiWeeklyEntry(); }); // 唤出/定时刷新时周报一并重估：跨天后无缓存可再自动生成一次
  api.onShowSettings(function () { showSettings(); });

  /* ---------- 启动 ---------- */
  renderSkeleton();
  api.getSettings().then(function (cfg) {
    state.settings = cfg;
    var th = savedTheme(); // 启动时恢复用户主题（整体配色 + 强调色，issue #27）
    themeId = th.id;
    themeAccent = th.accent;
    applyTheme(th.id, th.accent);
  });
  api.getPrefs().then(function (p) {
    state.prefs = p;
    state.branchSel = (p && p.branchSel) || {};
    state.sortMode = (p && p.sortMode) || 'manual';
    document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[state.sortMode];
    renderSortDrop();
    if (!p || !p.onboarded) { // 首次启动：自动打开一次设置，引导配置扫描根目录
      firstRun = true;
      state.prefs = Object.assign({}, state.prefs, { onboarded: true });
      api.setPrefs({ onboarded: true });
      showSettings();
    }
    if (state.board) renderAll();
  });
  loadAiTools();
  loadAiCaps(); // AI 入口显隐（issue #29）
  bindAiWeekly();
  load(false);
})();
