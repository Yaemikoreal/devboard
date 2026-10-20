// AI prompt 组装 / 模板 / parseFilter / 注册表一致性 / ipc-ai handler（供应商直连）验证（#180 后续）。
// 本机 CLI 引擎链已移除：ai.js 只保留 prompt 组装与输出解析；ipc-ai 的 ai:ask 只走应用直连供应商。
// handler 级测试以 Module._load 桩注入 fake electron（ipcMain/clipboard/net.fetch），不发真实网络请求、
// 不起子进程、不要求本机安装任何 CLI。
'use strict';

const assert = require('assert');
const ai = require('../src/main/ai');
const registry = require('../src/shared/ai-tools'); // AI 工具单一注册表（issue #123）
const scanner = require('../src/main/scanner'); // 探测登记一致性 / 假工具痕迹断言用（issue #123）

const NOW = new Date('2026-09-09T12:00:00');
const PROJECTS = [
  {
    name: 'alpha', path: 'E:\\p\\alpha', branch: 'main', commits7d: 9,
    recentCommits: [{ msg: '修复登录', rel: '1 天前' }, { msg: '重构设置页', rel: '2 天前' }],
    dirtyCount: 18, dirtyAt: '2026-09-05T12:00:00', ahead: 3, behind: 0,
    lastCommitAt: '2026-09-08T12:00:00', headSha: 'abc',
    warnings: [{ type: 'dirty', label: '18 文件未提交超3天' }, { type: 'ahead', label: '3 提交未推送' }],
  },
  {
    name: 'beta', path: 'E:\\p\\beta', branch: 'dev', commits7d: 0,
    recentCommits: [], dirtyCount: 0, dirtyAt: null, ahead: 0, behind: 2,
    lastCommitAt: '2026-08-01T12:00:00', headSha: 'def', warnings: [],
  },
];

// fake net.fetch 响应：成功 JSON / HTTP 错误
function okJson(data) {
  return { ok: true, status: 200, json: async () => data };
}
function httpError(status) {
  return { ok: false, status, json: async () => ({ error: { message: 'boom' } }) };
}

async function main() {
  // --- prompt 组装 ---
  const weekly = ai.buildWeeklyPrompt(PROJECTS, NOW);
  assert.ok(weekly.includes('alpha'), '周报 prompt 应包含活跃项目');
  assert.ok(!weekly.includes('- beta'), '周报 prompt 应排除近 7 天零提交项目');
  assert.ok(weekly.includes('本周建议关注'), '周报 prompt 应要求建议关注行');
  assert.ok(weekly.includes('不包含代码内容'), 'prompt 应显式声明不传代码');

  const advice = ai.buildAdvicePrompt(PROJECTS[0], NOW);
  assert.ok(advice.includes('18 个文件') && advice.includes('3 个提交未推送'), '建议 prompt 应含脏文件与未推送事实');
  assert.ok(advice.includes('以「- 」开头'), '建议 prompt 应约束输出格式');

  const filterP = ai.buildFilterPrompt('上周动过的 python 项目');
  assert.ok(filterP.includes('hot') && filterP.includes('上周动过的 python 项目'), '筛选 prompt 应含枚举与原文');

  // --- 提示词模板自定义（issue #78）---
  const customWeekly = ai.buildWeeklyPrompt(PROJECTS, NOW, '自定义角色与语气\n{{事实}}\n自定义输出结构');
  assert.ok(customWeekly.includes('自定义角色与语气') && customWeekly.includes('自定义输出结构'), '自定义周报模板应生效');
  assert.ok(customWeekly.includes('- alpha'), '自定义模板应在 {{事实}} 处注入事实块');
  assert.ok(!customWeekly.includes('本周总览：'), '自定义模板不含默认结构词');
  const noSlot = ai.buildAdvicePrompt(PROJECTS[0], NOW, '没有插入点的模板');
  assert.ok(noSlot.includes('没有插入点的模板') && noSlot.includes('18 个文件'), '缺失插入点时事实块应附加末尾');
  const blankTpl = ai.buildWeeklyPrompt(PROJECTS, NOW, '   ');
  assert.ok(blankTpl.includes('本周总览：') && blankTpl.includes('- alpha'), '空白模板应回落内置默认');
  assert.ok(ai.DEFAULT_WEEKLY_TEMPLATE.includes(ai.FACTS_SLOT) && ai.DEFAULT_ADVICE_TEMPLATE.includes(ai.FACTS_SLOT), '默认模板应含 {{事实}} 插入点');
  // 默认路径（不传模板）与显式默认模板产物一致：缓存键按模板内容哈希，两者同源
  assert.strictEqual(ai.buildWeeklyPrompt(PROJECTS, NOW), ai.buildWeeklyPrompt(PROJECTS, NOW, ai.DEFAULT_WEEKLY_TEMPLATE), '缺省模板应与显式默认模板一致');

  // --- parseFilter ---
  assert.deepStrictEqual(
    ai.parseFilter('{"band":"hot","keyword":"python","activeWithinDays":7}'),
    { band: 'hot', keyword: 'python', days: 7 }
  );
  assert.deepStrictEqual(
    ai.parseFilter('好的，结果是：\n{"band":null,"keyword":"web","activeWithinDays":null}\n完毕'),
    { band: null, keyword: 'web', days: null },
    '应容忍散文中夹带的 JSON'
  );
  assert.strictEqual(ai.parseFilter('无法解析'), null, '无 JSON 应返回 null');
  assert.strictEqual(ai.parseFilter('{"band":"nope"}'), null, '非法 band 且无其他条件应返回 null');

  // --- CLI 引擎移除（#180 后续）：ai.js 不再导出进程相关 API，旧模块文件已删除 ---
  for (const key of ['runCli', 'killChild', 'cleanOutput', 'stripAnsi', 'engineErrorLine', 'AI_TIMEOUT_MS']) {
    assert.strictEqual(ai[key], undefined, 'ai.js 不应再导出 CLI 符号: ' + key);
  }
  const fs = require('fs');
  const path = require('path');
  for (const file of ['ai-chain.js', 'ai-route.js']) {
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'src', 'main', file)), false, 'CLI 引擎模块应已删除: ' + file);
  }

  // --- 工具注册表一致性（issue #123）：登记一处，消费方全派生，防平行登记回归 ---
  // issue #141 起注册表含「可启动档」（无 spec、无会话探测的主流候选）：spec/探测两处契约相应放宽，
  // 对有 spec 的行维持原形状断言（漏登记防线对引擎档不放松）
  const ids = registry.AI_TOOLS.map((t) => t.id);
  assert.ok(ids.length >= 4, '注册表应登记默认工具');
  assert.strictEqual(new Set(ids).size, ids.length, '注册表 id 不得重复');
  for (const t of registry.AI_TOOLS) {
    assert.ok(t.id && t.label && t.cmd, '工具行应含 id/label/cmd: ' + t.id);
    if (t.spec) {
      assert.ok(Array.isArray(t.spec.args) && typeof t.spec.stdin === 'boolean' && typeof t.spec.shell === 'boolean',
        'spec 形状（args/stdin/shell）应完整: ' + t.id);
    }
    if (t.prefill) {
      assert.ok(['arg', 'stdin', 'none'].includes(t.prefill.mode), 'prefill.mode 应为已知值: ' + t.id);
    }
    assert.ok(t.icon && t.icon.bg && typeof t.icon.svg === 'string' && t.icon.svg, 'icon 形状（bg/svg）应完整: ' + t.id);
  }
  // 引擎规格查找与登记同源；未知工具返回 null（spec 缺席行按 null 归一，issue #141）
  assert.deepStrictEqual(registry.AI_TOOLS.map((t) => registry.specFor(t.id)), registry.AI_TOOLS.map((t) => t.spec || null),
    'specFor 应与注册表登记一致（缺席 spec 按 null 归一）');
  assert.strictEqual(registry.specFor('不存在的工具'), null, '未知工具 spec 应返回 null');
  // 默认清单 / 痕迹 label / 图标下拉三个派生面覆盖注册表全量 id
  assert.deepStrictEqual(registry.defaultToolList().map((t) => t.id), ids, '默认清单 id 集应与注册表一致');
  assert.deepStrictEqual(registry.defaultToolList().map((t) => t.label), registry.AI_TOOLS.map((t) => t.label),
    '默认清单 label 应与注册表一致');
  assert.deepStrictEqual(Object.keys(registry.aiToolLabels()), ids, '痕迹 label 映射应覆盖注册表全量 id');
  assert.deepStrictEqual(registry.iconChoices().map((p) => p[0]), ids, '图标下拉应覆盖注册表全量 id');
  // 图标回落链：未知 logo key + 未知 id → 终端兜底；命中登记 id → 品牌图标
  assert.strictEqual(registry.iconFor('unknown-key', 'unknown-id').bg, registry.FALLBACK_ICON.bg, '未知图标应回落终端兜底');
  assert.strictEqual(registry.iconFor(null, 'claude').bg, registry.toolById('claude').icon.bg, '按工具 id 应命中品牌图标');
  assert.strictEqual(registry.iconFor('kimi', 'custom-0').bg, registry.toolById('kimi').icon.bg, '自定义工具 logo key 应命中登记图标');
  // 逐次查表而非加载时快照（issue #168 第 14 条）：运行期增行后查找与新派生看到同一份数据
  assert.strictEqual(registry.toolById('不存在'), null, '未知 id 应返回 null');
  assert.deepStrictEqual(registry.AI_TOOLS.map((t) => registry.toolById(t.id)), registry.AI_TOOLS,
    'toolById 应逐次命中同一批登记行');
  // scanner 探测登记与注册表 id 一致（issue #141 放宽）：不得有孤儿探测；默认四件套必须有探测
  const probeIds = scanner.sessionProbeIds();
  const idSet = new Set(ids);
  assert.ok(probeIds.every((id) => idSet.has(id)), '会话探测不得有孤儿 id（探测的工具必须已登记）');
  for (const t of ['claude', 'codex', 'kimi', 'grok']) {
    assert.ok(probeIds.includes(t), '引擎档默认四件套必须有会话探测: ' + t);
  }
  // 桥载荷（真实下发面，issue #168 第 15 条）：断言 preload 实际暴露的派生结果
  const bridge = registry.rendererConsts();
  assert.deepStrictEqual(Object.keys(bridge), ['AI_TOOL_LABELS', 'AI_ICON_CHOICES', 'AI_ENGINE_LABELS'], '桥载荷只含三个派生面');
  assert.deepStrictEqual(Object.keys(bridge.AI_TOOL_LABELS), ids, '桥载荷 label 映射应覆盖注册表全量 id');
  assert.deepStrictEqual(bridge.AI_TOOL_LABELS, registry.aiToolLabels(), '桥载荷 label 应与派生同源');
  assert.deepStrictEqual(bridge.AI_ICON_CHOICES, registry.iconChoices(), '桥载荷图标选项应与派生同源');
  assert.deepStrictEqual(bridge.AI_ICON_CHOICES.map((p) => p[0]), ids, '图标下拉应覆盖注册表全量 id');
  assert.deepStrictEqual(bridge.AI_ENGINE_LABELS, registry.engineToolLabels(), '桥载荷引擎档 label 应与派生同源');
  assert.deepStrictEqual(Object.keys(bridge.AI_ENGINE_LABELS), registry.AI_TOOLS.filter((t) => t.spec).map((t) => t.id),
    '引擎档 label 应恰好覆盖有 spec 的登记行');
  // 注册表为纯数据 / 桥载荷不含函数（preload 经 contextBridge 下发）
  for (const t of registry.AI_TOOLS) {
    for (const [k, v] of Object.entries(t)) {
      assert.notStrictEqual(typeof v, 'function', '注册表字段 ' + t.id + '.' + k + ' 不得是函数（纯数据边界）');
    }
  }
  for (const v of Object.values(bridge.AI_TOOL_LABELS)) {
    assert.notStrictEqual(typeof v, 'function', '桥载荷 label 不得是函数');
  }
  bridge.AI_ICON_CHOICES.forEach((pair) => {
    assert.ok(Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string', '桥载荷图标选项应为 [id, 名称] 字符串对');
  });

  // --- 假工具 id 全链路（issue #123 验收项，issue #168 第 15 条补齐）---
  // 不真装 CLI：在注册表登记一行假工具，验证 清单/图标/spec/痕迹 四条派生面同时看到它。
  {
    const os = require('os');
    const fsx = require('fs');
    const pathx = require('path');
    const FAKE = {
      id: 'zz-fake-tool', label: 'Fake Tool', shortLabel: 'Fake', cmd: 'zz-fake-cmd',
      localDir: '.zz-fake', spec: { args: ['--fake'], stdin: false, shell: false },
      icon: { bg: '#123456', svg: '<path d="M0 0h1v1H0z" fill="#fff"/>' },
    };
    const before = registry.AI_TOOLS.length;
    registry.AI_TOOLS.push(FAKE);
    try {
      // 1) 清单可见
      assert.ok(registry.defaultToolList().some((t) => t.id === FAKE.id), '假工具应出现在默认清单');
      // 2) 图标可选、可挑品牌图标
      assert.ok(registry.iconChoices().some((p) => p[0] === FAKE.id && p[1] === 'Fake'), '假工具应出现在图标下拉');
      assert.strictEqual(registry.iconFor(FAKE.id, 'other').bg, FAKE.icon.bg, '假工具应能取到自己的品牌图标');
      assert.strictEqual(registry.rendererConsts().AI_TOOL_LABELS[FAKE.id], 'Fake Tool', '假工具 label 应随桥下发');
      // 3) 引擎按登记 spec 调用（查找逐次进行，加载时快照的写法在这里会回落成 null）
      assert.deepStrictEqual(registry.specFor(FAKE.id), FAKE.spec, '假工具 spec 应按登记下发');
      // 4) 会话痕迹可展出：注册表 localDir 层自动纳入遍历
      const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'dsh-faketool-'));
      try {
        fsx.mkdirSync(pathx.join(dir, '.git'));
        fsx.mkdirSync(pathx.join(dir, FAKE.localDir));
        fsx.writeFileSync(pathx.join(dir, FAKE.localDir, 'session.json'), '{}');
        const detail = await scanner.projectDetail(dir);
        assert.ok(detail.aiSessions.some((s) => s.tool === FAKE.id),
          '假工具的项目本地会话位应经注册表 localDir 自动纳入痕迹，实际: ' + JSON.stringify(detail.aiSessions));
        assert.strictEqual(registry.rendererConsts().AI_TOOL_LABELS[FAKE.id], FAKE.label,
          '痕迹明细 label 应能从桥载荷取到假工具');
      } finally {
        fsx.rmSync(dir, { recursive: true, force: true });
      }
      // 5) #141 放宽：登记工具可无会话探测；孤儿探测方向的反向防线保留
      assert.ok(scanner.sessionProbeIds().every((id) => registry.toolById(id)),
        '孤儿探测防线保持生效（探测 id 必须已登记）');
    } finally {
      registry.AI_TOOLS.length = before; // 还原注册表，避免影响后续断言
    }
  }

  // --- ipc-ai handler 级测试（#180 后续）：AI 生成只走供应商直连 ---
  // electron 以 Module._load 桩注入：ipcMain.handle 收集 handler、clipboard 记录预填、net.fetch 假响应。
  // checkCommand 桩控制安装集：claude/kimi（有 spec）+ gemini（可启动档）已装，其余未装。
  {
    const handles = {};
    const fakeIpcMain = { handle: (ch, fn) => { handles[ch] = fn; } };
    const clipboardWrites = [];
    const netCalls = [];
    let netResponder = () => okJson({ choices: [{ message: { content: '直连产出' } }] });
    const fakeNet = {
      fetch: async (url, init) => {
        let body = null;
        try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
        netCalls.push({ url, init, body });
        return netResponder(url, init);
      },
    };
    const Module = require('module');
    const origLoad = Module._load;
    const origConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => { loggedErrors.push(args.join(' ')); };
    Module._load = function (request) {
      if (request === 'electron') {
        return { ipcMain: fakeIpcMain, clipboard: { writeText: (t) => clipboardWrites.push(t) }, net: fakeNet };
      }
      return origLoad.apply(this, arguments);
    };
    try {
      const registerAi = require('../src/main/ipc-ai');
      const INSTALLED = { claude: true, kimi: true, gemini: true };
      const scanCache = { projects: { [PROJECTS[0].path]: PROJECTS[0] } };
      let config = {
        aiEnabled: true,
        aiTools: [],
        aiProviderPreset: 'deepseek',
        aiProviderProtocol: 'openai',
        aiProviderBaseUrl: '',
        aiProviderModel: '',
        aiApiKey: '',
        aiTemperature: 0.4,
        aiMaxTokens: 0,
        aiTimeoutMs: 60000,
        aiPromptWeekly: null,
        aiPromptAdvice: null,
      };
      let aiCache = {};
      const fakeStore = {
        getConfig: () => config,
        getAiCache: () => aiCache,
        setAiCache: (c) => { aiCache = c; },
        getScanCache: () => scanCache,
      };
      const spawnCalls = [];
      const registerResult = registerAi({
        store: fakeStore,
        checkCommand: async (cmd) => ({ ok: !!INSTALLED[cmd], reason: '' }),
        pathExists: async () => true,
        spawnResult: async (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return true; },
      });
      // CLI 引擎链已移除：registerAi 不再返回会话黑名单清空口
      assert.deepStrictEqual(registerResult, {}, 'registerAi 应返回空对象（引擎黑名单随 CLI 删除）');

      // aitools:list 保留（工作台/设置页）：可启动档随探测展出，未装候选不标 installed
      const list = await handles['aitools:list']();
      assert.ok(list.some((t) => t.id === 'gemini' && t.installed), '可启动档工具（gemini）应出现在工具清单');
      assert.ok(list.some((t) => t.id === 'claude' && t.installed), '引擎档工具应出现在工具清单');
      assert.ok(list.every((t) => !INSTALLED[t.cmd] ? !t.installed : true), '未安装候选不得标 installed');

      // aitools:open 保留（意图路由出口，issue #142）：prompt 预填按注册行 prefill.mode 分流
      spawnCalls.length = 0;
      const openBare = await handles['aitools:open'](null, 'claude', 'E:\\p\\x');
      assert.strictEqual(openBare, true, '无 prompt 应照常启动');
      assert.deepStrictEqual(spawnCalls[0].args, ['-d', 'E:\\p\\x', 'cmd', '/k', 'claude'], '无 prompt 不得追加参数');
      spawnCalls.length = 0;
      await handles['aitools:open'](null, 'claude', 'E:\\p\\x', '整理当前改动成合理提交');
      assert.ok(spawnCalls[0].args.includes('整理当前改动成合理提交'), 'arg 模式应把 prompt 作为独立参数拼接');
      assert.strictEqual(clipboardWrites.length, 0, 'arg 模式不得写剪贴板');
      clipboardWrites.length = 0;
      spawnCalls.length = 0;
      await handles['aitools:open'](null, 'grok', 'E:\\p\\x', '确认并推送');
      assert.strictEqual(clipboardWrites.length, 1, 'none 模式应写剪贴板兜底');
      assert.deepStrictEqual(spawnCalls[0].args, ['-d', 'E:\\p\\x', 'cmd', '/k', 'grok'], 'none 模式命令行不带 prompt');

      // ai:promptPreview 保留：只组装 prompt，不依赖供应商配置
      const preview = await handles['ai:promptPreview'](null, { kind: 'weekly' });
      assert.ok(preview.ok && preview.prompt.includes('- alpha'), '周报预览应产出含活跃项目的 prompt');
      const previewFilter = await handles['ai:promptPreview'](null, { kind: 'filter', query: 'x' });
      assert.strictEqual(previewFilter.ok, false, 'filter 不开放 prompt 预览');

      // a) ai:caps：未配供应商 → configured=false / provider=null；cliTool 来自已装且有 spec 的工具
      let caps = await handles['ai:caps']();
      assert.deepStrictEqual(caps, {
        enabled: true,
        configured: false,
        provider: null,
        cliTool: { id: 'claude', label: 'Claude Code', cmd: 'claude' },
      }, '未配供应商时 caps 形状不对（CLI 引擎字段应已移除）');

      // b) ai:ask：未配置供应商 → 指向设置页的固定文案，且不发网络请求
      netCalls.length = 0;
      const unconfigured = await handles['ai:ask'](null, { kind: 'weekly' });
      assert.strictEqual(unconfigured.ok, false, '未配供应商时 ai:ask 应失败');
      assert.ok(String(unconfigured.reason).includes('未配置 AI 供应商'), '未配供应商 reason 应指向设置页，实际: ' + JSON.stringify(unconfigured.reason));
      assert.strictEqual(netCalls.length, 0, '未配供应商不应发起网络请求');
      // AI 总开关关闭：保持原错误文案
      config.aiEnabled = false;
      const capsOff = await handles['ai:caps']();
      assert.strictEqual(capsOff.enabled, false, 'aiEnabled=false 时 caps.enabled 应为 false');
      const offAsk = await handles['ai:ask'](null, { kind: 'weekly' });
      assert.deepStrictEqual(offAsk, { ok: false, reason: 'AI 功能已在设置中关闭' }, 'AI 关闭时保持原错误文案');
      config.aiEnabled = true;

      // a) ai:caps：配全供应商后 configured=true，provider 反映预设/模型/协议
      config.aiProviderBaseUrl = 'https://api.deepseek.com/v1';
      config.aiProviderModel = 'deepseek-chat';
      config.aiApiKey = 'sk-test';
      caps = await handles['ai:caps']();
      assert.strictEqual(caps.configured, true, '配全供应商后 configured 应为 true');
      assert.deepStrictEqual(caps.provider, {
        preset: 'deepseek',
        label: 'DeepSeek · deepseek-chat',
        model: 'deepseek-chat',
        protocol: 'openai',
      }, 'caps.provider 应反映预设/模型/协议');
      assert.deepStrictEqual(caps.cliTool, { id: 'claude', label: 'Claude Code', cmd: 'claude' }, 'cliTool 应来自已装且有 spec 的工具');

      // c) ai:ask：供应商直连成功（fake net.fetch），检查请求、缓存 engine/via
      netCalls.length = 0;
      netResponder = () => okJson({ choices: [{ message: { role: 'assistant', content: '本周总览：供应商直连成功。' } }] });
      const weeklyAsk = await handles['ai:ask'](null, { kind: 'weekly' });
      assert.strictEqual(weeklyAsk.ok, true, '配全供应商后 ai:ask 应成功，实际: ' + JSON.stringify(weeklyAsk));
      assert.strictEqual(weeklyAsk.kind, 'weekly');
      assert.strictEqual(weeklyAsk.text, '本周总览：供应商直连成功。');
      assert.strictEqual(weeklyAsk.cached, false);
      assert.strictEqual(weeklyAsk.engine.id, 'provider', '生成引擎应为 provider');
      assert.strictEqual(weeklyAsk.engine.provider, true, 'provider 引擎应带 provider 标记');
      assert.strictEqual(weeklyAsk.engine.label, 'DeepSeek · deepseek-chat', '引擎标签应随预设/模型派生');
      assert.strictEqual(netCalls.length, 1, '应恰好发起一次供应商请求');
      const call = netCalls[0];
      assert.strictEqual(call.url, 'https://api.deepseek.com/v1/chat/completions', '请求 URL 应为供应商 chat/completions');
      assert.strictEqual(call.init.method, 'POST');
      assert.strictEqual(call.init.headers.Authorization, 'Bearer sk-test', '应带供应商 API Key');
      assert.strictEqual(call.body.model, 'deepseek-chat');
      assert.strictEqual(call.body.stream, false);
      assert.ok(call.body.messages[0].content.includes('本周总览：'), '发送的应是周报 prompt');
      const expectedVia = 'openai|https://api.deepseek.com/v1|deepseek-chat'; // providerSignature 口径
      assert.strictEqual(weeklyAsk.via, expectedVia);
      assert.ok(aiCache.weekly, '周报应写缓存');
      assert.strictEqual(aiCache.weekly.engine, 'provider', '缓存 engine 应记 provider');
      assert.strictEqual(aiCache.weekly.via, expectedVia, '缓存 via 应为供应商签名');
      assert.strictEqual(aiCache.weekly.text, '本周总览：供应商直连成功。');
      assert.strictEqual(aiCache.lastGoodEngine, undefined, 'CLI 引擎已移除，不应再写 lastGoodEngine');
      // 第二次：命中缓存，不再请求供应商
      netCalls.length = 0;
      const weeklyCached = await handles['ai:ask'](null, { kind: 'weekly' });
      assert.strictEqual(weeklyCached.ok, true);
      assert.strictEqual(weeklyCached.cached, true, '同供应商/模板/当天应命中缓存');
      assert.strictEqual(weeklyCached.via, expectedVia);
      assert.strictEqual(netCalls.length, 0, '缓存命中不应再请求供应商');

      // filter：供应商产出需 parseFilter 校验；不可解析视同失败，不写缓存
      netCalls.length = 0;
      netResponder = () => okJson({ choices: [{ message: { content: '{"band":"hot","keyword":"python","activeWithinDays":7}' } }] });
      const filterAsk = await handles['ai:ask'](null, { kind: 'filter', query: '上周动过的 python 项目' });
      assert.strictEqual(filterAsk.ok, true, 'filter 供应商产出可解析时应成功，实际: ' + JSON.stringify(filterAsk));
      assert.deepStrictEqual(filterAsk.filter, { band: 'hot', keyword: 'python', days: 7 });
      assert.strictEqual(filterAsk.engine.id, 'provider');
      assert.strictEqual(aiCache.filter, undefined, 'filter 不写缓存');
      netResponder = () => okJson({ choices: [{ message: { content: '我觉得是热项目' } }] });
      const badFilter = await handles['ai:ask'](null, { kind: 'filter', query: '热项目' });
      assert.strictEqual(badFilter.ok, false, 'filter 产出不可解析应失败');
      assert.strictEqual(badFilter.reason, '输出无法解析');

      // 供应商失败：中文分类原样回传（不再回退 CLI），失败不写缓存
      aiCache = {};
      netCalls.length = 0;
      netResponder = () => httpError(401);
      const failedAsk = await handles['ai:ask'](null, { kind: 'weekly' });
      assert.strictEqual(failedAsk.ok, false, '供应商 401 时 ai:ask 应失败');
      assert.strictEqual(failedAsk.reason, '鉴权失败（API Key 无效或无权限）', '失败原因应为中文分类');
      assert.strictEqual(aiCache.weekly, undefined, '失败不应写缓存');
      assert.strictEqual(netCalls.length, 1, '失败路径应恰好请求一次（无 CLI 回退）');
      assert.ok(loggedErrors.some((s) => s.includes('AI 供应商调用失败')), '供应商失败应记录 console.error 供排查');

      // d) ai:provider:test：成功 / 失败各一（走同一 fake net.fetch）
      netCalls.length = 0;
      netResponder = () => okJson({ choices: [{ message: { content: 'pong' } }] });
      const testOk = await handles['ai:provider:test'](null, {
        protocol: 'openai',
        baseUrl: 'https://api.test/v1',
        model: 'test-model',
        apiKey: 'sk-test',
      });
      assert.strictEqual(testOk.ok, true, 'provider:test 成功应 ok=true，实际: ' + JSON.stringify(testOk));
      assert.strictEqual(testOk.reason, '');
      assert.ok(typeof testOk.ms === 'number');
      assert.strictEqual(netCalls[0].url, 'https://api.test/v1/chat/completions');
      assert.strictEqual(netCalls[0].init.headers.Authorization, 'Bearer sk-test');
      assert.strictEqual(netCalls[0].body.max_tokens, 16, 'provider:test 应用极短 max_tokens');
      netResponder = () => httpError(401);
      const testFail = await handles['ai:provider:test'](null, {});
      assert.strictEqual(testFail.ok, false, 'provider:test 鉴权失败应 ok=false');
      assert.strictEqual(testFail.reason, '鉴权失败（API Key 无效或无权限）');
      assert.ok(typeof testFail.ms === 'number');
    } finally {
      Module._load = origLoad;
      console.error = origConsoleError;
    }
  }

  console.log('test-ai: 全部断言通过');
}

main().catch((err) => {
  console.error('test-ai 失败:', err);
  process.exit(1);
});
