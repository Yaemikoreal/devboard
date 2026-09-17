# 【审查·AI·可用性·中】设置页「默认引擎」把缺省物化成显式值，静默架空 #41 的 lastGood 优先

- 级别：中 ｜ 轴：Spec ｜ 规格出处：CONTEXT.md:72「设置可指定默认项，**缺省**取第一个可用」+「记忆最近可用引擎优先使用（issue #41）」
- 位置：`src/renderer/app.js:2512-2533`（下拉无「自动」档）、`:2530-2531`（空值选中 avail[0]）、`:2817`（silentSave 落盘）；`src/main/ipc.js:184`（`pref=[cfg.aiEngine, lastGood]`）

## 问题

设置页引擎下拉没有「自动/缺省」档：`cfg.aiEngine` 为空时 UI 直接选中 `avail[0]`，用户打开设置页改任何字段都会经 silentSave 把 `aiEngine = avail[0].id` 落盘。此后 `resolveEngines` 中固化的首选永远压过 lastGood——#41 的「记忆最近可用引擎优先」被静默架空；用户之后新装排序更靠前的工具也不会被缺省采纳。且下拉显示值与 ai:caps 实际首选（含 lastGood 排序）可能不一致，UI 与行为脱节。另 `app.js:2817`：无可用引擎时下拉禁用且 silentSave 落 `aiEngine:''`，用户后来重装工具，原显式偏好已丢。

## 方案

- 下拉首位加「自动（推荐）」档，值为 `''`；`cfg.aiEngine` 为空时选中该档而非 `avail[0]`，保留缺省语义。
- 无可用引擎时从 patch 剔除 aiEngine 字段，保持原值不被覆盖。
- 下拉各选项可标注 lastGood（如「上次可用」徽标），让 UI 与实际首选对齐。

## 验收

新装机器不改设置：引擎链首选随 lastGood 漂移；用户显式选过引擎后切回「自动」，配置回落 `''` 且 lastGood 重新生效。
