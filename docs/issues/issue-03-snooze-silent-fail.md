# 【审查·稳定性·中】警示消音等三处乐观写失败静默，违背 #97 toast 约定

- 级别：中 ｜ 轴：Standards ｜ 标准出处：HANDOFF.md #97 约定「渲染层乐观写失败要 toast 可见」
- 位置：`src/renderer/app.js:1277`、`:706-709`、`:1433-1441`、`:3082`

## 问题

- 警示消音 `api.snooze(p.path, w.type, w.label).then(function () { refresh(false); })`（app.js:1277）无 `.catch`：snooze:set 写 prefs 落盘失败时完全静默，用户误以为已消音，刷新后警示复出会被当作 bug。
- `api.aiToolsOpen(...)` 两处（app.js:706-709、1433-1441）只有 `.then` 无 `.catch`：IPC reject 时按钮停在原态无任何反馈。
- `api.resetData('prefs')`（app.js:3082）同样无 `.catch`：重置失败静默。

## 方案

- snooze 追加 `.catch(failTo('消音警示'))`（`failTo` 设施已在 #97 就位）。
- aiToolsOpen 两处补 `.catch`，走 `flashBtn(..., false)` 亮错。
- resetData 补 `.catch`，在结果位亮错或 `showHint('重置失败')`。

## 验收

人为制造写盘失败（如 prefs.json 置只读）后：消音/启动 AI 工具/重置偏好均出现可见错误反馈，不再静默。
