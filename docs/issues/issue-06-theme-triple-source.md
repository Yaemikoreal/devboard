# 【审查·重复·中】主题色值三处手工对齐，新增主题需多点同步

- 级别：中 ｜ 轴：Standards ｜ 异味：Shotgun Surgery / Duplicated Code
- 位置：`src/renderer/app.js:1883-2044`（THEMES 全量 token）、`src/main/boot-theme.js:8-16`（BOOT_COLORS 四色子集）、`src/renderer/styles.css:3-90`（`:root` 暖阳默认）

## 问题

同一套主题色值在三处手工维护。boot-theme.js:3 注释自承「新增主题时需同步维护此表」——#101 冷启动防闪引入 BOOT_COLORS 后，新增主题或调整底色需同步改三个文件，漏一处即出现首帧色偏或默认态漂移。

## 方案

收敛单一 token 源，择一：

- BOOT_COLORS 从 THEMES 派生：把 BOOT_COLORS 需要的四个字段（bg/ink/card/边框）作为 THEMES 每主题的必填字段，boot-theme.js 改为读共享 JSON（如 `assets/themes.json`，主进程与渲染层同源）；
- 或构建期生成：`scripts/` 加一个从 THEMES 生成 boot-theme.js 数据与 `:root` 默认值的小脚本，纳入 `npm run logo` 同款一键链路。

`:root` 暖阳默认值同步改为引用同一源。

## 验收

新增一套演示主题只改一处，冷启动首帧色、设置页预览、`:root` 默认三者一致；`DEVBOARD_MOCK_THEME=dark npm run shot` 出图无浅色残影（#101 不回退）。
