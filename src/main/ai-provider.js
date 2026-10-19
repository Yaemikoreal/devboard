// AI 供应商直连内核（issue #180 延续）：把「应用自身请求模型 API」收敛为 ask / test 两个方法。
// 纯 Node、零第三方依赖：fetch 由调用方注入（主进程传 Electron net.fetch，单测传假 fetch），
// 本模块只负责组装请求、超时控制与中文错误归类；不读配置、不落盘、不碰 Electron（接线在 ipc 层）。
'use strict';

const DEFAULT_TIMEOUT_MS = 60000; // 模型 API 生成周报可能较慢，默认放宽到 60s
const ANTHROPIC_VERSION = '2023-06-01'; // Anthropic 原生 Messages API 固定版本头
const CONFIG_INCOMPLETE = '供应商未配置完整（Base URL / 模型 / API Key）';
const UNPARSEABLE = '输出无法解析';

// Base URL 归一化：去首尾空白与尾部斜杠，避免拼出 //chat/completions
function cleanBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// endpoint 归一化：用户既可填根地址，也可直接填完整 endpoint，两种都不得重复拼接（契约）。
function endpointOf(protocol, baseUrl) {
  const base = cleanBase(baseUrl);
  if (protocol === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return base + '/messages';
    return base + '/v1/messages';
  }
  // 非 anthropic 一律按 OpenAI 兼容协议处理（自定义/未知协议给最通行的默认值）
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

// HTTP 状态 → 中文类别。401/403 归鉴权、404 归地址/模型、429 归配额限流、5xx 归服务端异常；
// 其余 4xx 契约未列，保守给带状态码的通用文案，方便用户对照服务商文档排查。
function httpFailReason(status) {
  const code = Number(status) || 0;
  if (code === 401 || code === 403) return '鉴权失败（API Key 无效或无权限）';
  if (code === 404) return '接口地址或模型不存在（HTTP 404）';
  if (code === 429) return '配额不足或触发限流（HTTP 429）';
  if (code >= 500 && code <= 599) return '供应商服务异常（HTTP ' + code + '）';
  return '请求失败（HTTP ' + (code || '未知') + '）';
}

// 网络层异常 → 中文类别；优先取底层 cause.code（Electron net.fetch / undici 常把真实 code 藏在 cause 里）
function netFailReason(err) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.name) || '未知错误';
  return '网络连接失败（' + code + '）';
}

// 只接受正数（超时/最大 token）；缺失或非法返回 null，由调用方回落默认值
function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// temperature 允许 0，故不能复用 positiveNumber；空串/非数字视为未配置
function optionalNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// OpenAI 兼容响应解析：标准 content 为字符串；部分兼容网关返回分段数组（新版 OpenAI 格式）也一并兼容
function openaiText(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

// Anthropic 原生响应解析：content 是块数组，只取 type === 'text' 的块拼接
function anthropicText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

// createProvider({ fetchImpl }) -> { ask, test }
// fetchImpl 形状同全局 fetch：(url, init) => Promise<Response>，signal 必须被尊重（超时靠 AbortController 打断）。
function createProvider(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new TypeError('createProvider 需要注入 fetchImpl(url, init) 函数');

  // ask(cfg, prompt, opts?)：opts 只做单次调用覆盖（test 用极短 maxTokens / 交互式场景可传更短超时），
  // 供应商身份（协议/地址/模型/Key）始终来自 cfg，避免调用点拼错配置。
  async function ask(cfg, prompt, callOpts) {
    const c = cfg || {};
    const co = callOpts || {};
    const baseUrl = cleanBase(c.baseUrl);
    const model = String(c.model == null ? '' : c.model).trim();
    const apiKey = String(c.apiKey == null ? '' : c.apiKey).trim();
    if (!baseUrl || !model || !apiKey) return { ok: false, reason: CONFIG_INCOMPLETE };

    const protocol = c.protocol === 'anthropic' ? 'anthropic' : 'openai';
    // timeout 与 timeoutMs 都接受：ipc 层习惯传 { timeout }，配置对象字段名是 timeoutMs，二者等价
    const timeoutMs = positiveNumber(co.timeoutMs) || positiveNumber(co.timeout) || positiveNumber(c.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const callTemp = optionalNumber(co.temperature);
    const temperature = callTemp !== null ? callTemp : optionalNumber(c.temperature);
    const maxTokens = positiveNumber(co.maxTokens) || positiveNumber(c.maxTokens);
    const promptText = String(prompt == null ? '' : prompt);
    const url = endpointOf(protocol, baseUrl);

    const headers = { 'content-type': 'application/json' };
    let body;
    if (protocol === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
      // Anthropic 的 max_tokens 必填：未配置时给 1024（契约）
      body = { model, max_tokens: maxTokens || 1024, messages: [{ role: 'user', content: promptText }] };
      if (temperature !== null) body.temperature = temperature;
    } else {
      headers.Authorization = 'Bearer ' + apiKey;
      body = { model, messages: [{ role: 'user', content: promptText }], stream: false };
      if (temperature !== null) body.temperature = temperature;
      if (maxTokens) body.max_tokens = maxTokens;
    }

    const started = Date.now();
    const timeoutReason = '响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）';
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    // 超时不能只依赖 fetch 尊重 signal：Promise.race 保证即使实现忽略 abort 也能按时返回，
    // 并在超时瞬间 abort 让底层请求尽快释放连接（契约要求 AbortController）。
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* 已取消 */ }
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    let outcome;
    try {
      const request = Promise.resolve().then(() => fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
      outcome = await Promise.race([
        request.then((response) => ({ response }), (error) => ({ error })),
        timeoutPromise,
      ]);
      if (outcome.timedOut) return { ok: false, reason: timeoutReason };
      if (outcome.error) {
        if (timedOut || controller.signal.aborted) return { ok: false, reason: timeoutReason };
        return { ok: false, reason: netFailReason(outcome.error) };
      }
      const response = outcome.response;
      if (!response) return { ok: false, reason: UNPARSEABLE };
      if (response.ok === false) return { ok: false, reason: httpFailReason(response.status) };

      // 读正文同样纳入超时：net.fetch 在响应头到达即 resolve，正文流卡住时不能无限等
      const parsed = await Promise.race([
        Promise.resolve().then(() => response.json()).then((data) => ({ data }), (error) => ({ error })),
        timeoutPromise,
      ]);
      if (parsed.timedOut) return { ok: false, reason: timeoutReason };
      if (parsed.error) return { ok: false, reason: UNPARSEABLE };
      const text = protocol === 'anthropic' ? anthropicText(parsed.data) : openaiText(parsed.data);
      if (!text) return { ok: false, reason: UNPARSEABLE };
      return { ok: true, text, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  // test(cfg)：发一条极短 prompt 验证 Key / URL / 模型是否真的可用；不产出业务文本，只报告成败与耗时
  async function test(cfg) {
    const started = Date.now();
    const r = await ask(cfg, 'ping', { maxTokens: 16 });
    if (r.ok) return { ok: true, ms: r.ms, reason: '' };
    return { ok: false, ms: Date.now() - started, reason: r.reason };
  }

  return { ask, test };
}

module.exports = { createProvider };
