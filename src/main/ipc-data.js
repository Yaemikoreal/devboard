// 数据/系统辅助域 IPC（issue #124 第三刀）：dialog:pick / util:checkCommand / shell:openExternal /
// data:openDir / data:export / data:import / data:reset，从 ipc.js 分出。设置页的目录/文件选择、
// 命令可用性校验、外链打开与「数据」组（打开数据目录 + 导出/导入 + 重置，issue #79）。
// deps: { store, getWindow, applySettings, checkCommand }——checkCommand 是跨域系统助手
// （AI 工具探测也在用），留在主干经 deps 注入；data:import 写回 config 后经 applySettings
// 让热键/自启/刷新间隔即时生效。通道名与 payload 全程不变。
// 挂载由主干 registerIpc 在 handle 包错 patch 之后统一调用。
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, shell, dialog, app } = require('electron');
const { DEFAULT_PREFS } = require('./store');
const { localDateStr } = require('../shared/constants'); // 共享常量（issue-11 / #127）

module.exports = function registerData({ store, getWindow, applySettings, checkCommand }) {
  // 设置页辅助：目录/文件选择
  ipcMain.handle('dialog:pick', async (_e, kind) => {
    const opts = kind === 'file'
      ? { properties: ['openFile'] }
      : { properties: ['openDirectory', 'createDirectory'] };
    const r = await dialog.showOpenDialog(getWindow(), opts);
    return r.canceled ? null : r.filePaths[0];
  });

  // 设置页辅助：命令可用性校验
  ipcMain.handle('util:checkCommand', (_e, cmd) => checkCommand(cmd));

  // GitHub 链接等外部打开，仅允许 http(s)
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  /* ----- 设置页「数据」组（issue #79）：打开数据目录 + 导出/导入 + 重置 ----- */
  ipcMain.handle('data:openDir', () => shell.openPath(app.getPath('userData')));

  // 导出：memos + prefs + config 打包单 JSON；config 剔除 githubToken/githubTokenEnc（token 不随导出迁移）；
  // 各类缓存（scan/AI/GitHub/meta）可再生，不进包
  ipcMain.handle('data:export', async () => {
    const r = await dialog.showSaveDialog(getWindow(), {
      title: '导出数据',
      defaultPath: 'signalboard-backup-' + localDateStr(new Date()) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    const cfgOut = Object.assign({}, store.getConfig());
    delete cfgOut.githubToken;
    delete cfgOut.githubTokenEnc;
    const payload = {
      app: 'SignalBoard',
      version: 1,
      exportedAt: new Date().toISOString(),
      memos: store.getMemos(),
      prefs: store.getPrefs(),
      config: cfgOut,
      handoffs: store.getHandoffs(), // 交接随包迁移（issue #147/#79）；旧版导入会忽略该可选字段
    };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, reason: '写入失败：' + err.message };
    }
  });

  // 导入：结构校验后写回 memos/prefs/config；导入的 config 不接收 token 字段（token 不迁移），
  // 经 setConfig 与现有配置合并——本机已配置的 token 导入后保留；写回后由渲染层触发全量刷新
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '导入数据',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, reason: '文件不是有效的 JSON' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '文件结构不符（应为 SignalBoard 导出的备份文件）' };
    }
    const memos = data.memos;
    const prefs = data.prefs;
    const config = data.config;
    const handoffs = data.handoffs; // 交接（issue #147）：结构校验后整包写回
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(memos) && !isObj(prefs) && !isObj(config) && !isObj(handoffs)) {
      return { ok: false, reason: '文件中找不到可导入的数据（需要 memos/prefs/config/handoffs 字段）' };
    }
    if (isObj(memos)) {
      // 备忘：path -> 纯文本，过滤非字符串脏值
      const clean = {};
      for (const k of Object.keys(memos)) {
        if (typeof memos[k] === 'string') clean[k] = memos[k];
      }
      store.writeJson('memos.json', clean);
    }
    if (isObj(prefs)) store.writeJson('prefs.json', prefs); // 读取时 getPrefs 归一化兜底
    if (isObj(handoffs)) {
      // 交接：path -> 条目数组，丢弃形状不符的条目与非数组键（issue #147）
      const clean = {};
      for (const k of Object.keys(handoffs)) {
        if (!Array.isArray(handoffs[k])) continue;
        clean[k] = handoffs[k].filter((e) => e && typeof e === 'object'
          && typeof e.id === 'string' && typeof e.text === 'string' && typeof e.createdAt === 'string');
      }
      store.setHandoffs(clean);
    }
    if (isObj(config)) {
      const patch = Object.assign({}, config);
      delete patch.githubToken; // 防御：即使导出文件被手工塞入 token 也不接收
      delete patch.githubTokenEnc;
      applySettings(store.setConfig(patch)); // 热键/自启/刷新间隔等即时生效
    }
    return { ok: true };
  });

  // 重置（issue #79）：prefs = 位序/图钉/消音/分支选择等偏好回默认；all = 清空全部本地数据并重启，
  // 重启后 onboarded 标记缺失回到首启引导态
  ipcMain.handle('data:reset', (_e, scope) => {
    if (scope === 'prefs') {
      store.writeJson('prefs.json', Object.assign({}, DEFAULT_PREFS));
      return { ok: true };
    }
    if (scope === 'all') {
      const files = ['memos.json', 'prefs.json', 'config.json', 'ai-cache.json', 'scan-cache.json', 'github-cache.json', 'handoffs.json', 'meta.json'];
      for (const f of files) {
        try { fs.unlinkSync(path.join(store.baseDir, f)); } catch { /* 不存在则跳过 */ }
      }
      app.relaunch();
      app.quit(); // before-quit 置 quitting 标记，窗口正常关闭后重启
      return { ok: true };
    }
    return { ok: false, reason: '未知的重置范围' };
  });
};
