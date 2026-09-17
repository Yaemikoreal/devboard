# 【审查·AI·结果·低】kimi 会话痕迹超 40 个会话时可能漏掉最新（#35 取较新者失真）

- 级别：低 ｜ 轴：Spec ｜ 规格出处：CONTEXT.md:15-16「最近会话时间…取较新者（issue #35）」
- 位置：`src/main/scanner.js:226`（`sessions.slice(0, 40)`）

## 问题

kimi 会话映射在读 `state.json` 前 `slice(0, 40)` 截断；本机实测 kimi 会话目录命名为 `session_<uuid>`（非时间序），`readdir` 字母序对时间无意义——截断的是任意子集而非最新 40 个。单项目 kimi 会话超过 40 个后，最新会话可能根本没被读到，`updatedAt` max 失真，痕迹时间停在旧值。

## 方案

截断前先按目录 mtime 排序取最新 40 个（一次 stat 目录即可，仍在 fsSlot 闸门内），或干脆按 mtime 倒序短路——找到足够新的即停。

## 验收

构造 50 个 kimi 会话目录、最新一个字母序在最后：探测结果反映最新会话时间。
