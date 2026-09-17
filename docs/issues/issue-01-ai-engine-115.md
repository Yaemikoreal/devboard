# 【审查·AI·高】#115 三处根因未修：codex 目录信任拒绝、claude 良性警告误杀、失败原因被 stderr 首行掩盖

- 级别：高 ｜ 轴：Spec ｜ 关联：gh issue #115（OPEN）
- 位置：`src/main/ai.js:17`、`:36`、`:43`、`:93-98`、`:130-148`、`:172`；`scripts/test-ai.js`

## 问题

#115 报告的四引擎连环失败，三个代码根因在当前 HEAD 全部健在：

1. **codex 目录信任拒绝**：`TOOL_SPECS.codex.args = ['exec']`（ai.js:36），且 `runCli` spawn 不设 cwd（ai.js:93-98）。开机自启等场景下工作目录不是受信仓库，`codex exec` 直接拒绝执行。
2. **claude 良性警告被误杀**：`ENGINE_ERROR_RE` 仍含 `unrecognized_model`（ai.js:17），claude 对第三方模型名输出的良性警告会被流式检测秒杀（ai.js:130-148）。另外 `ANSI_RE` 第二分支 `\[[0-9;]*m` 无 ESC 前缀（ai.js:43），模型名后缀如 `[1m]` 会被当 ANSI 序列吃掉。
3. **失败原因被掩盖**：close 兜底失败原因取 stderr **首行**（ai.js:172 `split('\n')[0]`），`Reading additional input from stdin...` 等信息行掩盖真错误。
4. **回归防线缺失**：`scripts/test-ai.js` 中 issue 要求的三个回归断言（防误杀 / 防吃 `[1m]` / 末行取因）不存在。

后果：该机环境下周报/建议四引擎连环失败，AI 功能整体不可用。

## 方案

1. codex args 加 `--skip-git-repo-check`；或 `runCli` spawn 显式设 `cwd` 为受信目录（如 `os.homedir()`）。
2. 从流式误杀正则 `ENGINE_ERROR_RE` 移除 `unrecognized_model`（或改为仅在退出码非 0 的 close 兜底中参与裁决）；`ANSI_RE` 第二分支补 `\x1B` 前缀。
3. close 兜底失败原因改为取 stderr **末行非空行**，并过滤已知信息行前缀（`Reading additional input` 等）。
4. `scripts/test-ai.js` 补三个回归断言：含良性警告的流不被秒杀、`[1m]` 后缀保留、失败原因取末行。

## 验收

`node scripts/test-ai.js` 全过；真机 `npm start` 触发一次周报生成，四引擎至少其一成功产出。
