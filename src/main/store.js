// userData 下的 JSON 持久化：config.json / memos.json / github-cache.json
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  roots: ['E:\\myproject'],
  extraPaths: [],
  blacklist: ['node_modules', '$RECYCLE.BIN', '.git'],
  githubToken: '',
  githubUsername: '',
  editorCmd: 'code',
  terminalCmd: '',
  hotkey: 'Ctrl+Shift+D',
  autoStart: true,
};

const DEFAULT_PREFS = {
  pinned: null, // 主攻项目路径
  cardOrder: [], // 用户自由重排的卡片位序（路径数组，优先生效）
  snoozes: {}, // 警示消音：path -> { warningType: label 签名 }
  windowBounds: null,
};

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  _file(name) {
    return path.join(this.baseDir, name);
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this._file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, data) {
    const file = this._file(name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  getConfig() {
    const raw = this.readJson('config.json', {});
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
    if (!Array.isArray(cfg.roots) || cfg.roots.length === 0) cfg.roots = DEFAULT_CONFIG.roots.slice();
    if (!Array.isArray(cfg.blacklist)) cfg.blacklist = DEFAULT_CONFIG.blacklist.slice();
    if (!Array.isArray(cfg.extraPaths)) cfg.extraPaths = [];
    return cfg;
  }

  setConfig(patch) {
    const cfg = Object.assign(this.getConfig(), patch || {});
    this.writeJson('config.json', cfg);
    return cfg;
  }

  getPrefs() {
    const raw = this.readJson('prefs.json', {});
    const prefs = Object.assign({}, DEFAULT_PREFS, raw);
    if (!Array.isArray(prefs.cardOrder)) prefs.cardOrder = [];
    if (!prefs.snoozes || typeof prefs.snoozes !== 'object') prefs.snoozes = {};
    return prefs;
  }

  setPrefs(patch) {
    const prefs = Object.assign(this.getPrefs(), patch || {});
    this.writeJson('prefs.json', prefs);
    return prefs;
  }

  getMemos() {
    return this.readJson('memos.json', {});
  }

  setMemo(projectPath, text) {
    const memos = this.getMemos();
    const key = path.resolve(projectPath);
    if (text && text.trim()) memos[key] = text;
    else delete memos[key];
    this.writeJson('memos.json', memos);
    return memos;
  }

  getGithubCache() {
    return this.readJson('github-cache.json', { fetchedAt: 0, repos: {} });
  }

  setGithubCache(cache) {
    this.writeJson('github-cache.json', cache);
  }

  getLastNotifyDate() {
    return this.readJson('meta.json', {}).lastNotifyDate || '';
  }

  setLastNotifyDate(dateStr) {
    const meta = this.readJson('meta.json', {});
    meta.lastNotifyDate = dateStr;
    this.writeJson('meta.json', meta);
  }
}

module.exports = { Store, DEFAULT_CONFIG, DEFAULT_PREFS };
