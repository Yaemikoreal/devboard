// 意图路由模板验证（issue #142）：三类警示固定模板——事实插入、pr 的 gh 降级、未知类型、
// 边界（模板只吃统计事实，不存在代码内容字段）。
'use strict';

const assert = require('assert');
const templates = require('../src/shared/intent-templates');

async function main() {
  // 三类警示（dirty/ahead/pr）有模板；ci/review 无模板返回 null（渲染层据此不挂执行键）
  assert.strictEqual(templates.warningTemplate('dirty').buildPrompt({ branch: 'main', dirtyCount: 18, dirtyDays: 3 }).includes('18'), true, 'dirty 模板应插入未提交数');
  assert.ok(templates.warningTemplate('ahead').buildPrompt({ branch: 'dev', ahead: 3 }).includes('3 个提交'), 'ahead 模板应插入领先数');
  assert.strictEqual(templates.warningTemplate('ci'), null, 'ci 无模板');
  assert.strictEqual(templates.warningTemplate('review'), null, 'review 无模板');
  assert.strictEqual(templates.warningTemplate('不存在'), null, '未知类型应返回 null');

  // pr 模板双版本：gh 在 → 引导用 gh CLI；gh 不在 → 降级通用网页表述
  const prWithGh = templates.warningTemplate('pr').buildPrompt({ prNumber: 7, prTitle: '登录重构', ghAvailable: true });
  assert.ok(prWithGh.includes('#7') && prWithGh.includes('登录重构'), 'pr 模板应插入 PR 号与标题');
  assert.ok(prWithGh.includes('gh CLI'), 'gh 在场应引导用 gh CLI');
  const prNoGh = templates.warningTemplate('pr').buildPrompt({ prNumber: 7, ghAvailable: false });
  assert.ok(prNoGh.includes('未安装 gh CLI'), 'gh 缺失应降级为通用表述');
  assert.ok(!prNoGh.includes('gh pr view'), '降级版不应引导 gh 命令');

  // 边界（ADR-0004）：模板不接收代码内容——buildPrompt 只消费统计事实字段
  const d = templates.warningTemplate('dirty').buildPrompt({ branch: 'main', dirtyCount: 1, code: 'secret-code' });
  assert.ok(!d.includes('secret-code'), '模板不得输出未定义的代码内容字段');
  // 事实缺省不炸：全空事实也能组装
  assert.ok(templates.warningTemplate('dirty').buildPrompt({}).includes('0 个文件'), '空事实应按 0 组装');
  // 模板为纯数据模块：除 buildPrompt 外不依赖任何注入
  assert.ok(typeof templates.WARNING_TEMPLATES.dirty.buildPrompt === 'function', '模板应以 buildPrompt 暴露');

  console.log('test-intent: 全部断言通过');
}

main().catch((err) => {
  console.error('test-intent 失败:', (err && err.stack) || err);
  process.exit(1);
});
