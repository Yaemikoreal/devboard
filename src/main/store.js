// userData 下的 JSON 持久化：config.json / memos.json / github-cache.json
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  roots: [], // 出厂默认空：不写死任何本机路径，首启由空态引导卡带用户添加扫描根目录（设置页 roots + scan:preview 设施复用）
  extraPaths: [],
  blacklist: ['node_modules', '$RECYCLE.BIN', '.git'],
  githubToken: '',
  githubUsername: '',
  editorCmd: 'code',
  terminalCmd: '',
  hotkey: 'Ctrl+Shift+D',
  autoStart: true,
  scanIntervalMin: 20, // 后台静默刷新间隔（分钟）：预设 5/10/20/60 四档（issue #70），唤出窗口时总会重扫一次
  warningDirtyDays: 3, // 警示规则：未提交改动滞留超 N 天记警示标记，预设 1/3/7 三档（issue #73）
  warningTypes: { dirty: true, unpushed: true, ci: true, review: true, pr: true }, // 警示独立开关（issue #73，CI/review 扩编见 issue #143/#144）
  notifyEnabled: true, // 警示摘要通知总开关（issue #80）
  notifyMode: 'daily', // 通知时机：daily=每天首次唤出 / newOnly=仅当需要关注数较昨日新增（issue #80）
  trayAttentionCount: true, // 托盘 tooltip 显示「N 个项目需要关注」计数（issue #80）
  aiTools: [], // 自定义 AI 工具清单：[{label, cmd}]，与默认 claude/codex/kimi/grok 合并（issue #15）
  aiEnabled: true, // AI 功能总开关：周报/建议/自然语言筛选（issue #29）
  aiEngine: '', // 默认 AI 引擎的工具 id；空 = 自动取第一个已探测可用的（issue #29）
  aiPromptWeekly: null, // AI 周报提示词模板（issue #78）：null = 代码内置默认模板；{{事实}} 为事实块插入点
  aiPromptAdvice: null, // AI 建议提示词模板（issue #78）：同上
  theme: { id: 'warm', accent: '#f5d90a' }, // 外观：整体主题 + 强调色（issue #27）
  density: 'standard', // 密度档位：standard / compact（issue #84）
  reduceMotion: false, // 降低动效：停动画并关闭玻璃模糊（issue #82）
  landingView: 'overview', // 唤出着陆视图：overview / projects / last（issue #86）
};

const DEFAULT_PREFS = {
  pinned: [], // 主攻项目路径集合（多图钉，任意排序下置顶；旧版单路径字符串读取时迁移，issue #16）
  cardOrder: [], // 用户自由重排的项目位序（路径数组，优先生效）
  sortMode: 'manual', // 排序方式：manual（可拖拽）/ activity / name（issue #18）
  snoozes: {}, // 警示消音：path -> { warningType: label 签名 }
  branchSel: {}, // 详情面板分支下拉选择：path -> 分支名（issue #4）
  handoffReadAt: {}, // 交接未读游标（issue #147）：path -> ISO 时间；未读 = 存在 createdAt > 游标的条目。
  // 人的行为数据放 prefs 而非交接本体：随导出迁移（换机不丢已读位），agent 经 MCP 写交接物理碰不到游标
  windowBounds: null,
};

// vault：token 加密封存接口（issue #12），由 Electron safeStorage 实现注入（见 token-vault.js）；
// 缺省（无 vault 或系统加密不可用）时退回明文兜底，保证 CLI 脚本等无 Electron 环境可用。
class Store {
  constructor(baseDir, vault) {
    this.baseDir = baseDir;
    this.vault = vault || null;
    this._mem = new Map(); // 内存副本（issue #93）：读一次后内存服务，消除拼板热路径的反复读盘+parse
    fs.mkdirSync(baseDir, { recursive: true });
  }

  _file(name) {
    return path.join(this.baseDir, name);
  }

  // 读 JSON：内存副本优先；文件缺失（首次启动的正常路径）直接用 fallback。
  // 文件存在但解析失败（断电/崩溃/杀软隔离导致截断）时，先把原文另存为 <name>.corrupt 再退用 fallback
  // （issue #168 第 8 条）——否则紧随其后的任意一次写入都会用空 fallback 覆盖掉用户唯一那份数据，
  // 且全程没有任何提示与恢复入口
  readJson(name, fallback) {
    if (this._mem.has(name)) return this._mem.get(name);
    const file = this._file(name);
    let data = fallback;
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch { /* 文件缺失：走 fallback */ }
    if (raw !== null) {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        this._backupCorrupt(name, raw, err);
      }
    }
    this._mem.set(name, data);
    return data;
  }

  // 损坏留证：写一份 <name>.corrupt（已存在则不覆盖，保留最早那份现场），并在控制台点名
  _backupCorrupt(name, raw, err) {
    const bak = this._file(name + '.corrupt');
    try {
      if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw, 'utf8');
    } catch { /* 留证失败不阻断启动 */ }
    console.error('[devboard] ' + name + ' 解析失败，已退用默认值并保留现场副本 ' + path.basename(bak) + '：' + ((err && err.message) || err));
  }

  // compact：缓存类大文件（scan/github/ai-cache）去 indent 美化（issue #93），体积缩小数倍
  // 先落盘、后更新内存副本（issue #168 第 8 条）：写失败（ENOSPC/EPERM）时内存不再领先于磁盘，
  // 消除「设置看着保存了、重启后回滚」的静默不一致；异常照旧上抛，由 IPC 兜底转成中文提示
  writeJson(name, data, compact) {
    const file = this._file(name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, compact ? JSON.stringify(data) : JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this._mem.set(name, data);
  }

  _canSeal() {
    return !!(this.vault && this.vault.available());
  }

  // seal 包 try（issue #109）：系统加密调用失败（DPAPI 异常等）时返回 null 让调用方回落明文，
  // 不让保存/启动链崩掉；unseal 已有同款兜底（token-vault.js）
  _seal(plain) {
    try {
      return this.vault.seal(plain);
    } catch (err) {
      console.error('[devboard] token 加密封存失败，退回明文:', (err && err.message) || err);
      return null;
    }
  }

  // 设置页据此提示「当前环境无法加密存储」（issue #65）：无 keyring 环境下 token 退回明文落盘
  cryptoAvailable() {
    return this._canSeal();
  }

  // 落盘前把 githubToken 转为 githubTokenEnc（加密 base64），config.json 不留明文
  _writeConfig(cfg) {
    const out = Object.assign({}, cfg);
    delete out.hasGithubToken;
    if (this._canSeal()) {
      const enc = cfg.githubToken ? this._seal(cfg.githubToken) : '';
      if (cfg.githubToken && enc === null) {
        out.githubToken = cfg.githubToken; // seal 失败退回明文：功能可用性优先（issue #109）
      } else {
        out.githubTokenEnc = enc;
        delete out.githubToken;
      }
    } else {
      out.githubToken = cfg.githubToken || ''; // 无加密能力时按注释承诺退回明文兜底
    }
    this.writeJson('config.json', out);
  }

  getConfig() {
    const raw = this.readJson('config.json', {});
    // 迁移旧明文 token：读到时立即改写为加密存储（issue #12）；seal 失败保留明文下次重试（issue #109）
    if (raw.githubToken && this._canSeal()) {
      const enc = this._seal(raw.githubToken);
      if (enc !== null) {
        const migrated = Object.assign({}, DEFAULT_CONFIG, raw, {
          githubTokenEnc: enc,
        });
        delete migrated.githubToken;
        this.writeJson('config.json', migrated);
        raw.githubTokenEnc = migrated.githubTokenEnc;
        delete raw.githubToken;
      }
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
    // 警示规则（issue #73）：天数限预设档；开关与默认深合并（旧配置缺字段时补齐 true，issue #143 扩编同法）
    if ([1, 3, 7].indexOf(cfg.warningDirtyDays) < 0) cfg.warningDirtyDays = 3;
    const wt = (raw.warningTypes && typeof raw.warningTypes === 'object') ? raw.warningTypes : {};
    cfg.warningTypes = {
      dirty: wt.dirty !== false,
      unpushed: wt.unpushed !== false,
      ci: wt.ci !== false,
      review: wt.review !== false,
      pr: wt.pr !== false,
    };
    // 通知（issue #80）：时机限已知值
    if (['daily', 'newOnly'].indexOf(cfg.notifyMode) < 0) cfg.notifyMode = 'daily';
    // 提示词模板（issue #78）：null = 内置默认；非字符串/空白脏数据回落 null
    if (typeof cfg.aiPromptWeekly !== 'string' || !cfg.aiPromptWeekly.trim()) cfg.aiPromptWeekly = null;
    if (typeof cfg.aiPromptAdvice !== 'string' || !cfg.aiPromptAdvice.trim()) cfg.aiPromptAdvice = null;
    // 密度档位（issue #84）：限已知值
    if (['standard', 'compact'].indexOf(cfg.density) < 0) cfg.density = 'standard';
    cfg.reduceMotion = !!cfg.reduceMotion; // 降低动效（issue #82）：布尔归一
    // 唤出着陆视图（issue #86）：限已知值
    if (['overview', 'projects', 'last'].indexOf(cfg.landingView) < 0) cfg.landingView = 'overview';
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
    if (!prefs.handoffReadAt || typeof prefs.handoffReadAt !== 'object') prefs.handoffReadAt = {};
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

  // 交接（Handoff，issue #147）：path -> 条目数组 [{id, agent, text, createdAt, doneAt?}]。
  // 与 memos.json 同构的 Store 封装（损坏留证/内存副本由 readJson/writeJson 自动继承）
  getHandoffs() {
    const h = this.readJson('handoffs.json', {});
    if (!h || typeof h !== 'object' || Array.isArray(h)) return {};
    return h;
  }

  setHandoffs(handoffs) {
    if (!handoffs || typeof handoffs !== 'object' || Array.isArray(handoffs)) throw new Error('交接数据结构不符');
    this.writeJson('handoffs.json', handoffs);
    return handoffs;
  }

  getGithubCache() {
    return this.readJson('github-cache.json', { fetchedAt: 0, repos: {} });
  }

  setGithubCache(cache) {
    this.writeJson('github-cache.json', cache, true);
  }

  // 本地扫描磁盘缓存（issue #22）：projects[path] = { ...project, headSha }（issue #23 分档用）
  getScanCache() {
    const c = this.readJson('scan-cache.json', { scannedAt: 0, projects: {} });
    if (!c.projects || typeof c.projects !== 'object') c.projects = {};
    return c;
  }

  setScanCache(cache) {
    this.writeJson('scan-cache.json', cache, true);
  }

  // AI 结果缓存（issue #29）：weekly 按当天日期复用；advice 按 项目+HEAD+模板哈希+事实摘要签名 复用（issue #78/#131）
  getAiCache() {
    const c = this.readJson('ai-cache.json', { weekly: null, advice: {} });
    if (!c.advice || typeof c.advice !== 'object') c.advice = {};
    return c;
  }

  setAiCache(cache) {
    this.writeJson('ai-cache.json', cache, true);
  }

  getLastNotifyDate() {
    return this.readJson('meta.json', {}).lastNotifyDate || '';
  }

  setLastNotifyDate(dateStr) {
    const meta = this.readJson('meta.json', {});
    meta.lastNotifyDate = dateStr;
    this.writeJson('meta.json', meta);
  }

  // 「仅新增」通知时机（issue #80）：每日评估时把当时的需要关注数落盘，作为次日的新增对比基线
  getAttentionBaseline() {
    const v = this.readJson('meta.json', {}).attentionBaseline;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  setAttentionBaseline(n) {
    const meta = this.readJson('meta.json', {});
    meta.attentionBaseline = n;
    this.writeJson('meta.json', meta);
  }
}

module.exports = { Store, DEFAULT_CONFIG, DEFAULT_PREFS };
