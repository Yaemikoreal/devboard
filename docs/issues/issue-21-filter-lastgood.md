# 【审查·AI·可用性·低】filter 通路不参与 #41 引擎记忆与拉黑

- 级别：低 ｜ 轴：Spec ｜ 规格出处：CONTEXT.md:72「记忆最近可用引擎优先使用（issue #41）」
- 位置：`src/main/ipc.js:564-570`（filter 成功/失败分支）

## 问题

filter 成功分支不写 `lastGoodEngine`（仅 weekly/advice 的 `cacheWrite` 写），`parseFilter` 失败也不入 `sessionBadEngines`——一个对 filter 稳定输出不可解析文本的引擎，每次 filter 调用仍被首选重试。「记忆最近可用」对该入口不成立。

## 方案

filter 成功时同样写 `lastGoodEngine`；`parseFilter` 失败视同引擎失败入 `sessionBadEngines`（与流式检测同级）。注意与 issue-16（filter 改单引擎短超时）的衔接：改后 lastGood 意义更大。

## 验收

引擎 A 对 filter 持续输出噪音、引擎 B 正常：第二次筛选直接打 B，不再先等 A 失败。
