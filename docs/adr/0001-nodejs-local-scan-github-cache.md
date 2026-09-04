# 架构：Node.js 本地服务 + 本地实时扫 / GitHub 缓存

Status: superseded by ADR-0002（项目目标从本地网页面板变更为桌面应用）

devboard 用 Node.js 实现一个本地 Web 服务：页面加载/手动刷新时同步实时扫描本地 git（快，毫秒级），GitHub issues/PRs 由后台每10分钟拉取并写入 JSON 缓存，页面展示缓存并标注最后更新时间。页面每10分钟自动刷新。

考虑过 Python（环境中 Python 项目居多、维护成本低），但使用者拍板 Node.js。考虑过全部后台定时扫描（页面永远秒开），但「刚提交完点刷新看不到变化」违背了工具帮用户回忆最新进度的核心场景；全部实时则会被 GitHub 请求拖慢并撞 rate limit。
