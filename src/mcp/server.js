// SignalBoard MCP server（issue #148，部署形态甲）：独立 stdio 进程，agent CLI 拉起，
// 直接读 userData 下 JSON 缓存（scan-cache / memos / handoffs）。Electron 不在跑也能答，
// 新鲜度 = scannedAt（响应携带数据龄）；无端口占用、无 Electron 生命周期纠缠。
// 协议：JSON-RPC 2.0 over stdio，消息为换行分隔的 JSON（每行一条，行内不得有换行）。
// 协议版本冻结 2024-11-05（已知稳定 spec）——升级须手动评估，不自动跟随。
// 有意不引 @modelcontextprotocol/sdk：本仓运行时依赖为零（CONTEXT.md 边界），stdio 协议面很小，手写可控。
//
// userData 缺失守卫：目录不存在时报错退出并指路应用先跑一次扫描——绝不静默建空目录假装有数据
// （Store 构造函数会 mkdirSync，纯读进程不能踩这层）。
'use strict';

const fs = require('fs');
const path = require('path');
const { Store, DEFAULT_CONFIG } = require('../main/store');
const tools = require('./tools');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'signalboard';
// 与 package.json 同源：bin 入口在仓库内，直接读包描述文件
const SERVER_VERSION = require('../../package.json').version || '0.0.0';

// 解析 userData 目录：默认与 Electron app.getPath('userData') 按 productName 一致
// （Windows: %APPDATA%\SignalBoard；macOS: ~/Library/Application Support/SignalBoard；
// Linux: ~/.config/SignalBoard），--user-data <dir> 可覆盖
function resolveUserDataDir(argv) {
  const flagIdx = argv.indexOf('--user-data');
  if (flagIdx >= 0) {
    const dir = argv[flagIdx + 1];
    if (!dir) throw new Error('--user-data 需要一个目录参数');
    return path.resolve(dir);
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'SignalBoard');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SignalBoard');
  return path.join(home, '.config', 'SignalBoard');
}

function start({ argv, stdin, stdout, stderr }) {
  let userDataDir;
  try {
    userDataDir = resolveUserDataDir(argv || []);
  } catch (err) {
    fail(stderr, err.message);
    return;
  }
  if (!fs.existsSync(userDataDir)) {
    fail(stderr, 'SignalBoard 数据目录不存在：' + userDataDir + '\n请先运行一次 SignalBoard 应用并完成扫描，或用 --user-data <目录> 指向现有数据目录。');
    return;
  }

  const store = new Store(userDataDir);
  const config = store.getConfig() || DEFAULT_CONFIG;

  // 逐工具调用：入参快照在每次调用时现取（进程常驻期间数据文件可能被应用更新）
  const snapshot = () => ({ store, config, now: new Date() });

  function handleRequest(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: tools.TOOL_DEFS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        let data;
        try {
          data = tools.callTool(snapshot(), name, args);
        } catch (err) {
          // 工具级失败（项目不存在/未知工具等）：isError 结构化返回，连接不断
          return {
            content: [{ type: 'text', text: (err && err.message) || String(err) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        };
      }
      default:
        return undefined; // 未知方法 → -32601（带 id 的请求才回错）
    }
  }

  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      respond(line);
    }
  });
  stdin.on('end', () => process.exit(0));

  function respond(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + err.message } });
      return;
    }
    if (!msg || typeof msg !== 'object') {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return; // 通知（如 notifications/initialized）不回包
    let result;
    try {
      result = handleRequest(msg);
    } catch (err) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error: ' + ((err && err.message) || err) } });
      return;
    }
    if (result === undefined) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      return;
    }
    write({ jsonrpc: '2.0', id: msg.id, result });
  }

  function write(obj) {
    stdout.write(JSON.stringify(obj) + '\n');
  }
}

function fail(stderr, message) {
  stderr.write('[signalboard-mcp] ' + message + '\n');
  process.exit(1);
}

module.exports = { start, resolveUserDataDir, PROTOCOL_VERSION };

// 直接执行（bin 入口）时启动；被测试 require 时不启动
if (require.main === module) {
  start({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}
