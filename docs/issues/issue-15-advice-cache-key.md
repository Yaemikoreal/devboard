# 【审查·AI·结果·中】建议缓存键不含事实摘要，git push 后展出过期建议

- 级别：中 ｜ 轴：Standards ｜ 维度：结果质量
- 位置：`src/main/ipc.js:532-543`（缓存键 = 项目 + headSha + 模板哈希）；事实块组装 `src/main/ai.js:242-258`

## 问题

AI 建议缓存键 = 项目 + HEAD + 模板哈希，但事实块还含 ahead/behind/dirtyCount/警示标签。`git push` 后 HEAD 不变、ahead 3→0，面板仍展出「3 个提交已落后/未推送」语境下的旧建议，直到下次提交才失效。规格 CONTEXT.md:80「按 项目+HEAD 缓存」字面达成，但缓存粒度过粗导致结果失真——「有 AI 会话但可能未提交」场景下建议与现实相反。

## 方案

缓存键纳入事实摘要的关键字段哈希（如 `head + ahead + behind + dirtyCount + warnSignature`），或命中前比对这些字段、不一致则视为 miss。规格文档 CONTEXT.md:80 同步补一句缓存键口径。

## 验收

同一项目 `git push` 前后各请求一次建议：push 后不再命中旧缓存，新建议反映 ahead=0。
