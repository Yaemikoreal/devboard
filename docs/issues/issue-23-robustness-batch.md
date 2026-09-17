# 【审查·AI·稳定性/效率·低】健壮性小项合集：streamJson 空正文 / 杀进程树 / stale 阈值 / 缓存前先探测 / 缓存尸体

- 级别：低 ｜ 轴：Standards ｜ 维度：稳定性 + 效率

## 清单

1. **streamJson 空正文兜底倒退**——`src/main/ai.js:52-69`：streamJson 规格下全文无 `role=assistant` 行（引擎报错/版本变更）时 `parts` 为空，回落到文本路径把原始 JSONL 行当「成功正文」展出并缓存。→ streamJson 且 parts 为空时返回空串，让上层按无输出判失败。
2. **win32 杀树不彻底**——`src/main/ai.js:74-82`：非 shell 引擎（kimi/codex/grok）只 `child.kill()` 顶层进程，若 exe 派生子进程并继承管道，超时后子进程成孤儿继续持有句柄。→ win32 不分 shell 与否统一 `taskkill /pid /T /F`。
3. **AI_JOB_STALE_MS 阈值假设脆弱**——`src/renderer/app.js:815-817`：10min 建立在「引擎数 × 90s ≤ 4 引擎」上，自定义工具 6+ 引擎即破假设，合法长任务被误清（可靠 pending 并回，但 UI 进度跳变）。→ 阈值按已安装引擎数动态放大（`max(10min, 引擎数 × 100s)`）或注释写明上限前提。
4. **缓存命中路径被探测绑架**——`src/main/ipc.js:500-503`：doAiAsk 先做引擎探测（无引擎直接报错）再读缓存，纯缓存命中也要等一轮 `where`。→ 缓存命中分支前移到引擎探测之前。
5. **advice 缓存尸体累积**——`src/main/ipc.js:541-546`：缓存按 path 永久累积，项目删除/改根目录后尸体条目永留 ai-cache.json。→ 拼板或写缓存时按现存项目集裁剪 advice 键。

## 验收

逐条对应：引擎输出 JSONL 噪音时按失败回退而非展出乱码；超时后无孤儿进程；7 引擎链长任务不被误清；无可用引擎时缓存周报仍能展出；删除项目后 ai-cache.json 无对应键。
