# 【审查·结构·中】新增一个 AI 工具需改 5 处，缺单一工具注册表

- 级别：中 ｜ 轴：Standards ｜ 异味：Shotgun Surgery
- 位置：`src/main/ipc.js:110-139`（默认清单+图标表）、`src/main/ai.js:34-41`（TOOL_SPECS）、`src/main/scanner.js:18,197-322`（会话探测位与三个探测函数）、`src/renderer/app.js:11,2463`（label 表+图标选项）

## 问题

每接入一个新 AI 工具（如当年的 grok），需要在 4 个文件 5 处平行添加：主进程默认工具清单与图标表、引擎 TOOL_SPECS、scanner 的会话探测位与探测函数、渲染层 label 表与设置页图标选项。漏任一处表现为：能启动但无会话痕迹，或有痕迹但设置页无图标。

## 方案

合并为单一工具注册表（如 `src/main/ai-tools.js`）：

```
id → { label, cmd, args, spec（ai 引擎参数）, icon, sessionProbe（会话探测函数） }
```

- ipc.js 默认清单/图标表、ai.js TOOL_SPECS、app.js label/图标选项全部从注册表派生（渲染层经 preload 或 IPC 获取）。
- scanner.js 的探测函数改为注册表驱动遍历，新工具只需在注册表加一行+一个探测函数。

## 验收

用一个假工具 id 走通全链路（探测→设置页可选→可启动→会话痕迹展出），新增改动集中在注册表一处。
