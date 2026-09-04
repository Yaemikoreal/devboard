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
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onTick: (cb) => ipcRenderer.on('board:tick', cb),
});
