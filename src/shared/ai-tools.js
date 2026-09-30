// AI 工具单一注册表（issue #123）：默认 AI 工具的登记收敛到本文件。
// 此前同一份信息按工具 id 散落四处平行登记（引擎 TOOL_SPECS、主进程默认清单+图标表、
// scanner 本地目录清单、渲染层 label 表+图标下拉），漏改任意一处即静默降级（Shotgun Surgery）。
// 纪律：本模块不依赖 Electron、不做 IO（与 shared/constants、shared/themes 同款约束），
// 主进程直接 require，渲染层只经 preload 下发的派生结果（rendererConsts）消费。
// 分两层登记（issue #123 待确认项）：本表持纯数据行（label/cmd/spec/icon/localDir），
// 用户目录会话探测是 fs 行为，按 id 登记在 scanner.js 的 SESSION_PROBES——那里漏登记会被
// test-ai 的探测登记一致性断言当场打红，不再静默降级。
'use strict';

const AI_TOOLS = [
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    cmd: 'claude',
    localDir: '.claude', // 旧版项目本地会话目录（兼容旧布局，issue #35）
    // shell: claude 是 npm .cmd shim，Windows 下必须经 shell 启动（Node 对 .cmd 的 CVE 限制）；
    // prompt 经 stdin 传入
    spec: { args: ['-p'], stdin: true, shell: true },
    // 图标来源：simple-icons anthropic（issue #21）
    icon: {
      bg: '#d97757',
      svg: '<path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" fill="#fff"/>',
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    cmd: 'codex',
    localDir: '.codex',
    // --skip-git-repo-check：开机自启等场景 cwd 不是受信 git 仓库时 codex exec 会直接拒绝执行（issue #115）
    spec: { args: ['exec', '--skip-git-repo-check'], stdin: false, shell: false },
    // 图标来源：simple-icons openai v13（新版已下架，issue #21）
    icon: {
      bg: '#202020',
      svg: '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#fff"/>',
    },
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    shortLabel: 'Kimi',
    cmd: 'kimi',
    localDir: '.kimi-code',
    // streamJson: 输出为 JSON 行，取 role=assistant 的 content 作为正文（kimi 文本模式会混入过程 bullet）
    spec: { args: ['-p'], stdin: false, shell: false, streamJson: true },
    // kimi 无官方 simple-icons 条目（未收录 Moonshot），沿用 demos 的近似标（K 字，issue #21）
    icon: {
      bg: '#101010',
      svg: '<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="sans-serif">K</text>',
    },
  },
  {
    id: 'grok',
    label: 'Grok',
    shortLabel: 'Grok',
    cmd: 'grok',
    localDir: '.grok',
    spec: { args: ['--single'], stdin: false, shell: false },
    // 图标来源：simple-icons x（issue #21）
    icon: {
      bg: '#000000',
      svg: '<path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" fill="#fff"/>',
    },
  },
];

// 按 id 查登记行：每次现查而非加载时快照——注册表若在运行期增行（#141 自动发现等），
// 引擎规格/图标查找与清单/label 派生必须同时看到新行，不允许一边派生一边回落（静默降级）
function toolById(toolId) {
  return AI_TOOLS.find((t) => t.id === toolId) || null;
}

// 自定义工具（config.aiTools）的通用兜底图标（终端，原 AI_TOOL_ICONS.terminal）
const FALLBACK_ICON = {
  bg: '#322e27',
  svg: '<path d="M5.5 7l4.5 4-4.5 4M11.5 15H18" stroke="#f5d90a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

// 引擎调用规格查找：未知工具（自定义命令无法预知参数形态）返回 null，由 ai.js 落到通用规格
function specFor(toolId) {
  const t = toolById(toolId);
  return (t && t.spec) || null;
}

// 图标查找（原 AI_TOOL_ICONS 取值逻辑）：先按自定义 logo key（=某工具 id），再按工具自身 id，
// 均未命中（未知 key / 自定义工具）回落终端兜底
function iconFor(logoKey, id) {
  const t = toolById(logoKey) || toolById(id);
  return (t && t.icon) || FALLBACK_ICON;
}

// 默认工具清单（aitools:list 探测与合并用）：只挑清单字段，spec/icon 属实现细节不外泄
function defaultToolList() {
  return AI_TOOLS.map(({ id, label, cmd }) => ({ id, label, cmd }));
}

// 会话痕迹展示 label 映射（id -> 显示名）：渲染层「AI 会话痕迹」明细派生用
function aiToolLabels() {
  const map = {};
  for (const t of AI_TOOLS) map[t.id] = t.label;
  return map;
}

// 设置页图标下拉选项（[id, shortLabel] 数组）：自定义工具行挑品牌图标用。
// shortLabel（'Claude'/'Kimi'）是设置页下拉的短名 facet，注册表建议形状之外的显式增补
function iconChoices() {
  return AI_TOOLS.map((t) => [t.id, t.shortLabel || t.label]);
}

// preload 桥载荷（issue #123）：渲染层需要的两个派生面在此一次性算好下发，
// 只给派生的最小结果——引擎 spec / localDir / 图标 SVG 属实现细节，不过桥（不扩大下发面）
function rendererConsts() {
  return {
    AI_TOOL_LABELS: aiToolLabels(),
    AI_ICON_CHOICES: iconChoices(),
  };
}

module.exports = {
  AI_TOOLS,
  toolById,
  FALLBACK_ICON,
  specFor,
  iconFor,
  defaultToolList,
  aiToolLabels,
  iconChoices,
  rendererConsts,
};
