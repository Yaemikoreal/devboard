# 【审查·AI·测试·低】test-ai.js 覆盖缺口：超限裁决 / 空兜底 / 杀树 / 残段复检 / 引擎链

- 级别：低 ｜ 轴：Standards ｜ 维度：稳定性（测试防线）
- 位置：`scripts/test-ai.js`

## 问题

现有断言全过（本轮实测），但以下关键路径无覆盖：

- `STREAM_CAP` 超限 kill 后的裁决分支（ai.js:153-160，「按已有输出裁决」）；
- streamJson 全文无 assistant 行的空正文兜底（见 issue-23 第 1 条）；
- `shell:true` 的 taskkill 路径（win32 分支）；
- close 时对残段的全量复检（增量游标之外的尾部）；
- ipc 侧引擎链回退、`sessionBadEngines` 拉黑、缓存键命中/失效——完全无测试。

## 方案

- 以假 child（`node -e` 脚本模拟 stdout/stderr/退出码）补超限与残段用例；
- 引擎链逻辑抽成可注入 runCli 的纯函数后单测回退顺序与拉黑行为；
- #115 落地时同步补其三断言（防误杀/防吃 `[1m]`/末行取因，见 issue-01）。

## 验收

`node scripts/test-ai.js` 覆盖上述分支；人为注入超限流与空 streamJson 流时断言如期失败（红绿验证）。
