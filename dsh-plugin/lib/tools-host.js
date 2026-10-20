// 13 个 DSH agent 工具（设计 §3 工具面）：MCP 十工具同口径映射 + weekly_facts/advice_facts
// 两个事实工具 + save_summary 窄写面。复用 src/mcp/tools.js 纯函数实现（callTool 分发），
// 警示重算/信封新鲜度/白名单边界原样继承——备忘写面与消音面不存在于本清单（§8 审计点）。
//
// 注册契约（V4 实测）：definition = {name, description, parameters(JSON Schema), output:{schema, render},
// execute(args, exec), isConcurrencySafe?}；裸 register 无自动参数校验 → 每个工具先做参数防御；
// execute 抛错由注册表转 isError（文本 Error: <message>），业务错误码放方括号前缀（mcpCode 风格）。
import { mcpTools } from './domain.js';
import { makeSnapshot } from './snap.js';
import { quickOpen, openCli } from './actions.js';
import * as facts from './facts.js';
import * as summary from './summary.js';

// MCP 工具名 → DSH 工具名（signalboard_ 前缀 = 平面命名空间的显式归属，语义同口径）
const MCP_ALIASES = {
  signalboard_list_projects: 'list_projects',
  signalboard_get_project: 'get_project',
  signalboard_get_attention: 'get_attention',
  signalboard_get_memos: 'get_memos',
  signalboard_get_handoffs: 'get_handoffs',
  signalboard_handoff_write: 'handoff_write',
  signalboard_handoff_complete: 'handoff_complete',
};

function requiredString(args, key, tool) {
  const v = args ? args[key] : undefined;
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    const err = new Error(`[${tool}] 参数 ${key} 必须是非空字符串`);
    err.code = 'BAD_ARGS';
    throw err;
  }
  return s;
}

function optionalEnum(args, key, values, fallback) {
  const v = args ? args[key] : undefined;
  return values.includes(v) ? v : fallback;
}

function fail(err) {
  if (err && err.code && !String(err.message).startsWith('[')) {
    throw new Error('[' + err.code + '] ' + err.message);
  }
  throw err;
}

// 信封带 dataAgeMs：与 MCP 同款新鲜度语义（agent 自判数据龄）
function envelope(store, now, data) {
  const cache = store.getScanCache();
  const scannedAt = cache.scannedAt || null;
  const dataAgeMs = scannedAt ? Math.max(0, now.getTime() - Date.parse(scannedAt)) : null;
  return { scannedAt, dataAgeMs, ...data };
}

export function buildToolDefs(ctx, store, cfg) {
  const snapOf = () => makeSnapshot(store, cfg);

  // MCP 同口径工具：快照现取 → callTool 分发（业务错误码透传）
  function mcpExec(mcpName, argFix) {
    return (args) => {
      try {
        const fixed = argFix ? argFix(args || {}) : (args || {});
        return mcpTools.callTool(snapOf(), mcpName, fixed);
      } catch (err) {
        return fail(err);
      }
    };
  }

  const renderJson = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  // V4 实测勘误：output.schema 的 type 白名单只有 object/array/string/number/integer/boolean/null
  // （计划 §0 V4 行把 json/oneOf 写进受控子集是过度陈述，注册即拒）；13 工具返回值全为对象信封，
  // 统一收敛 type:'object'——schema 不再下钻，具体形状由 render 的 JSON 文本承载
  const jsonOut = () => ({ schema: { type: 'object', description: 'JSON 数据（信封含 scannedAt/dataAgeMs）' }, render: renderJson });
  const readOnly = () => true;
  const notSafe = () => false;

  return [
    {
      name: 'signalboard_list_projects',
      description: '列出 SignalBoard 扫描发现的全部本机 git 项目：路径/名称/分支/活跃分带/最后活动时间/警示标记（按当前警示规则重算）',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: jsonOut(),
      execute: mcpExec('list_projects'),
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_get_project',
      description: '读取单个项目的近况信号全量：提交/未提交/领先落后/AI 会话/分带/警示/备忘/最新交接',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '项目绝对路径（signalboard_list_projects 返回的 path）' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: (args) => mcpExec('get_project')({ path: requiredString(args, 'path', 'signalboard_get_project') }),
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_get_attention',
      description: '读取需要关注清单：有警示标记的项目，按严重度排序（未提交超期 > 未推送 > CI 失败 > 待处理 review > 开放 PR）',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: jsonOut(),
      execute: mcpExec('get_attention'),
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_get_memos',
      description: '读取备忘（人写的项目笔记）。带 path 返回单项目备忘；不带返回全部',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '项目绝对路径（可选）' } },
        required: [],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: mcpExec('get_memos'),
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_get_handoffs',
      description: '读取交接（agent 留给下一个执行者的接力留言）。带 path 返回该项目条目（新在前）；不带返回全部',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '项目绝对路径（可选）' } },
        required: [],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: mcpExec('get_handoffs'),
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_handoff_write',
      description: '为指定项目写一条交接（agent 留给下一个执行者的接力留言）。仅此写面与 signalboard_handoff_complete——备忘与警示消音不可经工具改动',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目绝对路径' },
          text: { type: 'string', description: '交接正文（做了什么、下一步注意什么）' },
          agent: { type: 'string', description: 'agent 署名（缺省为 agent）' },
        },
        required: ['path', 'text'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: (args) => mcpExec('handoff_write')({
        path: requiredString(args, 'path', 'signalboard_handoff_write'),
        text: requiredString(args, 'text', 'signalboard_handoff_write'),
        ...(args && typeof args.agent === 'string' ? { agent: args.agent } : {}),
      }),
      isConcurrencySafe: notSafe,
    },
    {
      name: 'signalboard_handoff_complete',
      description: '标记某条交接已被接力完成（幂等，doneAt 不刷新）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目绝对路径' },
          id: { type: 'string', description: '交接条目 id（signalboard_get_handoffs 返回的 id）' },
        },
        required: ['path', 'id'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: (args) => mcpExec('handoff_complete')({
        path: requiredString(args, 'path', 'signalboard_handoff_complete'),
        id: requiredString(args, 'id', 'signalboard_handoff_complete'),
      }),
      isConcurrencySafe: notSafe,
    },
    {
      name: 'signalboard_rescan',
      description: '立即触发一次全量重扫——插件进程内直扫（自己就是扫描者），完成后返回新的 scannedAt 与项目数',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: jsonOut(),
      execute: async () => {
        const next = await ctxSignalboard().rescan();
        return { rescanned: true, scannedAt: next.scannedAt, count: Object.keys(next.projects).length, note: '已在插件进程内完成重扫' };
      },
      isConcurrencySafe: notSafe,
    },
    {
      name: 'signalboard_quickopen',
      description: '在资源管理器/编辑器/终端打开某项目（可见窗口，人在环）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目绝对路径' },
          kind: { type: 'string', enum: ['folder', 'editor', 'terminal'], description: '缺省 folder' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: async (args) => {
        const p = requiredString(args, 'path', 'signalboard_quickopen');
        const kind = optionalEnum(args, 'kind', ['folder', 'editor', 'terminal'], 'folder');
        const config = store.getConfig();
        const r = await quickOpen(p, kind, config);
        if (!r.ok) {
          const err = new Error(r.reason || '打开失败');
          err.code = 'OPEN_FAILED';
          return fail(err);
        }
        return envelope(store, new Date(), { opened: { path: p, kind } });
      },
      isConcurrencySafe: notSafe,
    },
    {
      name: 'signalboard_open_cli',
      description: '在项目目录的可见终端里启动指定 AI CLI（可带 prompt 预填，按 CLI 注册行 prefill 方式）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目绝对路径' },
          cmd: { type: 'string', description: 'AI CLI 命令（如 claude）' },
          prompt: { type: 'string', description: '初始 prompt（支持度按注册行 prefill）' },
        },
        required: ['path', 'cmd'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: async (args) => {
        const p = requiredString(args, 'path', 'signalboard_open_cli');
        const c = requiredString(args, 'cmd', 'signalboard_open_cli');
        const r = await openCli(c, p, args && args.prompt, store.getConfig());
        if (!r.ok) {
          const err = new Error(r.reason || '终端启动失败');
          err.code = 'OPEN_FAILED';
          return fail(err);
        }
        return envelope(store, new Date(), { launched: { path: p, cmd: c }, note: r.note || '' });
      },
      isConcurrencySafe: notSafe,
    },
    {
      name: 'signalboard_weekly_facts',
      description: '读取 AI 周报的事实块：近 7 天各项目的提交事实（与桌面端周报同一组装线）。供你生成周报文本；生成后用 signalboard_save_summary 落缓存',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: jsonOut(),
      execute: () => {
        const cache = store.getScanCache();
        const out = facts.weeklyFacts(cache, new Date());
        if (out.empty) {
          const err = new Error(out.reason);
          err.code = 'NO_FACTS';
          return fail(err);
        }
        return envelope(store, new Date(), { facts: out.facts, projects: out.projects });
      },
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_advice_facts',
      description: '读取单个项目的 AI 建议事实块：git 信号 + 警示 + 最近提交（与桌面端建议同一组装线）。供你生成下一步建议；生成后用 signalboard_save_summary 落缓存',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '项目绝对路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: (args) => {
        const p = requiredString(args, 'path', 'signalboard_advice_facts');
        const out = facts.adviceFacts(store.getScanCache(), p, new Date());
        if (!out.ok) {
          const err = new Error(out.reason);
          err.code = out.code;
          return fail(err);
        }
        return envelope(store, new Date(), { project: out.project, facts: out.facts });
      },
      isConcurrencySafe: readOnly,
    },
    {
      name: 'signalboard_save_summary',
      description: "保存你生成的 AI 总结到插件缓存（唯一写面）：kind='weekly' 落本周总结（按天覆盖复用），kind='advice' 连同 path 落单项目建议。只写 dsh-summary-cache.json，不碰备忘/消音/prefs",
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['weekly', 'advice'], description: '总结类型' },
          path: { type: 'string', description: "kind='advice' 时必填：项目绝对路径" },
          text: { type: 'string', description: '总结正文（按周报/建议的结构输出）' },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      output: jsonOut(),
      execute: (args) => {
        const kind = optionalEnum(args, 'kind', ['weekly', 'advice'], null);
        if (!kind) {
          const err = new Error('[BAD_KIND] kind 必须是 weekly 或 advice');
          throw err;
        }
        const text = requiredString(args, 'text', 'signalboard_save_summary');
        const entry = summary.saveSummary(store, { kind, path: args && args.path, text });
        return envelope(store, new Date(), { written: true, kind, entry });
      },
      isConcurrencySafe: notSafe,
    },
  ];
}

// rescan 工具需要服务侧在飞去重；index.js 装配时挂到本模块（避免循环依赖用惰性取）
let serviceRef = null;
export function bindService(svc) {
  serviceRef = svc;
}
function ctxSignalboard() {
  if (!serviceRef) throw new Error('[INTERNAL] service 未绑定');
  return serviceRef;
}
