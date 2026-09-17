# 【审查·结构·中】ipc.js(883 行)/app.js(3280 行) Divergent Change，按域拆分

- 级别：中 ｜ 轴：Standards ｜ 异味：Divergent Change
- 位置：`src/main/ipc.js`、`src/renderer/app.js`

## 问题

`ipc.js` 同时承担拼板/watcher 调度/AI 调度/GitHub 鉴权/设置白名单/数据导出导入/窗口控制七类职责；`app.js` 承担全部渲染域（总览/主面板/详情/设置/主题/AI/搜索/拖拽）。任一域的改动都落在同一文件，评审与回归半径大，#93–#112 修复期已多次出现同文件多域交错修改。

## 方案

渐进拆分，不追求一步到位：

- 主进程：先拆 `ipc-ai.js`（doAiAsk/promptPreview/引擎链）与 `ipc-github.js`（importGh/deviceFlow/disconnect），拼板与 watcher 留 `ipc.js` 主干；各模块导出 `register(deps)`，由 `registerIpc` 统一挂载（保留 ipcMain.handle 统一包错 monkey-patch 在主干）。
- 渲染层：先拆设置域（`settings.js`，app.js:2050-3080 一段天然成块）与 AI 域（周报/建议渲染）；总览/主面板留主干。
- 每拆一块跑一次验证基线，不做行为变更。

## 验收

拆分后 `npm run test:scan` + `DEVBOARD_MOCK=1 npm run shot` 与拆前行为一致；单域改动不再触及无关文件。
