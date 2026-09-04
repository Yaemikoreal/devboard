# 桌面应用：Electron 形态

Status: accepted（supersedes ADR-0001）

项目目标从「本地 Web 服务 + 浏览器面板」变更为桌面应用，驱动力是窗口行为需求：托盘常驻、开机自启、全局热键唤出、系统通知，这些在纯网页形态下都不成立。

选 Electron：全 JS 技术栈与既定 Node 方向一致，生态成熟，主进程可直接跑 git CLI 与 GitHub API。考虑过 Tauri 2（安装包约 10MB、内存低，且本机 Rust 与 WebView2 均已就绪），使用者基于技术栈一致性选择 Electron，接受其约 150MB 安装包与较高常驻内存的代价。

ADR-0001 中的「本地 git 实时扫 + GitHub 后台 10 分钟缓存」策略不受影响，保留并改由 Electron 主进程执行。
