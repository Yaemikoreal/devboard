// MCP 一键注册器（issue #149）：把 SignalBoard MCP server 写进已探测 CLI 的配置。
// 优先走各家原生 `mcp add` 子命令——各家配置格式（toml/json、路径、键名）持续变动，
// 让 CLI 自己写自己的配置最抗漂移；不支持原生命令的 CLI 如实报「暂不支持」，
// 绝不瞎写用户配置文件（写坏用户 CLI 配置是本 issue 最大风险面）。
// 零 Electron 依赖：execFile 经 deps 注入（测试喂假实现），注册目标/参数全部纯函数可测。
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { toolById } = require('../shared/ai-tools');

const SERVER_KEY = 'signalboard'; // 注册到各家 CLI 的 server 名（去重/移除的键）

// 构造注册命令（纯函数）：node <bin> --user-data <dir> [--app-exe <exe> [--app-cwd <dir>]]
// bin/server 路径与数据目录由调用方（主进程）解析；execFile 直跑不经 shell，路径含空格安全
function registerArgs(toolId, opts) {
  const t = toolById(toolId);
  if (!t || !t.mcp || t.mcp.add !== 'native') {
    return { supported: false, reason: '暂不支持一键注册（该 CLI 的 MCP 注册方式未核实），请按 README 手动配置' };
  }
  const o = opts || {};
  const bin = String(o.binPath || '');
  const userData = String(o.userDataDir || '');
  if (!bin || !userData) return { supported: false, reason: '缺少 server 脚本路径或数据目录' };
  // 用 node 而非 process.execPath：打包形态 execPath 是 SignalBoard.exe，Electron 直接带脚本
  // 参数会按应用启动（需 ELECTRON_RUN_AS_NODE 才是纯 Node，而该 env 无法经各家 mcp add 传进
  // CLI 自己拉起的子进程）；bin 脚本为纯 Node stdio 程序，node 在开发者 PATH 必有（README 同形式）
  const args = ['mcp', 'add', SERVER_KEY, '--', 'node', bin, '--user-data', userData];
  if (o.appExe) args.push('--app-exe', o.appExe);
  if (o.appCwd) args.push('--app-cwd', o.appCwd);
  return { supported: true, cmd: t.cmd, args, serverKey: SERVER_KEY };
}

// 构造移除命令（纯函数）：回滚方式（原生 `mcp remove <key>`）
function removeArgs(toolId) {
  const t = toolById(toolId);
  if (!t || !t.mcp || t.mcp.add !== 'native') return { supported: false, reason: '同注册' };
  return { supported: true, cmd: t.cmd, args: ['mcp', 'remove', SERVER_KEY], serverKey: SERVER_KEY };
}

// 执行注册（execFile 可注入）：返回逐 CLI 结果，失败信息含回滚方式。
// execFile 不经 shell，参数数组原样传递——注入用户可控字符串的注入面不存在
function registerMcp(toolId, opts, deps) {
  const spec = registerArgs(toolId, opts);
  if (!spec.supported) return Promise.resolve({ toolId, ok: false, reason: spec.reason });
  const run = (deps && deps.execFile) || execFile;
  return new Promise((resolve) => {
    run(spec.cmd, spec.args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          toolId,
          ok: false,
          reason: (err.message || String(err)) + (stderr ? '\n' + String(stderr).trim() : ''),
          rollback: removeArgs(toolId).supported ? `${spec.cmd} mcp remove ${SERVER_KEY}` : null,
        });
        return;
      }
      resolve({
        toolId,
        ok: true,
        detail: (String(stdout || '').trim() || '已注册'),
        rollback: `${spec.cmd} mcp remove ${SERVER_KEY}`,
      });
    });
  });
}

// 解析 server 侧文件路径（纯函数）：仓库 checkout / 打包 resources 两种形态
function serverScriptPath(appPath) {
  return path.join(appPath, 'bin', 'signalboard-mcp.js');
}

module.exports = { SERVER_KEY, registerArgs, removeArgs, registerMcp, serverScriptPath };
