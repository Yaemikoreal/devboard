# devboard

本地桌面端项目概况板：在众多并行的 vibecoding 项目中，自动聚合各项目的事实近况（提交、改动、AI 会话痕迹、GitHub issues/PR），帮助快速回忆起「每个项目做到哪了」。核心是事实聚合，不是项目管理平台。领域语言与边界见 `CONTEXT.md`，架构决策见 `docs/adr/`。

## 运行

```bash
npm install       # 安装依赖（electron，约 100MB）
npm start         # 启动应用：托盘常驻，Ctrl+Shift+D 唤出/隐藏
npm run test:scan # 不起界面，直接跑项目扫描并打印 JSON，用于验证
npm run shot      # 隐藏窗口渲染真实数据后截图到 screenshot.png
```

## 设置

顶栏齿轮进入设置页，保存后热键与自启即时生效：

- **扫描根目录**：一行一个，递归发现其中含 `.git` 的目录（深度上限 4，跳过黑名单与 `.` 开头目录）
- **黑名单目录**：一行一个，默认 `node_modules` / `$RECYCLE.BIN` / `.git`
- **GitHub Token + 用户名**：两者都配置后，拉取 owner 是自己的仓库的开放 issues/PR（10 分钟缓存）；fork 的上游仓库自然跳过
- **编辑器命令**：快捷打开「编辑器」按钮使用的命令，默认 `code`
- **全局热键**：默认 `Ctrl+Shift+D`
- **开机自启**：默认开

## 数据存放

全部在 Electron userData 目录下（Windows: `%APPDATA%/devboard/`）：

- `config.json`：上述设置
- `memos.json`：各项目备忘（按项目路径索引）
- `github-cache.json`：GitHub issues/PR 缓存，10 分钟 TTL，失败静默用旧缓存
- `meta.json`：每日通知去重等杂项

## 分带与警示

活跃分带按最后提交时间：**热** ≤3 天，**活跃** ≤7 天，**冷却** ≤30 天，否则**搁浅**。

警示标记（汇总进「需要关注」黑卡）：

- 有未提交改动且最后提交超 3 天 →「N 文件未提交超3天」
- 领先远程未推送 →「N 提交未推送」
- 有开放 PR →「N 个开放 PR」

## 已知取舍

- 「脏文件超 3 天」是近似：git 无法给出脏文件起始时间，用最后提交时间近似判断
- GitHub 集成仅覆盖 owner 是使用者的仓库；未配置 token 时对应区域显示占位
- 空 git 仓库（无提交）降级为仅有路径的搁浅条目
