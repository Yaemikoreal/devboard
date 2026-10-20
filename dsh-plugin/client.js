// SignalBoard DSH 插件 Client 半边（Task 5：三视图完整实现）。
// 契约实测（whale-pet 参照 + dsh-client-ui-renderer / dsh-client-ui-commands 源码）：
// - window.__ModuleLoader__.load({id, factory(require) → {inject, apply}})；
// - ctx.slots.inject(slot名, () => ctx.slots.register(options, Component))——register 内部自带 effect；
// - 注册选项 locale:'<ns>' 使组件 kit 携带 t；侧栏条目 label 支持 (t)=>string；
// - main 是 keyed 槽：options.key 即面板 id；组件 props 携带标准 kit（useSessions 等）；
// - 命令：ctx.remote.commands.execute(sessionId, '/name rawInput', []) → {ok, value:{result:{kind,text}}}；
// - 当前会话：useSessions(snapshot=>snapshot) → catalog.byId[id]，retainedBy.mainView>0 的是主视图会话
//   （whale-pet selectedSessionId 同法）；
// - 样式：仅 --dsw-alias-* token，<style> 随 apply 注册、disposer 卸载（5.5 纪律）。
// 读 = web 路由（board + detail 懒加载）；写 = 命令（备忘/偏好/交接完成/快捷打开/触发链）。
window.__ModuleLoader__.load({
  id: '@local/signalboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ============ 常量（shared/constants 的客户端镜像——客户端拿不到 CJS 模块，同源注明）============
    // BAND_DEFS 镜像自 src/shared/constants.js（分带唯一来源）：id/label 逐字同源
    const BAND_DEFS = [
      { id: 'hot', label: '活跃' },
      { id: 'active', label: '近期' },
      { id: 'cooling', label: '渐冷' },
      { id: 'stale', label: '沉睡' },
      { id: 'archive', label: '归档' },
    ];
    const BAND_LABEL = {}; for (const b of BAND_DEFS) BAND_LABEL[b.id] = b.label;

    // ============ locale 字典 ============
    const zh = {
      'meta.title': 'SignalBoard',
      'panel.title': 'SignalBoard',
      'view.overview': '总览',
      'view.board': '项目板',
      'view.back': '返回',
      'panel.loading': '正在读取项目概况…',
      'panel.loadError': '读取失败',
      'panel.retry': '重试',
      'panel.refresh': '刷新',
      'panel.empty': '尚未发现项目——请先在桌面端设置扫描根目录，或在本会话内运行 signalboard_rescan。',
      'ov.attention': '需要关注',
      'ov.attentionEmpty': '没有需要关注的项目',
      'ov.stats.total': '项目',
      'ov.stats.commits': '近 7 天提交',
      'ov.stats.attention': '需关注',
      'ov.activity': '按月活动（近 12 个月）',
      'ov.weekly': 'AI 周报',
      'ov.weekly.empty': '本周尚未生成总结。',
      'ov.weekly.generate': '生成本周总结',
      'ov.weekly.today': '今日已生成 · 重新生成',
      'ov.weekly.genFailed': '生成需在会话中进行——当前无活动会话，可在会话内输入 /signalboard-weekly。',
      'ov.weekly.engine': 'DSH 会话生成',
      'ov.workbench': '工作台',
      'ov.workbench.empty': '未探测到已安装的 AI CLI（仅用于启动/意图路由，不参与生成）',
      'ov.guide.title': '开始使用',
      'ov.guide.body': '还没有配置扫描根目录。在桌面端「设置 → 扫描根目录」添加后，这里会展示项目概况。',
      'bd.search': '搜索项目名或备忘…',
      'bd.none': '没有匹配的项目',
      'bd.memoHint': '备忘：',
      'dt.signals': '近况信号',
      'dt.commits': '近 7 天提交',
      'dt.dirty': '未提交文件',
      'dt.ahead': '未推送',
      'dt.behind': '落后远程',
      'dt.aiSession': '最近 AI 会话',
      'dt.memo': '备忘',
      'dt.memoSave': '保存备忘',
      'dt.memoSaved': '备忘已保存',
      'dt.memoPlaceholder': '写给下一次打开这里的自己（空串 = 删除）',
      'dt.quickopen': '快捷打开',
      'dt.open.folder': '文件夹',
      'dt.open.editor': '编辑器',
      'dt.open.terminal': '终端',
      'dt.warnings': '警示',
      'dt.mute': '消音',
      'dt.muted': '已消音',
      'dt.unmute': '取消消音',
      'dt.handoffs': '交接',
      'dt.handoff.total': '{n} 条',
      'dt.handoff.latest': '最新：',
      'dt.handoff.done': '标记完成',
      'dt.handoff.none': '暂无交接',
      'dt.advice': 'AI 建议',
      'dt.advice.empty': '尚未生成建议。',
      'dt.advice.ask': '请求建议',
      'dt.advice.genFailed': '生成需在会话中进行——可在会话内对该项目运行 /signalboard-advice。',
      'dt.recentCommits': '近期提交',
      'dt.dirtyFiles': '未提交清单',
      'dt.degraded': '数据为降级缓存（上次扫描超时）',
      'dt.detailLoading': '正在读取深度信息…',
      'dt.readme': 'README 摘要',
      'dt.aiSessions': 'AI 会话痕迹',
      'cmd.failed': '命令执行失败',
      'cmd.noSession': '没有可用会话——请在会话中执行该操作',
    };
    const en = {
      'meta.title': 'SignalBoard',
      'panel.title': 'SignalBoard',
      'view.overview': 'Overview',
      'view.board': 'Projects',
      'view.back': 'Back',
      'panel.loading': 'Loading project overview…',
      'panel.loadError': 'Failed to load',
      'panel.retry': 'Retry',
      'panel.refresh': 'Refresh',
      'panel.empty': 'No projects found — configure scan roots in the desktop app, or run signalboard_rescan in this session.',
      'ov.attention': 'Needs attention',
      'ov.attentionEmpty': 'Nothing needs attention',
      'ov.stats.total': 'Projects',
      'ov.stats.commits': 'Commits (7d)',
      'ov.stats.attention': 'Attention',
      'ov.activity': 'Monthly activity (last 12 months)',
      'ov.weekly': 'AI Weekly',
      'ov.weekly.empty': 'No summary generated this week yet.',
      'ov.weekly.generate': 'Generate weekly summary',
      'ov.weekly.today': 'Generated today · Regenerate',
      'ov.weekly.genFailed': 'Generation needs a session — run /signalboard-weekly in a session.',
      'ov.weekly.engine': 'DSH session',
      'ov.workbench': 'Workbench',
      'ov.workbench.empty': 'No installed AI CLI detected (launch/intent-routing only, not generation)',
      'ov.guide.title': 'Get started',
      'ov.guide.body': 'No scan roots configured yet. Add them in the desktop app settings and the overview will appear here.',
      'bd.search': 'Search name or memo…',
      'bd.none': 'No matching projects',
      'bd.memoHint': 'Memo: ',
      'dt.signals': 'Signals',
      'dt.commits': 'Commits (7d)',
      'dt.dirty': 'Dirty files',
      'dt.ahead': 'Unpushed',
      'dt.behind': 'Behind',
      'dt.aiSession': 'Last AI session',
      'dt.memo': 'Memo',
      'dt.memoSave': 'Save memo',
      'dt.memoSaved': 'Memo saved',
      'dt.memoPlaceholder': 'A note for your next visit (empty = delete)',
      'dt.quickopen': 'Quick open',
      'dt.open.folder': 'Folder',
      'dt.open.editor': 'Editor',
      'dt.open.terminal': 'Terminal',
      'dt.warnings': 'Warnings',
      'dt.mute': 'Mute',
      'dt.muted': 'Muted',
      'dt.unmute': 'Unmute',
      'dt.handoffs': 'Handoffs',
      'dt.handoff.total': '{n} total',
      'dt.handoff.latest': 'Latest: ',
      'dt.handoff.done': 'Mark done',
      'dt.handoff.none': 'No handoffs yet',
      'dt.advice': 'AI Advice',
      'dt.advice.empty': 'No advice generated yet.',
      'dt.advice.ask': 'Request advice',
      'dt.advice.genFailed': 'Generation needs a session — run /signalboard-advice for this project.',
      'dt.recentCommits': 'Recent commits',
      'dt.dirtyFiles': 'Dirty file list',
      'dt.degraded': 'Degraded cache data (last scan timed out)',
      'dt.detailLoading': 'Loading deep info…',
      'dt.readme': 'README digest',
      'dt.aiSessions': 'AI session traces',
      'cmd.failed': 'Command failed',
      'cmd.noSession': 'No available session — run this action inside a session',
    };

    // ============ 样式（--dsw-alias-* token only，<style> 随 run 生命周期）============
    const CSS = `
.sb-root { color: var(--dsw-alias-fg, inherit); font-size: 13px; line-height: 1.55; }
.sb-root h2 { margin: 0; font-size: 15px; font-weight: 600; }
.sb-tabs { display: flex; gap: 4px; align-items: center; margin-bottom: 10px; }
.sb-tab { border: none; background: transparent; color: var(--dsw-alias-fg-muted, inherit);
  padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.sb-tab.on { background: var(--dsw-alias-bg-active, rgba(128,128,128,.18)); color: var(--dsw-alias-fg, inherit); }
.sb-spacer { flex: 1; }
.sb-btn { border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.4)); background: transparent;
  color: inherit; padding: 3px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.sb-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.12)); }
.sb-btn.accent { border-color: var(--dsw-alias-accent, currentColor); color: var(--dsw-alias-accent, inherit); }
.sb-btn[disabled] { opacity: .5; cursor: default; }
.sb-muted { color: var(--dsw-alias-fg-muted, inherit); }
.sb-card { border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.3)); border-radius: 8px;
  padding: 10px 12px; margin-bottom: 10px; }
.sb-chips { display: flex; gap: 14px; margin-bottom: 12px; }
.sb-chip { display: flex; flex-direction: column; }
.sb-chip b { font-size: 20px; font-weight: 600; }
.sb-att { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px;
  cursor: pointer; border: 1px solid transparent; }
.sb-att:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); border-color: var(--dsw-alias-border, transparent); }
.sb-warn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-warn, #d97706); flex: none; }
.sb-bars { display: flex; gap: 6px; align-items: flex-end; height: 56px; margin: 6px 0 2px; }
.sb-bar { flex: 1; background: var(--dsw-alias-accent, currentColor); opacity: .75; border-radius: 3px 3px 0 0; min-height: 2px; }
.sb-bar-l { font-size: 10px; color: var(--dsw-alias-fg-muted, inherit); text-align: center; }
.sb-row { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px;
  cursor: pointer; border: 1px solid transparent; }
.sb-row:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); border-color: var(--dsw-alias-border, transparent); }
.sb-row b { font-weight: 600; }
.sb-pill { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.4)); flex: none; }
.sb-pill.hot { color: var(--dsw-alias-accent, inherit); border-color: var(--dsw-alias-accent, currentColor); }
.sb-search { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-subtle, transparent);
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.35)); color: inherit;
  border-radius: 7px; padding: 6px 10px; margin-bottom: 10px; font-size: 13px; outline: none; }
.sb-search:focus { border-color: var(--dsw-alias-accent, currentColor); }
.sb-textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
  background: var(--dsw-alias-bg-subtle, transparent); border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.35));
  color: inherit; border-radius: 7px; padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none; }
.sb-textarea:focus { border-color: var(--dsw-alias-accent, currentColor); }
.sb-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 14px; margin: 6px 0; }
.sb-kv { display: flex; justify-content: space-between; gap: 10px; }
.sb-kv .k { color: var(--dsw-alias-fg-muted, inherit); }
.sb-h3 { font-size: 12px; font-weight: 600; color: var(--dsw-alias-fg-muted, inherit);
  text-transform: none; margin: 14px 0 6px; }
.sb-mono { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 12px; }
.sb-handoff { padding: 6px 0; border-top: 1px solid var(--dsw-alias-border, rgba(128,128,128,.2)); }
.sb-handoff:first-of-type { border-top: none; }
.sb-unread { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-accent, currentColor);
  display: inline-block; margin-right: 6px; }
.sb-toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px;
  background: var(--dsw-alias-bg-subtle, rgba(0,0,0,.7)); border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.4));
  color: inherit; padding: 7px 14px; border-radius: 8px; font-size: 12px; z-index: 60; }
.sb-err { color: var(--dsw-alias-danger, #dc2626); }
`;

    // ============ 帮手 ============
    function relTime(iso, now) {
      if (!iso) return '—';
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return '—';
      const d = Math.max(0, ((now || Date.now()) - t) / 1000);
      if (d < 60) return '<1 分钟';
      if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
      if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
      if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
      return Math.floor(d / (86400 * 30)) + ' 个月前';
    }
    // activity365（今日止的逐日计数）聚合到近 12 个月：[{label:'3月', count}]
    function monthlyActivity(activity365, activityDate) {
      const months = [];
      const now = new Date();
      const counts = Array.isArray(activity365) ? activity365 : [];
      // activity365[i] 对应 now-(364-i) 天（issue #23 口径）；activityDate 缺省按今天
      const base = activityDate ? new Date(activityDate) : now;
      for (let m = 11; m >= 0; m--) {
        const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
        const next = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
        let c = 0;
        for (let i = 0; i < counts.length; i++) {
          const day = new Date(base.getTime() - (364 - i) * 86400000);
          if (day >= d && day < next) c += counts[i];
        }
        months.push({ label: (d.getMonth() + 1) + '月', count: c });
      }
      return months;
    }
    function bandGroup(p) { return BAND_LABEL[p.band] ? p.band : 'archive'; }

    // ============ 数据层 ============
    async function fetchBoard() {
      const res = await fetch('/api/signalboard/board', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }
    async function fetchDetail(path) {
      const res = await fetch('/api/signalboard/detail?path=' + encodeURIComponent(path), { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    // ============ 图标（Task 4 定稿）============
    function PanelIcon({ size, active }) {
      const s = size || 16;
      const fill = active ? 'var(--dsw-alias-accent)' : 'currentColor';
      const cell = (x, y, signal) => h('rect', {
        x, y, width: 5.4, height: 5.4, rx: 1.1, fill, opacity: signal ? 1 : 0.38,
      });
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        cell(2.5, 2.5, false), cell(9.3, 2.5, false), cell(16.1, 2.5, true),
        cell(2.5, 9.3, false), cell(9.3, 9.3, false), cell(16.1, 9.3, false),
        cell(2.5, 16.1, true), cell(9.3, 16.1, false), cell(16.1, 16.1, false),
      );
    }

    // ============ 应用（工厂内组合，apply 时注入 ctx 依赖）============
    function createApp({ ctx }) {
      // 命令执行：解析当前主视图会话 → remote.commands.execute；无会话返回结构化失败
      async function runCommand(line) {
        let sessionId = null;
        try {
          const sessions = ctx.get('sessions');
          if (sessions && typeof sessions.useSnapshot === 'function') {
            const snap = sessions.useSnapshot();
            const row = Object.values((snap && snap.byId) || {}).find((r) => r && r.retainedBy && (r.retainedBy.mainView ?? 0) > 0);
            sessionId = row && row.id;
          }
        } catch { /* 会话面缺席 → 引导文案 */ }
        if (!sessionId) return { kind: 'error', text: 'no-session' };
        const r = await ctx.remote.commands.execute(sessionId, line, []);
        if (!r.ok) throw new Error((r.error && r.error.message) || 'execute failed');
        return (r.value && r.value.result) || { kind: 'error', text: 'empty result' };
      }

      // ---- 顶栏（视图切换 + 刷新）----
      function TopBar({ view, setView, onRefresh, ageText }) {
        return h('div', { className: 'sb-tabs' },
          h('button', { className: 'sb-tab' + (view === 'overview' ? ' on' : ''), onClick: () => setView('overview') }, T('view.overview')),
          h('button', { className: 'sb-tab' + (view === 'board' ? ' on' : ''), onClick: () => setView('board') }, T('view.board')),
          h('div', { className: 'sb-spacer' }),
          h('span', { className: 'sb-muted', style: { fontSize: 11 } }, ageText || ''),
          h('button', { className: 'sb-btn', onClick: onRefresh }, T('panel.refresh')),
        );
      }

      // ---- 总览 ----
      function Overview({ data, goDetail, now, refreshSoon }) {
        const b = data.board;
        const guide = data.guide || {};
        const summary = data.summary || {};
        const aiTools = Array.isArray(data.aiTools) ? data.aiTools.filter((t) => t.installed) : [];
        if (!guide.rootsConfigured && b.stats.total === 0) {
          return h('div', { className: 'sb-card' },
            h('h2', null, T('ov.guide.title')),
            h('div', { className: 'sb-muted', style: { marginTop: 6 } }, T('ov.guide.body')),
          );
        }
        const months = monthlyActivity(
          b.projects.reduce((acc, p) => acc.map((c, i) => c + (p.activity365 ? p.activity365[i] : 0)), new Array(365).fill(0)),
          null,
        );
        const maxM = Math.max(1, ...months.map((m) => m.count));
        const weekly = summary.weekly;
        const todayStr = new Date().toISOString().slice(0, 10);
        return [
          h('div', { className: 'sb-chips', key: 'chips' },
            h('div', { className: 'sb-chip' }, h('b', null, String(b.stats.total)), h('span', { className: 'sb-muted' }, T('ov.stats.total'))),
            h('div', { className: 'sb-chip' }, h('b', null, String(b.stats.commits7d)), h('span', { className: 'sb-muted' }, T('ov.stats.commits'))),
            h('div', { className: 'sb-chip' }, h('b', null, String(b.stats.attentionCount)), h('span', { className: 'sb-muted' }, T('ov.stats.attention'))),
          ),
          h('div', { className: 'sb-card', key: 'att' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('ov.attention')),
            (b.attention.length === 0)
              ? h('div', { className: 'sb-muted' }, T('ov.attentionEmpty'))
              : b.attention.map((a) => h('div', {
                  key: a.path, className: 'sb-att', onClick: () => goDetail(a.path), title: a.path,
                },
                  h('span', { className: 'sb-warn-dot' }),
                  h('b', null, a.name),
                  h('span', { className: 'sb-muted' }, a.label),
                )),
          ),
          h('div', { className: 'sb-card', key: 'act' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 2px' } }, T('ov.activity')),
            h('div', { className: 'sb-bars' }, months.map((m) => h('div', {
              key: m.label, className: 'sb-bar', style: { height: Math.round(4 + (m.count / maxM) * 48) }, title: m.label + ' · ' + m.count,
            }))),
            h('div', { style: { display: 'flex', gap: 6 } }, months.map((m) => h('div', { key: m.label, className: 'sb-bar-l', style: { flex: 1 } }, m.label))),
          ),
          h('div', { className: 'sb-card', key: 'weekly' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('ov.weekly')),
            weekly
              ? h('div', null,
                  h('div', { style: { whiteSpace: 'pre-wrap' } }, weekly.text),
                  h('div', { className: 'sb-muted', style: { fontSize: 11, marginTop: 6 } },
                    T('ov.weekly.engine') + ' · ' + relTime(weekly.at, now) + (weekly.date ? ' · ' + weekly.date : '')),
                )
              : h('div', { className: 'sb-muted' }, T('ov.weekly.empty')),
            h('button', {
              className: 'sb-btn accent', style: { marginTop: 8 }, disabled: !weekly || weekly.date !== todayStr ? false : false,
              onClick: () => runCommand('/signalboard-weekly').then(refreshSoon).catch(() => {}),
            }, weekly && weekly.date === todayStr ? T('ov.weekly.today') : T('ov.weekly.generate')),
          ),
          h('div', { className: 'sb-card', key: 'bench' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('ov.workbench')),
            aiTools.length === 0
              ? h('div', { className: 'sb-muted' }, T('ov.workbench.empty'))
              : h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, aiTools.map((t) =>
                  h('button', {
                    key: t.id, className: 'sb-btn',
                    onClick: () => { const p = b.projects[0]; if (p) runCommand('/signalboard-open ' + JSON.stringify({ path: p.path, kind: 'terminal' })).then(refreshSoon).catch(() => {}); },
                    title: t.id,
                  }, t.label || t.id)),
              ),
          ),
        ];
      }

      // ---- 项目板 ----
      function Board({ data, goDetail, now }) {
        const [q, setQ] = React.useState('');
        const prefs = data.prefs || {};
        const pinned = new Set(prefs.pinned || []);
        const groups = new Map(BAND_DEFS.map((b) => [b.id, []]));
        const projects = (data.board.projects || []).slice();
        projects.sort((a, b2) => {
          const pa = pinned.has(a.path) ? 0 : 1;
          const pb = pinned.has(b2.path) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          const ia = prefs.cardOrder ? prefs.cardOrder.indexOf(a.path) : -1;
          const ib = prefs.cardOrder ? prefs.cardOrder.indexOf(b2.path) : -1;
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
        for (const p of projects) {
          if (q && !((p.name || '').toLowerCase().includes(q.toLowerCase()) || (p.memo || '').toLowerCase().includes(q.toLowerCase()))) continue;
          groups.get(bandGroup(p)).push(p);
        }
        return [
          h('input', { key: 'q', className: 'sb-search', placeholder: T('bd.search'), value: q, onChange: (e) => setQ(e.target.value) }),
          BAND_DEFS.map((b) => {
            const list = groups.get(b.id);
            if (!list || list.length === 0) return null;
            return h('div', { key: b.id, style: { marginBottom: 12 } },
              h('div', { className: 'sb-h3' }, b.label + ' · ' + list.length),
              list.map((p) => h('div', { key: p.path, className: 'sb-row', onClick: () => goDetail(p.path), title: p.path },
                pinned.has(p.path) ? h('span', { style: { opacity: .7 } }, '📌') : null,
                h('b', null, p.name),
                h('span', { className: 'sb-pill' + (p.band === 'hot' ? ' hot' : '') }, BAND_LABEL[bandGroup(p)]),
                (p.warnings || []).slice(0, 2).map((w) => h('span', { key: w.type, className: 'sb-muted', style: { fontSize: 11 } }, w.label)),
                (p.handoffs && p.handoffs.unreadCount > 0) ? h('span', { className: 'sb-unread', title: p.handoffs.latest && p.handoffs.latest.text }) : null,
                h('div', { className: 'sb-spacer' }),
                h('span', { className: 'sb-muted', style: { fontSize: 11 } }, relTime(p.lastActivityAt, now)),
              )),
            );
          }),
          (data.board.projects || []).length === 0 ? h('div', { className: 'sb-muted' }, T('panel.empty')) : null,
          (data.board.projects || []).length > 0 && BAND_DEFS.every((b) => (groups.get(b.id) || []).length === 0)
            ? h('div', { className: 'sb-muted' }, T('bd.none')) : null,
        ];
      }

      // ---- 详情 ----
      function Detail({ data, path, goBack, now }) {
        const p = (data.board.projects || []).find((x) => x.path === path);
        const prefs = data.prefs || {};
        const mySnoozes = (prefs.snoozes || {})[path] || {};
        const advice = (data.summary && data.summary.advice) || {};
        const myAdvice = advice[path];
        const [memo, setMemo] = React.useState(p ? (p.memo || '') : '');
        const [toast, setToast] = React.useState('');
        const [deep, setDeep] = React.useState(null);
        const [saving, setSaving] = React.useState(false);
        React.useEffect(() => {
          let alive = true;
          fetchDetail(path).then((d) => { if (alive) setDeep(d); }, () => { if (alive) setDeep({ readme: '', aiSessions: [] }); });
          return () => { alive = false; };
        }, [path]);
        if (!p) return h('div', null, h('button', { className: 'sb-btn', onClick: goBack }, T('view.back')), h('div', { className: 'sb-muted', style: { marginTop: 8 } }, T('bd.none')));
        const say = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2600); };
        const run = (line, okMsg) => runCommand(line)
          .then((r) => say(r && r.kind === 'success' ? (okMsg || r.text || T('cmd.failed')) : (r && r.text) || T('cmd.failed')))
          .catch((e) => say(T('cmd.failed') + '：' + (e && e.message)))
          .finally(refreshSoon);
        const snoozeKeys = Object.keys(mySnoozes);
        return h('div', null,
          h('div', { className: 'sb-tabs' },
            h('button', { className: 'sb-btn', onClick: goBack }, '← ' + T('view.back')),
            h('div', { className: 'sb-spacer' }),
            h('span', { className: 'sb-pill' + (p.band === 'hot' ? ' hot' : '') }, BAND_LABEL[bandGroup(p)]),
          ),
          h('h2', { style: { margin: '4px 0 2px' } }, p.name),
          h('div', { className: 'sb-muted sb-mono', style: { marginBottom: 8 } }, p.branch || '—', p.degraded ? ' · ' + T('dt.degraded') : ''),
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 4px' } }, T('dt.signals')),
            h('div', { className: 'sb-grid' },
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('dt.commits')), h('span', null, String(p.commits7d))),
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('dt.dirty')), h('span', null, String(p.dirtyCount))),
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('dt.ahead')), h('span', null, String(p.ahead))),
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('dt.behind')), h('span', null, String(p.behind))),
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('dt.aiSession')), h('span', null, relTime(p.aiSessionAt, now))),
              h('div', { className: 'sb-kv' }, h('span', { className: 'k' }, T('panel.refresh')), h('span', null, relTime(p.lastActivityAt, now))),
            ),
          ),
          (p.warnings || []).length > 0 || snoozeKeys.length > 0 ? h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.warnings')),
            (p.warnings || []).map((w) => h('div', { key: w.type, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
              h('span', { className: 'sb-warn-dot' }), h('span', null, w.label),
              h('div', { className: 'sb-spacer' }),
              h('button', { className: 'sb-btn', onClick: () => run('/signalboard-pref ' + JSON.stringify({ action: 'snooze', path, type: w.type, label: w.label }), T('dt.muted')) }, T('dt.mute')),
            )),
            snoozeKeys.map((k) => h('div', { key: 'm' + k, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', opacity: .7 } },
              h('span', { className: 'sb-muted' }, T('dt.muted') + '：' + (mySnoozes[k] || k)),
              h('div', { className: 'sb-spacer' }),
              h('button', { className: 'sb-btn', onClick: () => run('/signalboard-pref ' + JSON.stringify({ action: 'unsnooze', path, type: k }), T('dt.unmute')) }, T('dt.unmute')),
            )),
          ) : null,
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.quickopen')),
            h('div', { style: { display: 'flex', gap: 8 } },
              ['folder', 'editor', 'terminal'].map((k) => h('button', {
                key: k, className: 'sb-btn',
                onClick: () => run('/signalboard-open ' + JSON.stringify({ path, kind: k })),
              }, T('dt.open.' + k))),
            ),
          ),
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.memo')),
            h('textarea', { className: 'sb-textarea', value: memo, placeholder: T('dt.memoPlaceholder'), onChange: (e) => setMemo(e.target.value) }),
            h('button', {
              className: 'sb-btn accent', style: { marginTop: 8 }, disabled: saving,
              onClick: () => {
                setSaving(true);
                runCommand('/signalboard-memo ' + JSON.stringify({ path, text: memo }))
                  .then((r) => say(r && r.kind === 'success' ? T('dt.memoSaved') : (r && r.text) || T('cmd.failed')))
                  .catch((e) => say(T('cmd.failed') + '：' + (e && e.message)))
                  .finally(() => { setSaving(false); refreshSoon(); });
              },
            }, T('dt.memoSave')),
          ),
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.handoffs') + (p.handoffs ? ' · ' + (T('dt.handoff.total') || '').replace('{n}', String(p.handoffs.total ?? '')) : '')),
            (!p.handoffs || !p.handoffs.latest)
              ? h('div', { className: 'sb-muted' }, T('dt.handoff.none'))
              : h('div', { className: 'sb-handoff' },
                  (p.handoffs.unreadCount > 0 ? h('span', { className: 'sb-unread' }) : null),
                  h('span', { className: 'sb-muted' }, T('dt.handoff.latest')),
                  h('span', null, p.handoffs.latest.text),
                  h('div', { className: 'sb-muted sb-mono', style: { fontSize: 11, marginTop: 2 } },
                    (p.handoffs.latest.agent || '') + ' · ' + relTime(p.handoffs.latest.createdAt, now)),
                  !p.handoffs.latest.doneAt ? h('button', {
                    className: 'sb-btn', style: { marginTop: 6 },
                    onClick: () => run('/signalboard-handoff-done ' + JSON.stringify({ path, id: p.handoffs.latest.id })),
                  }, T('dt.handoff.done')) : null,
                ),
          ),
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.advice')),
            myAdvice
              ? h('div', null,
                  h('div', { style: { whiteSpace: 'pre-wrap' } }, myAdvice.text),
                  h('div', { className: 'sb-muted', style: { fontSize: 11, marginTop: 4 } }, T('ov.weekly.engine') + ' · ' + relTime(myAdvice.at, now)),
                )
              : h('div', { className: 'sb-muted' }, T('dt.advice.empty')),
            h('button', { className: 'sb-btn accent', style: { marginTop: 8 }, onClick: () => run('/signalboard-advice ' + JSON.stringify({ path })) }, T('dt.advice.ask')),
          ),
          (p.recentCommits || []).length > 0 ? h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.recentCommits')),
            p.recentCommits.slice(0, 5).map((c, i) => h('div', { key: i, className: 'sb-mono', style: { padding: '2px 0' } }, '· ' + (c.msg || c.message || ''))),
          ) : null,
          (p.dirtyFiles || []).length > 0 ? h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.dirtyFiles') + ' · ' + p.dirtyFiles.length),
            p.dirtyFiles.slice(0, 10).map((f, i) => h('div', { key: i, className: 'sb-mono sb-muted', style: { padding: '1px 0' } }, typeof f === 'string' ? f : (f.path || f.name || ''))),
          ) : null,
          h('div', { className: 'sb-card' },
            h('div', { className: 'sb-h3', style: { margin: '0 0 6px' } }, T('dt.readme') + ' / ' + T('dt.aiSessions')),
            !deep ? h('div', { className: 'sb-muted' }, T('dt.detailLoading')) : [
              deep.readme ? h('div', { key: 'r', className: 'sb-muted', style: { whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden' } }, deep.readme) : null,
              (deep.aiSessions || []).length > 0 ? h('div', { key: 's', className: 'sb-mono sb-muted', style: { marginTop: 6 } },
                deep.aiSessions.slice(0, 5).map((s, i) => h('div', { key: i }, '· ' + (typeof s === 'string' ? s : (s.name || s.tool || '')))) , null) : null,
              !deep.readme && (deep.aiSessions || []).length === 0 ? h('div', { className: 'sb-muted' }, '—') : null,
            ],
          ),
          toast ? h('div', { className: 'sb-toast' }, toast) : null,
        );
      }

      // ---- 根组件：轮询 + 视图路由 ----
      function Page() {
        const [phase, setPhase] = React.useState('loading');
        const [data, setData] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [view, setView] = React.useState({ kind: 'overview' });
        const [now, setNow] = React.useState(Date.now());
        const load = React.useCallback(() => {
          fetchBoard().then(
            (d) => { setPhase('ready'); setData(d); setError(null); },
            (e) => { setPhase('error'); setError(e); },
          );
        }, []);
        React.useEffect(() => { load(); }, [load]);
        React.useEffect(() => {
          const poll = setInterval(load, 30000);
          const tick = setInterval(() => setNow(Date.now()), 60000);
          return () => { clearInterval(poll); clearInterval(tick); };
        }, [load]);
        const refreshSoon = React.useCallback(() => { setTimeout(load, 400); }, [load]);
        if (phase === 'loading' && !data) return h('div', { className: 'sb-root', style: PAD }, h('span', { className: 'sb-muted' }, T('panel.loading')));
        if (phase === 'error' && !data) return h('div', { className: 'sb-root', style: PAD },
          h('div', { className: 'sb-err' }, T('panel.loadError') + '：' + (error && error.message)),
          h('button', { className: 'sb-btn', style: { marginTop: 8 }, onClick: load }, T('panel.retry')));
        const scannedAt = data && data.scannedAt;
        const age = scannedAt ? relTime(scannedAt, now) : '';
        return h('div', { className: 'sb-root', style: PAD },
          h(TopBar, { view: view.kind, setView: (k) => setView({ kind: k }), onRefresh: load, ageText: age }),
          view.kind === 'overview' ? h(Overview, { data, goDetail: (p) => setView({ kind: 'detail', path: p }), now, refreshSoon }) : null,
          view.kind === 'board' ? h(Board, { data, goDetail: (p) => setView({ kind: 'detail', path: p }), now }) : null,
          view.kind === 'detail' ? h(Detail, { data, path: view.path, goBack: () => setView({ kind: 'board' }), now, refreshSoon }) : null,
        );
      }

      // T()：命名空间 t 的工厂内兜底（apply 前 ctx 未定；组件内主要靠 kit t，这里统一出口便于占位期）
      let tSeat = null;
      function T(key) {
        if (tSeat) { try { const v = tSeat(key); if (v) return v; } catch { /* fallthrough */ } }
        const lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
        return ((/^zh/i.test(lang) ? zh : en)[key]) || key;
      }
      const PAD = { padding: 14, maxWidth: 720, margin: '0 auto' };
      return { Page, T: (seat) => { tSeat = seat; } };
    }

    // ============ 装配 ============
    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('signalboard', { zh, en }), 'signalboard: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'signalboard: stylesheet');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'signalboard',
          order: 60,
          locale: 'signalboard',
          label: (t) => (typeof t === 'function' ? t('panel.title') : 'SignalBoard'),
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'signalboard',
          locale: 'signalboard',
        }, function SignalboardPage(props) {
          const app = React.useMemo(() => createApp({ ctx }), []);
          React.useEffect(() => {
            // 面板注册了 locale 命名空间 → kit.t 即该命名空间的 seat
            app.T(typeof props.t === 'function' ? props.t : null);
          }, [app, props.t]);
          return h(app.Page, null);
        }));
      },
    };
  },
});
