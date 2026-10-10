// MCP 动作 argv 协议（issue #149）：server（独立进程）与主进程（second-instance/启动段）
// 之间跨进程传递动作的约定。纯函数、零依赖——server 侧 build、主进程侧 parse，双向可测。
//
// 形式：--mcp-action=<rescan|refresh|quickopen|open-cli> + --mcp-<key>=<value> 附加参数。
// prompt 等可能含换行/引号的文本走 --mcp-prompt-b64=<base64>（命令行参数无法可靠承载换行）。
// 动作语义是「请求」：server 侧 detached 拉起应用 exe 即返回，不等待完成结果（人在环，ADR-0004）。
'use strict';

const ACTION_KEYS = ['mcp-action', 'mcp-path', 'mcp-kind', 'mcp-cmd', 'mcp-prompt-b64'];

// 从 argv 抽取 --mcp-*=* 键值；无 --mcp-action 时返回 null（普通启动/其他用途的 argv 不误伤）
function parseActionArgv(argv) {
  const out = {};
  let has = false;
  for (const a of argv || []) {
    const m = /^--(mcp-[a-z0-9-]+)=(.*)$/s.exec(String(a));
    if (!m) continue;
    out[m[1]] = m[2];
    if (m[1] === 'mcp-action') has = true;
  }
  return has ? out : null;
}

// 构造动作 argv：{ 'mcp-action': 'open-cli', 'mcp-path': ..., 'mcp-prompt-b64': ... }
function buildActionArgv(action) {
  const out = [];
  for (const [k, v] of Object.entries(action || {})) {
    if (!ACTION_KEYS.includes(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    out.push('--' + k + '=' + v);
  }
  if (!out.some((a) => a.startsWith('--mcp-action='))) throw new Error('缺少 mcp-action');
  return out;
}

// prompt 文本 → base64（utf8）；空文本返回 undefined（不生成参数）
function encodePrompt(text) {
  const s = String(text || '');
  if (!s.trim()) return undefined;
  return Buffer.from(s, 'utf8').toString('base64');
}

function decodePrompt(b64) {
  if (!b64) return '';
  const s = String(b64);
  // Node 的 base64 解码宽容（非法字符被静默跳过，try/catch 形同虚设）——先验字符集，坏输入返回空串
  if (!/^[A-Za-z0-9+/]*={0,3}$/.test(s)) return '';
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { parseActionArgv, buildActionArgv, encodePrompt, decodePrompt, ACTION_KEYS };
