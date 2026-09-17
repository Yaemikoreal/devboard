# 【审查·文档·低】文档漂移与 housekeeping：CONTEXT.md 位次、#114 待关闭、mock 注释失实

- 级别：低 ｜ 轴：Spec
- 位置：`CONTEXT.md:56`；gh issue #114；`scripts/mock-board.js:119`

## 问题

1. **CONTEXT.md:56 详情面板区块位次与实现漂移**：规格顺序为 …AI 建议→月份热力图→README 摘要→AI 会话痕迹明细→近期提交→未提交文件→issues/PR；实现按已关闭的 #83 把 README/AI 痕迹/GitHub 并入底部「更多事实」折叠组、排在近期提交与未提交文件之后（app.js:1515-1556）。实现有 issue 依据，是文档未随 #83 同步。
2. **#114 代码已闭环但 GitHub 仍 OPEN**：超 10 分钟死任务读时即清已接入全部三个读取点（app.js:817-825 `AI_JOB_STALE_MS`，调用点 :829/:896/:947），主进程在飞去重+结果缓存双兜底，commit 59b187e 与 issue 修复方案逐条对应。
3. **mock-board.js:119 注释失实**：注释称「scanner 同规则」补 lastActivityAt，但只取 max(最后提交, AI 会话)，漏了 scanner.js:536 的 dirtyAt 第三路。mock 因 band 硬编码不受影响，仅注释与实际不符。
4. **store.js:218 注释失实**：注释称「advice 按 项目+HEAD+引擎 复用」，实现实为 项目+HEAD+模板哈希（#78 改造后的陈旧注释），行为本身符合 CONTEXT.md:80。

## 方案

1. CONTEXT.md:56 更新为现行位次（注明 #83 折叠分组）。
2. `gh issue close 114 --comment "已修复（59b187e）：死任务读时即清接入 startAiJob/周报卡/建议面板三读取点"`。
3. mock-board.js:119 注释改为说明 mock 省略 dirtyAt 的理由，或补上第三路取 max。
4. store.js:218 注释改为「按 项目+HEAD+模板哈希 复用」。

## 验收

文档与实现对齐；#114 在 GitHub 关闭；mock 注释不再误导。
