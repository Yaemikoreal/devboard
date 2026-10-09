// 交接（Handoff）领域服务验证（issue #147）：写入/列表/接力标记/拼板并入（未读游标 + 活动时间 + 分带重算）。
// 不起 Electron：Store 用临时目录真落盘，拼板并入走纯函数 applyToProjects（快照入参）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const handoffs = require('../src/main/handoffs');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoffs-'));
  const store = new Store(dir);

  // --- 写入与列表（issue #147 领域对象最小结构）---
  const p1 = path.resolve('E:\\p\\alpha');
  const now = new Date();
  const e1 = handoffs.writeHandoff(store, p1, { agent: 'claude', text: '登录模块已重构，注意 settings 缓存键变了' });
  assert.strictEqual(e1.agent, 'claude', 'agent 名应按写入落盘');
  assert.ok(e1.id && e1.createdAt, '条目应有 id 与 createdAt');
  // 空文本拒写
  assert.throws(() => handoffs.writeHandoff(store, p1, { text: '  ' }), /交接内容为空/, '空正文应拒绝');
  // 超长截断
  const long = handoffs.writeHandoff(store, p1, { agent: 'a', text: 'x'.repeat(9000) });
  assert.strictEqual(long.text.length, handoffs.MAX_TEXT, '超长正文应截断');
  // agent 缺省
  const e3 = handoffs.writeHandoff(store, p1, { text: '默认署名' });
  assert.strictEqual(e3.agent, 'agent', 'agent 缺省应为 agent');
  // 列表：新条目在前；真落盘（换一个 Store 实例再读，验证 handoffs.json 持久化）
  const list1 = handoffs.listHandoffs(store, p1);
  assert.strictEqual(list1[0].id, e3.id, '列表应为新条目在前');
  const store2 = new Store(dir);
  assert.strictEqual(handoffs.listHandoffs(store2, p1).length, 3, '交接应真落盘 handoffs.json');
  // 未知项目返回空数组（#148 get_handoffs 首版口径）
  assert.deepStrictEqual(handoffs.listHandoffs(store, 'E:\\p\\none'), [], '无数据项目应返回空数组');

  // --- 接力标记：幂等 ---
  const done = handoffs.markDone(store, p1, e3.id);
  assert.ok(done.doneAt, '标记后应有 doneAt');
  const done2 = handoffs.markDone(store, p1, e3.id);
  assert.strictEqual(done2.doneAt, done.doneAt, '重复标记不得刷新 doneAt');
  assert.throws(() => handoffs.markDone(store, p1, 'nope'), /未找到/, '未知 id 应报错');

  // --- 拼板并入（applyToProjects 纯函数）---
  // 项目磁盘活动停留在 20 天前（渐冷带），交接写入时间更新 → lastActivityAt 计入 + 分带重算为活跃
  const proj = {
    path: 'E:\\p\\alpha', name: 'alpha', band: 'cooling',
    lastActivityAt: new Date(now.getTime() - 20 * 86400000).toISOString(),
  };
  const readAt = {}; // 无游标：全部未读
  handoffs.applyToProjects([proj], { handoffsAll: store.getHandoffs(), handoffReadAt: readAt }, now);
  assert.ok(proj.handoffs, '有交接的项目应并入 handoffs 摘要');
  assert.strictEqual(proj.handoffs.unreadCount, 2, '未完成且无游标的条目应计未读（2 条，已接力 1 条不计）');
  assert.strictEqual(proj.handoffs.latest.id, e3.id, 'latest 应为最新条目（id 随摘要透出，供接力标记）');
  assert.strictEqual(proj.band, 'hot', '交接写入时间应把 20 天前的渐冷项目拉回活跃（hot）带');
  assert.strictEqual(Date.parse(proj.lastActivityAt), Date.parse(e3.createdAt), 'lastActivityAt 应计入交接时间');

  // 已读游标推进 → 未读清零；旧交接（早于游标）不再计未读
  readAt[p1] = e3.createdAt;
  const proj2 = { path: p1, name: 'alpha', band: 'cold', lastActivityAt: proj.lastActivityAt };
  handoffs.applyToProjects([proj2], { handoffsAll: store.getHandoffs(), handoffReadAt: readAt }, now);
  assert.strictEqual(proj2.handoffs.unreadCount, 0, '游标之后无新交接时未读应为 0');
  assert.ok(proj2.handoffs.latest.doneAt, 'latest 的已接力态应透出');

  // 游标之后新写一条 → 未读 +1（未读 = createdAt > 游标）
  const e4 = handoffs.writeHandoff(store, p1, { agent: 'kimi', text: '补一条：建议先跑回归再合' });
  const proj3 = { path: p1, name: 'alpha', band: 'active', lastActivityAt: proj.lastActivityAt };
  handoffs.applyToProjects([proj3], { handoffsAll: store.getHandoffs(), handoffReadAt: readAt }, now);
  assert.strictEqual(proj3.handoffs.unreadCount, 1, '游标后的新交接应计 1 条未读');
  assert.strictEqual(proj3.handoffs.latest.id, e4.id, 'latest 应随新写入更新');

  // 交接早于现有活动时间：不改写 lastActivityAt / 分带（避免回拨）
  const oldProj = { path: 'E:\\p\\old', name: 'old', band: 'hot', lastActivityAt: now.toISOString() };
  handoffs.writeHandoff(store, 'E:\\p\\old', { agent: 'a', text: '旧时间交接' });
  const allOld = store.getHandoffs();
  allOld[path.resolve('E:\\p\\old')][0].createdAt = new Date(now.getTime() - 30 * 86400000).toISOString();
  store.setHandoffs(allOld);
  handoffs.applyToProjects([oldProj], { handoffsAll: store.getHandoffs(), handoffReadAt: {} }, now);
  assert.strictEqual(oldProj.band, 'hot', '交接早于现有活动时不得回拨分带');
  assert.strictEqual(Date.parse(oldProj.lastActivityAt), Date.parse(now.toISOString()), 'lastActivityAt 不得被旧交接回拨');

  // 每项目条目上限（防 MCP 洪泛）
  for (let i = 0; i < handoffs.MAX_PER_PROJECT + 5; i++) {
    handoffs.writeHandoff(store, 'E:\\p\\flood', { agent: 'a', text: 't' + i });
  }
  assert.strictEqual(handoffs.listHandoffs(store, 'E:\\p\\flood').length, handoffs.MAX_PER_PROJECT,
    '每项目条目数应封顶');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('test-handoffs: 全部断言通过');
}

main().catch((err) => {
  console.error('test-handoffs 失败:', (err && err.stack) || err);
  process.exit(1);
});
