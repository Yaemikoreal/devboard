#!/usr/bin/env node
// SignalBoard MCP server 入口（issue #148）：`node bin/signalboard-mcp.js [--user-data <dir>]`。
// 协议与工具面见 src/mcp/server.js / src/mcp/tools.js。
'use strict';

require('../src/mcp/server.js').start({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
