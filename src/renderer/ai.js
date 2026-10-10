/* devboard 渲染层 AI 域（issue #124 渲染层拆分）：工作台工具格与项目选择器、AI 能力探测、
   周报卡、详情面板建议区、自然语言筛选、后台任务注册表（issue #40）。
   以经典脚本挂工厂（window.DevboardAi），由 app.js 注入 ctx 挂载：
   板/渲染域入口（详情面板/行列表/搜索补全/视图切换）一律经 ctx，通道与行为零变更。
   ctx: { state, api, el, BAND_LABEL, relTime, findProject, renderPanel, projectOrder, pinnedList,
          flashBtn, toolsCard, sec, suggestEl, closeSuggest, suggestCandidates, switchView,
          syncChips, renderRows, jumpToProject } */
(function (root) {
  'use strict';

  root.DevboardAi = function initAiDomain(ctx) {
    var state = ctx.state;
    var api = ctx.api;
    var el = ctx.el;
    var BAND_LABEL = ctx.BAND_LABEL;
    var relTime = ctx.relTime;
    var findProject = ctx.findProject;
    var renderPanel = ctx.renderPanel;
    var projectOrder = ctx.projectOrder;
    var pinnedList = ctx.pinnedList;
    var flashBtn = ctx.flashBtn;
    var toolsCard = ctx.toolsCard;
    var sec = ctx.sec;
    var suggestEl = ctx.suggestEl;
    var closeSuggest = ctx.closeSuggest;
    var suggestCandidates = ctx.suggestCandidates;
    var switchView = ctx.switchView;
    var syncChips = ctx.syncChips;
    var renderRows = ctx.renderRows;
    var jumpToProject = ctx.jumpToProject;
    var DAY_MS = 86400000;
    var localDateStr = root.devboardConsts.localDateStr; // AI 周报缓存的当天日期键（与 app.js 同源 preload 常量）

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

    // 选择器开合状态查询（issue #124 拆分）：toolPickEl 属本域私有，doc 级 mousedown/Esc 经此探询
    function isToolPickerOpen() { return !!toolPickEl; }

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
        }).catch(function () { flashBtn(btn, '启动失败', false); }); // IPC reject 也亮错（issue #119）
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

    // AI 结果区：徽标（引擎 + 生成时间，issue #43 精简）+ 结构化正文/错误；box 内重建。
    // __lastText 供「执行」键（issue #142）取当前展出的建议正文作预填 prompt
    function fillAiBox(box, r) {
      box.innerHTML = '';
      box.__lastText = r && r.ok ? String(r.text || '') : '';
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

    // 系统睡眠跨夜后在飞任务的 IPC 回复可能永久丢失，running 态永不落幕（实测挂起 9h 后仍显示生成中）；
    // 主进程侧最坏路径是引擎链全部超时（每引擎 90s），超过阈值仍 running 的必是死任务，读时即清。
    // 阈值按已安装引擎数动态放大（issue #139）：max(10 分钟, 引擎数 × 100s)，6+ 引擎的合法长任务不被误清。
    // 清掉后各入口自然落回缓存读取或重新发起（主进程在飞去重 + 结果缓存双兜底）
    function aiJobStaleMs() {
      return Math.max(10 * 60 * 1000, installedTools().length * 100 * 1000);
    }
    function liveAiJob(key) {
      var job = state.aiJobs[key];
      if (job && job.status === 'running' && Date.now() - job.startAt > aiJobStaleMs()) {
        delete state.aiJobs[key];
        return null;
      }
      return job;
    }

    function startAiJob(kind, payload) {
      var key = aiJobKey(kind, payload.path);
      var job = liveAiJob(key);
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
        // 之后各视图统一走主进程 ai-cache 展出（单一事实源，HEAD 变化后不会出现陈旧建议）；
        // 身份比对（issue #129）：死任务被「读时即清」后同 key 新任务已在飞，旧任务迟到 resolve 的 finally 不得误删新任务
        if (state.aiJobs[key] === job) delete state.aiJobs[key];
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

    // 「生成中」进行态（issue #86）：骨架行 +「正在总结…」措辞；已等待秒数每秒刷新；行被重绘移除后定时器自清
    function paintAiRunning(box, btn, job) {
      box.classList.remove('hidden');
      box.innerHTML = '';
      // 注意：渲染分支调用时所在 section 可能尚未挂上 DOM，首帧文案必须无条件写入，
      // 定时器只在「曾挂载后被移除」时自清（issue #40 实测 bug）
      var line = el('div', 'ai-err', '');
      var makeText = function () {
        // 引擎可能中途消失（issue #168 第 12 条）：ai:caps 失败或设置里关掉 AI 都会把
        // state.aiCaps 置成 { enabled:false, engine:null }，而本函数跑在 1s setInterval 里——
        // 无保护地取 .engine.label 会每秒抛一次未捕获异常，秒数文案随之冻结
        var eng = state.aiCaps && state.aiCaps.engine;
        return '正在总结…（本机 ' + (eng ? eng.label : 'AI 引擎') + '，已等待 ' +
          Math.max(0, Math.round((Date.now() - job.startAt) / 1000)) + ' 秒；可切换到别处，完成后回来查看）';
      };
      line.textContent = makeText();
      box.appendChild(line);
      var sk = el('div', 'ai-sk'); // 骨架行：等候期间给「内容正在成形」的预期
      for (var i = 0; i < 3; i++) sk.appendChild(el('i', null, ''));
      box.appendChild(sk);
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
    var weeklyAutoDay = ''; // 自动生成标记与当天日期绑定（成功后才落，issue #136）：应用常驻跨天后复位，第二天无缓存时再自动生成一次
    var weeklyAutoFailAt = 0; // 自动失败退避起点（issue #136）：「无数据」类暂时性失败不消耗当天名额，退避期内 onTick 重估不再发起
    var WEEKLY_AUTO_RETRY_MS = 10 * 60 * 1000; // 自动失败后的重试退避窗口；手动点「生成周报」不受限

    function renderAiWeeklyEntry() {
      var card = document.getElementById('aiWeeklyCard');
      if (!card) return;
      card.classList.toggle('hidden', !aiReady());
      if (!aiReady()) return;
      var btn = document.getElementById('aiWeeklyBtn');
      var box = document.getElementById('aiWeeklyBox');
      var job = liveAiJob(aiJobKey('weekly'));
      if (job && job.status === 'running') { paintAiRunning(box, btn, job); return; }
      delete btn.dataset.busy;
      btn.textContent = '✦ 生成周报';
      if (job) {
        // 自动名额结算（issue #136）：成功才落当天日期标记；失败记退避起点，退避期内 onTick 重估不再自动发起
        if (job.auto) {
          if (job.status === 'done') weeklyAutoDay = localDateStr(new Date());
          else weeklyAutoFailAt = Date.now();
        }
        if (job.status === 'error' && job.auto) return; // 自动生成失败保持安静（issue #42）
        // 刚完成的后台任务：直接展出交接结果
        box.classList.remove('hidden');
        fillAiBox(box, job.result);
        return;
      }
      // 今日已生成过的周报直接展出（只读缓存，不触发新生成），模块内标明模型与生成时间；
      // 主进程有同任务在飞时回 pending（如页面重载后）→ 转为正式请求并入该任务（不置 auto：失败对触发者可见，issue #138）；
      // 今日无缓存 → 启动后自动后台生成一次（issue #42），自动失败退避期内不再发起（issue #136）
      api.aiAsk({ kind: 'weekly', cachedOnly: true }).then(function (r) {
        if (r && r.ok) {
          box.classList.remove('hidden');
          fillAiBox(box, r);
        } else if (r && r.reason === 'pending') {
          startAiJob('weekly', { kind: 'weekly' });
          renderAiWeeklyEntry();
        } else if (r && r.reason === 'no-cache' && weeklyAutoDay !== localDateStr(new Date()) &&
          Date.now() - weeklyAutoFailAt > WEEKLY_AUTO_RETRY_MS) {
          // auto 仅在此（自动发起处）置位（issue #138）：手动点击与 pending 并入的任务失败都走可见错误条
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
    bindAiWeekly(); // 周报按钮绑定随域初始化（原 app.js 启动段调用点等价前移，issue #124）

    /* ----- P0 · 项目 AI 建议（详情面板，按 项目+HEAD 缓存；后台执行 issue #40） ----- */
    // 生成按钮收进标题行（issue #38）；已缓存的建议打开面板即默认展开，不再多点一次。
    // 「执行」键（issue #142，意图路由）：把当前展出的建议文本作为预填 prompt，在项目目录
    // 可见终端起默认 AI CLI（aitools:open 出口，prefill.mode=arg 参数数组转义）——写操作
    // 由用户自己的 AI 会话完成，板保持只读（ADR-0004）
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
      var job = liveAiJob(key);
      // 「执行」键（issue #142）：把当前展出的建议文本作为预填 prompt，在项目目录可见终端起 CLI。
      // 文本取 fillAiBox 记录的 __lastText（面板重渲后随 box 重建，不落陈旧引用）
      var runBtn = el('button', 'ai-btn ai-run', '▶ 执行');
      runBtn.type = 'button';
      runBtn.title = '在项目目录用 ' + state.aiCaps.engine.label + ' 执行这条建议（预填建议文本，人在环确认）';
      runBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var text = box.__lastText;
        if (!text) return; // 还没有可执行的建议（未生成/生成失败）
        api.aiToolsOpen(state.aiCaps.engine.cmd, p.path, text).then(function (ok) {
          flashBtn(runBtn, ok ? '已启动' : '启动失败', ok);
        }).catch(function () { flashBtn(runBtn, '启动失败', false); });
      });
      s.firstChild.appendChild(runBtn);
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
    var aiFilterJob = null; // 在飞的筛选解析 { query, cancelled }：Esc 取消（issue #132）；落地前校验上下文（issue #138）
    function applyAiFilter(query) {
      suggestEl.innerHTML = '';
      suggestEl.appendChild(el('div', 'drop-empty', 'AI 解析筛选条件中…'));
      suggestEl.classList.remove('hidden');
      suggestEl.classList.add('open');
      var job = aiFilterJob = { query: query, cancelled: false };
      api.aiAsk({ kind: 'filter', query: query }).then(function (r) {
        if (aiFilterJob === job) aiFilterJob = null;
        // 迟到结果不落地（issue #138）：在飞期间用户已 Esc 取消（issue #132）、改过查询词或跳转他处
        // （state.query 已变），不再强行 switchView/改 band；hint 已被 Esc 收起或被新输入的补全列表替换，均不动
        if (job.cancelled || state.query !== query) return;
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
        if (aiFilterJob === job) aiFilterJob = null;
        if (job.cancelled || state.query !== query) return; // 同上：迟到失败不落地
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

    // Esc 取消在飞筛选解析（issue #132）：aiFilterJob 属本域私有，keydown 处理器经此入口取消
    function cancelAiFilter() {
      if (aiFilterJob) {
        aiFilterJob.cancelled = true;
        aiFilterJob = null;
      }
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

    // 提示词模板改动后（issue #78，settings.js 保存链回调）：复位周报自动生成标记，
    // 设置页已关闭时立即按新模板重估（原 app.js onPromptChanged 闭包逻辑随域搬迁）
    function onPromptChanged() {
      weeklyAutoDay = '';
      if (document.getElementById('app') && !document.getElementById('app').classList.contains('show-settings')) renderAiWeeklyEntry();
    }

    return {
      installedTools: installedTools,
      loadAiTools: loadAiTools,
      loadAiCaps: loadAiCaps,
      renderTools: renderTools,
      toolButton: toolButton,
      closeToolPicker: closeToolPicker,
      isToolPickerOpen: isToolPickerOpen,
      aiReady: aiReady,
      renderAiWeeklyEntry: renderAiWeeklyEntry,
      renderAiAdviceSec: renderAiAdviceSec,
      applyAiFilter: applyAiFilter,
      renderFilterChip: renderFilterChip,
      clearAiFilter: clearAiFilter,
      aiFilterPass: aiFilterPass,
      cancelAiFilter: cancelAiFilter,
      onPromptChanged: onPromptChanged,
    };
  };
})(window);
