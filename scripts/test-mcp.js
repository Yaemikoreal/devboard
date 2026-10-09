// MCP server 验证（issue #148）：起独立 stdio 子进程，走真实协议面——
// initialize 握手 / notifications/initialized / tools/list / tools/call 五工具 / ping / 未知方法 /
// Parse error / userData 缺失守卫。零依赖（child_process + assert）。
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'signalboard-mcp.js');
const NOW = Date.now();
const DAY = 86400000;

function makeUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-'));
  const scannedAt = new Date(NOW - 5 * 60 * 1000).toISOString();
  const projDirty = {
    path: 'E:\\p\\alpha', name: 'alpha', branch: 'main', commits7d: 3,
    recentCommits: [{ msg: 'x', rel: '1 天前' }],
    dirtyCount: 18, dirtyAt: new Date(NOW - 9 * DAY).toISOString(),
    ahead: 2, behind: 0,
    lastCommitAt: new Date(NOW - 9 * DAY).toISOString(), // 9 天前 → dirty 警示（默认 3 天）
    aiSessionAt: null, lastActivityAt: new Date(NOW - 9 * DAY).toISOString(),
    headSha: 'abc', band: 'cooling', originUrl: 'https://github.com/me/alpha.git',
  };
  const projClean = {
    path: 'E:\\p\\beta', name: 'beta', branch: 'dev', commits7d: 0,
    recentCommits: [], dirtyCount: 0, dirtyAt: null, ahead: 0, behind: 0,
    lastCommitAt: new Date(NOW - DAY).toISOString(),
    aiSessionAt: null, lastActivityAt: new Date(NOW - DAY).toISOString(),
    headSha: 'def', band: 'active', originUrl: 'https://github.com/me/beta.git',
  };
  fs.writeFileSync(path.join(dir, 'scan-cache.json'), JSON.stringify({ scannedAt, projects: { 'E:\\p\\alpha': projDirty, 'E:\\p\\beta': projClean } }));
  fs.writeFileSync(path.join(dir, 'memos.json'), JSON.stringify({ 'E:\\p\\alpha': '登录模块待回归' }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), JSON.stringify({
    'E:\\p\\alpha': [{ id: 'h1', agent: 'claude', text: '已完成登录重构', createdAt: new Date(NOW - 3600000).toISOString(), doneAt: null }],
  }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}));
  return { dir, scannedAt, projDirty, projClean };
}

// 行协议客户端：spawn 子进程，按行收响应（带超时）
function startServer(userDataDir) {
  const child = spawn(process.execPath, [BIN, '--user-data', userDataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let buf = '';
  let stderrBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const resolver = pending.shift();
      if (resolver) resolver(JSON.parse(line));
    }
  });
  child.stderr.on('data', (c) => { stderrBuf += c; });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.push(resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  const waitExit = () => new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr: stderrBuf })));
  return { child, call, notify, waitExit, kill: () => child.kill() };
}

async function main() {
  const { dir, scannedAt, projDirty } = makeUserData();

  // --- 正常数据目录：全协议链路 ---
  const server = startServer(dir);
  const init = await server.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.strictEqual(init.result.protocolVersion, '2024-11-05', '协议版本应冻结为 2024-11-05');
  assert.strictEqual(init.result.serverInfo.name, 'signalboard', 'serverInfo.name 应为 signalboard');
  assert.ok(init.result.capabilities && init.result.capabilities.tools, '应声明 tools 能力');
  server.notify('notifications/initialized'); // 通知不回包——不 await，直接继续

  // tools/list：首版五个只读工具
  const list = await server.call('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names, ['list_projects', 'get_project', 'get_attention', 'get_memos', 'get_handoffs'],
    '工具面应恰为五个只读工具（白名单即边界）');
  for (const t of list.result.tools) {
    assert.ok(t.description && t.inputSchema, '每个工具应有 description 与 inputSchema: ' + t.name);
  }

  // list_projects：警示响应侧重算（alpha 9 天前有 18 个脏文件 → dirty 警示按当前规则算出）
  const lp = await server.call('tools/call', { name: 'list_projects', arguments: {} });
  assert.strictEqual(lp.result.isError, false, 'list_projects 不应报错');
  const lpData = JSON.parse(lp.result.content[0].text);
  assert.strictEqual(lpData.count, 2, '应列出两个项目');
  const lpAlpha = lpData.projects.find((p) => p.name === 'alpha');
  assert.ok(lpAlpha.warnings.some((w) => w.type === 'dirty'), '警示应按当前规则响应侧重算（不读缓存旧值）');
  assert.strictEqual(lpData.scannedAt, scannedAt, '响应应携带 scannedAt');
  assert.ok(typeof lpData.dataAgeMs === 'number' && lpData.dataAgeMs >= 0, '响应应携带数据龄');

  // get_project：全量信号 + 备忘 + 交接摘要；凭据类字段不得出现
  const gp = await server.call('tools/call', { name: 'get_project', arguments: { path: projDirty.path } });
  const gpData = JSON.parse(gp.result.content[0].text);
  assert.strictEqual(gpData.project.name, 'alpha');
  assert.strictEqual(gpData.project.dirtyCount, 18, '近况信号应含未提交数');
  assert.strictEqual(gpData.project.memo, '登录模块待回归', '备忘应可读');
  assert.strictEqual(gpData.project.handoffs.total, 1, '交接摘要应有条目');
  assert.strictEqual(gpData.project.handoffs.latest.agent, 'claude', '交接 latest 应为最新条目');
  assert.ok(!JSON.stringify(gpData).includes('githubToken'), '响应不得含 token 字段');
  assert.ok(!JSON.stringify(gpData).includes('originUrl'), 'originUrl 属内部解析字段，不下发');

  // get_project：未知路径 → 结构化失败
  const gpMiss = await server.call('tools/call', { name: 'get_project', arguments: { path: 'E:\\p\\none' } });
  assert.strictEqual(gpMiss.result.isError, true, '未知项目应 isError');
  assert.ok(gpMiss.result.content[0].text.includes('不在扫描缓存'), '错误信息应可行动');

  // get_attention：只有 alpha 有警示（dirty 9 天 + ahead 2 提交）；排序口径（单元素不验序，验形状与计数）
  const ga = await server.call('tools/call', { name: 'get_attention', arguments: {} });
  const gaData = JSON.parse(ga.result.content[0].text);
  assert.strictEqual(gaData.attentionCount, 1, '只有 alpha 有警示');
  assert.strictEqual(gaData.attention[0].name, 'alpha');
  assert.deepStrictEqual(gaData.attention[0].types, ['dirty', 'ahead'], '警示类型应随响应下发（dirty + ahead）');

  // get_memos：全部 + 单项目
  const gmAll = JSON.parse((await server.call('tools/call', { name: 'get_memos', arguments: {} })).result.content[0].text);
  assert.strictEqual(gmAll.memos['E:\\p\\alpha'], '登录模块待回归', '全量备忘应可读');
  const gmOne = JSON.parse((await server.call('tools/call', { name: 'get_memos', arguments: { path: 'E:\\p\\beta' } })).result.content[0].text);
  assert.strictEqual(gmOne.memo, '', '无备忘项目返回空串');
  assert.strictEqual(gmOne.exists, false, 'exists 标记备忘缺失');

  // get_handoffs：单项目（新在前）+ 全量
  const ghOne = JSON.parse((await server.call('tools/call', { name: 'get_handoffs', arguments: { path: 'E:\\p\\alpha' } })).result.content[0].text);
  assert.strictEqual(ghOne.handoffs.length, 1, 'alpha 应有一条交接');
  assert.strictEqual(ghOne.handoffs[0].text, '已完成登录重构', '交接正文应可读');
  const ghAll = JSON.parse((await server.call('tools/call', { name: 'get_handoffs', arguments: {} })).result.content[0].text);
  assert.ok(ghAll.handoffs['E:\\p\\alpha'], '全量交接应按 path 键控');

  // ping + 未知方法
  const ping = await server.call('ping', {});
  assert.deepStrictEqual(ping.result, {}, 'ping 应返回空结果');
  const unknown = await server.call('no/such/method', {});
  assert.strictEqual(unknown.error.code, -32601, '未知方法应 -32601');

  // Parse error：坏行 → id 为 null 的 -32700，且连接继续服务后续正常请求
  {
    let buf3 = '';
    let resolveGot;
    const gotPromise = new Promise((r) => { resolveGot = r; });
    const onData = (c) => {
      buf3 += c;
      let nl;
      while ((nl = buf3.indexOf('\n')) >= 0) {
        const line = buf3.slice(0, nl).trim();
        buf3 = buf3.slice(nl + 1);
        if (line) got.push(JSON.parse(line));
        if (got.length >= 2) {
          server.child.stdout.removeListener('data', onData);
          resolveGot(got);
        }
      }
    };
    const got = [];
    server.child.stdout.on('data', onData);
    server.child.stdin.write('this is not json\n');
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'ping', params: {} }) + '\n');
    const [pe, pk] = await gotPromise;
    assert.strictEqual(pe.error.code, -32700, '坏行应回 -32700 Parse error');
    assert.strictEqual(pe.id, null, 'Parse error 响应的 id 应为 null');
    assert.strictEqual(pk.id, 999, '坏行之后连接应继续服务正常请求');
    assert.deepStrictEqual(pk.result, {}, 'ping 应正常返回');
  }

  server.child.kill();

  // --- userData 缺失守卫：报错退出，不静默建目录 ---
  const missing = path.join(os.tmpdir(), 'dsh-mcp-missing-' + Date.now());
  const bad = spawn(process.execPath, [BIN, '--user-data', missing], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exitInfo = await new Promise((resolve) => {
    let errTxt = '';
    bad.stderr.on('data', (c) => { errTxt += c; });
    bad.on('exit', (code) => resolve({ code, errTxt }));
  });
  assert.strictEqual(exitInfo.code, 1, '数据目录缺失应非零退出');
  assert.ok(exitInfo.errTxt.includes('数据目录不存在'), '退出信息应指路先跑一次扫描');
  assert.ok(!fs.existsSync(missing), '守卫不得静默建目录');

  // --- --user-data 缺参 ---
  const bad2 = spawn(process.execPath, [BIN, '--user-data'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit2 = await new Promise((resolve) => {
    let errTxt = '';
    bad2.stderr.on('data', (c) => { errTxt += c; });
    bad2.on('exit', (code) => resolve({ code, errTxt }));
  });
  assert.strictEqual(exit2.code, 1, '--user-data 缺参应非零退出');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('test-mcp: 全部断言通过');
}

main().catch((err) => {
  console.error('test-mcp 失败:', (err && err.stack) || err);
  process.exit(1);
});
