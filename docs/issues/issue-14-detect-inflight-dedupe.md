# 【审查·AI·效率·中】探测/会话映射缓存只在落地后写，无 Promise 级在飞去重；codex 读文件绕过 fsSlot

- 级别：中 ｜ 轴：Standards ｜ 维度：效率
- 位置：`src/main/ipc.js:144-173`（detectAiTools）；`src/main/scanner.js:208-239`（kimiSessionMap）、`:247-303`（codexSessionMap，文件读在 :287-299）

## 问题

1. **detectAiTools 无在飞去重**：只有结果缓存没有 Promise 去重。启动时 `loadAiTools()`（app.js:3276）与 `loadAiCaps()`（app.js:3277）并发打到主进程，缓存均空 → 两轮完整 `where` 探测并行互拖，正中 issue #29 注释「启动负载期进程创建很慢」要避开的场景。
2. **会话映射缓存同样模式**：kimiSessionMap/codexSessionMap 均在函数末尾才写缓存，全量扫描时 N 个项目几乎同时到达 `aiSessionTraces`（scanner.js:313-315），映射被并发重复构建。
3. **codex 分支绕过并发闸门**：最多 400 个 rollout 文件的 open/read/stat（scanner.js:287-299）完全没过 fsSlot——#103 只罩住了 dirLatestMtime。

## 方案

- 三处缓存统一改为「缓存进行中的 Promise」：首个调用方挂 `cache.promise`，落地后再写结果值；并发调用方复用同一 Promise。
- codex 文件读统一走 fsSlot 获取槽位（与 dirLatestMtime 同闸门）。

## 验收

冷启动时 `where` 探测进程数 = 工具数 ×1 而非 ×2；全量扫描 29 项目时会话映射只构建一次；扫描期磁盘并发读不超过 fsSlot 上限。
