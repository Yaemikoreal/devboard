# 【审查·AI·稳定性·中】startAiJob 的 finally 无条件 delete，迟到 resolve 误删新任务

- 级别：中 ｜ 轴：Standards ｜ 维度：稳定性
- 位置：`src/renderer/app.js:838-843`

## 问题

`startAiJob` 的 `.finally` 无条件 `delete state.aiJobs[key]`。#114 修复引入「读时即清」后存在竞态：死任务被清 → 同 key 新任务已发起在飞 → 死任务的 Promise 迟到 resolve/reject，其 finally 把新任务的 `state.aiJobs[key]` 一并删掉——新任务丢「生成中」态、在飞去重保护失效，可能并发发起第三次。

## 方案

删除前比对任务身份：`if (state.aiJobs[key] === job) delete state.aiJobs[key]`（job 为 startAiJob 创建的任务对象引用）。

## 验收

构造：key=A 任务挂起 → 等待超 10 分钟被 liveAiJob 清掉 → 重新发起 key=A 新任务 → 让旧 Promise resolve；新任务的「生成中」态与去重不受影响。
