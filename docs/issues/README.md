# 审查建档 · Issue 清单

> 已全部推送云端（2026-09-17）：本地 01–24 对应 GitHub **#117–#140**（依次序一一对应）。

## 第一轮：全量双轴审查（2026-09-17）

审查基线：根提交 `8e2d219` → HEAD `59b187e`（全量代码库）。双轴：**Standards**（HANDOFF.md 工程约定 + CONTEXT.md 领域语言 + Fowler 异味基线）与 **Spec**（CONTEXT.md / docs/adr/* / GitHub issues）。

| # | 级别 | 轴 | 标题 |
|---|---|---|---|
| [01](issue-01-ai-engine-115.md) | 高 | Spec | AI 引擎三处根因未修：codex 目录信任拒绝、claude 良性警告误杀、失败原因被掩盖（#115 落地） |
| [02](issue-02-github-instant-pull.md) | 中 | Spec | GitHub 连接/断开后无即时拉取触发，「落地即推补丁展出」缺口（#44 不完整） |
| [03](issue-03-snooze-silent-fail.md) | 中 | Standards | 警示消音等三处乐观写失败静默，违背 #97 toast 约定 |
| [04](issue-04-prompt-template-wording.md) | 中 | Standards+Spec | 内置 AI 建议模板违反 Avoid 词表，条数与规格不符 |
| [05](issue-05-confirm-duplication.md) | 中 | Standards | 「再点一次确认」两份实现，ghDisconnectBtn 未复用 armConfirm |
| [06](issue-06-theme-triple-source.md) | 中 | Standards | 主题色值三处手工对齐，新增主题需多点同步 |
| [07](issue-07-ai-tool-registry.md) | 中 | Standards | 新增一个 AI 工具需改 5 处，缺单一工具注册表 |
| [08](issue-08-module-split.md) | 中 | Standards | ipc.js(883 行)/app.js(3280 行) Divergent Change，按域拆分 |
| [09](issue-09-docs-drift.md) | 低 | Spec | 文档漂移与 housekeeping：CONTEXT.md 位次、#114 待关闭、mock/store 注释失实 |
| [10](issue-10-default-roots.md) | 低 | Standards | 出厂默认 roots 写死作者本机路径 `E:\myproject` |
| [11](issue-11-shared-constants.md) | 低 | Standards | 跨进程共享常量多份手写（WARN_SEVERITY/localDateStr/heatLevel/band 定义） |
| [12](issue-12-small-duplications.md) | 低 | Standards | 小重复形状清扫合集（kind 分派/seg 控件/并发槽/headers/Middle Man/无用导出等） |

## 第二轮：AI 工具链路专项深查（2026-09-17，稳定性/可用性/效率/结果）

| # | 级别 | 轴 | 维度 | 标题 |
|---|---|---|---|---|
| [13](issue-13-aijob-finally-race.md) | 中 | Standards | 稳定性 | startAiJob finally 无条件 delete，迟到 resolve 误删新任务 |
| [14](issue-14-detect-inflight-dedupe.md) | 中 | Standards | 效率 | 探测/会话映射缓存无 Promise 级在飞去重；codex 读文件绕过 fsSlot |
| [15](issue-15-advice-cache-key.md) | 中 | Standards | 结果 | 建议缓存键不含事实摘要，git push 后展出过期建议 |
| [16](issue-16-filter-timeout.md) | 中 | Standards | 可用性 | 自然语言筛选复用「90s × 全引擎」链，最坏干等 6 分钟 |
| [17](issue-17-prompt-hardening.md) | 中 | Standards | 结果/安全 | prompt 无注入护栏、提交消息无截长、argv 长度无护栏 |
| [18](issue-18-engine-default-materialized.md) | 中 | Spec | 可用性 | 设置页把缺省引擎物化成显式值，架空 #41 lastGood 优先 |
| [19](issue-19-kimi-session-truncate.md) | 低 | Spec | 结果 | kimi 会话超 40 个时 slice 截断可能漏掉最新（#35 失真） |
| [20](issue-20-weekly-auto-quota.md) | 低 | Spec | 可用性 | 周报每日自动名额被「无数据」暂时性失败消耗（#42） |
| [21](issue-21-filter-lastgood.md) | 低 | Spec | 可用性 | filter 通路不参与 #41 引擎记忆与拉黑 |
| [22](issue-22-usability-batch.md) | 低 | Standards+Spec | 可用性 | 黑名单无复位口 / 错误原文上屏 / 手动任务标自动 / 筛选落地不校验 |
| [23](issue-23-robustness-batch.md) | 低 | Standards | 稳定性/效率 | streamJson 空正文 / 杀进程树 / stale 阈值 / 缓存前先探测 / 缓存尸体 |
| [24](issue-24-test-coverage.md) | 低 | Standards | 测试 | test-ai.js 覆盖缺口：超限裁决/空兜底/杀树/残段复检/引擎链 |

验证基线（修完每条后）：`node --check <改动js>` + `npm run test:scan` + `DEVBOARD_MOCK=1 npm run shot`；AI 链路另跑 `node scripts/test-ai.js`；涉及扫描/设置链路再 `npm start` 人工过一遍。

修复后按工程约定：`gh issue close <号> --comment "已修复（<sha>）…"`。
