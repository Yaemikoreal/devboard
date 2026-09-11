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

  // --- 提示词模板自定义（issue #78）---
  const customWeekly = ai.buildWeeklyPrompt(PROJECTS, NOW, '自定义角色与语气\n{{事实}}\n自定义输出结构');
  assert.ok(customWeekly.includes('自定义角色与语气') && customWeekly.includes('自定义输出结构'), '自定义周报模板应生效');
  assert.ok(customWeekly.includes('- alpha'), '自定义模板应在 {{事实}} 处注入事实块');
  assert.ok(!customWeekly.includes('本周总览：'), '自定义模板不含默认结构词');
  const noSlot = ai.buildAdvicePrompt(PROJECTS[0], NOW, '没有插入点的模板');
  assert.ok(noSlot.includes('没有插入点的模板') && noSlot.includes('18 个文件'), '缺失插入点时事实块应附加末尾');
  const blankTpl = ai.buildWeeklyPrompt(PROJECTS, NOW, '   ');
  assert.ok(blankTpl.includes('本周总览：') && blankTpl.includes('- alpha'), '空白模板应回落内置默认');
  assert.ok(ai.DEFAULT_WEEKLY_TEMPLATE.includes(ai.FACTS_SLOT) && ai.DEFAULT_ADVICE_TEMPLATE.includes(ai.FACTS_SLOT), '默认模板应含 {{事实}} 插入点');
  // 默认路径（不传模板）与显式默认模板产物一致：缓存键按模板内容哈希，两者同源
  assert.strictEqual(ai.buildWeeklyPrompt(PROJECTS, NOW), ai.buildWeeklyPrompt(PROJECTS, NOW, ai.DEFAULT_WEEKLY_TEMPLATE), '缺省模板应与显式默认模板一致');

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

  // --- 引擎错误特征识别（issue #41）---
  assert.ok(ai.engineErrorLine('API Error: Request rejected (429) · 用量上限'), '应识别 API Error/429');
  assert.ok(ai.engineErrorLine('Error: 401 unauthorized'), '应识别 401');
  assert.strictEqual(ai.engineErrorLine('- 建议先提交代码\n- 尽快 push'), '', '正常建议文本不应误判');

  // --- runCli：引擎报错后进程挂起 → 流式命中即快速失败（claude 429 实测场景）---
  const tFast = Date.now();
  r = await ai.runCli(process.execPath, 'x', {
    spec: { args: ['-e', 'console.log("API Error: Request rejected (429)"); setTimeout(()=>{},60000)'], stdin: false, shell: false },
    timeout: 30000,
  });
  assert.ok(!r.ok && r.reason.includes('429'), '引擎报错应快速失败并带原因，实际: ' + JSON.stringify(r));
  assert.ok(Date.now() - tFast < 10000, '引擎报错应立即终止进程，不应等到超时');

  // --- runCli：exit 0 但 stdout 是引擎错误 → 不能误判成功 ---
  r = await ai.runCli(process.execPath, 'x', {
    spec: { args: ['-e', 'console.log("Error: 401 unauthorized")'], stdin: false, shell: false },
    timeout: 10000,
  });
  assert.ok(!r.ok && r.reason.includes('401'), 'exit 0 的引擎错误输出应判失败，实际: ' + JSON.stringify(r));

  // --- runCli：超时但已有有效输出 → 采用部分输出（进程输出完毕却不退出的兜底）---
  r = await ai.runCli(process.execPath, 'x', {
    spec: { args: ['-e', 'console.log("- 已产出的建议内容"); setTimeout(()=>{},60000)'], stdin: false, shell: false },
    timeout: 500,
  });
  assert.ok(r.ok && r.text.includes('已产出的建议内容'), '超时应采用已产出的部分输出，实际: ' + JSON.stringify(r));

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
