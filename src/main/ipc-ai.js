// AI 调度域 IPC（issue #124 第二刀 / #180 后续）：aitools:list / aitools:open / ai:caps / ai:ask /
// ai:promptPreview / ai:provider:test 六个 handler + 模块级 AI 帮手（工具探测/模板哈希/事实签名），
// 从 ipc.js 分出。deps: { store, checkCommand, pathExists, spawnResult }——checkCommand/
// pathExists/spawnResult 是跨域共用的系统助手（quickopen/branch/scan:preview 等主干域也在用），
// 留主干、经 deps 注入。AI 生成只走应用直连供应商（src/main/ai-provider.js）；本机 CLI 仅保留
// aitools:list / aitools:open 的工作台与意图路由启动能力，不再参与 AI 生成。
// 通道名与 payload 全程不变。挂载由主干 registerIpc 在 handle 包错 patch 之后统一调用。
'use strict';

const crypto = require('crypto');
const { ipcMain, clipboard, net } = require('electron');
const ai = require('./ai');
const { createProvider } = require('./ai-provider'); // 应用直连模型 API（#180 后续）
const { providerReady, providerSignature, providerLabel } = require('../shared/ai-providers');
const { localDateStr } = require('../shared/constants'); // 共享常量（issue-11 / #127）
const { iconFor, defaultToolList, specFor, toolById } = require('../shared/ai-tools'); // AI 工具单一注册表（issue #123）

// 供应商直连网络出口：Electron net.fetch 走 Chromium 网络栈并读取系统证书库（与 github 模块同一出口，
// issue #153）；测试经 fake electron.net 注入假 fetch（scripts/test-ai.js），本文件不直接触网。
const providerClient = createProvider({ fetchImpl: (url, init) => net.fetch(url, init) });

// 预填方式（issue #142）：注册行 prefill.mode——'arg'=交互式位置参数；'none'/缺席（含自定义命令）=
// 剪贴板兜底。按 CLI 逐个实测后定值；可启动档工具不在此列（不进引擎候选，执行键不用它们）
function prefillModeOf(cmd) {
  const t = toolById(cmd);
  return (t && t.prefill && t.prefill.mode) || 'none';
}

// 意图路由出口的核心实现（issue #142；issue #149 的 open-cli 动作复用同一管线）：
// prompt 按 prefillModeOf 分流——arg = 独立 argv 元素（quoteShellArg 逐参转义，中文/引号安全）；
// none/未知命令（含自定义工具）= 先写剪贴板兜底。pathExists/spawnResult 由调用方注入
async function openCliInTerminal(cmd, projectPath, prompt, helpers) {
  const h = helpers || {};
  const exists = h.pathExists || ((p) => Promise.resolve(true));
  const spawn = h.spawnResult || (() => Promise.resolve(false));
  const c = String(cmd || '').trim();
  const p = String(projectPath || '');
  if (!c || !p || !(await exists(p))) return false; // 异步探盘（issue #168 第 5 条）
  const promptText = String(prompt || '').trim();
  if (promptText && prefillModeOf(c) === 'arg') {
    const okArg = await spawn('wt', ['-d', p, 'cmd', '/k', c, promptText]);
    if (okArg) return true;
    return spawn('cmd', ['/c', 'start', 'cmd', '/k', c, promptText], { cwd: p });
  }
  if (promptText) clipboard.writeText(promptText); // 预填不支持的 CLI：剪贴板兜底
  const ok = await spawn('wt', ['-d', p, 'cmd', '/k', c]);
  if (ok) return true;
  return spawn('cmd', ['/c', 'start', 'cmd', '/k', c], { cwd: p });
}

// 默认 AI 工具清单与品牌图标已收敛进 AI 工具注册表（issue #123）：
// defaultToolList() 出清单、iconFor(logoKey, id) 出图标，本文件不持有按工具 id 键控的平行常量表

// 合并默认与自定义工具并逐项 where 探测；随发品牌图标（issue #21）。aitools:list 与 ai:caps 的
// cliTool 解析共用。结果缓存 60s：启动负载期（扫描 + 探测并发）进程创建很慢，重复 spawn 会互相拖超时
// （issue #29 实测）；缓存键含自定义清单，设置变更后立即重探。
// 在飞去重（issue #130）：缓存进行中的 Promise 而非仅落地后的结果——启动时 loadAiTools/loadAiCaps
// 并发打到主进程、结果缓存均空时复用同一轮探测（where 进程数 = 工具数 ×1 而非 ×2）；
// 失败时清掉在飞缓存，下次调用立即重试
let aiToolsDetectCache = { at: 0, key: '', list: null, promise: null };
function detectAiTools(cfg, checkCommand) {
  // 缓存键含注册表默认清单（issue #141）：注册表扩容后旧缓存不得冒充新探测结果；
  // 自定义清单变化同样触发重探
  const key = JSON.stringify([defaultToolList().map((t) => t.cmd), cfg.aiTools || []]);
  const c = aiToolsDetectCache;
  if (c.key === key) {
    if (c.list && Date.now() - c.at < 60000) return Promise.resolve(c.list);
    if (c.promise) return c.promise;
  }
  const promise = probeAiTools(cfg, checkCommand).then((list) => {
    // 旧 key 的在飞 Promise 落地时不覆盖新条目（设置变更可能已触发重探）
    if (aiToolsDetectCache.promise === promise) aiToolsDetectCache = { at: Date.now(), key, list, promise: null };
    return list;
  }, (err) => {
    if (aiToolsDetectCache.promise === promise) aiToolsDetectCache = { at: 0, key, list: null, promise: null };
    throw err;
  });
  aiToolsDetectCache = { at: 0, key, list: null, promise };
  return promise;
}

async function probeAiTools(cfg, checkCommand) {
  const custom = (cfg.aiTools || [])
    .map((t, i) => ({
      id: 'custom-' + i,
      label: String(t.label || t.cmd || ''),
      cmd: String(t.cmd || '').trim(),
      logoKey: typeof t.logo === 'string' ? t.logo : '',
    }))
    .filter((t) => t.cmd);
  const tools = defaultToolList().concat(custom);
  return Promise.all(
    tools.map(async (t) => {
      const icon = iconFor(t.logoKey, t.id);
      return {
        id: t.id,
        label: t.label,
        cmd: t.cmd,
        installed: (await checkCommand(t.cmd)).ok,
        logo: icon,
      };
    })
  );
}

// 直连供应商的引擎信息（缓存命中时也要能还原标签）：id 固定 'provider'，
// 标签随当前预设/模型派生；cmd 为空——「执行」类动作（起本机 CLI）不适用于直连。
function providerEngineInfo(cfg) {
  return {
    id: 'provider',
    label: providerLabel(cfg.aiProviderPreset, cfg.aiProviderModel),
    cmd: '',
    provider: true,
  };
}

// 提示词模板内容哈希（issue #78）：AI 周报/建议的缓存键纳入模板哈希，
// 模板被自定义或恢复默认后旧缓存自动失效，不会被旧结果掩盖修改；
// 键基于实际生效的模板（默认模板亦如此：未来内置模板优化时旧缓存自然重建）
function promptTplKey(template) {
  return crypto.createHash('sha1').update(String(template)).digest('hex').slice(0, 10);
}

// filter 短超时（issue #132）：自然语言筛选是交互式场景，20s 上限，失败即回让渲染层安静回退关键字搜索；
// weekly/advice 用配置的 aiTimeoutMs（默认 60s）
const FILTER_TIMEOUT_MS = 20000;

// advice 事实摘要签名（issue #131）：ahead/behind/dirtyCount/警示标签哈希进缓存键——
// git push 后 HEAD 不变但 ahead 变化即 miss，不再展出过期语境的建议
function adviceFactsKey(p) {
  const warnSig = (p.warnings || []).map((w) => w.label).join('|');
  const sig = [p.ahead || 0, p.behind || 0, p.dirtyCount || 0, warnSig].join('/');
  return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 10);
}

module.exports = function registerAi({ store, checkCommand, pathExists, spawnResult }) {
  // AI 工具清单：默认四项 + config.aiTools 自定义项，逐项 where 探测安装情况（issue #15）
  ipcMain.handle('aitools:list', () => detectAiTools(store.getConfig(), checkCommand));

  // 意图路由出口（issue #142）：第三参 prompt 缺省时行为与原来完全一致（工作台等既有调用零改动）；
  // 实现抽到模块级 openCliInTerminal（#149 的 open-cli 动作复用同一管线）
  ipcMain.handle('aitools:open', (_e, cmd, projectPath, prompt) =>
    openCliInTerminal(cmd, projectPath, prompt, { pathExists, spawnResult }));

  // AI 能力探测（#180 后续）：AI 生成只走供应商直连，configured 决定入口显隐与设置页提示。
  // cliTool 只给「执行 / 意图路由」起本机 CLI 用：注册表顺序第一个「已安装且有调用规格」的工具；
  // 它不参与 AI 生成，也不代表 AI 功能可用。
  ipcMain.handle('ai:caps', async () => {
    const cfg = store.getConfig();
    const ready = providerReady(cfg);
    const provider = ready
      ? {
        preset: cfg.aiProviderPreset,
        label: providerLabel(cfg.aiProviderPreset, cfg.aiProviderModel),
        model: cfg.aiProviderModel,
        protocol: cfg.aiProviderProtocol,
      }
      : null;
    const tool = (await detectAiTools(cfg, checkCommand)).find((t) => t.installed && !!specFor(t.id));
    return {
      enabled: !!cfg.aiEnabled,
      configured: ready,
      provider,
      cliTool: tool ? { id: tool.id, label: tool.label, cmd: tool.cmd } : null,
    };
  });

  // 供应商连通性测试（#180 后续）：设置页「测试连接」。payload 允许传未保存的草稿值；
  // apiKey 留空则用已保存的 Key（避免设置页为测试而回显明文）。不写缓存、不落盘。
  ipcMain.handle('ai:provider:test', async (_e, payload) => {
    const cfg = store.getConfig();
    const p = payload || {};
    const protocol = ['openai', 'anthropic'].indexOf(p.protocol) >= 0 ? p.protocol : cfg.aiProviderProtocol;
    const pick = (v, fallback) => (v === undefined || v === null ? fallback : v);
    const baseUrl = String(pick(p.baseUrl, cfg.aiProviderBaseUrl) || '').trim();
    const model = String(pick(p.model, cfg.aiProviderModel) || '').trim();
    const apiKey = String((p.apiKey && String(p.apiKey).trim()) || cfg.aiApiKey || '').trim();
    const t0 = Date.now();
    const r = await providerClient.test({
      protocol,
      baseUrl,
      model,
      apiKey,
      temperature: cfg.aiTemperature,
      maxTokens: 16,
      timeoutMs: Math.min(cfg.aiTimeoutMs, 30000),
    });
    return { ok: !!r.ok, ms: Date.now() - t0, reason: r.reason || '' };
  });

  // 在飞 AI 任务：同 kind+目标 的请求共享同一 Promise，切页后重复触发不会重复请求（issue #40）
  const aiInFlight = new Map();

  // AI kind 处理器表（issue #128）：doAiAsk 与 ai:promptPreview 的按 kind 分派共用此表，
  // 取代两处平行的 if 级联。字段约定：
  //   customTplOf(cfg)                  —— 已落盘的自定义模板（null = 内置默认，issue #78）
  //   tplOf(cfg)                        —— 实际生效模板（含内置默认回落），其哈希进缓存键（issue #78）
  //   previewable                       —— 是否开放 ai:promptPreview（filter 是 parseFilter 严格 JSON 契约，不开放）
  //   keyOf({ payload, now })           —— 缓存键上下文；filter 不缓存（issue #29）无此层
  //   readHit({ cache, key, tplKey, via }) —— 命中返回缓存条目，否则 null
  //   writeEntry(ctx, text, engineId)   —— 写 kind 专属缓存条目
  //   buildPrompt(ctx)                  —— { ok, prompt } | { ok:false, reason }；
  //                                        template/emptyReason/project 由调用方按场景给（预览可传草稿模板）
  const aiKindHandlers = {
    weekly: {
      customTplOf: (cfg) => cfg.aiPromptWeekly,
      tplOf: (cfg) => cfg.aiPromptWeekly || ai.DEFAULT_WEEKLY_TEMPLATE,
      previewable: true,
      // 周报按当天日期缓存（issue #29）；两处空数据文案不同：emptyReason 由调用方传
      keyOf: ({ now }) => ({ date: localDateStr(now) }),
      // via 入命中判定（#180 后续）：换供应商/模型/协议后旧缓存不得冒充新结果
      readHit: ({ cache, key, tplKey, via }) => {
        const hit = cache.weekly;
        return hit && hit.date === key.date && hit.text && hit.tpl === tplKey && hit.via === via ? hit : null;
      },
      writeEntry: ({ cache, key, tplKey, now, via }, text, engineId) => {
        cache.weekly = { date: key.date, engine: engineId, text, at: now.toISOString(), tpl: tplKey, via };
      },
      buildPrompt: ({ now, template, emptyReason }) => {
        const projects = Object.values(store.getScanCache().projects);
        if (!projects.some((p) => p.commits7d > 0)) return { ok: false, reason: emptyReason };
        return { ok: true, prompt: ai.buildWeeklyPrompt(projects, now, template) };
      },
    },
    advice: {
      customTplOf: (cfg) => cfg.aiPromptAdvice,
      tplOf: (cfg) => cfg.aiPromptAdvice || ai.DEFAULT_ADVICE_TEMPLATE,
      previewable: true,
      // 建议按 项目+HEAD+事实摘要签名 缓存（issue #131：git push 后 ahead 变化即 miss，不展出过期语境的建议）；
      // 项目不在扫描缓存时 keyOf 返回 null，由 buildPrompt 统一报「项目不在扫描缓存中」
      keyOf: ({ payload }) => {
        const p = store.getScanCache().projects[String((payload && payload.path) || '')];
        if (!p) return null;
        return { project: p, head: p.headSha || 'nohead', facts: adviceFactsKey(p) };
      },
      readHit: ({ cache, key, tplKey, via }) => {
        const hit = cache.advice[key.project.path];
        return hit && hit.head === key.head && hit.facts === key.facts && hit.text && hit.tpl === tplKey && hit.via === via ? hit : null;
      },
      writeEntry: ({ cache, key, tplKey, now, via }, text, engineId) => {
        cache.advice[key.project.path] = { head: key.head, facts: key.facts, engine: engineId, text, at: now.toISOString(), tpl: tplKey, via };
      },
      buildPrompt: ({ project, now, template, emptyReason }) => {
        if (!project) return { ok: false, reason: emptyReason };
        return { ok: true, prompt: ai.buildAdvicePrompt(project, now, template) };
      },
      // 预览无指定项目：取近 7 天最活跃的项目作示例；扫描缓存为空时返回 null
      previewSubject: () => {
        const projects = Object.values(store.getScanCache().projects);
        if (!projects.length) return null;
        return projects.slice().sort((a, b) => (b.commits7d || 0) - (a.commits7d || 0))[0];
      },
    },
    filter: {
      previewable: false,
      tplOf: () => '',
      buildPrompt: ({ payload }) => {
        const query = String((payload && payload.query) || '').trim().slice(0, 100);
        if (!query) return { ok: false, reason: '查询为空' };
        return { ok: true, prompt: ai.buildFilterPrompt(query) };
      },
    },
  };

  // AI 统一调用入口（issue #29）：prompt 组装 / 供应商直连 / 结果缓存；kind 分派走处理器表（issue #128）
  // kind: weekly（按当天缓存）| advice（按 项目+HEAD+事实摘要签名+模板哈希 缓存，issue #131）| filter（不缓存）
  // 缓存命中分支在供应商判定之后：未配置供应商时直接返回配置提示，不读旧缓存（避免掩盖配置变更）
  async function doAiAsk(payload) {
    const cfg = store.getConfig();
    if (cfg.aiEnabled === false) return { ok: false, reason: 'AI 功能已在设置中关闭' };
    const kind = payload && payload.kind;
    const handler = aiKindHandlers[kind];
    if (!handler) return { ok: false, reason: '未知的 AI 请求类型' };
    // 供应商直连是唯一 AI 生成后端（#180 后续）：未配全时给出可操作的设置入口提示
    if (!providerReady(cfg)) {
      return { ok: false, reason: '未配置 AI 供应商（设置 → AI 工具 → AI 后端与供应商）' };
    }
    const now = new Date();
    const cache = store.getAiCache();
    const tplKey = handler.readHit ? promptTplKey(handler.tplOf(cfg)) : ''; // 模板哈希入缓存键（issue #78）
    const keyCtx = handler.keyOf ? handler.keyOf({ payload, now }) : null;
    const providerCfg = {
      protocol: cfg.aiProviderProtocol,
      baseUrl: cfg.aiProviderBaseUrl,
      model: cfg.aiProviderModel,
      apiKey: cfg.aiApiKey,
      temperature: cfg.aiTemperature,
      maxTokens: cfg.aiMaxTokens,
      timeoutMs: kind === 'filter' ? Math.min(FILTER_TIMEOUT_MS, cfg.aiTimeoutMs) : cfg.aiTimeoutMs,
    };
    // 缓存键里的后端身份：供应商签名（协议|Base URL|模型），换供应商/模型后旧结果自动失配
    const via = providerSignature(cfg);

    if (handler.readHit && keyCtx) {
      const hit = handler.readHit({ cache, key: keyCtx, tplKey, via });
      if (hit) {
        return { ok: true, kind, text: hit.text, engine: providerEngineInfo(cfg), cached: true, via, at: hit.at || null };
      }
    }
    if (payload.cachedOnly) return { ok: false, kind, reason: 'no-cache' };

    const built = handler.buildPrompt({
      payload,
      now,
      template: handler.customTplOf ? handler.customTplOf(cfg) : undefined,
      project: keyCtx ? keyCtx.project : undefined,
      emptyReason: kind === 'weekly' ? '近 7 天没有提交活动，暂无可摘要的内容' : '项目不在扫描缓存中',
    });
    if (!built.ok) return { ok: false, reason: built.reason };

    const r = await providerClient.ask(providerCfg, built.prompt);
    if (!r.ok) {
      console.error('[devboard] AI 供应商调用失败：' + r.reason);
      return { ok: false, kind, reason: r.reason };
    }
    // filter 产出必须能解析成筛选 JSON，否则视同该次调用失败（渲染层回退关键字搜索）
    let parsedFilter = null;
    if (kind === 'filter') {
      parsedFilter = ai.parseFilter(r.text);
      if (!parsedFilter) {
        console.error('[devboard] AI 供应商产出无法解析为筛选条件');
        return { ok: false, kind, reason: '输出无法解析' };
      }
    }
    const providerEngine = providerEngineInfo(cfg);
    if (kind === 'filter') {
      return { ok: true, kind, filter: parsedFilter, engine: providerEngine, via };
    }
    if (handler.writeEntry && keyCtx) {
      const cur = store.getAiCache();
      handler.writeEntry({ cache: cur, key: keyCtx, tplKey, now, via }, r.text, 'provider');
      store.setAiCache(cur);
    }
    return { ok: true, kind, text: r.text, engine: providerEngine, cached: false, via, at: now.toISOString() };
  }

  ipcMain.handle('ai:ask', (_e, payload) => {
    const kind = String((payload && payload.kind) || '');
    const key = kind + '|' + String((payload && (payload.path || payload.query)) || '');
    if (payload && payload.cachedOnly) {
      // 只读缓存不进在飞表；若同任务在飞则回 pending，渲染层据此转为正式请求并入该任务（issue #40）
      return doAiAsk(payload).then((r) => {
        if (!r.ok && r.reason === 'no-cache' && aiInFlight.has(key)) return { ok: false, kind, reason: 'pending' };
        return r;
      });
    }
    if (aiInFlight.has(key)) return aiInFlight.get(key);
    const job = doAiAsk(payload).finally(() => aiInFlight.delete(key));
    aiInFlight.set(key, job);
    return job;
  });

  // 提示词模板预览（issue #78）：用真实数据组装完整 prompt 展示给设置页，眼见为实地编辑；
  // 只组装不调用模型。渲染层可传当前草稿模板（template 字段），未传则用已落盘配置；
  // 自然语言筛选 prompt 不开放（parseFilter 严格 JSON 契约，处理器表 previewable=false）
  // kind 分派与 doAiAsk 共用处理器表（issue #128）；预览专属差异：草稿模板优先 + 预览措辞的空数据文案
  ipcMain.handle('ai:promptPreview', (_e, payload) => {
    const kind = String((payload && payload.kind) || '');
    const handler = aiKindHandlers[kind];
    if (!handler || !handler.previewable) return { ok: false, reason: '未知的预览类型' };
    const cfg = store.getConfig();
    const now = new Date();
    // 草稿优先：payload 显式带 template 字段时（含 null = 恢复默认）用草稿，否则用已存配置
    const hasDraft = payload && Object.prototype.hasOwnProperty.call(payload, 'template');
    const draft = hasDraft
      ? ((typeof payload.template === 'string' && payload.template.trim()) ? payload.template.slice(0, 10000) : null)
      : undefined;
    const template = draft === undefined ? handler.customTplOf(cfg) : draft;
    // advice 无指定项目时取近 7 天最活跃的项目作示例（previewSubject 返回 null = 扫描缓存为空）
    const subject = handler.previewSubject ? handler.previewSubject() : undefined;
    const built = handler.buildPrompt({
      payload,
      now,
      template,
      project: subject,
      emptyReason: subject === null
        ? '扫描缓存为空，请先完成一次扫描'
        : '近 7 天没有提交活动，暂无事实可组装（先完成一次扫描）',
    });
    if (!built.ok) return { ok: false, reason: built.reason };
    const out = { ok: true, prompt: built.prompt };
    if (subject) out.sample = subject.name;
    return out;
  });

  // 无会话级引擎状态需要清理（CLI 引擎链已移除）；保留空返回口，调用方零改动
  return {};
};

// 命名导出（issue #149）：open-cli 动作与主干注册器复用的管线与探测
module.exports.openCliInTerminal = openCliInTerminal;
module.exports.prefillModeOf = prefillModeOf;
module.exports.detectAiTools = detectAiTools;
