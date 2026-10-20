// ai-provider 单元验证（#180 后续：AI 生成只走应用直连供应商）：
// 直连供应商的 URL / headers / body 组装与响应解析、baseUrl 归一化、鉴权/404/限流/5xx/超时/网络/
// 解析失败的中文 reason、配置不全短路、test() 探活。CLI 引擎链已移除，ai-route 及其用例一并删除。
// 零依赖（node:assert + 假 fetch），不起 Electron、不发真实网络请求；直接 node scripts/test-provider.js。
'use strict';

const assert = require('assert');
const { createProvider } = require('../src/main/ai-provider');

const CFG = { protocol: 'openai', baseUrl: 'https://api.test/v1', model: 'test-model', apiKey: 'sk-test' };
const CONFIG_INCOMPLETE = '供应商未配置完整（Base URL / 模型 / API Key）';
const UNPARSEABLE = '输出无法解析';

function okJson(data, status) {
  return { ok: true, status: status || 200, json: async () => data };
}

function httpError(status) {
  return { ok: false, status, json: async () => ({ error: { message: 'boom' } }) };
}

function openaiReply(text) {
  return okJson({ choices: [{ message: { role: 'assistant', content: text } }] });
}

function anthropicReply(blocks) {
  return okJson({ content: blocks });
}

// 假 fetch：记录每次调用的 url/init/解析后的 body；handler 可按调用序号返回不同响应
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function providerWith(handler) {
  const fetchImpl = fakeFetch(handler);
  return { provider: createProvider({ fetchImpl }), fetchImpl };
}

// 统一跑一次失败调用并返回 reason
async function reasonFor(handler, cfg) {
  const { provider } = providerWith(handler);
  const r = await provider.ask(Object.assign({}, CFG, cfg || {}), '你好');
  assert.strictEqual(r.ok, false, '该场景应判失败');
  assert.strictEqual(typeof r.reason, 'string', '失败应带字符串 reason');
  return r.reason;
}

async function main() {
  // ---------- createProvider 入参校验 ----------
  assert.throws(() => createProvider(), TypeError, '缺 fetchImpl 应抛 TypeError');
  assert.throws(() => createProvider({}), TypeError, 'fetchImpl 非函数应抛 TypeError');

  // ---------- OpenAI 协议：URL / headers / body / 解析 ----------
  {
    const { provider, fetchImpl } = providerWith(() => openaiReply('  你好，世界  '));
    const cfg = Object.assign({}, CFG, { temperature: 0.3, maxTokens: 512 });
    const r = await provider.ask(cfg, '你好');
    assert.strictEqual(r.ok, true, 'OpenAI 调用应成功');
    assert.strictEqual(r.text, '你好，世界', '应返回 trim 后的 message.content');
    assert.ok(typeof r.ms === 'number' && r.ms >= 0, '成功结果应带毫秒耗时');
    const call = fetchImpl.calls[0];
    assert.strictEqual(call.url, 'https://api.test/v1/chat/completions', 'OpenAI URL 应拼 /chat/completions');
    assert.strictEqual(call.init.method, 'POST', '应使用 POST');
    assert.strictEqual(call.init.headers.Authorization, 'Bearer sk-test', 'OpenAI 应带 Bearer 鉴权头');
    assert.strictEqual(call.init.headers['content-type'], 'application/json', '应声明 JSON 正文');
    assert.ok(call.init.signal && typeof call.init.signal.aborted === 'boolean', '应透传 AbortSignal');
    assert.deepStrictEqual(call.body, {
      model: 'test-model',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      temperature: 0.3,
      max_tokens: 512,
    }, 'OpenAI 请求体形状应与契约一致');
  }

  // 可选字段缺省时不进 body（服务商默认值生效）
  {
    const { provider, fetchImpl } = providerWith(() => openaiReply('ok'));
    await provider.ask(CFG, 'hi');
    assert.deepStrictEqual(fetchImpl.calls[0].body, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, '未配置 temperature/maxTokens 时不应写进 body');
  }

  // ---------- Anthropic 协议：URL / headers / body / content 拼接 ----------
  {
    const { provider, fetchImpl } = providerWith(() => anthropicReply([
      { type: 'text', text: '你好' },
      { type: 'tool_use', id: 'tool-1' },
      { type: 'text', text: '，世界' },
    ]));
    const cfg = {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/',
      model: 'claude-test',
      apiKey: 'sk-ant-test',
      temperature: 0.2,
      maxTokens: 300,
    };
    const r = await provider.ask(cfg, '你好');
    assert.strictEqual(r.ok, true, 'Anthropic 调用应成功');
    assert.strictEqual(r.text, '你好，世界', '应只拼接 type=text 的块');
    const call = fetchImpl.calls[0];
    assert.strictEqual(call.url, 'https://api.anthropic.com/v1/messages', 'Anthropic URL 应拼 /v1/messages');
    assert.strictEqual(call.init.headers['x-api-key'], 'sk-ant-test', 'Anthropic 应带 x-api-key');
    assert.strictEqual(call.init.headers['anthropic-version'], '2023-06-01', 'Anthropic 应带版本头');
    assert.strictEqual(call.init.headers['content-type'], 'application/json', '应声明 JSON 正文');
    assert.strictEqual(call.init.headers.Authorization, undefined, 'Anthropic 不应带 Bearer 头');
    assert.deepStrictEqual(call.body, {
      model: 'claude-test',
      max_tokens: 300,
      messages: [{ role: 'user', content: '你好' }],
      temperature: 0.2,
    }, 'Anthropic 请求体形状应与契约一致（无 stream）');
  }

  // Anthropic max_tokens 未配置时默认 1024
  {
    const { provider, fetchImpl } = providerWith(() => anthropicReply([{ type: 'text', text: 'ok' }]));
    await provider.ask({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' }, 'q');
    assert.strictEqual(fetchImpl.calls[0].body.max_tokens, 1024, 'Anthropic 缺省 max_tokens 应为 1024');
  }

  // ---------- baseUrl 归一化：尾部斜杠 / 已含 endpoint / /v1 分支 ----------
  {
    const cases = [
      ['openai', 'https://x.test/v1', 'https://x.test/v1/chat/completions'],
      ['openai', 'https://x.test/v1/', 'https://x.test/v1/chat/completions'],
      ['openai', 'https://x.test/v1///', 'https://x.test/v1/chat/completions'],
      ['openai', '  https://x.test/v1  ', 'https://x.test/v1/chat/completions'],
      ['openai', 'https://x.test/v1/chat/completions', 'https://x.test/v1/chat/completions'],
      ['openai', 'https://x.test/v1/chat/completions/', 'https://x.test/v1/chat/completions'],
      ['anthropic', 'https://x.test', 'https://x.test/v1/messages'],
      ['anthropic', 'https://x.test/', 'https://x.test/v1/messages'],
      ['anthropic', 'https://x.test/v1', 'https://x.test/v1/messages'],
      ['anthropic', 'https://x.test/v1/', 'https://x.test/v1/messages'],
      ['anthropic', 'https://x.test/v1/messages', 'https://x.test/v1/messages'],
      ['anthropic', 'https://x.test/v1/messages/', 'https://x.test/v1/messages'],
    ];
    for (const [protocol, baseUrl, expected] of cases) {
      const { provider, fetchImpl } = providerWith(() => (
        protocol === 'anthropic' ? anthropicReply([{ type: 'text', text: 'x' }]) : openaiReply('x')
      ));
      const r = await provider.ask(Object.assign({}, CFG, { protocol, baseUrl, apiKey: 'k' }), 'q');
      assert.strictEqual(r.ok, true, protocol + ' ' + baseUrl + ' 应调用成功');
      assert.strictEqual(fetchImpl.calls[0].url, expected, protocol + ' baseUrl=' + baseUrl + ' 的 endpoint 归一化不对');
    }
  }

  // ---------- HTTP 错误 → 中文 reason ----------
  {
    const cases = [
      [401, '鉴权失败（API Key 无效或无权限）'],
      [403, '鉴权失败（API Key 无效或无权限）'],
      [404, '接口地址或模型不存在（HTTP 404）'],
      [429, '配额不足或触发限流（HTTP 429）'],
      [500, '供应商服务异常（HTTP 500）'],
      [502, '供应商服务异常（HTTP 502）'],
    ];
    for (const [status, expected] of cases) {
      assert.strictEqual(await reasonFor(() => httpError(status)), expected, 'HTTP ' + status + ' 归类不对');
    }
  }

  // ---------- 超时：按 AbortController 打断并报秒数 ----------
  {
    let aborted = false;
    const { provider } = providerWith((url, init) => new Promise(() => {
      init.signal.addEventListener('abort', () => { aborted = true; });
    }));
    const started = Date.now();
    const r = await provider.ask(Object.assign({}, CFG, { timeoutMs: 1000 }), '慢请求');
    assert.strictEqual(r.ok, false, '超时应判失败');
    assert.strictEqual(r.reason, '响应超时（1 秒）', '超时 reason 应带秒数');
    assert.ok(Date.now() - started >= 900, '超时应至少等到配置的时长');
    assert.strictEqual(aborted, true, '超时应 abort 底层请求');
  }
  // 调用级 opts.timeout 覆盖（ipc 层按调用场景传 { timeout }）
  {
    const { provider } = providerWith(() => new Promise(() => {}));
    const r = await provider.ask(CFG, '慢请求', { timeout: 1000 });
    assert.strictEqual(r.ok, false, 'opts.timeout 超时应判失败');
    assert.strictEqual(r.reason, '响应超时（1 秒）', 'opts.timeout 应覆盖配置超时');
  }
  // 响应头已到达但正文流卡住：读正文也要受同一个超时约束
  {
    const { provider } = providerWith(() => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }));
    const r = await provider.ask(Object.assign({}, CFG, { timeoutMs: 1000 }), '慢正文');
    assert.strictEqual(r.ok, false, '正文卡住应判失败');
    assert.strictEqual(r.reason, '响应超时（1 秒）', '读正文超时也应报响应超时');
  }

  // ---------- 网络异常 → 中文 reason ----------
  {
    const codeErr = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    assert.strictEqual(await reasonFor(() => { throw codeErr; }), '网络连接失败（ECONNREFUSED）');
    const causeErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    assert.strictEqual(await reasonFor(() => { throw causeErr; }), '网络连接失败（ENOTFOUND）');
  }

  // ---------- 非 JSON / 空正文 / 缺字段 → 输出无法解析 ----------
  {
    assert.strictEqual(await reasonFor(() => okJson({})), UNPARSEABLE, '缺 choices 应判不可解析');
    assert.strictEqual(await reasonFor(() => okJson(null)), UNPARSEABLE, '空正文应判不可解析');
    assert.strictEqual(await reasonFor(() => okJson({ choices: [{ message: { content: '   ' } }] })), UNPARSEABLE, '空白 content 应判不可解析');
    assert.strictEqual(
      await reasonFor(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })),
      UNPARSEABLE,
      '非 JSON 响应应判不可解析'
    );
    assert.strictEqual(await reasonFor(() => anthropicReply([]), { protocol: 'anthropic', baseUrl: 'https://x.test' }), UNPARSEABLE, '空 content 应判不可解析');
    assert.strictEqual(
      await reasonFor(() => anthropicReply([{ type: 'tool_use', id: 't' }]), { protocol: 'anthropic', baseUrl: 'https://x.test' }),
      UNPARSEABLE,
      '无 text 块应判不可解析'
    );
  }

  // ---------- 配置不全短路：不发请求 ----------
  {
    const fetchImpl = fakeFetch(() => openaiReply('x'));
    const provider = createProvider({ fetchImpl });
    const incomplete = [
      {},
      { baseUrl: 'https://x.test', model: 'm' },
      { baseUrl: 'https://x.test', apiKey: 'k' },
      { model: 'm', apiKey: 'k' },
      { baseUrl: '   ', model: 'm', apiKey: 'k' },
      { baseUrl: 'https://x.test', model: '   ', apiKey: 'k' },
      { baseUrl: 'https://x.test', model: 'm', apiKey: '   ' },
    ];
    for (const cfg of incomplete) {
      const r = await provider.ask(cfg, 'q');
      assert.strictEqual(r.ok, false, '配置不全应判失败');
      assert.strictEqual(r.reason, CONFIG_INCOMPLETE, '配置不全 reason 应与契约一致');
    }
    assert.strictEqual(fetchImpl.calls.length, 0, '配置不全不应发网络请求');
  }

  // ---------- test()：极短 prompt 探活 ----------
  {
    const { provider, fetchImpl } = providerWith(() => openaiReply('pong'));
    const r = await provider.test(Object.assign({}, CFG, { maxTokens: 1024 }));
    assert.strictEqual(r.ok, true, 'test 成功应 ok=true');
    assert.strictEqual(r.reason, '', 'test 成功 reason 应为空串');
    assert.ok(typeof r.ms === 'number' && r.ms >= 0, 'test 应带耗时');
    const body = fetchImpl.calls[0].body;
    assert.strictEqual(body.max_tokens, 16, 'test 应强制 max_tokens=16');
    assert.strictEqual(body.messages[0].content, 'ping', 'test 应发极短 prompt');
  }
  {
    const { provider, fetchImpl } = providerWith(() => anthropicReply([{ type: 'text', text: 'pong' }]));
    const r = await provider.test({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k', maxTokens: 1024 });
    assert.strictEqual(r.ok, true, 'Anthropic test 成功应 ok=true');
    assert.strictEqual(fetchImpl.calls[0].body.max_tokens, 16, 'Anthropic test 也应强制 max_tokens=16');
  }
  {
    const { provider } = providerWith(() => httpError(401));
    const r = await provider.test(CFG);
    assert.strictEqual(r.ok, false, 'test 鉴权失败应 ok=false');
    assert.strictEqual(r.reason, '鉴权失败（API Key 无效或无权限）', 'test 失败应透出中文 reason');
    assert.ok(typeof r.ms === 'number', 'test 失败也应带耗时');
  }
  {
    const { provider } = providerWith(() => openaiReply('x'));
    const r = await provider.test({});
    assert.strictEqual(r.ok, false, 'test 配置不全应失败');
    assert.strictEqual(r.reason, CONFIG_INCOMPLETE, 'test 配置不全 reason 应与契约一致');
  }

  console.log('test-provider: 全部断言通过');
}

main().catch((err) => {
  console.error('test-provider 失败:', err);
  process.exit(1);
});
