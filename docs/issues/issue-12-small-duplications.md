# 【审查·重复·低】小重复形状清扫合集

- 级别：低 ｜ 轴：Standards ｜ 异味：Duplicated Code / Middle Man / Speculative Generality / Mysterious Name / Data Clumps

一组低危同构重复，建议一次清扫 PR 打包处理，逐条独立可验。

## 清单

1. **AI kind 分派两套**（Repeated Switches）——`src/main/ipc.js:509-553` vs `:607-619`：doAiAsk 与 ai:promptPreview 按 kind（weekly/advice/filter）各写一套 if 级联，weekly/advice 的缓存命中+写回形状近乎重复。→ 按 kind 注册处理器表，两处共享。
2. **分段控件（seg）模式重复 5 次**——`src/renderer/app.js:2133-2245`：scanInterval/warnDirtyDays/notifyMode/density/landing 各一套 render* + *Value + click→scheduleSave。→ 提取通用 `bindSeg(el, key, onChange)`。
3. **并发槽同形两份**——`src/main/scanner.js:25-56` vs `:61-86`：git/fs 两个并发槽逐行平行。→ 提取 `makeSlot(limit)`。
4. **GitHub 请求头写两遍**——`src/main/github.js:42-47` vs `:174-179`：Authorization/Accept/User-Agent/X-GitHub-Api-Version 头块重复。→ 提取 headers 工厂。
5. **Middle Man 两处**——`src/main/ipc.js:176-179` `resolveEngine` 仅转发 `resolveEngines` 取 [0]（单调用点 ipc.js:481）；`src/main/scanner.js:241-243` `kimiSessionAt` 仅转发 `kimiSessionMap` 查一个 key（单调用点 scanner.js:314）。→ 内联到调用点。
6. **无消费者导出**（Speculative Generality）——`src/main/watcher.js:88`（resolveGitdir/DEBOUNCE_MS/COOLDOWN_MS/MAX_WATCHED）、`src/main/scanner.js:607`（bandOf/emptyProject），全仓无消费（头注释称「可单测」但无对应测试）。→ 收窄导出面，或补上真实消费方/测试。
7. **Mysterious Name**——`src/main/scanner.js:163-190` `dirLatestMtime(dir, budget)` 的 `budget` 实为「剩余可遍历条目数」计数器。→ 改名 `remaining`/`entriesLeft`。
8. **Data Clumps**——`(roots, blacklist, extraPaths)` 三参永远一起出现（scanner.js:99,559；ipc.js:758-770；app.js:2825-2826 改动域检测的 JSON.stringify 三数组）。→ 捆成 `scanScope` 对象传递。

## 验收

逐条改完跑 `node --check` + `npm run test:scan` + `DEVBOARD_MOCK=1 npm run shot`；行为零变化（纯重构）。
