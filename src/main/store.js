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
  aiTools: [], // 自定义 AI 工具清单：[{label, cmd}]，与默认 claude/codex/kimi/grok 合并（issue #15）
  theme: { accent: '#f5d90a' }, // 外观：强调色，渲染层据此派生热力图色阶等（issue #27）
};

const DEFAULT_PREFS = {
  pinned: [], // 主攻项目路径集合（多图钉，任意排序下置顶；旧版单路径字符串读取时迁移，issue #16）
  cardOrder: [], // 用户自由重排的项目位序（路径数组，优先生效）
  sortMode: 'manual', // 排序方式：manual（可拖拽）/ activity / name（issue #18）
  snoozes: {}, // 警示消音：path -> { warningType: label 签名 }
  branchSel: {}, // 详情面板分支下拉选择：path -> 分支名（issue #4）
  windowBounds: null,
};

// vault：token 加密封存接口（issue #12），由 Electron safeStorage 实现注入（见 token-vault.js）；
// 缺省（无 vault 或系统加密不可用）时退回明文兜底，保证 CLI 脚本等无 Electron 环境可用。
class Store {
  constructor(baseDir, vault) {
    this.baseDir = baseDir;
    this.vault = vault || null;
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

  _canSeal() {
    return !!(this.vault && this.vault.available());
  }

  // 落盘前把 githubToken 转为 githubTokenEnc（加密 base64），config.json 不留明文
  _writeConfig(cfg) {
    const out = Object.assign({}, cfg);
    delete out.hasGithubToken;
    if (this._canSeal()) {
      out.githubTokenEnc = cfg.githubToken ? this.vault.seal(cfg.githubToken) : '';
    }
    delete out.githubToken;
    this.writeJson('config.json', out);
  }

  getConfig() {
    const raw = this.readJson('config.json', {});
    // 迁移旧明文 token：读到时立即改写为加密存储（issue #12）
    if (raw.githubToken && this._canSeal()) {
      const migrated = Object.assign({}, DEFAULT_CONFIG, raw, {
        githubTokenEnc: this.vault.seal(raw.githubToken),
      });
      delete migrated.githubToken;
      this.writeJson('config.json', migrated);
      raw.githubTokenEnc = migrated.githubTokenEnc;
      delete raw.githubToken;
    }
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
    if (raw.githubTokenEnc && this._canSeal()) {
      cfg.githubToken = this.vault.unseal(raw.githubTokenEnc) || '';
    } else if (raw.githubTokenEnc && !this._canSeal()) {
      cfg.githubToken = ''; // 有密文但无法解密（如跨机拷贝），按未配置处理
    }
    delete cfg.githubTokenEnc;
    if (!Array.isArray(cfg.roots) || cfg.roots.length === 0) cfg.roots = DEFAULT_CONFIG.roots.slice();
    if (!Array.isArray(cfg.blacklist)) cfg.blacklist = DEFAULT_CONFIG.blacklist.slice();
    if (!Array.isArray(cfg.extraPaths)) cfg.extraPaths = [];
    if (!Array.isArray(cfg.aiTools)) cfg.aiTools = [];
    return cfg;
  }

  setConfig(patch) {
    const cfg = Object.assign(this.getConfig(), patch || {});
    this._writeConfig(cfg);
    return cfg;
  }

  getPrefs() {
    const raw = this.readJson('prefs.json', {});
    const prefs = Object.assign({}, DEFAULT_PREFS, raw);
    // 旧版 pinned 为单路径字符串，迁移为多路径集合（issue #16）
    if (typeof raw.pinned === 'string') prefs.pinned = raw.pinned ? [raw.pinned] : [];
    if (!Array.isArray(prefs.pinned)) prefs.pinned = [];
    if (['manual', 'activity', 'name'].indexOf(prefs.sortMode) < 0) prefs.sortMode = 'manual';
    if (!Array.isArray(prefs.cardOrder)) prefs.cardOrder = [];
    if (!prefs.snoozes || typeof prefs.snoozes !== 'object') prefs.snoozes = {};
    if (!prefs.branchSel || typeof prefs.branchSel !== 'object') prefs.branchSel = {};
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

  // 本地扫描磁盘缓存（issue #22）：projects[path] = { ...project, headSha }（issue #23 分档用）
  getScanCache() {
    const c = this.readJson('scan-cache.json', { scannedAt: 0, projects: {} });
    if (!c.projects || typeof c.projects !== 'object') c.projects = {};
    return c;
  }

  setScanCache(cache) {
    this.writeJson('scan-cache.json', cache);
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
