// CJS 域模块桥（ADR-0005 复用方式）：本包以目录链接安装在本仓库 dsh-plugin/ 下，
// 域模块在上一级的 src/{main,mcp,shared}。零 bare import——DSH 包不进插件依赖，
// 域模块经 createRequire 以绝对路径加载（加载后其内部相对 require 自行解析）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
// 仓库根 = 本包目录的上一级（目录链接安装时 import.meta.url 已是真实路径）
const repoRoot = path.resolve(here, '..');

function domain(rel) {
  const abs = path.join(repoRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    throw new Error(
      `[signalboard] 无法加载域模块 ${rel}（尝试 ${abs}）：${(err && err.message) || err}。`
      + '本插件以目录链接方式复用仓库域模块；若插件被复制安装到其他位置，请将其放回仓库 dsh-plugin/ 目录后重装。'
    );
  }
}

export const scanner = domain('src/main/scanner.js');
export const storeMod = domain('src/main/store.js');
export const handoffs = domain('src/main/handoffs.js');
export const github = domain('src/main/github.js');
export const ai = domain('src/main/ai.js');
export const board = domain('src/main/board.js');
export const mcpTools = domain('src/mcp/tools.js');
export const actionProto = domain('src/mcp/protocol.js');
export const shared = domain('src/shared/constants.js');
export const aiTools = domain('src/shared/ai-tools.js');
export { repoRoot };
