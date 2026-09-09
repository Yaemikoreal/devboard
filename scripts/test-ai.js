// ai.js 单元验证（issue #29）：prompt 组装 / 输出解析 / runCli 成功、超时、失败、stdin、stream-json 路径。
// 不起 Electron；--real 时追加一次真实 kimi 调用冒烟。
'use strict';

const assert = require('assert');
const ai = require('../src/main/ai');

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

  // --- cleanOutput ---
  const streamJson = [
    '{"role":"meta","type":"system.version"}',
    'Warning: something',
    '{"role":"assistant","content":"第一行\\n第二行"}',
    '{"role":"meta","type":"session.resume_hint"}',
  ].join('\n');
  assert.strictEqual(
    ai.cleanOutput(streamJson, { streamJson: true }),
    '第一行\n第二行',
    'stream-json 应只取 assistant 正文'
  );
  assert.strictEqual(
    ai.cleanOutput('结果\nTo resume this session: kimi -r xxx', {}),
    '结果',
    '文本模式应去掉会话恢复尾行'
  );

  // --- runCli：成功（参数模式，node 回显 argv）---
  const echoArgv = 'process.stdout.write(process.argv.slice(1).join("|"))';
  let r = await ai.runCli(process.execPath, '你好', {
    spec: { args: ['-e', echoArgv], stdin: false, shell: false },
  });
  assert.ok(r.ok && r.text.includes('你好'), '参数模式应把 prompt 传给子进程，实际: ' + JSON.stringify(r));

  // --- runCli：成功（stdin 模式）---
  r = await ai.runCli(process.execPath, 'stdin 测试', {
    spec: { args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: true, shell: false },
  });
  assert.ok(r.ok && r.text.includes('stdin 测试'), 'stdin 模式应回显 prompt，实际: ' + JSON.stringify(r));

  // --- runCli：超时降级 ---
  const t0 = Date.now();
  r = await ai.runCli(process.execPath, 'x', {
    spec: { args: ['-e', 'setTimeout(()=>{},60000)'], stdin: true, shell: false },
    timeout: 500,
  });
  assert.ok(!r.ok && r.reason.includes('超时'), '超时应降级为 ok:false，实际: ' + JSON.stringify(r));
  assert.ok(Date.now() - t0 < 5000, '超时后应 kill 子进程而非挂起');

  // --- runCli：命令不存在降级 ---
  r = await ai.runCli('definitely-not-a-cmd-xyz', 'x', { timeout: 5000 });
  assert.ok(!r.ok && r.reason, '不存在的命令应降级为 ok:false，实际: ' + JSON.stringify(r));

  console.log('test-ai: 全部断言通过');

  // --- --real：真实 kimi 冒烟（本机已装已登录时）---
  if (process.argv.includes('--real')) {
    console.log('test-ai: 真实调用 kimi -p …');
    const rr = await ai.runCli('kimi', ai.buildFilterPrompt('上周动过的 python 项目'), { toolId: 'kimi' });
    console.log('  ok=%s text=%j reason=%s', rr.ok, rr.text, rr.reason);
    assert.ok(rr.ok, '真实 kimi 调用应成功');
    assert.ok(ai.parseFilter(rr.text), '真实输出应可解析为筛选条件');
    console.log('test-ai: 真实调用通过');
  }
}

main().catch((err) => {
  console.error('test-ai 失败:', err);
  process.exit(1);
});
