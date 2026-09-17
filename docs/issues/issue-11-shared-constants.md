# 【审查·重复·低】跨进程共享常量多份手写：WARN_SEVERITY / localDateStr / heatLevel / band 定义

- 级别：低 ｜ 轴：Standards ｜ 异味：Duplicated Code / Primitive Obsession
- 位置：
  - WARN_SEVERITY ×3：`src/main/ipc.js:279-280`、`src/renderer/app.js:13-23`、`scripts/mock-board.js:127-128`（两处注释自承「与主进程一致/同规则」）
  - localDateStr ×3：`src/main/ipc.js:198`、`src/main/scanner.js:412`、`src/renderer/app.js:96`
  - heatLevel ×2：`src/renderer/app.js:306`、`:383`（`n===0?0:n<3?1:n<7?2:3`）
  - band 阈值/枚举/label/pill ×4：`src/main/scanner.js:416-424`、`src/main/ai.js:271`、`src/renderer/app.js:7-8`、`src/renderer/index.html:132-137`

## 问题

同一份领域常量跨进程手写多份，注释自承互相保持一致——即没有任何机制保证一致。调一次分带阈值或警示严重度需多点同步，漏改即静默不一致。

## 方案

- 主进程侧：scanner.js 导出 band 定义与 localDateStr，ipc.js 直接 import，消灭主进程内重复。
- 跨进程：建 `src/shared/constants.js`（WARN_SEVERITY、band 阈值+label、heatLevel），preload 暴露给渲染层；`scripts/mock-board.js` 从同一文件取。
- band 同时治 Primitive Obsession：阈值、枚举、label、css 类名收敛单一 band 定义模块，四处消费。

## 验收

改一处分带阈值，主面板 pill、筛选 chips、AI 提示词三处表现同步；mock 板与真实板严重度排序一致。
