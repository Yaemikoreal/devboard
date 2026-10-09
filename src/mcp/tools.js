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

// 工具登记面（白名单即边界，issue #149：写面工具在此清单之外的字段中登记，本清单只读）
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
