# SignalBoard DSH 插件（@local/signalboard）设计

- 日期：2026-10-19
- 状态：设计已评审认可，待实施计划
- 决策记录：[ADR-0005](../../adr/0005-dsh-plugin.md)
- 上游讨论：完整双半边 / 共享 userData 互不依赖 / DSH agent 作 AI 引擎，三项骨架决策均经用户逐项确认

## 0. 背景与目标

SignalBoard（本项目，Electron 桌面端项目概况板）要能作为插件集成进 DeepSeek Harness（DSH）：**功能点原汁原味，插件形态贴合 DSH 设计模式**。DSH 的插件体系是 Cordis bundle——一个 package（`dsh.bundle.patch` 声明 Loader 行）带 Host 半边（`export function apply(ctx, config)`，注册 Service/Event/Tool/Config）与可选 Client 半边（React 组件注入 Slot，宿主主题 token + locale）。

两项要求在两处天然冲突，已议定裁决：

| 冲突点 | 裁决 | 依据 |
|---|---|---|
| 七套主题 vs DSH「插件 UI 是 Harness UI 的一部分」 | 功能/信息架构原汁原味，视觉跟随宿主 `--dsw-alias-*` token | DSH 铁律不可谈判；域语言功能点无损 |
| 外部 AI CLI 引擎 vs DSH 宿主自带 agent | 引擎换成 DSH agent，事实口径仍由插件计算 | 贴合「framework drives, plugin computes」；ai.js/ai-chain.js 留在桌面端 |

## 1. 已确认的骨架决策

1. **形态：完整双半边**。Host 复用纯 Node 域模块进程内扫描（不依赖桌面应用运行）；Client 把总览/项目板/详情重写为 React 注入 DSH `main` 面板 + `sidebar.panellist` 侧栏图标；agent 获得原生工具面。否决了 Host-only（原汁原味只剩工具面）与 MCP 桥接（配置-only bundle 挂 bin/signalboard-mcp.js——零改动但不贴合 DSH 原生模式，无 toolview/Config/UI）。
2. **数据：共享 userData，两形态互不依赖**。插件读写同一 `%APPDATA%/SignalBoard`，但「有桌面端没有插件端不影响，没有桌面端有插件端也不影响」——即 MCP server 已验证的生态位（读缓存、写交接、请求应用刷新、应用不在也能答）扩展为完整形态。独立性是硬约束：插件不检测不依赖桌面应用，应用对插件零感知（除 assembleBoard 提取外应用代码零改动）。
3. **AI 引擎：DSH agent**。周报/建议的产品功能保留（按需生成、缓存、UI 展示、标引擎与时间），总结者换成宿主 agent；插件新增事实工具供给输入。

支撑决策的代码事实（已验证）：

- `scanner.js`/`store.js`/`handoffs.js`/`github.js`/`ai.js` 不依赖 Electron；Electron 耦合仅在壳层（index.js / ipc*.js / preload / token-vault / boot-theme）。
- `store.writeJson` 是 tmp+rename 原子写——双写 last-writer-wins 不撕裂文件。
- 应用 `second-instance`/启动段已处理 `--mcp-action` argv（index.js:248-269、ipc.js:605）——跨进程刷新协议现成，即 MCP `requestAppRefresh` 逻辑可直接复用。
- MCP `tools.js` 纯函数入参 `{ store, config, now }`，白名单即边界（备忘写/消音工具不存在于 TOOL_DEFS，是「不实现」不是「不暴露」）。
- 唯一缺口：`assembleBoard` 长在 `ipc.js:208`（Electron 耦合），而 tools.js 各处强调「与 assembleBoard 同口径」。

## 2. 总体架构

仓库内新增 `dsh-plugin/`（install_bundle 以绝对路径安装，本仓库内即目录链接；发布 npm 的打包问题届时再议）：

```
dsh-plugin/
  package.json        # name: @local/signalboard + dsh.bundle.patch + dsh.client 段
  cordis.patch.yml    # Loader 行插入
  index.js            # Host 半边：export function apply(ctx, config)
  client.js           # Client 半边：React 工厂 → main 面板页
  locale/zh.json|en.json  # meta.title/description + UI 文案（走宿主 locale 服务）
  icon.svg            # 复用 SignalBoard 图标
  lib/                # 薄适配层
```

复用方式：顶层薄 ESM 壳用 `createRequire` 加载 CJS 域模块（相对路径 `require('../../src/main/…')`）；适配层只做三件事——ESM/CJS 桥接、Electron 壳能力替换（`shell.openPath` → spawn explorer / start）、snap 装配（把 Store/config/now 组装成 tools.js 纯函数入参）。

**配套工程**：`assembleBoard` 从 ipc.js 提取为纯模块 `src/main/board.js`（快照入参、可单测），桌面应用与插件共用同一拼板实现——「同口径」从注释约定升级为结构保证。这是一处有意的 targeted improvement，服务于本设计。

## 3. Host 半边

### 服务与扫描

- `signalboard` Host service：持 Store 实例（userDataDir 默认 `%APPDATA%/SignalBoard`，Config 可覆盖）；激活扫一次 + `scanIntervalMin` 定时静默刷新；定时器注册进 `ctx.effect`，插件卸载即清。
- **rescan 直接进程内执行**——插件自己就是扫描者，「请求应用执行」语义在此形态下消失（保留在 MCP server）。
- 扫描实现沿用 scanner 的并发槽（git 6 / fs 8）与慢扫 breakdown。

### agent 工具面（13 个）

复用 `tools.js` 纯函数实现，同口径映射 MCP 十工具：

| 组 | 工具 | 语义变化 |
|---|---|---|
| 只读 5 | list_projects / get_project / get_attention / get_memos / get_handoffs | 无；信封（scannedAt + 数据龄）原样 |
| 交接写 2 | handoff_write / handoff_complete | 写后 spawn `--mcp-action=refresh` 通知运行中应用（应用不在则跳过自愈） |
| 动作 3 | rescan / quickopen / open_cli | rescan 进程内直扫；quickopen/open_cli 经适配层 spawn（可见 OS 终端，人在环保留） |
| 事实 2（新） | weekly_facts / advice_facts | AI 周报/建议的事实块输入，供 DSH agent 生成总结；口径复用现有事实组装代码 |
| 总结写 1（新） | save_summary | AI 触发链的窄写面：只写独立缓存文件 dsh-summary-cache.json，不碰备忘/消音/prefs |

**白名单即边界结构性保留**：备忘写入与消音工具不存在于清单；新增写面仅 save_summary 一项（窄面：只写 dsh-summary-cache.json，不碰备忘/消音/prefs）。

### Config

插件 Config 只放 DSH 侧专属项：`userDataDir`（默认 `%APPDATA%/SignalBoard`）。扫描根目录/黑名单/警示规则/引擎偏好等以 userData 的 `config.json` 为唯一事实源——**用户不配两遍**，桌面端改了插件即用。

## 4. Client 半边

- `sidebar.panellist` 注册 SignalBoard 图标 → 派发 `main` 面板 key `signalboard`。
- 页面内保留三视图信息架构（域语言逐项落位）：
  - **总览**：统计行、全年提交热力图、按月活动流、「需要关注」锚点卡（视觉权重最高位置语义保留）、AI 周报模块、工作台（本机 AI CLI 按 PATH 探测显隐，读 config.json 的 aiTools）。
  - **项目板**：五档活跃分带行列表、搜索（名称/备忘）、图钉置顶、位序拖拽持久化、行内分支/警示/最近动静。
  - **详情面板**：备忘编辑（人写）、快捷打开、近况信号、警示消音、AI 建议、月份热力图（可翻页）、近期提交、未提交文件、「更多事实」折叠组（README 摘要 / AI 会话痕迹 / issues·PR）。
- UI 操作的数据通路：Client 经宿主 Client-可调 Host 入口调 `signalboard` service 同一方法（「一个操作，两个调用方」：UI 动作与 agent 工具同源，不另设逻辑）。
- **皮肤贴合 DSH**：颜色一律 `--dsw-alias-*` token、跟随宿主明暗；间距/字号/行模式抄宿主同类页（管理列表参考 Plugin Manager 页）；UI 文案走宿主 locale 服务；不读其他插件 DOM，不自挂 document.body。
- **AI 周报触发链**：模块提供「生成本周总结」按钮 → Host 入口把请求注入当前会话 → agent 调 weekly_facts 生成 → save_summary 落缓存 → UI 展示（当天复用）。**有意取舍**：桌面端「打开即自动生成」在 DSH 改为「按钮触发 + 当天缓存」——不往用户会话里塞未请求的生成任务。

## 5. 数据协议（共享 userData，互不影响）

| 文件 | 桌面应用 | 插件 | 协调机制 |
|---|---|---|---|
| config.json | 读+写 | **只读** | 插件不写，零冲突；改设置去桌面端（插件页提供只读展示 + 引导） |
| scan-cache.json | 写 | 写 | 派生缓存；原子写 last-writer-wins 无害；各自 20min 重扫自愈 |
| memos.json / prefs.json | 读+写 | 读+写（仅 UI） | 原子写 + 编辑前重读 + 写后 spawn `--mcp-action=refresh`；应用不在则跳过 |
| handoffs.json | 读 | 写（agent 工具）+ 读 | 与 MCP server 现状一致 |
| github-cache.json | 写 | **只读** | v1 不拉取、不解密 token；按数据龄展示，应用不在则占位 |
| ai-cache*.json | 写 | 写独立文件 | 引擎不同（CLI vs agent），插件写 dsh-summary-cache.json，不与桌面端 ai-cache 混写 |

- token（Electron safeStorage = Windows DPAPI 密封）插件不解密；插件侧独立拉取 GitHub 留作 M3 再议（届时评估 DPAPI 解密 vs 插件 Config 独立 token）。
- 派生缓存的丢失更新无害（下次扫描重填）；memos/prefs 是唯一真实双写面，单人双窗口并发罕见，原子写 + 刷新协议兜底。
- **独立性验证标准**：卸载插件后桌面应用行为与数据完全不变；桌面应用卸载后插件功能完全可用（GitHub 数据退化到缓存数据龄）。

## 6. 保留 / 适配 / 舍弃清单

- **原样保留**：项目发现、近况信号、AI 会话痕迹探测、五档分带、警示规则 + 消音、需要关注排序、备忘、交接、位序、图钉、全年热力图、月活动流、快捷打开、工作台、工具面白名单边界、信封新鲜度语义。
- **语义适配**（功能保留，机制换 DSH 原生）：主题→宿主 token；AI 引擎→宿主 agent；周报触发→按钮 + 缓存；动作工具「请求应用」→进程内直执行；`shell.openPath`→spawn。
- **舍弃**（桌面形态专属，DSH 无对应概念）：托盘常驻、全局热键、开机自启、系统通知（workspace.toast 键域固定，插件不可新增）、自然语言筛选（v1 暂缓，后续可经 agent 链路）、窗口边界记忆、密度/动效偏好。

## 7. 错误处理

- 工具失败带结构化错误（沿用 mcpCode 风格：PROJECT_NOT_FOUND / APP_NOT_CONFIGURED 等），不炸宿主进程。
- 首启空态：roots 为空时沿用应用首启引导卡设计（常驻插件静默建 userData 目录合理；与 MCP「目录不存在报错退出」的差异是有意的形态差异——server 按需起，插件常驻）。
- 扫描失败/超时沿用 scanner 既有并发与降级；插件激活失败不阻塞 DSH 启动（DSH Loader 语义）。
- 跨进程刷新失败（应用 exe 缺失等）：数据已落盘，对方下个刷新周期自愈——沿用 MCP requestAppRefresh 的容错语义。

## 8. 测试与验证

- 域模块复用零新测试（test:scan 等既有把守）；适配层配单测（snap 装配、spawn 适配）。
- **同口径断言**：assembleBoard 提取后插件拼板 === 应用拼板共享同一实现，口径漂移在结构上不可能；提取本身配回归断言（重构前后拼板输出一致）。
- 「一个操作两个调用方」验证：备忘编辑仅 UI 可达；审计 agent 工具清单无备忘写面/消音面。
- 安装验证走 DSH 标准流程：install_bundle → `application: applied` → cordis_inspect_query 确认行/工具/slot → 连接页验证渲染与交互；无浏览器控制时按 verification.md 报告未验证项。

## 9. 交付切分

- **M1 Host**：service + 13 工具（MCP 同口径 10 + weekly_facts / advice_facts / save_summary）+ Config + assembleBoard 提取 → agent 立即可用（对话内即可查事实、写交接、生成并落缓存周报），独立可验证。
- **M2 Client**：三视图页面 + 侧栏入口 + 备忘/位序/消音交互 + 数据协调（刷新协议接线）+ AI 周报模块（读 dsh-summary-cache.json，按钮触发走 M1 的 save_summary 链路）。
- **M3 增强**：tool.call.toolview 专属卡片、AI 触发链打磨、GitHub 插件侧拉取（再议）、open_cli 映射 DSH 内建 terminal（演进选项）。

## 10. 实施期待验证的 DSH API（inspect 清单）

以下 API 名称以 `cordis_inspect_query` 实测为准，实施 M1/M2 前逐项确认：

1. Host 工具注册 API（`ctx.tools.*` 形态、工具 schema 投影方式）
2. Host Config 导出形态与 `plugins.row.config` 配置页键（`<package>#<row id>`）
3. Client 调 Host 的机制（Client Service 目录中的 remote/commands 入口）
4. `sidebar.panellist` → `main` 面板的派发方式（key 语义、选中态）
5. session command / 请求注入机制（AI 触发链用）
6. `tool.call.toolview` 注册契约（M3）
7. 宿主主题 token 清单（`Theme.listTokens`）与 locale 服务用法

## 11. 开放问题（不阻塞 M1/M2）

- open_cli 是否演进为映射 DSH 内建 terminal（terminal_* 工具面存在）：v1 保持可见 OS 终端（原汁原味 + 人在环），演进留 Config 或后续版本议。
- 发布形态：本仓库内目录链接安装已满足自用；npm 发布时 files 打包域模块的方案（复制 vs 构建时收拢）届时再议。
- DSH 侧是否提供 config.json 的编辑入口：v1 明确不做（只读 + 引导桌面端），避免双写面扩大。
