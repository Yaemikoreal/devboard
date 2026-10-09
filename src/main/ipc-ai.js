// AI 调度域 IPC（issue #124 第二刀）：aitools:list / aitools:open / ai:caps / ai:ask /
// ai:promptPreview 五个 handler + 模块级 AI 帮手（工具探测/引擎排序/模板哈希/事实签名），
// 从 ipc.js 分出。deps: { store, checkCommand, pathExists, spawnResult }——checkCommand/
// pathExists/spawnResult 是跨域共用的系统助手（quickopen/branch/scan:preview 等主干域也在用），
// 留主干、经 deps 注入；引擎链已独立在 ai-chain.js，本模块 deps 除此之外仅需 store。
// 会话级引擎黑名单的清空口经返回值暴露（settings:set 变更 AI 配置时调用，issue #138）。
// 通道名与 payload 全程不变。挂载由主干 registerIpc 在 handle 包错 patch 之后统一调用。
'use strict';

const crypto = require('crypto');
const { ipcMain } = require('electron');
const ai = require('./ai');
const { runEngineChain } = require('./ai-chain'); // 引擎链回退/拉黑/错误归类（issue-24）
const { localDateStr } = require('../shared/constants'); // 共享常量（issue-11 / #127）
const { iconFor, defaultToolList } = require('../shared/ai-tools'); // AI 工具单一注册表（issue #123）

// 默认 AI 工具清单与品牌图标已收敛进 AI 工具注册表（issue #123）：
// defaultToolList() 出清单、iconFor(logoKey, id) 出图标，本文件不持有按工具 id 键控的平行常量表

// 合并默认与自定义工具并逐项 where 探测；随发品牌图标（issue #21）。aitools:list 与 ai 引擎解析共用。
// 结果缓存 60s：启动负载期（扫描 + 探测并发）进程创建很慢，重复 spawn 会互相拖超时（issue #29 实测）；
// 缓存键含自定义清单，设置变更后立即重探。
// 在飞去重（issue #130）：缓存进行中的 Promise 而非仅落地后的结果——启动时 loadAiTools/loadAiCaps
// 并发打到主进程、结果缓存均空时复用同一轮探测（where 进程数 = 工具数 ×1 而非 ×2）；
// 失败时清掉在飞缓存，下次调用立即重试
let aiToolsDetectCache = { at: 0, key: '', list: null, promise: null };
function detectAiTools(cfg, checkCommand) {
  const key = JSON.stringify(cfg.aiTools || []);
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

// 引擎候选排序：显式指定 > 最近成功 > 清单默认顺序（稳定排序）；供 ai:ask 链式回退（issue #41）
async function resolveEngines(cfg, lastGoodId, checkCommand) {
  const avail = (await detectAiTools(cfg, checkCommand)).filter((t) => t.installed);
  const pref = [cfg.aiEngine, lastGoodId].filter(Boolean);
  const rank = (t) => {
    const i = pref.indexOf(t.id);
    return i < 0 ? pref.length : i;
  };
  return avail.slice().sort((a, b) => rank(a) - rank(b));
}

// 缓存结果的引擎徽标信息：引擎可能已卸载，从完整探测清单（含未安装项）取 label，找不到就裸显 id
async function findToolInfo(cfg, engineId, checkCommand) {
  const t = (await detectAiTools(cfg, checkCommand)).find((x) => x.id === engineId);
  return { id: engineId || 'unknown', label: t ? t.label : String(engineId || 'AI'), cmd: t ? t.cmd : '' };
}

// 提示词模板内容哈希（issue #78）：AI 周报/建议的缓存键纳入模板哈希，
// 模板被自定义或恢复默认后旧缓存自动失效，不会被旧结果掩盖修改；
// 键基于实际生效的模板（默认模板亦如此：未来内置模板优化时旧缓存自然重建）
function promptTplKey(template) {
  return crypto.createHash('sha1').update(String(template)).digest('hex').slice(0, 10);
}

// filter 短超时（issue #132）：自然语言筛选是交互式场景，只打首选引擎 + 20s 上限，
// 失败即回让渲染层安静回退关键字搜索；weekly/advice 维持 runCli 默认 90s 不变
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

  // 在所选项目目录开终端执行 AI 工具命令：优先 wt -d，回退 cmd /c start（issue #15）
  ipcMain.handle('aitools:open', async (_e, cmd, projectPath) => {
    const c = String(cmd || '').trim();
    const p = String(projectPath || '');
    if (!c || !p || !(await pathExists(p))) return false; // 异步探盘（issue #168 第 5 条）
    const ok = await spawnResult('wt', ['-d', p, 'cmd', '/k', c]);
    if (ok) return true;
    return spawnResult('cmd', ['/c', 'start', 'cmd', '/k', c], { cwd: p });
  });

  // AI 能力探测（issue #29）：渲染层据此显隐 AI 入口；engine 为空 = 无可用工具
  ipcMain.handle('ai:caps', async () => {
    const cfg = store.getConfig();
    const enabled = cfg.aiEnabled !== false;
    // 首选引擎 = 候选链首项（issue #128：原 resolveEngine 仅转发 resolveEngines 取 [0]，已内联删除）
    const engine = enabled ? (await resolveEngines(cfg, store.getAiCache().lastGoodEngine, checkCommand))[0] || null : null;
    return {
      enabled,
      engine: engine ? { id: engine.id, label: engine.label, cmd: engine.cmd } : null,
    };
  });

  // 在飞 AI 任务：同 kind+目标 的请求共享同一 Promise，切页后重复触发不会再起 CLI 进程（issue #40）
  const aiInFlight = new Map();
  // 会话级引擎黑名单：本进程内已失败过的引擎不再重复尝试（配额/挂起类故障在会话内不会自愈，issue #41）；
  // settings:set 变更 AI 配置（aiEngine/aiTools/aiEnabled）时清空（issue #138），修好引擎后无需重启即可恢复首选
  const sessionBadEngines = new Set();

  // 记最近可用引擎（issue #41）：filter 无结果缓存，成功时经引擎链 onLastGood 回调单独落 lastGoodEngine（issue #137）；
  // weekly/advice 在缓存写回时一并落，不走这里
  function writeLastGoodEngine(engineId) {
    const cur = store.getAiCache();
    cur.lastGoodEngine = engineId;
    store.setAiCache(cur);
  }

  // AI kind 处理器表（issue #128）：doAiAsk 与 ai:promptPreview 的按 kind 分派共用此表，
  // 取代两处平行的 if 级联。字段约定：
  //   customTplOf(cfg)                  —— 已落盘的自定义模板（null = 内置默认，issue #78）
  //   tplOf(cfg)                        —— 实际生效模板（含内置默认回落），其哈希进缓存键（issue #78）
  //   previewable                       —— 是否开放 ai:promptPreview（filter 是 parseFilter 严格 JSON 契约，不开放）
  //   keyOf({ payload, now })           —— 缓存键上下文；filter 不缓存（issue #29）无此层
  //   readHit({ cache, key, tplKey })   —— 命中返回缓存条目，否则 null
  //   writeEntry(ctx, text, engineId)   —— 写 kind 专属缓存条目（lastGoodEngine 由调用方统一落）
  //   buildPrompt(ctx)                  —— { ok, prompt } | { ok:false, reason }；
  //                                        template/emptyReason/project 由调用方按场景给（预览可传草稿模板）
  const aiKindHandlers = {
    weekly: {
      customTplOf: (cfg) => cfg.aiPromptWeekly,
      tplOf: (cfg) => cfg.aiPromptWeekly || ai.DEFAULT_WEEKLY_TEMPLATE,
      previewable: true,
      // 周报按当天日期缓存（issue #29）；两处空数据文案不同：emptyReason 由调用方传
      keyOf: ({ now }) => ({ date: localDateStr(now) }),
      readHit: ({ cache, key, tplKey }) => {
        const hit = cache.weekly;
        return hit && hit.date === key.date && hit.text && hit.tpl === tplKey ? hit : null;
      },
      writeEntry: ({ cache, key, tplKey, now }, text, engineId) => {
        cache.weekly = { date: key.date, engine: engineId, text, at: now.toISOString(), tpl: tplKey };
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
      readHit: ({ cache, key, tplKey }) => {
        const hit = cache.advice[key.project.path];
        return hit && hit.head === key.head && hit.facts === key.facts && hit.text && hit.tpl === tplKey ? hit : null;
      },
      writeEntry: ({ cache, key, tplKey, now }, text, engineId) => {
        cache.advice[key.project.path] = { head: key.head, facts: key.facts, engine: engineId, text, at: now.toISOString(), tpl: tplKey };
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

  // AI 统一调用入口（issue #29）：prompt 组装 / 超时 / 失败降级 / 结果缓存；kind 分派走处理器表（issue #128）
  // kind: weekly（按当天缓存）| advice（按 项目+HEAD+事实摘要签名+模板哈希 缓存，issue #131）| filter（不缓存）
  // 缓存命中分支在引擎探测之前（issue #139）：纯缓存命中不再等一轮 where 探测
  // 引擎链式回退（issue #41，链实现已抽 ai-chain.js 便于单测，issue-24）：首选失败后自动尝试其余已安装引擎，
  // 成功则记为最近可用；filter 例外（issue #132）：只打链首首选引擎 + 20s 短超时，失败即回，渲染层安静回退关键字搜索
  async function doAiAsk(payload) {
    const cfg = store.getConfig();
    if (cfg.aiEnabled === false) return { ok: false, reason: 'AI 功能已在设置中关闭' };
    const kind = payload && payload.kind;
    const handler = aiKindHandlers[kind];
    if (!handler) return { ok: false, reason: '未知的 AI 请求类型' };
    const now = new Date();
    const cache = store.getAiCache();
    const tplKey = handler.readHit ? promptTplKey(handler.tplOf(cfg)) : ''; // 模板哈希入缓存键（issue #78）
    const keyCtx = handler.keyOf ? handler.keyOf({ payload, now }) : null;

    if (handler.readHit && keyCtx) {
      const hit = handler.readHit({ cache, key: keyCtx, tplKey });
      if (hit) {
        const eng = await findToolInfo(cfg, hit.engine, checkCommand);
        return { ok: true, kind, text: hit.text, engine: eng, cached: true, at: hit.at || null };
      }
    }
    if (payload.cachedOnly) return { ok: false, kind, reason: 'no-cache' };

    const engines = await resolveEngines(cfg, cache.lastGoodEngine, checkCommand);
    if (!engines.length) return { ok: false, reason: '未检测到可用的 AI 命令行工具' };

    const built = handler.buildPrompt({
      payload,
      now,
      template: handler.customTplOf ? handler.customTplOf(cfg) : undefined,
      project: keyCtx ? keyCtx.project : undefined,
      emptyReason: kind === 'weekly' ? '近 7 天没有提交活动，暂无可摘要的内容' : '项目不在扫描缓存中',
    });
    if (!built.ok) return { ok: false, reason: built.reason };

    // 引擎链（issue-24 抽 ai-chain.js）：健康过滤（全灭照旧全试）、失败拉黑、中文类别聚合都在链内；
    // filter 例外（issue #132）由 firstOnly + run 闭包的 20s 短超时实现
    const chain = await runEngineChain({
      engines,
      badEngines: sessionBadEngines,
      run: (engine) => ai.runCli(engine.cmd, built.prompt, {
        toolId: engine.id,
        timeout: kind === 'filter' ? FILTER_TIMEOUT_MS : undefined, // filter 短超时（issue #132）
      }),
      onFail: (engine, reason) => {
        console.error('[devboard] AI 引擎调用失败（' + engine.id + '）：' + reason); // 原始错误行进 console（issue #138）
      },
      validate: kind === 'filter' ? ai.parseFilter : null, // filter 产出需可解析（issue #137）
      // filter 成功即记最近可用（issue #137）；weekly/advice 在缓存写回时一并落（issue #41），不走链回调
      onLastGood: kind === 'filter' ? writeLastGoodEngine : null,
      firstOnly: kind === 'filter',
    });
    if (!chain.ok) {
      return { ok: false, kind, reason: chain.fails.join('；') || '所有可用 AI 引擎均调用失败' };
    }
    if (kind === 'filter') {
      return { ok: true, kind, filter: chain.extra, engine: chain.engine };
    }
    if (handler.writeEntry && keyCtx) {
      const cur = store.getAiCache();
      handler.writeEntry({ cache: cur, key: keyCtx, tplKey, now }, chain.text, chain.engine.id);
      cur.lastGoodEngine = chain.engine.id; // 成功引擎记为最近可用（issue #41）
      store.setAiCache(cur);
    }
    return { ok: true, kind, text: chain.text, engine: chain.engine, cached: false, at: now.toISOString() };
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
  // 只组装不调用引擎。渲染层可传当前草稿模板（template 字段），未传则用已落盘配置；
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

  // settings:set（主干）变更 AI 配置时清空会话级黑名单（issue #138），经返回值暴露清空口
  return { clearSessionBadEngines: () => sessionBadEngines.clear() };
};
