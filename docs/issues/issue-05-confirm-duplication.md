# 【审查·重复·中】「再点一次确认」两份实现，ghDisconnectBtn 未复用 armConfirm

- 级别：中 ｜ 轴：Standards ｜ 异味：Duplicated Code
- 位置：`src/renderer/app.js:2971-2991` vs `:3065-3078`

## 问题

「再点一次确认」模式有两份实现：ghDisconnectBtn 手写 `dataset.confirm` 武装逻辑；`armConfirm` 已提取同款通用实现（注释自承「沿用断开连接」）却只有重置按钮在用。两份逻辑平行演化，后续改确认时长/文案需改两处。

## 方案

ghDisconnectBtn 改用 `armConfirm`，删除手写武装逻辑；确认文案与超时参数如有差异，收敛为 `armConfirm` 的参数。

## 验收

断开 GitHub 连接仍为两段确认，行为与改前一致；代码中只剩一处确认模式实现。
