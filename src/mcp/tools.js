// MCP 查询工具实现（issue #148）：首版五个只读工具，全部为纯函数——入参 { store, config, now }
// 快照，出参为可 JSON 序列化的数据。乙形态（主进程内嵌）迁移与单测都直接复用。
// 口径纪律：
// - 警示在响应侧重算（scanner.localWarnings + scanner.warningRulesOf），不吐缓存里的旧规则产物——
//   与 assembleBoard 同口径，防「板说没警示、agent 查到警示」的漂移
// - 需要关注排序照 WARN_SEVERITY（shared/constants），与 assembleBoard 同序
// - token 与凭据类字段一律不进响应；github-cache 整体不外泄（首版工具面不含 github）
'use strict';

const scanner = require('../main/scanner');
const handoffsSvc = require('../main/handoffs');
const actionProto = require('./protocol');
const { WARN_SEVERITY } = require('../shared/constants');

// 响应信封：附带 scannedAt 与数据龄，由 agent 自判新鲜度（甲形态新鲜度 = scannedAt）
function envelope(store, config, now, data) {
  const cache = store.getScanCache();
  const scannedAt = cache.scannedAt || null;
  const dataAgeMs = scannedAt ? Math.max(0, now.getTime() - Date.parse(scannedAt)) : null;
  return { scannedAt, dataAgeMs, ...data };
}

// 项目快照的响应侧重算：警示按当前规则重算 + 消音不在此处（消音是人的偏好，MCP 响应给全量事实）
function decorate(store, config, now, p) {
  const out = { ...p };
  out.warnings = scanner.localWarnings(out, now, scanner.warningRulesOf(config));
  return out;
}

function listProjects({ store, config, now }) {
  const cache = store.getScanCache();
  const projects = Object.values(cache.projects).map((p) => decorate(store, config, now, p));
  return envelope(store, config, now, {
    count: projects.length,
    projects: projects.map((p) => ({
      path: p.path, name: p.name, branch: p.branch, band: p.band,
      lastActivityAt: p.lastActivityAt || null,
      warnings: (p.warnings || []).map((w) => ({ type: w.type, label: w.label })),
      hasMemo: !!(p.memo),
    })),
  });
}

function getProject({ store, config, now }, args) {
  const want = String((args && args.path) || '');
  const cache = store.getScanCache();
  const raw = cache.projects[want] || null;
  if (!raw) {
    const err = new Error('项目不在扫描缓存中：' + (want || '(空路径)'));
    err.mcpCode = 'PROJECT_NOT_FOUND';
    throw err;
  }
  const p = decorate(store, config, now, raw);
  const memo = store.getMemos()[p.path] || '';
  // 交接摘要：与拼板 applyToProjects 同口径（latest + 未读数按人的已读游标）
  const entries = handoffsSvc.listHandoffs(store, p.path);
  return envelope(store, config, now, {
    project: {
      path: p.path, name: p.name, branch: p.branch, band: p.band,
      commits7d: p.commits7d, recentCommits: p.recentCommits || [],
      dirtyCount: p.dirtyCount, dirtyAt: p.dirtyAt || null,
      ahead: p.ahead, behind: p.behind,
      lastCommitAt: p.lastCommitAt || null, aiSessionAt: p.aiSessionAt || null,
      lastActivityAt: p.lastActivityAt || null, headSha: p.headSha || null,
      warnings: (p.warnings || []).map((w) => ({ type: w.type, label: w.label })),
      memo,
      handoffs: entries.length
        ? { latest: { id: entries[0].id, agent: entries[0].agent, text: entries[0].text, createdAt: entries[0].createdAt, doneAt: entries[0].doneAt || null }, total: entries.length }
        : { latest: null, total: 0 },
    },
  });
}

// 需要关注清单：警示按当前规则重算后取非空项目，严重度升序（dirty > ahead > ci > review > pr）、
// 同级按名称稳定排序——与 assembleBoard 的 attention 同口径
function getAttention({ store, config, now }) {
  const cache = store.getScanCache();
  const severityOf = (types) => Math.min.apply(null, types.map((t) => (t in WARN_SEVERITY ? WARN_SEVERITY[t] : 9)));
  const attention = Object.values(cache.projects)
    .map((p) => decorate(store, config, now, p))
    .filter((p) => (p.warnings || []).length > 0)
    .map((p) => ({
      path: p.path,
      name: p.name,
      label: p.warnings.map((w) => w.label).join('，'),
      types: p.warnings.map((w) => w.type),
    }))
    .sort((a, b) => severityOf(a.types) - severityOf(b.types) || a.name.localeCompare(b.name));
  return envelope(store, config, now, { attentionCount: attention.length, attention });
}

function getMemos({ store, config, now }, args) {
  const all = store.getMemos();
  const want = args && args.path ? String(args.path) : null;
  const data = want
    ? { path: want, memo: all[want] || '', exists: Object.prototype.hasOwnProperty.call(all, want) }
    : { memos: all };
  return envelope(store, config, now, data);
}

function getHandoffs({ store, config, now }, args) {
  const want = args && args.path ? String(args.path) : null;
  const data = want
    ? { path: want, handoffs: handoffsSvc.listHandoffs(store, want) }
    : { handoffs: store.getHandoffs() };
  return envelope(store, config, now, data);
}

// 写面（issue #149，ADR-0004 第 3 条）：agent 写交接 / 标记接力完成——薄封装 handoffs.js。
// **白名单即边界**：备忘写入与消音类工具不存在于 TOOL_DEFS（不是「实现了不暴露」，是不实现），
// agent 写不了备忘、动不了消音，审计 tools/list 即可验证合规。
// 写入后经 appSpawn（server 注入的「拉起应用 exe 带 --mcp-action=refresh」函数）请求应用
// 立即重拼推补丁，未读点即时可见；应用未运行时会拉起应用（启动段处理同一动作）。
function requestAppRefresh(snap) {
  if (!snap.appSpawn) return false;
  try {
    snap.appSpawn({ 'mcp-action': 'refresh' });
    return true;
  } catch {
    return false; // 拉起失败（exe 缺失等）：数据已落盘，UI 下个刷新周期自会带上
  }
}

function handoffWrite(snap, args) {
  const a = args || {};
  const entry = handoffsSvc.writeHandoff(snap.store, String(a.path || ''), {
    agent: a.agent,
    text: a.text,
  });
  const refreshRequested = requestAppRefresh(snap);
  return envelope(snap.store, snap.config, snap.now, {
    written: entry,
    refreshRequested,
    note: refreshRequested ? '已请求应用刷新，未读点即时可见' : '已写入；应用不在运行或未配置 --app-exe，未读点在下个刷新周期出现',
  });
}

function handoffComplete(snap, args) {
  const a = args || {};
  const updated = handoffsSvc.markDone(snap.store, String(a.path || ''), String(a.id || ''));
  const refreshRequested = requestAppRefresh(snap);
  return envelope(snap.store, snap.config, snap.now, { updated, refreshRequested });
}

// 动作工具（issue #149，读法一）：触发重扫 / 快捷打开 / 在项目目录起 AI CLI——
// 全部透出现有能力，写操作永远落在可见终端、人在环；不做无人值守自动调度（ADR-0004 第 4 条已否）。
// 动作经 protocol.buildActionArgv 构造 argv，detached 拉起应用 exe（second-instance/启动段处理），
// 语义是「请求」：不等待完成结果。
function actionSpawn(snap, action) {
  if (!snap.appSpawn) {
    const err = new Error('无法定位 SignalBoard 应用（注册 MCP 时需带 --app-exe）——动作工具不可用，查询工具不受影响');
    err.mcpCode = 'APP_NOT_CONFIGURED';
    throw err;
  }
  try {
    actionProto.buildActionArgv(action); // 校验：未知键/缺 action 在此报 BAD_ACTION
  } catch (err) {
    err.mcpCode = 'BAD_ACTION';
    throw err;
  }
  snap.appSpawn(action); // appSpawn 约定收 action 对象（server 侧包装内构造 argv，与 requestAppRefresh 一致）
  return { requested: true, note: '已请求应用执行该动作（人在环，结果在应用内查看）' };
}

function rescan(snap) {
  return envelope(snap.store, snap.config, snap.now, actionSpawn(snap, { 'mcp-action': 'rescan' }));
}

function quickOpenTool(snap, args) {
  const a = args || {};
  const kind = ['folder', 'editor', 'terminal'].includes(String(a.kind)) ? String(a.kind) : 'folder';
  return envelope(snap.store, snap.config, snap.now, actionSpawn(snap, {
    'mcp-action': 'quickopen',
    'mcp-path': String(a.path || ''),
    'mcp-kind': kind,
  }));
}

function openCli(snap, args) {
  const a = args || {};
  const promptB64 = actionProto.encodePrompt(a.prompt);
  const action = {
    'mcp-action': 'open-cli',
    'mcp-path': String(a.path || ''),
    'mcp-cmd': String(a.cmd || ''),
  };
  if (promptB64) action['mcp-prompt-b64'] = promptB64;
  return envelope(snap.store, snap.config, snap.now, actionSpawn(snap, action));
}

// 工具登记面（白名单即边界，issue #149）：五个只读（#148）+ 两个交接写（agent 写交接、
// 标记接力完成）+ 三个动作（触发重扫/快捷打开/起 AI CLI，人在环）。
// 备忘写入与消音类工具**不存在于清单**——ADR-0004 写面边界固化成结构保证，审计 tools/list 即可验证
const TOOL_DEFS = [
  {
    name: 'list_projects',
    description: '列出 SignalBoard 扫描发现的全部项目：路径/名称/分支/活跃分带/最后活动时间/警示标记（按当前警示规则重算）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (snap) => listProjects(snap),
  },
  {
    name: 'get_project',
    description: '读取单个项目的近况信号全量：提交/未提交/领先落后/AI 会话/分带/警示/备忘/最新交接',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '项目绝对路径（list_projects 返回的 path）' } }, required: ['path'], additionalProperties: false },
    run: (snap, args) => getProject(snap, args),
  },
  {
    name: 'get_attention',
    description: '读取需要关注清单：有警示标记的项目，按严重度排序（未提交超期 > 未推送 > CI 失败 > 待处理 review > 开放 PR）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (snap) => getAttention(snap),
  },
  {
    name: 'get_memos',
    description: '读取备忘（人写的项目笔记）。带 path 返回单项目备忘；不带返回全部',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    run: (snap, args) => getMemos(snap, args),
  },
  {
    name: 'get_handoffs',
    description: '读取交接（agent 留给下一个执行者的接力留言）。带 path 返回该项目条目（新在前）；不带返回全部',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    run: (snap, args) => getHandoffs(snap, args),
  },
  {
    name: 'handoff_write',
    description: '为指定项目写一条交接（agent 留给下一个执行者的接力留言）。写入后请求应用刷新，未读点即时可见。仅此写面与 handoff_complete——备忘与警示消音不可经 MCP 改动',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目绝对路径' },
        text: { type: 'string', description: '交接正文（做了什么、下一步注意什么）' },
        agent: { type: 'string', description: 'agent 署名（缺省为 agent）' },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
    run: (snap, args) => handoffWrite(snap, args),
  },
  {
    name: 'handoff_complete',
    description: '标记某条交接已被接力完成（幂等，doneAt 不刷新）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目绝对路径' },
        id: { type: 'string', description: '交接条目 id（get_handoffs 返回的 id）' },
      },
      required: ['path', 'id'],
      additionalProperties: false,
    },
    run: (snap, args) => handoffComplete(snap, args),
  },
  {
    name: 'rescan',
    description: '请求 SignalBoard 立即触发一次全量重扫（应用内执行，本工具只发请求不等待）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (snap) => rescan(snap),
  },
  {
    name: 'quickopen',
    description: '请求 SignalBoard 打开某项目的文件夹/编辑器/终端（人在环）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目绝对路径' },
        kind: { type: 'string', enum: ['folder', 'editor', 'terminal'], description: '缺省 folder' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: (snap, args) => quickOpenTool(snap, args),
  },
  {
    name: 'open_cli',
    description: '请求在项目目录的可见终端里启动指定 AI CLI（可带 prompt 预填，按注册行 prefill 方式）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目绝对路径' },
        cmd: { type: 'string', description: 'AI CLI 命令（如 claude）' },
        prompt: { type: 'string', description: '初始 prompt（支持度按注册行 prefill，不支持的走剪贴板）' },
      },
      required: ['path', 'cmd'],
      additionalProperties: false,
    },
    run: (snap, args) => openCli(snap, args),
  },
];

module.exports = { TOOL_DEFS, callTool };

// 工具调用分发：tools/call 的统一入口。抛错转结构化失败（isError: true），不炸进程
function callTool(snap, name, args) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    const err = new Error('未知工具：' + name);
    err.mcpCode = 'UNKNOWN_TOOL';
    throw err;
  }
  return def.run(snap, args || {});
}
