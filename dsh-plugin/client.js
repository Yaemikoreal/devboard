// SignalBoard DSH 插件 Client 半边（计划 Task 4）：侧栏图标 + main 键控面板 + locale。
// 契约实测（whale-pet 参照 + dsh-client-ui-renderer 源码）：
// - 工厂形状 window.__ModuleLoader__.load({id, factory(require) → {inject, apply}})；
// - ctx.slots.inject(slot名, () => ctx.slots.register(options, Component))——register 内部自带
//   effect 生命周期，外层不必再包；
// - 注册选项 locale: '<ns>' 使组件 kit 携带 t（localeSeat），侧栏条目 label 经 resolveSlotLabel
//   支持（t） => 字符串并在 locale 变化时重算；
// - main 是 keyed 槽（kind:"keyed"）：options.key 即面板 id，ctx.layout.selectPanel(key) 切换；
// - 组件 props 携带标准 kit（useSessions 等宿主 hooks 由 renderer 注入）。
window.__ModuleLoader__.load({
  id: '@local/signalboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---- locale 字典（同源镜像 shared/constants 的分带词表之外的面板文案；Task 5 扩展）----
    const zh = {
      'meta.title': 'SignalBoard',
      'panel.title': 'SignalBoard',
      'panel.loading': '正在读取项目概况…',
      'panel.loadError': '读取失败',
      'panel.retry': '重试',
      'panel.empty': '尚未发现项目——请先在桌面端设置扫描根目录，或在本会话内运行 signalboard_rescan。',
      'panel.task4Placeholder': '三视图（总览/项目板/详情）在 Task 5 落地。',
    };
    const en = {
      'meta.title': 'SignalBoard',
      'panel.title': 'SignalBoard',
      'panel.loading': 'Loading project overview…',
      'panel.loadError': 'Failed to load',
      'panel.retry': 'Retry',
      'panel.empty': 'No projects found — configure scan roots in the desktop app first, or run signalboard_rescan in this session.',
      'panel.task4Placeholder': 'Three views (overview / project board / detail) arrive in Task 5.',
    };

    // ---- 侧栏图标：icon.svg 图形语言的单色线性版（3x3 点阵，对角信号格），跟随 currentColor ----
    function PanelIcon({ size, active }) {
      const s = size || 16;
      const fill = active ? 'var(--dsw-alias-accent)' : 'currentColor';
      const cell = (x, y, signal) => h('rect', {
        x, y, width: 5.4, height: 5.4, rx: 1.1,
        fill: signal ? fill : fill,
        opacity: signal ? 1 : 0.38,
      });
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true,
        style: { display: 'block' },
      },
        cell(2.5, 2.5, false), cell(9.3, 2.5, false), cell(16.1, 2.5, true),
        cell(2.5, 9.3, false), cell(9.3, 9.3, false), cell(16.1, 9.3, false),
        cell(2.5, 16.1, true), cell(9.3, 16.1, false), cell(16.1, 16.1, false),
      );
    }

    // ---- 面板数据层（Task 5.1 提前落地：读 = web 路由，失败降级提示命令通道）----
    async function fetchBoard() {
      const res = await fetch('/api/signalboard/board', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    function SignalboardPage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const load = React.useCallback(() => {
        setState({ phase: 'loading', data: null, error: null });
        fetchBoard().then(
          (data) => setState({ phase: 'ready', data, error: null }),
          (err) => setState({ phase: 'error', data: null, error: err }),
        );
      }, []);
      React.useEffect(() => { load(); }, [load]);

      if (state.phase === 'loading') {
        return h('div', { style: pad(16) }, h('span', { style: dim() }, t0('panel.loading')));
      }
      if (state.phase === 'error') {
        return h('div', { style: pad(16) },
          h('div', { style: dim() }, t0('panel.loadError') + '：' + (state.error && state.error.message)),
          h('button', { onClick: load, style: btn() }, t0('panel.retry')),
        );
      }
      const board = state.data && state.data.board;
      const guide = state.data && state.data.guide;
      return h('div', { style: pad(16) },
        h('h2', { style: { margin: '0 0 8px', fontSize: 16 } }, 'SignalBoard'),
        (!board || !board.stats || board.stats.total === 0)
          ? h('div', { style: dim() }, t0('panel.empty'))
          : h('div', { style: dim() },
              'projects: ' + board.stats.total + ' · commits7d: ' + board.stats.commits7d
              + ' · attention: ' + board.stats.attentionCount
              + (guide ? ' · userData: ' + guide.userDataDir : '')),
        h('div', { style: dim() }, t0('panel.task4Placeholder')),
      );
    }

    // 工厂闭包内无 ctx.locale  seat 时的静态兜底文案（面板注册了 locale 命名空间后组件 kit 有 t；
    // 占位阶段先用简版直接渲染键对应的中文——Task 5 全面换 t()）
    function t0(key) {
      const lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
      const dict = /^zh/i.test(lang) ? zh : en;
      return dict[key] || key;
    }
    function pad(n) { return { padding: n, fontFamily: 'inherit' }; }
    function dim() { return { color: 'var(--dsw-alias-fg-muted, inherit)', fontSize: 13, lineHeight: 1.6 }; }
    function btn() {
      return {
        marginTop: 8, padding: '4px 12px', cursor: 'pointer',
        background: 'var(--dsw-alias-bg-subtle, transparent)',
        border: '1px solid var(--dsw-alias-border, currentColor)', borderRadius: 6, color: 'inherit',
      };
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('signalboard', { zh, en }), 'signalboard: dictionaries');
        // 侧栏入口：panellist 条目（图标组件）——label 用函数形式走 locale seat
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'signalboard',
          order: 60,
          locale: 'signalboard',
          label: (t) => (typeof t === 'function' ? t('panel.title') : 'SignalBoard'),
        }, PanelIcon));
        // 主面板：keyed 槽，key 即 selectPanel 目标 id
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'signalboard',
          locale: 'signalboard',
        }, SignalboardPage));
      },
    };
  },
});
