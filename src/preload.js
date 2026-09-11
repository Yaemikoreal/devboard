'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devboard', {
  getBoard: () => ipcRenderer.invoke('board:get'),
  rescan: () => ipcRenderer.invoke('board:rescan'),
  setMemo: (projectPath, text) => ipcRenderer.invoke('memo:set', projectPath, text),
  quickOpen: (projectPath, kind) => ipcRenderer.invoke('quickopen', { path: projectPath, kind }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getHotkeyError: () => ipcRenderer.invoke('settings:hotkeyError'),
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
  // 后台重扫完成后的整板补丁（issue #22）
  onBoardPatch: (cb) => ipcRenderer.on('board:patch', (_e, board) => cb(board)),
  onShowSettings: (cb) => ipcRenderer.on('nav:settings', cb),
});
