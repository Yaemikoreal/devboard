'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 冷启动防闪（issue #101）：同步取主进程按已存主题算好的首帧关键色，head 内联脚本在样式生效前铺底
let bootTheme = null;
try {
  bootTheme = ipcRenderer.sendSync('boot:theme');
} catch { /* 主进程未就绪等异常时走 styles.css 默认浅色 token */ }

contextBridge.exposeInMainWorld('devboardBoot', { theme: bootTheme });

// 共享领域常量（issue-11 / #127）：分带定义/警示严重度/热力色阶/日期键与主进程同源，
// 渲染层经 window.devboardConsts 消费，不再手写本地副本
contextBridge.exposeInMainWorld('devboardConsts', require('./shared/constants'));

// 主题 token 单一事实源（issue #122）：七套主题全量 token + 颜色工具，渲染层 app.js 经
// window.devboardThemes 消费；冷启动四色与 :root 暖阳默认值亦从该模块派生
contextBridge.exposeInMainWorld('devboardThemes', require('./shared/themes'));

contextBridge.exposeInMainWorld('devboard', {
  getBoard: () => ipcRenderer.invoke('board:get'),
  rescan: () => ipcRenderer.invoke('board:rescan'),
  setMemo: (projectPath, text) => ipcRenderer.invoke('memo:set', projectPath, text),
  quickOpen: (projectPath, kind) => ipcRenderer.invoke('quickopen', { path: projectPath, kind }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getHotkeyError: () => ipcRenderer.invoke('settings:hotkeyError'),
  getAutoStartError: () => ipcRenderer.invoke('settings:autoStartError'), // 自启注册失败原因（issue #108）
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  snooze: (projectPath, type, label) => ipcRenderer.invoke('snooze:set', projectPath, type, label),
  pickPath: (kind) => ipcRenderer.invoke('dialog:pick', kind),
  checkCommand: (cmd) => ipcRenderer.invoke('util:checkCommand', cmd),
  testGithub: (token, username) => ipcRenderer.invoke('github:test', token, username),
  scanPreview: (draft) => ipcRenderer.invoke('scan:preview', draft),
  // 分支详情懒取（issue #4）
  branchCommits: (projectPath, branch) => ipcRenderer.invoke('branch:commits', projectPath, branch),
  // GitHub 鉴权简化（issue #12）
  githubAuthCaps: () => ipcRenderer.invoke('github:authCaps'),
  githubDeviceStart: () => ipcRenderer.invoke('github:deviceStart'),
  githubDevicePoll: (deviceCode) => ipcRenderer.invoke('github:devicePoll', deviceCode),
  githubImportGh: () => ipcRenderer.invoke('github:importGh'),
  // GitHub 账户状态卡 + 断开（issue #45）
  githubStatus: () => ipcRenderer.invoke('github:status'),
  githubDisconnect: () => ipcRenderer.invoke('github:disconnect'),
  // AI 工具快捷启动（issue #15）
  aiToolsList: () => ipcRenderer.invoke('aitools:list'),
  aiToolsOpen: (cmd, projectPath) => ipcRenderer.invoke('aitools:open', cmd, projectPath),
  // AI 功能：能力探测 + 统一调用（issue #29）
  aiCaps: () => ipcRenderer.invoke('ai:caps'),
  aiAsk: (payload) => ipcRenderer.invoke('ai:ask', payload),
  // 提示词模板预览（issue #78）：用真实数据组装完整 prompt 展示
  aiPromptPreview: (payload) => ipcRenderer.invoke('ai:promptPreview', payload),
  // 设置页「数据」组（issue #79）：打开数据目录 + 导出/导入 + 重置
  openDataDir: () => ipcRenderer.invoke('data:openDir'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  resetData: (scope) => ipcRenderer.invoke('data:reset', scope),
  // 详情面板深区数据（issue #17）
  projectDetail: (projectPath) => ipcRenderer.invoke('project:detail', projectPath),
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onTick: (cb) => ipcRenderer.on('board:tick', cb),
  // 唤出着陆视图（issue #86）：窗口从托盘/热键唤出时触发
  onWinShown: (cb) => ipcRenderer.on('win:shown', cb),
  // 后台重扫完成后的整板补丁（issue #22）
  onBoardPatch: (cb) => ipcRenderer.on('board:patch', (_e, board) => cb(board)),
  // 后台重扫失败信号（issue #98）：渲染层收到后熄灭「扫描中…」指示
  onBoardScanfail: (cb) => ipcRenderer.on('board:scanfail', () => cb()),
  onShowSettings: (cb) => ipcRenderer.on('nav:settings', cb),
});
