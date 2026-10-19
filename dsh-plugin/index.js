// SignalBoard DSH 插件 Host 半边（ADR-0005 / docs/superpowers/specs/2026-10-19-dsh-plugin-design.md）：
// - signalboard 工具面：13 个 agent 工具（MCP 十工具同口径 + weekly_facts/advice_facts + save_summary）
// - UI 命令：备忘/偏好/交接完成（一个操作两个调用方）+ 周报/建议触发链（注入会话）
// - 面板数据路由：GET /api/signalboard/board（webServer 可选，缺席降级）
// - 常驻扫描：激活首扫 + scanIntervalMin 定时静默刷新（timer 在 effect 内自清）
// 零 bare import：域模块经 lib/domain.js 的 createRequire 桥加载（目录链接安装语义）。
import path from 'node:path';
import { Store } from './lib/domain.js';
import { defaultUserDataDir } from './lib/snap.js';
import { createService } from './lib/service.js';
import { buildToolDefs, bindService } from './lib/tools-host.js';
import { registerCommands } from './lib/commands-host.js';

// 插件 Config（V3：Standard Schema 手写校验器，无 schemastery 依赖）。
// 只放 DSH 侧专属项：userDataDir（默认与桌面应用共享目录）；appExe/appCwd 供写交接后
// 通知运行中应用（可选，缺省跳过刷新走自愈）。扫描根目录等域配置以 userData 的
// config.json 为唯一事实源——用户不配两遍，桌面端改了插件即用（插件只读）。
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'signalboard',
    validate(value) {
      const v = value && typeof value === 'object' ? value : {};
      const out = {};
      const stringField = (key, label) => {
        if (v[key] === undefined) return true;
        if (typeof v[key] !== 'string' || (key === 'userDataDir' && !v[key].trim())) {
          return { message: label + ' 必须是非空字符串', path: [key] };
        }
        out[key] = v[key];
        return true;
      };
      for (const [key, label] of [['userDataDir', 'userDataDir'], ['appExe', 'appExe'], ['appCwd', 'appCwd']]) {
        const r = stringField(key, label);
        if (r !== true) return { issues: [r] };
      }
      return { value: out };
    },
  },
};

// 注入核心服务（缺席则插件不激活——Loader 语义，不阻塞 DSH 启动）
export const inject = ['tools', 'commands'];

export function apply(ctx, config) {
  const cfg = config || {};
  const userDataDir = cfg.userDataDir
    ? path.resolve(cfg.userDataDir)
    : defaultUserDataDir();
  // Store 构造会静默建 userData 目录（设计 §7：常驻插件首启空态合理，与 MCP 报错退出的差异是有意的）
  const store = new Store(userDataDir);
  const svc = createService(ctx, store, cfg);
  bindService(svc); // rescan 工具经此取在飞去重的重扫 Promise

  // 13 个 agent 工具：逐个注册并持有 disposer
  for (const def of buildToolDefs(ctx, store, cfg)) {
    ctx.effect(() => ctx.tools.register(def), 'signalboard: tool ' + def.name);
  }

  // UI 命令（描述走宿主 locale 服务由 Client 注册字典；Host 侧描述用注册时静态文案兜底）
  ctx.effect(() => registerCommands(ctx, store, svc), 'signalboard: commands');

  // 面板数据路由（可选能力）：同源 GET，读侧与 agent 工具共用同一拼板实现
  ctx.effect(() => {
    const webServer = ctx.get('webServer');
    if (!webServer) return; // 无 web 服务器的部署（headless）面板数据走命令通道
    return webServer.register({
      kind: 'exact',
      path: '/api/signalboard/board',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end();
          return;
        }
        svc.boardPayload().then((data) => {
          const body = JSON.stringify(data);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(req.method === 'HEAD' ? undefined : body);
        }, (err) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: String((err && err.message) || err) }));
        });
      },
    });
  }, 'signalboard: board route');

  // 常驻扫描：激活扫一次 + 定时静默刷新（scanIntervalMin 来自 userData config.json，
  // 下限 5 分钟；定时器登记进 effect，插件卸载即清）
  ctx.effect(() => {
    void svc.rescan().catch((err) => {
      ctx.logger.warn('[signalboard] 激活首扫失败: ' + ((err && err.message) || err));
    });
    let timer = null;
    const arm = () => {
      const min = Math.max(5, store.getConfig().scanIntervalMin || 20);
      timer = setInterval(() => {
        void svc.rescan().catch(() => { /* 下个周期自愈 */ });
      }, min * 60 * 1000);
      if (timer.unref) timer.unref();
    };
    arm();
    return () => { if (timer) clearInterval(timer); };
  }, 'signalboard: scan loop');
}
