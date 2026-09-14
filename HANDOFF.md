# HANDOFF · SignalBoard v0.1.0 发布交接

> 给下一位 Agent：本文档是当前会话的完整交接。~~目标：完成 #90 剩余中/低危修复~~（✅ 2026-09-14 已全部完成），**下一步：执行 #91 发布（第三节），并补 gh issue 关闭（见第一节末）**。

## 一、当前状态（已完成）

| 事项 | Issue | 状态 |
|---|---|---|
| 换用 logo2 为项目 Logo（draft-d.svg 管线，托盘简化稿） | #89 | ✅ 已关闭（commit `824864d`） |
| README 中英双语改版（官网同源叙事 + 补 MIT LICENSE） | #92 | ✅ 已关闭（commit `b880a5f`） |
| 发布前三轴审查（性能/流畅度/稳定性），20 条发现逐条建档 | #90 | ✅ 高危+中低危全部修复（评论归档待网络恢复） |
| 审查高危 7 项修复 | #93–#99 | ✅ 已关闭（commit `30d29f8`） |
| 审查中/低危 13 项修复 | #100–#112 | ✅ 已修复（commit 见下表；issue 关闭待网络恢复） |
| 工作区整理（官网入库、真实数据截图移出跟踪） | #91 前置 | ✅ 已提交（commit `8c10ed5`） |
| 敏感数据处置 + 安装包 + Release v0.1.0 | #91 | ⬜ 待做（本文档第三节） |

**本地 master 领先 origin 多个 commit，发布第一步 git push 时一并推（见第三节）。**

### 中/低危修复 commit 对照（#100–#112，2026-09-14 完成）

| Issue | Commit | 修法落地 |
|---|---|---|
| #100 补丁打断拖拽/焦点/展开态 | `8e12f81` | 拖拽在飞补丁排队到 dragend；renderRows 重放焦点行；renderPanel 重放折叠组展开态 |
| #110 dragover O(N) | `8e12f81` | dragstart 缓存行数组，dragover 索引比较 + 移动后同步 |
| #101 冷启动主题闪烁 | `3a8c3c2` | `src/main/boot-theme.js` 首帧 token 表；建窗前定底色；preload sendSync 桥 + head 内联脚本铺底 |
| #102 kimi 探测无共享缓存 | `f111af4` | 60s TTL 全量 cwd→updatedAt 映射（与 codexSessionMap 同款） |
| #103 FS 探测无并发上限 | `f111af4` | dirLatestMtime 入口接入 fsSlot（上限 8，gitSlot 同款队列） |
| #104 悬停气泡同步布局 | `801b547` | 双 rAF 延迟读 offsetWidth |
| #105 唤出重复拼板 | `801b547` | buildBoard 缓存分支 cachedBoardInFlight 在飞去重 |
| #106 迁移幂等缺口 | `fe2998c` | .migrated 完成标记 + 逐文件只补缺失（五场景单测过） |
| #107 Device Flow 无超时 | `62bf9a3` | 10s AbortController；poll 超时按 pending 继续 |
| #108 自启失败静默 | `3a8c3c2`+`b49da53` | setLoginItemSettings 回读验证；settings:autoStartError 链路 + 设置页 err 位 |
| #109 seal 无兜底 | `236b6da` | _seal 包 try，失败回落明文记日志；迁移处失败保留明文下次重试 |
| #111 降低动效遗漏 | `801b547` | 锚点导航 smooth→auto；.set-group/.ai-box 半透明底换实底 |
| #112 双渲染/过期补丁 | `801b547` | 板与补丁带 scanGeneration；渲染层丢弃旧代次迟到补丁与同代次整板重演 |

**验证记录**：`node --check` 全过；`npm run test:scan` 正常；`DEVBOARD_MOCK=1 npm run shot` 与 `DEVBOARD_MOCK_THEME=dark` 出图完好（深色无浅色残影）；`npm start` 真实启动冒烟正常（29 项目扫描、无异常日志）。

### ✅ gh issue 关闭已全部完成（2026-09-14）

#100–#112 十三项与 #90（含三轴审查归档评论）全部关闭。GitHub 连通故障已排查解决：
本机 hosts 曾被写入 27 条 `127.0.0.1 github 全家桶` 黑洞记录（浏览器走 DoH 不受影响，git/gh/FlClash 读系统 hosts 全被带偏；该网络环境 GitHub 本可直连无墙）。已注释清零（备份：`C:\Windows\System32\drivers\etc\hosts.bak-20260914`）。**若日后 GitHub 再连不上，先查 hosts 是否被写回**（疑似某去广告/管控类工具维护，约数日一写）。

### 高危修复要点（#93–#99，已验证）

- **#93** `src/main/store.js`：内存副本层（`this._mem` Map，读一次后内存服务）；`writeJson(name, data, compact)` 第三参为 true 时去 indent（三个缓存 setter 已传）。
- **#94** `src/main/ipc.js` onUpdate → `board:patch` 载荷降为 `{project, stats, attention, scannedAt}`；渲染层 `app.js` onBoardPatch 识别 `patch.project` 就地替换 state 后 `renderAll()`。**注意：DOM 级局部重渲未做，归入 #100。**
- **#95** `src/main/index.js`：`process.on('uncaughtException'/'unhandledRejection')` 只记日志不退出；`whenReady().then(...).catch` → `dialog.showErrorBox` + quit。
- **#96** `src/main/ai.js`：`STREAM_CAP = 1MB`，超限 kill 并按已有输出裁决（与超时同策略）；`checkStream` 改增量行匹配（`outScanned/errScanned` 游标），close 时仍全量检。
- **#97** `src/main/ipc.js`：`registerIpc` 开头 monkey-patch `ipcMain.handle` 统一包错（「操作失败：…」）；渲染层 `app.js` 新增 `ipcErrText()`/`toast()`/`failTo()`/`savePrefs()`/`saveMemo()`，设置保存链 `.catch → showHint('保存失败')`，其余点位（runCheck/previewBtn/testGh/ghImport/ghDisconnect/quickOpen/branchCommits）各自 `.catch` 落位。toast 样式在 `styles.css` 末尾 `.toast`。
- **#98** `board:scanfail` 频道（ipc.js catch 分支发 → preload → 渲染层熄灭扫描指示）。
- **#99** `styles.css`：`.rows`/`.panel-in` 移出玻璃共享规则改 `var(--card)` 实底（与 reduced-motion 退化观感一致）；玻璃保留 `.ov-card/.settings-card/.skel/.nav/.search/.chips/.icon-btn/.attn-card`。

## 二、✅ 已完成：#90 中/低危修复（13 项，#100–#112，2026-09-14）

原修法摘要留档如下，落地情况见第一节的 commit 对照表。

| Issue | 级别 | 位置 | 修法摘要 |
|---|---|---|---|
| #100 补丁整板替换打断拖拽/焦点/展开态 | 中 | `app.js` onBoardPatch / renderRows(:1126) / dragend(:1087) | 补丁渲染前检测 `.dragging` 与焦点行/展开态并重放；拖拽在飞时把补丁排队到 dragend 后渲染；顺带把 #94 的就地替换升级为 DOM 级行局部重渲 |
| #101 冷启动主题闪烁 | 中 | `styles.css:3-90` / `app.js:3089+` / `index.js:52` backgroundColor | 建窗前主进程读 config 定 backgroundColor；preload 同步暴露主题 id，`<head>` 内联脚本首帧前铺 token（参考 `site/index.html:14-28` 的防闪烁手法） |
| #102 kimi 会话探测无共享缓存 | 低 | `scanner.js:175-207` | 加与 codexSessionMap(:211-215) 同款 60s TTL 共享缓存 |
| #103 AI 会话 FS 探测无并发上限 | 低 | `scanner.js:532-559`, `:270-286` | FS 探测复用 gitSlot(:25-57) 式并发限制器 |
| #104 热力图悬停气泡强制同步布局 | 低 | `app.js:561-577`（:572 写后立即读 offsetWidth） | rAF 延迟读宽度，或按内容长度估算钳制 |
| #105 唤出路径重复拼板 | 低 | `index.js:80-86` show 的 board:tick + maybeNotify(:181-212) 各 buildBoard 一次 | maybeNotify 复用在飞 buildBoard 结果，或 board:get 缓存分支加在飞去重 |
| #106 userData 迁移幂等缺口 | 低 | `userdata-migrate.js:14,19-28` | 「new-exists 即返回」改为逐文件比对补拷，或写迁移完成标记 |
| #107 Device Flow fetch 无超时 | 低 | `github.js:216,240` | 补 10s AbortController（参照同文件 :34/:170） |
| #108 自启注册失败静默 | 低 | `index.js:172` | try 包裹记 `lastAutoStartError`，设置页仿 lastHotkeyError 链展示 |
| #109 token-vault seal 无兜底 | 低 | `store.js` `_writeConfig`/getConfig 迁移处 | seal 包 try，失败回落明文并记日志（unseal 已有同款兜底 `token-vault.js:17-22`） |
| #110 dragover 每事件 O(N) 查询 | 低 | `app.js:1091-1099` | dragstart 缓存行数组与拖拽节点引用，dragover 只做索引比较 |
| #111 降低动效两处遗漏 | 低 | `app.js:2141` smooth scroll；`styles.css:947/:1205` `.set-group`/`.ai-box` | reduced 时 behavior 改 'auto'；退化选择器（:1176-1187）补这两个类改 `var(--bg)` 实底 |
| #112 手动刷新与在飞重扫并发双渲染 | 低 | `ipc.js:289-294/:403/:331-339` + `app.js` onBoardPatch | 补丁带 scanGeneration（主进程已有 `scanGeneration` 变量），渲染层丢弃不新于当前 board 的补丁 |

**修完验证**：`node --check` 改动文件 → `npm run test:scan` → `DEVBOARD_MOCK=1 npm run shot` 看 mock 板渲染 → 真实跑一次 `npm start` 人工过一遍：扫描/切换视图/详情面板/拖拽/设置保存/主题切换。

## 三、待办 B：#91 发布（门禁 → 打包 → 发布）

### 1. 敏感数据清查（发布门禁，大部分已完成）

已完成的扫描（全部 63 个 commit 全历史）结论：
- ✅ 无 GitHub token（`ghp_`/`gho_`/`ghu_`/`github_pat_`）、无私钥、无 `.env`、无通用密钥赋值、无其他平台 key 模式
- ✅ `src/main/github.js:12` `DEVICE_FLOW_CLIENT_ID = ''` 全历史为空占位，从未提交真实值
- ✅ 用户数据文件（config/memos 等）从未入库

**⚠️ 唯一待决策项：`screenshot.png` / `screenshot-mock.png` 的历史版本仍在 git 历史中**（本次已 `git rm --cached` + gitignore，当前树干净）。`screenshot.png` 旧版本是**真实数据截图**（含本机项目名/路径/活跃度），已随历史推上云端。处置选项：
- A. 认为泄露面可接受（项目名非机密），仅保持现状不再新增 —— 需用户确认
- B. 重写历史：`git filter-repo --path screenshot.png --path screenshot-mock.png --invert-paths` 后 `git push --force-with-lease`（破坏性，需用户确认；本地先 `git remote remove origin` 防 filter-repo 拒绝，完后 re-add）

可选加固：`gitleaks detect --no-git` + `gitleaks detect`（本机未装，scoop/winget 可装）复核一遍。

### 2. 安装包构建（electron-builder）

```bash
npm i -D electron-builder
```

`package.json` 的 `build` 段补齐（现有 appId/win.icon）：

```jsonc
"scripts": { "dist": "electron-builder" },
"build": {
  "appId": "com.yaemikoreal.signalboard",
  "productName": "SignalBoard",
  "win": { "icon": "build/icon.ico", "target": ["nsis"] },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "shortcutName": "SignalBoard" },
  "files": ["src/**", "assets/**", "package.json"],
  "directories": { "output": "dist" }
}
```

产出 `dist/SignalBoard-Setup-0.1.0.exe`。**必须本机实测**：安装 → 启动 → 托盘图标（tray-32）→ `Ctrl+Shift+D` 唤出 → 设置页改项保存（验证 #97 在打包态正常）→ 关机自启项 → 卸载。注意打包态 `process.env.NODE_ENV` 与 dev 工具行为差异；`electron .` 与打包态的 userData 目录名不同（打包用 productName）。

### 3. 发布 v0.1.0

```bash
git push origin master          # 先推代码（含本交接前全部 commit）
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 "dist/SignalBoard-Setup-0.1.0.exe" --title "SignalBoard v0.1.0" --notes-file release-notes.md
```

发布文案（中英双语，与 README 语言策略一致）要点——中文段：定位一句话（事实聚合，非项目管理平台）；核心能力（总览/分带/需要关注/详情面板/AI 周报与建议/七套主题）；安装（下载 exe，Windows；数据只存本机，token 系统加密）；已知取舍（脏文件 3 天近似、GitHub 仅本人仓库、全静项目入归档）。英文段镜像。素材从 `README.md`/`CONTEXT.md` 提炼。发布后把 Release 链接回贴 #91 并关闭。

### 4. 发布后顺手

- 官网 Pages：仓库 Settings → Pages → Source 选「GitHub Actions」（一次性前置，见 `site/README.md`），push 后确认 `https://yaemikoreal.github.io/devboard/` 上线
- `site/index.html` 的 Releases 按钮自此有真实产物

## 四、工程约定（本仓库实际风格）

- commit：中文长 message，逐条列改动与 issue 号；只 `git add` 明确文件，不 `git add -A`
- issue：发现的问题先建 issue 再修（本次 #93–#112 即此流程）；修复 commit 引用 `(#n)`，`gh issue close n --comment "已修复（<sha>）…"`
- 验证基线：`node --check <改动js>` + `npm run test:scan` + `DEVBOARD_MOCK=1 npm run shot`；涉及扫描/设置链路再 `npm start` 人工过一遍
- 领域语言以 `CONTEXT.md` 为准（项目/近况信号/活跃分带/警示标记…），新文案不造新词
- 真实数据截图永远不入库（.gitignore 已挡）；官网截图一律 mock 数据（`scripts/shot-site.sh` 链路）

## 五、风险提示

- #94 后 watcher 补丁走增量，`scripts/screenshot.js` 的 `DEVBOARD_WAIT_PATCH=1` 等的是 `'[devboard] patched'` 日志，两种补丁形态都会打这行日志，出图链路不受影响
- #99 观感变化（行列表/详情面板去玻璃改实底）建议人工过目一遍七套主题，重点看暗夜/夜幕
- #100 修复时注意：备忘编辑保护逻辑在 `app.js:1271-1346`，补丁重放别破坏它
- electron-builder 首次安装 node_modules 体积 +~200MB；打包机需能访问 GitHub 下载 electron 二进制缓存
