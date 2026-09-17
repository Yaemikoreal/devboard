# 【审查·配置·低】出厂默认 roots 写死作者本机路径 `E:\myproject`

- 级别：低 ｜ 轴：Standards
- 位置：`src/main/store.js:8`

## 问题

`DEFAULT_CONFIG.roots = ['E:\\myproject']` 把作者本机路径作为出厂默认随安装包分发。其他机器首启即为无效路径（scan:preview 会标红，但首启观感不佳，且扫描一个不存在的根目录是无谓开销）。

## 方案

- 默认改空数组，首启进入引导态：空态页引导添加扫描根目录（设置页已有 roots 编辑与 scan:preview 标红设施，可直接复用）；
- 或探测常见候选（`%USERPROFILE%\Projects` 等）做预填建议，但仍需用户确认后落盘。

## 验收

全新机器（无 userData）安装启动：不出现无效红标路径，空态引导可达添加根目录流程。
