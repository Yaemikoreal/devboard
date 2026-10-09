/* devboard 渲染层：总览 | 项目 双视图 + 右侧推出详情面板 + 设置视图 */
/* 设计定稿：demos/demo-f-overview.html（issue #14/#15/#16/#17/#18） */
(function () {
  'use strict';

  var api = window.devboard;
  // 共享领域常量（issue-11 / #127）：经 preload 暴露，与主进程/mock 同源，不再手写本地副本
  var consts = window.devboardConsts;
  var BAND_DEFS = consts.BAND_DEFS;
  var BAND_LABEL = consts.BAND_LABEL;
  var BAND_PILL = consts.BAND_PILL;
  var WARN_SEVERITY = consts.WARN_SEVERITY; // 警示严重度排序；未知类型回退 9
  var heatLevel = consts.heatLevel; // 热力图色阶
  var localDateStr = consts.localDateStr; // AI 周报缓存的当天日期键
  var SORT_MODES = ['manual', 'activity', 'name'];
  var SORT_LABEL = { manual: '手动', activity: '最近活跃', name: '名称' };
  // AI 工具注册表派生（issue #123）：痕迹明细 label 与设置页图标选项由注册表经 preload 下发
  // （preload 侧 rendererConsts 单一派生点），渲染层直用，不再手写按工具 id 键控的本地副本
  var AI_TOOL_LABEL = consts.AI_TOOL_LABELS;
  var AI_ICON_CHOICES = [['', '默认（终端）']].concat(consts.AI_ICON_CHOICES);
  // 警示类型（issue #77）：类型图形 class；未知类型回退 dirty 图形
  var WARN_GLYPH = { dirty: 'wg-dirty', ahead: 'wg-ahead', ci: 'wg-ci', review: 'wg-review', pr: 'wg-pr' };
  // PR 条目 review 状态徽标（issue #144）：状态 -> 文案与样式档
  var REVIEW_BADGE = {
    CHANGES_REQUESTED: { text: '待改', cls: ' rv-changes' },
    APPROVED: { text: '已批', cls: ' rv-approved' },
    COMMENTED: { text: '评论', cls: '' },
  };
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
    boardGen: 0, // 当前板的扫描代次：过期补丁丢弃依据（issue #112）
    pendingPatch: null, // 拖拽在飞时排队的补丁，dragend 后放行（issue #100）
    pendingLoadPatch: null, // 加载在飞时排队的补丁，load 收尾后放行（issue #168 第 12 条）
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
    ghExpandedKey: null, // 详情面板 GitHub 区当前展开的条目 'owner/repo#n'（issue #146），不持久化
    ghDetailCache: {}, // 'owner/repo#n' -> 展开详情 | 'loading'（issue #146 按需拉取，会话内内存缓存）
    ghDetailAt: {}, // 'owner/repo#n' -> 缓存写入时间戳：ghDetailCache 的会话 TTL 用（issue #161）
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
    savePrefs({ pinned: list });
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
    }).catch(function (err) {
      delete state.branchDetail[p.path + ' ' + name]; // 不缓存失败态，下次选中可重试
      failTo('分支数据加载')(err);
    });
  }

  function selectBranch(p, name) {
    if (name === p.branch) delete state.branchSel[p.path];
    else state.branchSel[p.path] = name;
    savePrefs({ branchSel: state.branchSel });
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
      var lvl = heatLevel(n);
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
      var lvl = heatLevel(n);
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
    renderGhNotify();
    renderTools();
  }

  // GitHub 通知小节（issue #145）：仅本人仓库的未读事件流；警示是板上事实、通知是 GitHub 事件，
  // 分卡展出语义即区分；未连接/无未读不占版面，同步失败给一行提示（短 TTL 自动重试）
  var NOTIFY_TOP = 6; // 版面友好：最多展 6 条，总数在副标里交代
  function renderGhNotify() {
    var card = document.getElementById('ghNotifyCard');
    var list = document.getElementById('ghNotifyList');
    var n = state.board && state.board.notifications;
    var connected = state.settings && (state.settings.hasGithubToken || state.settings.githubToken);
    var items = (n && n.data) || [];
    if (!connected || (!items.length && !(n && n.error))) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    var sub = document.getElementById('ghNotifySub');
    sub.classList.remove('bad');
    if (!items.length && n && n.error) {
      sub.textContent = '同步失败：' + n.error + '（稍后自动重试）';
      sub.classList.add('bad');
      list.innerHTML = '';
      return;
    }
    // 旧数据 + 刷新失败（issue #163）：error 存在时不能静默照常展出旧未读数——过期的数字
    // 毫无提示会误导。副标追加失败说明（旧数据照展），与 per-repo 区旧数据旁展示 githubError 同口径
    sub.textContent = items.length + ' 条未读 · 仅本人仓库'
      + (n && n.error ? ' · 同步失败，数据可能过期' : '');
    if (n && n.error) sub.classList.add('bad');
    list.innerHTML = '';
    items.slice(0, NOTIFY_TOP).forEach(function (it) {
      var row = el('div', 'ntf-item');
      row.appendChild(el('i', 'ntf-dot'));
      row.appendChild(el('span', 'ntf-repo mono', it.repo));
      row.appendChild(el('span', 'ntf-reason', it.reasonLabel));
      row.appendChild(el('span', 't', it.title));
      row.title = it.repo + ' · ' + it.title;
      row.addEventListener('click', function () { api.openExternal(it.htmlUrl); });
      list.appendChild(row);
    });
    if (items.length > NOTIFY_TOP) {
      list.appendChild(el('div', 'ntf-more', '其余 ' + (items.length - NOTIFY_TOP) + ' 条在 GitHub 通知页'));
    }
  }

  /* ---------- 热力图悬停气泡（issue #19）：总览全年图与详情面板月份日历共用（issue #34） ---------- */
  var heatTip = el('div', 'heat-tip');
  document.body.appendChild(heatTip);
  // 定位合帧（issue #168 第 12 条）：原先每个 cell 各排一条双 rAF 链，一帧内掠过多个格子会排队多次
  // 「写样式 → 读 getBoundingClientRect/offsetWidth → 写样式」，每次读都强制一次同步布局。
  // 改为只保留最新目标、整帧最多一条链；回调内先读完再写，不在读写之间穿插。
  var heatTipTarget = null;
  var heatTipPending = 0;
  function placeHeatTip() {
    heatTipPending = 0;
    var c = heatTipTarget;
    if (!c || !c.isConnected) return;
    var r = c.getBoundingClientRect(); // 读
    var half = heatTip.offsetWidth / 2 + 8; // 读
    var cx = r.left + r.width / 2;
    // 气泡 fixed 定位跟随格子；贴窗口左右缘时钳制内收（面板滚动经 scroll 捕获隐藏）
    if (cx + half > window.innerWidth) cx = window.innerWidth - half;
    else if (cx < half) cx = half;
    heatTip.style.left = cx + 'px'; // 写
    heatTip.style.top = (r.top - 8) + 'px'; // 写
  }
  function scheduleHeatTip() {
    if (heatTipPending) return;
    heatTipPending = 1;
    // 宽度读取延迟两帧（issue #104）：写内容后立即读 offsetWidth 会强制同步布局；
    // 双 rAF 让本帧布局先落地再读（免强制）。定位晚一帧（~16ms）无感
    requestAnimationFrame(function () {
      requestAnimationFrame(placeHeatTip);
    });
  }
  document.addEventListener('mouseover', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('.cell') : null;
    if (!c || c.classList.contains('blank') || !c.dataset.tip || !c.closest('.gheat,.p-heat,.mheat')) {
      heatTipTarget = null;
      heatTip.style.opacity = 0;
      return;
    }
    heatTip.textContent = c.dataset.tip;
    heatTip.style.opacity = 1;
    heatTipTarget = c;
    scheduleHeatTip();
  });
  document.addEventListener('mouseleave', function () { heatTip.style.opacity = 0; }, true);
  // passive（issue #168 第 12 条）：捕获相滚动监听会在应用内每个滚动容器上逐次触发，
  // 只写一次样式，声明 passive 让浏览器不必等处理器返回即可继续滚动
  document.addEventListener('scroll', function () { heatTip.style.opacity = 0; }, { capture: true, passive: true });

  /* ---------- AI 域（issue #124 渲染层拆分）：工作台工具格/项目选择器、能力探测、周报、
     详情建议、自然语言筛选、后台任务注册表 → ai.js ----------
     板/渲染域入口经 ctx 注入（详情面板/行列表/搜索补全/视图切换）；AI 域函数在板域的
     调用点（renderOverview/renderPanel/renderRows/搜索/doc mousedown/Esc/onTick）经 var 别名零改动 */
  var ai = window.DevboardAi({
    state: state,
    api: api,
    el: el,
    BAND_LABEL: BAND_LABEL,
    relTime: relTime,
    findProject: findProject,
    renderPanel: renderPanel,
    projectOrder: projectOrder,
    pinnedList: pinnedList,
    flashBtn: flashBtn,
    toolsCard: toolsCard,
    sec: sec,
    suggestEl: suggestEl,
    closeSuggest: closeSuggest,
    suggestCandidates: suggestCandidates,
    switchView: switchView,
    syncChips: syncChips,
    renderRows: renderRows,
    jumpToProject: jumpToProject,
  });
  var installedTools = ai.installedTools;
  var loadAiTools = ai.loadAiTools;
  var loadAiCaps = ai.loadAiCaps;
  var renderTools = ai.renderTools;
  var toolButton = ai.toolButton;
  var closeToolPicker = ai.closeToolPicker;
  var aiReady = ai.aiReady;
  var renderAiWeeklyEntry = ai.renderAiWeeklyEntry;
  var renderAiAdviceSec = ai.renderAiAdviceSec;
  var applyAiFilter = ai.applyAiFilter;
  var renderFilterChip = ai.renderFilterChip;
  var aiFilterPass = ai.aiFilterPass;
  /* AI 能力探测 / 周报卡 / 详情建议区 / 自然语言筛选 / 后台任务注册表已随 AI 域拆至 ai.js（issue #124） */

  /* ---------- 项目页：行列表（issue #16） ---------- */

  // 拖拽在飞上下文（issue #110）：{node, rows}，dragover 高频触发时只做索引比较，
  // 不再每事件 querySelectorAll O(N) 查询；拖拽中到达的补丁也据此排队（issue #100）
  var dragState = null;

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
    if (p.handoffs && p.handoffs.unreadCount > 0) {
      // 交接未读点（issue #147）：新交接行内可见，进详情读后即消（与警示消音语义无关）
      name.classList.add('has-handoff');
      name.title = '有 ' + p.handoffs.unreadCount + ' 条未读交接';
    }
    name.title = name.title || p.name;
    top.appendChild(name);
    if (p.handoffs && p.handoffs.unreadCount > 0) {
      top.appendChild(el('span', 'r-handoff', '✉ ' + p.handoffs.unreadCount));
    }
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
      dragState = { node: row, rows: Array.prototype.slice.call(rowsEl.querySelectorAll('.row')) };
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      dragState = null;
      persistRowOrder();
      flushPendingPatch(); // 拖拽结束后放行排队的补丁（issue #100）
    });
    row.addEventListener('dragover', function (e) {
      if (!canDrag()) return;
      e.preventDefault();
      var dragging = dragState && dragState.node;
      if (!dragging || dragging === row) return;
      var all = dragState.rows;
      var ia = all.indexOf(dragging);
      var ib = all.indexOf(row);
      if (ia < 0 || ib < 0) return;
      if (ia < ib) row.after(dragging);
      else row.before(dragging);
      // DOM 移动后同步缓存数组，连续跨行移动时索引不过期（issue #110）
      all.splice(ia, 1);
      all.splice(ib, 0, dragging);
    });
    return row;
  }

  // 行列表键盘流（issue #86）：j/k 或 ↑/↓ 在行间移动焦点；Enter/Space 开详情由行自身 keydown 承担
  rowsEl.addEventListener('keydown', function (e) {
    var row = e.target && e.target.closest ? e.target.closest('.row') : null;
    if (!row || e.target !== row) return;
    var down = e.key === 'ArrowDown' || e.key === 'j';
    var up = e.key === 'ArrowUp' || e.key === 'k';
    if (!down && !up) return;
    var next = row[down ? 'nextElementSibling' : 'previousElementSibling'];
    while (next && !next.classList.contains('row')) next = next[down ? 'nextElementSibling' : 'previousElementSibling'];
    if (next) { e.preventDefault(); next.focus(); }
  });

  // 拖拽结束后按当前 DOM 顺序持久化 cardOrder（仅手动位序可达）
  function persistRowOrder() {
    var order = Array.prototype.map.call(rowsEl.querySelectorAll('.row'), function (r) {
      return r.dataset.path;
    });
    state.prefs = Object.assign({}, state.prefs, { cardOrder: order });
    savePrefs({ cardOrder: order });
    renderRows();
  }

  function renderRows() {
    // 焦点行保留（issue #100）：后台补丁整板重渲时，键盘流聚焦的行（含行内控件）重建后重新聚焦
    var activeEl = document.activeElement;
    var focusRow = activeEl && activeEl.closest ? activeEl.closest('.row') : null;
    var focusPath = focusRow ? focusRow.dataset.path : null;
    rowsEl.innerHTML = '';
    if (!state.board) return;
    var list = sortedProjects();
    if (!list.length) {
      if (state.board.projects.length) {
        // 分带空态（issue #86）：虚线圈小手绘替代一行灰字
        var re = el('div', 'rows-empty');
        re.innerHTML = '<svg class="re-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="7" stroke-dasharray="2.5 4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';
        re.appendChild(document.createTextNode('该分带下没有项目'));
        rowsEl.appendChild(re);
      } else rowsEl.appendChild(emptyGuide());
      return;
    }
    list.forEach(function (p) { rowsEl.appendChild(projectRow(p)); });
    if (focusPath) {
      var fr = rowsEl.querySelector('.row[data-path="' + CSS.escape(focusPath) + '"]');
      if (fr) fr.focus();
    }
  }

  // 空项目引导卡：手绘雷达图形 + 一句话简介 + 三步指引 + 打开设置主按钮
  function emptyGuide() {
    var box = el('div', 'board-empty');
    // 手绘图形（issue #86）：从圆心散出的三层雷达弧 + 基线，呼应 SignalBoard 的信号语言；虚线与圆角保持手绘感
    var art = el('div', 'be-art');
    art.innerHTML = '<svg viewBox="0 0 132 76" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">'
      + '<path d="M14 62h104" stroke-dasharray="1 6" opacity=".6"/>'
      + '<path d="M32 48a14 14 0 0 1 14 14"/>'
      + '<path d="M32 34a28 28 0 0 1 28 28" stroke-dasharray="3 5"/>'
      + '<path d="M32 20a42 42 0 0 1 42 42" stroke-dasharray="2 7" opacity=".7"/>'
      + '<circle cx="32" cy="62" r="2.6" fill="currentColor" stroke="none"/>'
      + '<circle cx="96" cy="30" r="1.8" fill="currentColor" stroke="none" opacity=".55"/>'
      + '<circle cx="110" cy="46" r="1.8" fill="currentColor" stroke="none" opacity=".4"/>'
      + '</svg>';
    box.appendChild(art);
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

  // 交接已读游标（issue #147）：进详情即把游标推到该仓最新交接时间，未读点行内即消。
  // 只在确有未读时写 prefs，避免每次选中项目都落盘
  function markHandoffsRead(p) {
    if (!p.handoffs || !(p.handoffs.unreadCount > 0)) return;
    var prefs = state.prefs || {};
    var cur = prefs.handoffReadAt || {};
    cur[p.path] = new Date().toISOString();
    prefs.handoffReadAt = cur;
    savePrefs({ handoffReadAt: cur });
    p.handoffs.unreadCount = 0; // 本地即时消点，不等下一轮拼板；行列表就地重渲（选中态经 projectRow 自恢复）
    renderRows();
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
    markHandoffsRead(p);
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
        api.snooze(p.path, w.type, w.label).then(function () { refresh(false); }).catch(failTo('消音警示')); // 写盘失败 toast 可见（issue #119）
      });
      s.appendChild(x);
      box.appendChild(s);
    });
    parent.appendChild(box);
  }

  // GitHub 区（issue #146 深化）：Release 节奏行 + 远程新提交交叉验证提示 + 可展开详情。
  // 点击条目改为就地展开（正文/评论流/diff 统计/reviewer），行尾外链图标保留原跳转
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
    // 最新 Release + 发布节奏（issue #146）：距上次发布的提交数来自 compare(tag...HEAD)
    if (gh.release && gh.release.tag) {
      var relRow = el('div', 'gh-rel');
      relRow.appendChild(el('span', 't', '最新 Release：' + (gh.release.name || gh.release.tag)
        + (typeof gh.release.aheadBy === 'number' ? ' · 距上次发布 ' + gh.release.aheadBy + ' 个提交' : '')
        + (gh.release.publishedAt ? ' · ' + relTime(gh.release.publishedAt) : '')));
      relRow.title = '在 GitHub 查看该 Release';
      relRow.addEventListener('click', function (e) {
        e.stopPropagation();
        api.openExternal(gh.release.url);
      });
      parent.appendChild(relRow);
    }
    // 远程有本地没有的提交（issue #146 元数据交叉验证）：本地在默认分支且无领先提交时，
    // 远程 HEAD sha 与本地 headSha 不同 → 另一台机器推过（裸 pushed_at 会把自己刚 push 也算进去，不用）
    if (gh.meta && gh.meta.remoteHeadSha && p.headSha && p.branch === gh.meta.defaultBranch
      && !p.ahead && p.headSha !== gh.meta.remoteHeadSha) {
      parent.appendChild(el('div', 'gh-remote', '远程默认分支有本地没有的提交（另一台机器推过？）'));
    }
    var box = el('div', 'gh');
    gh.items.forEach(function (it) {
      var key = gh.owner + '/' + gh.repo + '#' + it.number;
      var open = state.ghExpandedKey === key;
      var row = el('div', 'gh-item' + (open ? ' open' : ''));
      row.appendChild(el('span', 'tag' + (it.type === 'issue' ? ' issue' : ''), it.type === 'pr' ? 'PR' : 'ISS'));
      row.appendChild(el('span', 't', '#' + it.number + ' ' + it.title));
      // review 状态徽标（issue #144）：仅 PR 条目且拉到状态时展出
      if (it.type === 'pr' && it.reviewState && REVIEW_BADGE[it.reviewState]) {
        var b = REVIEW_BADGE[it.reviewState];
        row.appendChild(el('span', 'rv' + b.cls, b.text));
      }
      var ext = el('button', 'gh-ext', '↗');
      ext.title = '在 GitHub 打开';
      ext.addEventListener('click', function (e) {
        e.stopPropagation();
        api.openExternal(it.url);
      });
      row.appendChild(ext);
      row.addEventListener('click', function () {
        var c = state.ghDetailCache[key];
        // 错误态原地重试（issue #160）：展开中带错误行的条目，点击语义是「重试」而非「折叠」——
        // 原实现先折叠再展开要点两次才真正重拉。清掉错误缓存并保持展开，面板重渲即重新发起拉取
        if (open && c && c.error) {
          delete state.ghDetailCache[key];
          delete state.ghDetailAt[key];
          var errCur = findProject(state.selectedPath);
          if (errCur) renderPanel(errCur);
          return;
        }
        state.ghExpandedKey = open ? null : key;
        // 失败态在再次展开时清掉，让「点击条目重试」真的会重试（issue #168 第 5 条）
        if (c && c.error) {
          delete state.ghDetailCache[key];
          delete state.ghDetailAt[key];
        }
        var cur = findProject(state.selectedPath);
        if (cur) renderPanel(cur); // 展开态经折叠组重放保留（issue #100）
      });
      box.appendChild(row);
      if (open) {
        var db = el('div', 'gh-detail');
        box.appendChild(db);
        fillGhDetail(db, gh, it);
      }
    });
    parent.appendChild(box);
  }

  // 展开详情填充（issue #146）：缓存命中直接渲染；未命中现拉（按需 IPC，不进 JSON 缓存），
  // 拉到后经面板重渲走缓存渲染路径；失败落进共享缓存并重渲，给出可重试提示
  // 会话 TTL（issue #161）：板数据感知不到纯 GitHub 侧的变化（issue 新评论不改板上任何字段），
  // 条目对齐 GitHub 缓存的 10 分钟周期过期，到期展开即重拉；板侧失效见 invalidateDetailCaches
  var GH_DETAIL_TTL_MS = 10 * 60 * 1000;
  function ghDetailFresh(key) {
    var at = state.ghDetailAt[key];
    if (!at || Date.now() - at > GH_DETAIL_TTL_MS) {
      delete state.ghDetailCache[key];
      delete state.ghDetailAt[key];
      return false;
    }
    return true;
  }
  function fillGhDetail(box, gh, it) {
    var key = gh.owner + '/' + gh.repo + '#' + it.number;
    var cached = state.ghDetailCache[key];
    // TTL 到期的条目（含错误态）按未缓存处理，展开即重拉——纯 GitHub 侧的变化
    // （issue 新评论）板数据感知不到，靠周期性过期兜底（issue #161）
    if (cached && cached !== 'loading' && !ghDetailFresh(key)) cached = null;
    if (cached === 'loading') {
      box.appendChild(el('div', 'gh-detail-note', '加载中…'));
      return;
    }
    if (cached && cached.error) {
      box.appendChild(el('div', 'gh-detail-note bad', '详情获取失败：' + cached.error + '（点击条目重试）'));
      return;
    }
    if (cached && typeof cached === 'object') {
      renderGhDetail(box, cached);
      return;
    }
    state.ghDetailCache[key] = 'loading';
    box.appendChild(el('div', 'gh-detail-note', '加载中…'));
    api.githubItemDetail({ owner: gh.owner, repo: gh.repo, type: it.type, number: it.number }).then(function (d) {
      state.ghDetailCache[key] = d;
      state.ghDetailAt[key] = Date.now();
      var cur = findProject(state.selectedPath);
      if (cur) renderPanel(cur);
    }).catch(function (err) {
      // 失败经共享缓存 + 重渲落地（issue #168 第 5 条）：原实现把错误写进「请求发起时」捕获的 box 节点，
      // 若期间发生过任意一次重渲（补丁很频繁），错误就写进了已脱离 DOM 的节点——可见框永远停在
      // 「加载中…」，既没有错误也没有重试入口。落到共享缓存后，任何一次重渲都会重新展出失败态。
      state.ghDetailCache[key] = { error: (err && err.message) || String(err) };
      state.ghDetailAt[key] = Date.now();
      var cur = findProject(state.selectedPath);
      if (cur) renderPanel(cur);
    });
  }

  // 展开详情渲染（issue #146）：正文 / diff 统计（PR）/ reviewer 指派 / 评论流
  function renderGhDetail(box, d) {
    if (d.body) {
      box.appendChild(el('div', 'gh-detail-body', d.body));
    }
    if (d.pr) {
      var st = el('div', 'gh-detail-stats mono',
        (d.pr.additions != null ? '+' + d.pr.additions : '')
        + (d.pr.deletions != null ? ' −' + d.pr.deletions : '')
        + (d.pr.changedFiles != null ? ' · ' + d.pr.changedFiles + ' 个文件' : ''));
      box.appendChild(st);
      var reviewers = d.pr.reviewers || [];
      if (reviewers.length) {
        var rv = el('div', 'gh-detail-reviewers');
        rv.appendChild(el('span', 'k', 'reviewer：'));
        reviewers.forEach(function (r, i) {
          if (i) rv.appendChild(document.createTextNode('、'));
          rv.appendChild(el('span', 'v', r.login
            + (r.state === 'CHANGES_REQUESTED' ? '（待改）' : r.state === 'APPROVED' ? '（已批）' : r.state === 'PENDING' ? '（待审）' : '')));
        });
        box.appendChild(rv);
      }
    }
    var comments = d.comments || [];
    if (comments.length) {
      var cw = el('div', 'gh-detail-comments');
      cw.appendChild(el('div', 'k', '评论 ' + comments.length + ' 条'));
      comments.slice(0, 8).forEach(function (c) {
        var item = el('div', 'cmt');
        // 来源标注（issue #164）：行级 review 评论与对话评论合并展出，行级标注所评文件路径
        var head = (c.user || '匿名') + (c.createdAt ? ' · ' + relTime(c.createdAt) : '');
        if (c.source === 'line') head += ' · 行级' + (c.path ? ' · ' + c.path : '');
        item.appendChild(el('div', 'ch', head));
        item.appendChild(el('div', 'cb', c.body));
        cw.appendChild(item);
      });
      box.appendChild(cw);
    }
    if (!d.body && !comments.length && !d.pr) {
      box.appendChild(el('div', 'gh-detail-note', '无正文与评论'));
    }
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  // 自适应高度合帧（issue #168 第 12 条）：autosize 写 height 再读 scrollHeight 会强制一次整文档布局，
  // 每击键各来一次没必要——合并到下一帧只做一次，输入观感不变
  var autosizeRaf = 0;
  var autosizeTarget = null;
  function scheduleAutosize(ta) {
    autosizeTarget = ta;
    if (autosizeRaf) return;
    autosizeRaf = requestAnimationFrame(function () {
      autosizeRaf = 0;
      if (autosizeTarget && autosizeTarget.isConnected) autosize(autosizeTarget);
    });
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
    // 折叠组（未提交文件/更多事实）展开态按出现顺序记录，重建后重放（issue #100）
    var openToggles = [];
    if (state.panelPath === p.path) {
      Array.prototype.forEach.call(panelIn.querySelectorAll('.dirty-toggle'), function (t) {
        openToggles.push(t.classList.contains('open'));
      });
    }
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
    var rowSub = null; // 行上备忘节点缓存（issue #168 第 12 条）：原先每击键 querySelector 全表重匹配
    ta.addEventListener('input', function () {
      scheduleAutosize(ta);
      p.memo = ta.value; // 行上备忘随输入即时回填
      if (!rowSub || !rowSub.isConnected) {
        rowSub = rowsEl.querySelector('.row[data-path="' + CSS.escape(p.path) + '"] .r-sub');
      }
      if (rowSub) {
        rowSub.textContent = ta.value || '无备忘';
        rowSub.classList.toggle('empty', !ta.value);
      }
    });
    ta.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
      if (ev.key === 'Escape') { p.memo = origMemo; ta.value = origMemo; ta.blur(); }
    });
    ta.addEventListener('blur', function () {
      p.memo = ta.value.replace(/\s+$/, '');
      saveMemo(p.path, p.memo);
      renderRows();
      // 编辑期间被推迟的面板重建在此补上（issue #168 第 12 条）：此刻已失焦，不会自激
      if (pendingPanelPath) {
        pendingPanelPath = null;
        var cur = findProject(state.selectedPath);
        if (cur) renderPanel(cur);
      }
    });
    panelIn.appendChild(ta);
    if (memoVal !== null) {
      ta.value = memoVal;
      ta.focus();
      if (memoSel) ta.setSelectionRange(memoSel[0], memoSel[1]);
    }
    autosize(ta);

    // 交接区（issue #147）：与备忘并列，视觉上明确区分「agent 写 / 人写」——
    // agent 名 + 时间 + 正文 +「接力完成」标记；数据经按需 IPC（与 branch:commits 同款懒取不进板）
    if (p.handoffs && p.handoffs.latest) {
      var hoSec = sec('交接');
      var hoList = el('div', 'ho-list');
      var entries = p.handoffs.latest; // 摘要只带最新一条，全量经 handoff:list 懒取
      var renderHo = function (e) {
        var item = el('div', 'ho-item' + (e.doneAt ? ' done' : ''));
        var head = el('div', 'ho-head');
        head.appendChild(el('i', 'ho-ic'));
        head.appendChild(el('span', 'ho-agent mono', e.agent));
        head.appendChild(el('span', 'ho-time', relTime(e.createdAt)));
        if (e.doneAt) head.appendChild(el('span', 'ho-done', '已接力'));
        item.appendChild(head);
        item.appendChild(el('div', 'ho-text', e.text));
        if (!e.doneAt) {
          var done = el('button', 'ho-btn', '接力完成');
          done.type = 'button';
          done.title = '标记这条交接已被接力（仅标记，不改动任何项目文件）';
          done.addEventListener('click', function () {
            api.handoffMarkDone(p.path, e.id).then(function () {
              done.classList.add('ok');
              done.textContent = '已标记';
              done.disabled = true;
              refresh(false);
            }).catch(function (err) { toast('标记接力失败：' + ipcErrText(err)); });
          });
          item.appendChild(done);
        }
        return item;
      };
      hoList.appendChild(renderHo(entries));
      hoSec.appendChild(hoList);
      var more = el('button', 'ho-more', '查看全部交接');
      more.type = 'button';
      more.addEventListener('click', function () {
        more.disabled = true;
        api.handoffList(p.path).then(function (list) {
          more.remove();
          (list || []).slice(1).forEach(function (e) { hoList.appendChild(renderHo(e)); });
          if (hoList.children.length <= 1) {
            hoList.appendChild(el('div', 'ho-empty', '没有更多交接'));
          }
        }).catch(function (err) {
          more.disabled = false;
          toast('读取交接失败：' + ipcErrText(err));
        });
      });
      hoSec.appendChild(more);
      panelIn.appendChild(hoSec);
    }

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
        }).catch(function () { flashBtn(b, '打开失败', false); });
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
          }).catch(function () { flashBtn(btn, '启动失败', false); }); // IPC reject 也亮错（issue #119）
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
    // 折叠组展开态重放（issue #100）：索引对不上（如脏文件清零后区块消失）时宁误开不错关
    Array.prototype.forEach.call(panelIn.querySelectorAll('.dirty-toggle'), function (t, i) {
      if (openToggles[i]) t.click();
    });
    state.panelPath = p.path;
    panelIn.scrollTop = scrollTop;
  }

  /* ---------- 视图切换与跳转 ---------- */
  // 标题栏状态字（issue #86）：随视图/设置切换，替代与 logo 重复的应用名
  function syncTbName() {
    document.getElementById('tbName').textContent =
      appEl.classList.contains('show-settings') ? '设置' : (state.view === 'projects' ? '项目' : '总览');
  }
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    viewOverview.classList.toggle('hidden', view !== 'overview');
    viewProjects.classList.toggle('hidden', view !== 'projects');
    renderViewIfNeeded(view); // 补丁期间被标脏的隐藏视图在此补渲（issue #168 第 11 条）
    hideSettings();
    syncTbName();
    syncScrolled(); // 切换视图后按当前视图滚动位置重算过渡带状态（issue #28）
    // 「上次停留」着陆偏好（issue #86）：离开即记，唤出时按 landingView=last 恢复
    state.prefs = Object.assign({}, state.prefs, { lastView: view });
    savePrefs({ lastView: view });
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
        savePrefs({ sortMode: m });
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
  // GitHub 展开详情缓存（issue #161）：新板落地时该项目 GitHub 数据若已变化（新评论/review 会改
  // prReviews 或 items），该仓的展开详情缓存一并失效——原实现只清 details/branchDetail，
  // ghDetailCache 整会话不失效，展开条目直到重启都停留旧评论
  function invalidateDetailCaches(board) {
    if (!state.board || !board) return;
    var prevProj = {};
    state.board.projects.forEach(function (p) { prevProj[p.path] = p; });
    board.projects.forEach(function (p) {
      var old = prevProj[p.path];
      var headChanged = !old || old.headSha !== p.headSha;
      var ghChanged = JSON.stringify(old && old.github) !== JSON.stringify(p.github);
      if (!headChanged && !ghChanged) return;
      if (headChanged) {
        delete state.details[p.path];
        Object.keys(state.branchDetail).forEach(function (k) {
          if (k.indexOf(p.path + ' ') === 0) delete state.branchDetail[k];
        });
      }
      if (ghChanged) {
        // github 数据有变：失效该仓的展开详情（键形如 owner/repo#n）；
        // 无 github 数据可定位（断开/非本人仓库）时全清，宁多重拉不展旧账号内容
        var prefix = p.github && p.github.owner && p.github.repo ? p.github.owner + '/' + p.github.repo + '#' : null;
        Object.keys(state.ghDetailCache).forEach(function (k) {
          if (!prefix || k.indexOf(prefix) === 0) {
            delete state.ghDetailCache[k];
            delete state.ghDetailAt[k];
          }
        });
      }
      if (headChanged && state.selectedPath === p.path) {
        ensureDetail(p);
        ensureBranchDetail(p, selBranch(p));
      }
    });
  }

  /* ---------- IPC 失败兜底（issue #97）：invoke reject 不再静默 ---------- */
  function ipcErrText(err) {
    return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      t.setAttribute('role', 'alert');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4500);
  }

  // 返回一个 .catch 处理器：toast 出「<label>：<原因>」
  function failTo(label) {
    return function (err) {
      console.error('[devboard]', label, err);
      toast(label + '：' + ipcErrText(err));
    };
  }

  // 乐观 UI 的静默写（图钉/位序/分支选择/排序等着偏好即改即存）：写失败至少 toast 可见（issue #97）
  function savePrefs(patch) {
    api.setPrefs(patch).catch(failTo('保存偏好'));
  }
  function saveMemo(projectPath, text) {
    api.setMemo(projectPath, text).catch(failTo('保存备忘'));
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
      if (board && typeof board.scanGeneration === 'number') state.boardGen = board.scanGeneration;
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
      flushPendingLoadPatch(); // 加载期间到达的补丁在此落地（issue #168 第 12 条）
    });
    state.loadPromise = p;
    return p;
  }

  // 后台重扫补丁（issue #22）：整板替换渲染；若期间用户又在手动刷新则丢弃。
  // 增量形态（issue #94）：watcher 推 {project, stats, attention}，只就地替换该项目与全局聚合。
  // 拖拽在飞时排队到 dragend 后应用（issue #100），避免整板重渲打断拖拽
  function handleBoardPatch(patch) {
    // 加载在飞时的补丁排队而非丢弃（issue #168 第 12 条）：原实现直接 return。走缓存路径时
    // state.awaitPatch=true，而「扫描中」指示要等补丁（或 scanfail）才熄灭；丢掉唯一那个补丁
    // 会让数据停在旧值、指示器挂到下一个 tick（默认 20 分钟）
    if (state.loading) { state.pendingLoadPatch = patch; return; }
    if (patch && typeof patch.scanGeneration === 'number' && state.board) {
      // 过期补丁丢弃（issue #112）：手动刷新落地后，旧代次的迟到补丁不再盖回旧数据
      if (patch.scanGeneration < state.boardGen) return;
      // 同代次整板补丁且不在等补丁：同一次扫描的重演，跳过重复渲染
      if (patch.scanGeneration === state.boardGen && !patch.project && !state.awaitPatch) return;
    }
    if (dragState) { state.pendingPatch = patch; return; } // 拖拽在飞：排队（issue #100）
    state.awaitPatch = false;
    if (patch && patch.project) {
      if (!state.board) return; // 增量早于首板到达：丢弃，首板随即覆盖
      invalidateDetailCaches({ projects: [patch.project] });
      var arr = state.board.projects;
      var i;
      for (i = 0; i < arr.length; i++) {
        if (arr[i].path === patch.project.path) { arr[i] = patch.project; break; }
      }
      if (i >= arr.length) arr.push(patch.project); // 新出现的项目（补充路径首开等）
      state.board.stats = patch.stats;
      state.board.attention = patch.attention;
      state.board.scannedAt = patch.scannedAt;
      state.board.fromCache = false;
    } else if (patch && patch.projects) {
      invalidateDetailCaches(patch);
      state.board = patch;
      if (typeof patch.scanGeneration === 'number') state.boardGen = patch.scanGeneration;
    }
    renderPatched(patch);
    setScanning(false);
    console.log('[devboard] patched'); // 供 scripts/screenshot.js 等待（DEVBOARD_WAIT_PATCH=1）
  }
  api.onBoardPatch(handleBoardPatch);

  // 补丁落地的最小重绘（issue #168 第 11 条）：原实现无条件 renderAll()——即使用户停在「项目」页，
  // 也会重建 365 格全年热力图、活动流与需要关注清单，并连带重建详情面板，让「增量补丁」退化成
  // 整 UI 重建；它同时放大了备忘 IME 丢失、详情永久「加载中」、引擎下拉死控件三个缺陷。
  // 现在只刷可见/受影响的区域：隐藏视图标脏，切回时补渲（switchView 里消费）。
  var staleViews = { overview: false, projects: false };
  var pendingPanelPath = null; // 备忘编辑期间被推迟的面板重建目标（失焦后补渲）

  function panelMemoEditing() {
    var a = document.activeElement;
    return !!(a && a.classList && a.classList.contains('memo-input') && panelIn.contains(a));
  }

  // 切到某视图时若有攒下的脏标记则补渲（顶栏 scanTime 始终已更新，其余统计都在总览容器内）
  function renderViewIfNeeded(view) {
    if (!staleViews[view]) return;
    staleViews[view] = false;
    if (view === 'overview') renderOverview();
    else renderRows();
  }

  function renderPatched(patch) {
    if (!state.board) return;
    document.getElementById('scanTime').textContent = hhmm(state.board.scannedAt);
    var patchedPath = patch && patch.project ? patch.project.path : null;
    if (state.view === 'overview') renderOverview();
    else staleViews.overview = true;
    if (state.view === 'projects') renderRows();
    else staleViews.projects = true;
    if (!state.selectedPath) return;
    var p = findProject(state.selectedPath);
    if (!p || (state.band !== 'all' && p.band !== state.band)) { selectProject(null); return; }
    if (patchedPath && patchedPath !== state.selectedPath) return; // 与他项目无关：面板不动
    // 备忘编辑中推迟重建（issue #168 第 12 条）：renderPanel 会清空重建面板，
    // 正在输入的 textarea 节点被换掉会丢掉进行中的 IME 组合缓冲
    if (panelMemoEditing()) { pendingPanelPath = p.path; return; }
    renderPanel(p);
  }

  // 加载收尾放行排队中的补丁（issue #168 第 12 条）
  function flushPendingLoadPatch() {
    if (!state.pendingLoadPatch) return;
    var p = state.pendingLoadPatch;
    state.pendingLoadPatch = null;
    handleBoardPatch(p);
  }

  // 拖拽结束后放行排队中的补丁（issue #100）
  function flushPendingPatch() {
    if (!state.pendingPatch) return;
    var p = state.pendingPatch;
    state.pendingPatch = null;
    handleBoardPatch(p);
  }

  // 后台重扫失败（issue #98）：补丁不会来了，熄灭扫描指示，保留旧板展示
  api.onBoardScanfail(function () {
    state.awaitPatch = false;
    if (!state.loading) setScanning(false);
  });

  function refresh(manual) {
    var btn = document.getElementById('refreshBtn');
    if (manual) btn.classList.add('spin');
    load(manual).finally(function () {
      btn.classList.remove('spin');
    });
  }

  /* ---------- 设置域（issue #124 渲染层拆分）：外观/主题 + 设置页全域 → settings.js ----------
     板/渲染域（总览/主面板/详情/搜索/拖拽）留本文件；跨域入口经 ctx 注入：
     onPromptChanged（#78 周报自动名额复位，weeklyAutoDay 属 AI 渲染域）、renderSortUi（排序 UI 属板域） */
  var settings = window.DevboardSettings({
    state: state,
    api: api,
    el: el,
    ipcErrText: ipcErrText,
    closeDrops: closeDrops,
    switchView: switchView,
    syncTbName: syncTbName,
    refresh: refresh,
    loadAiTools: loadAiTools,
    loadAiCaps: loadAiCaps,
    renderAiWeeklyEntry: renderAiWeeklyEntry,
    onPromptChanged: function () { ai.onPromptChanged(); }, // weeklyAutoDay 属 AI 域（issue #124），复位+按需重估随域搬迁
    renderSortUi: function () {
      document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[state.sortMode];
      renderSortDrop();
    },
  });
  // 别名：设置域函数在板域的既有调用点（emptyGuide/switchView/Esc/onShowSettings/启动序列）保持原样
  var showSettings = settings.showSettings;
  var hideSettings = settings.hideSettings;
  var applyDensity = settings.applyDensity;
  var applyMotion = settings.applyMotion;
  var applyLanding = settings.applyLanding;
  var renderLanding = settings.renderLanding;
  var applyCurrentTheme = settings.applyCurrentTheme;

  /* 设置视图 DOM 引用 / bindSeg 分段控件 / 扫描间隔与警示规则 / 通知 / 密度 / 动效 / 着陆视图 /
     提示词模板助手 / 子模块导航 / 主题域（整体主题 + 强调色 + 主题卡/色板/浮层）已随设置域拆至 settings.js */

  // 设置页流程（设置读取回填 / GitHub 账户与设备码流 / AI 工具行与引擎下拉 / 自动保存链 /
  // 设置页事件绑定 / 提示词模板绑定 / 数据组）已随设置域拆至 settings.js（issue #124）

  /* ---------- 事件绑定（板域；设置页绑定已随设置域拆至 settings.js，issue #124） ---------- */
  document.getElementById('winMin').addEventListener('click', api.winMin);
  document.getElementById('winMax').addEventListener('click', api.winMax);
  document.getElementById('winClose').addEventListener('click', api.winClose);
  document.getElementById('refreshBtn').addEventListener('click', function () { refresh(true); });
  document.getElementById('streamMore').addEventListener('click', function () {
    state.streamShown = Infinity;
    renderStream();
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

  // 项目页分带筛选 chips（issue #16）：按共享分带定义动态构建（issue-11 / #127，阈值/文案/顺序同源），
  // DOM 结构与 class 与原静态标签一致；手动切换分带即退出 AI 筛选（issue #29）
  var bandChipsEl = document.getElementById('bandChips');
  [{ id: 'all', label: '全部', chipHint: '' }].concat(BAND_DEFS).forEach(function (def) {
    var btn = el('button', def.id === state.band ? 'active' : null);
    btn.setAttribute('data-band', def.id);
    if (def.chipHint) {
      btn.title = def.label + '：' + def.chipHint;
      btn.appendChild(el('i', 'dot'));
    }
    btn.appendChild(document.createTextNode(def.label));
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
    bandChipsEl.appendChild(btn);
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
      ai.cancelAiFilter(); // 取消在飞的 AI 筛选解析（issue #132；在飞态属 AI 域，issue #124）
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
    if (ai.isToolPickerOpen() && !e.target.closest('.tool-pick') && !e.target.closest('.tool-btn')) closeToolPicker();
  });

  // 键盘流：Esc 逐层关闭（选择器/补全/下拉 → 设置 → 详情面板 → 隐藏到托盘）；/ 聚焦搜索
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return; // 输入框内的 Esc 由各控件自理
      if (ai.isToolPickerOpen()) { closeToolPicker(); return; }
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
  // AI 工具说明文案随注册表派生（issue #168 第 5 条）：注册表加了工具，设置页说明同步跟上
  (function () {
    var desc = document.getElementById('aiToolsDesc');
    if (!desc) return;
    desc.textContent = '总览页工作台按本机 PATH 探测 ' +
      Object.keys(AI_TOOL_LABEL).map(function (k) { return AI_TOOL_LABEL[k]; }).join(' / ') +
      '；下方可增删自定义命令（名称 + 命令），与默认清单一并探测';
  })();
  renderSkeleton();
  api.getSettings().then(function (cfg) {
    state.settings = cfg;
    settings.applyStartupAppearance(cfg); // 主题恢复 + 密度/动效/着陆 seg（issue #124 拆分后经设置域，顺序与原序列一致）
    if (state.prefs) applyLanding(); // 着陆视图需 settings+prefs 都就绪（issue #86）
    // 启动时序（issue #165）：getSettings 与首板并发，settings 晚于首板 resolve 时首屏
    // renderAll 在 state.settings=null 下跑过——renderGhNotify 判「未连接」把通知卡藏掉了，
    // 此后无任何重渲机会。settings 到位即补一次通知卡渲染（板未到则由首板渲染兜底）
    if (state.board) renderGhNotify();
  }).catch(function (err) {
    // 补 catch（issue #168 第 12 条）：原来 IPC 一次性失败会静默跳过主题/密度/动效初始化，
    // 界面留在未应用偏好的状态且毫无提示。退到默认外观照常起界面。
    console.error('设置读取失败', err);
    applyCurrentTheme();
    applyMotion();
  });
  api.getPrefs().then(function (p) {
    state.prefs = p;
    state.branchSel = (p && p.branchSel) || {};
    state.sortMode = (p && p.sortMode) || 'manual';
    document.getElementById('sortLabel').textContent = '排序：' + SORT_LABEL[state.sortMode];
    renderSortDrop();
    if (state.settings) applyLanding(); // 着陆视图需 settings+prefs 都就绪（issue #86）
    if (!p || !p.onboarded) { // 首次启动：自动打开一次设置，引导配置扫描根目录
      settings.markFirstRun(); // 首次启动标记：自动打开设置并展示一次性欢迎提示（标记属设置域，issue #124）
      state.prefs = Object.assign({}, state.prefs, { onboarded: true });
      savePrefs({ onboarded: true });
      showSettings();
    }
    if (state.board) renderAll();
  }).catch(function (err) {
    // 补 catch（issue #168 第 12 条）：偏好读取失败原来会静默跳过排序/着陆/首启引导初始化，
    // 且留下一条未处理的 rejection。这里退到空偏好继续起界面。
    console.error('偏好读取失败', err);
    state.prefs = state.prefs || {};
    if (state.settings) applyLanding();
  });
  loadAiTools();
  loadAiCaps(); // AI 入口显隐（issue #29）；bindAiWeekly 已随 AI 域初始化（issue #124）
  load(false);
})();
