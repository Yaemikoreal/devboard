// AI 供应商预设（issue #180 延续：应用自身直连模型 API，周报/建议不再强依赖本机 CLI）。
// 单一事实源：主进程（配置归一化、引擎标签）与渲染层（设置页下拉、占位提示）共用。
// 预设只负责「填默认值」，用户仍可改 Base URL / 模型 / 协议，因此这里不追求穷尽，
// 新增供应商只需在 AI_PROVIDERS 追加一项，UI 自动出现。
'use strict';

// 协议：openai = OpenAI 兼容 /chat/completions；anthropic = Anthropic 原生 /v1/messages
const AI_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容（/chat/completions）' },
  { id: 'anthropic', label: 'Anthropic 原生（/v1/messages）' },
];

const AI_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: 'sk-…（platform.deepseek.com 创建）',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    keyHint: 'sk-…（platform.moonshot.cn 创建）',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyHint: '…（open.bigmodel.cn 创建）',
  },
  {
    id: 'dashscope',
    label: '通义千问（DashScope 兼容模式）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyHint: 'sk-…（dashscope.console.aliyun.com 创建）',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'sk-…（platform.openai.com 创建）',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    keyHint: 'sk-ant-…（console.anthropic.com 创建）',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    keyHint: 'sk-…（cloud.siliconflow.cn 创建）',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    keyHint: '本地服务可留空（仍需填任意占位符）',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    keyHint: '按你的服务商文档填写',
  },
];

function providerById(id) {
  return AI_PROVIDERS.find((p) => p.id === id) || null;
}

function protocolById(id) {
  return AI_PROTOCOLS.find((p) => p.id === id) || AI_PROTOCOLS[0];
}

// 引擎标签（展示用）：预设名 + 模型；自定义/未知预设退化为「自定义供应商」
function providerLabel(presetId, model) {
  const p = providerById(presetId);
  const base = p ? p.label : '自定义供应商';
  return model ? base + ' · ' + model : base;
}

// 供应商是否配置完整：三项缺一不可（Base URL / 模型 / API Key）。主进程判定「是否可走直连」、
// 设置页显示「已配置」状态、AI 入口显隐都以此为准，避免三处各写一套判定漂移。
function providerReady(cfg) {
  return !!(cfg && String(cfg.aiProviderBaseUrl || '').trim() && String(cfg.aiProviderModel || '').trim() && String(cfg.aiApiKey || '').trim());
}

// 供应商签名：进 AI 缓存键。换供应商/模型/协议后旧缓存不得复用（不同模型产出不可比），
// 也让「先本机 CLI、后切直连」的历史缓存自然失效一次。
function providerSignature(cfg) {
  return [cfg.aiProviderProtocol || 'openai', String(cfg.aiProviderBaseUrl || '').trim(), String(cfg.aiProviderModel || '').trim()].join('|');
}

module.exports = { AI_PROTOCOLS, AI_PROVIDERS, providerById, protocolById, providerLabel, providerReady, providerSignature };
