// 渲染层纯逻辑单测（issue #160/#163/#165 回归）：不起 Electron、不引第三方 DOM 库——
// 用最小 hand-rolled document stub 跑真实 src/renderer/app.js，经真实入口走真实代码断言。
//   #160 错误态行点击原地重试（点击语义=重试而非折叠）
//   #163 通知旧数据 + error 并存时副标带失败提示
//   #165 启动时序：settings 晚于首板 resolve 时补渲通知卡
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

/* ---------- 最小 DOM stub（仅覆盖 app.js 用到的接口） ---------- */
function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); },
    },
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getPropertyValue(k) { return this._props[k] || ''; },
      removeProperty(k) { delete this._props[k]; },
    },
    dataset: {},
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    title: '',
    children: [],
    parentNode: null,
    _listeners: {},
    _attrs: {},
    _innerHTML: '',
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { if (c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); } return c; },
    insertBefore(c, ref) {
      if (c && c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (c) c.parentNode = this;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = this._listeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(t, ev) { (this._listeners[t] || []).slice().forEach((fn) => fn.call(this, ev || {})); },
    click() { this.dispatch('click', { stopPropagation() {}, preventDefault() {}, target: this }); },
    querySelector(sel) {
      const want = String(sel).replace(/^[.#]/, '');
      const stack = this.children.slice();
      while (stack.length) {
        const n = stack.shift();
        if (n.tagName && (n.id === want || String(n.className).split(' ').indexOf(want) >= 0)) return n;
        if (n.children) stack.push.apply(stack, n.children);
      }
      return null;
    },
    querySelectorAll: (sel) => {
    // '#nav button' / '#bandChips button' 形态：按 id 找容器，返回子元素
    const parts = String(sel).split(' ');
    const idPart = parts[0].replace(/^[.#]/, '');
    const container = byId[idPart];
    if (!container) return [];
    if (parts.length === 1) return container.children.slice();
    const tagWant = parts[1].toUpperCase();
    return container.children.filter((c) => c.tagName === tagWant);
  },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    cloneNode() { return makeEl(this.tagName); },
    focus() {}, blur() {}, select() {},
    get scrollHeight() { return 0; },
    set scrollHeight(v) {},
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
    get childElementCount() { return this.children.length; }, // renderThemeCards 首建判断用（stub 此前缺该属性）
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
  };
}

// 用 index.html 预置全部 id 元素（缺一 app.js 启动即抛）
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const byId = {};
const ID_RE = /id="([^"]+)"/g;
let m;
while ((m = ID_RE.exec(html))) {
  const e = makeEl('div');
  e.id = m[1];
  byId[m[1]] = e;
}
// 模拟 class（hidden 等）：按 index.html 的 class 属性回填 classList
const CLS_RE = /class="([^"]*)"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*class="([^"]*)"/g;
while ((m = CLS_RE.exec(html))) {
  const cls = m[1] || m[4] || '';
  const id = m[2] || m[3];
  const el = byId[id];
  if (!el) continue;
  el.className = cls;
  cls.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
}
// 常驻 body 级元素
byId.__body = makeEl('body');
byId.__html = makeEl('html');
// 无 id 的关键元素（app.js 经 querySelector 取，如 .settings-body）：预挂到 body 下
[['settings-body', 'div'], ['toast', 'div']].forEach(([cls, tag]) => {
  const e = makeEl(tag);
  e.className = cls;
  e.classList.add(cls);
  byId.__body.appendChild(e);
});

const docListeners = {};
const fakeDoc = {
  getElementById: (id) => byId[id] || null,
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const l = docListeners[t];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  querySelector: (sel) => {
    // 仅支持 '.settings-body' 等单类选择器（app.js 启动期用到的唯一 querySelector）
    const want = String(sel).replace(/^[.#]/, '');
    const isCls = String(sel).charAt(0) === '.';
    const stack = [byId.__body].concat(Object.keys(byId).map((k) => byId[k]));
    while (stack.length) {
      const n = stack.shift();
      if (!n || !n.tagName) continue;
      if (isCls ? String(n.className).split(' ').indexOf(want) >= 0 : n.id === want) return n;
      if (n.children) stack.push.apply(stack, n.children);
    }
    return null;
  },
  querySelectorAll: () => [],
  body: byId.__body,
  documentElement: byId.__html,
  title: '',
  hidden: false,
  visibilityState: 'visible',
  createElementNS: (ns, t) => makeEl(t),
};
global.document = fakeDoc;

/* ---------- 可控 API stub ---------- */
let settingsGate = null;
let releaseSettings = null; // #165 时序：在 require 前挂 gate，test 主体释放
let boardPayload = null;
let showSettingsCb = null; // #124 设置域拆分：捕获 onShowSettings 回调，供测试真实开合设置页
let lastSettingsPatch = null; // 捕获最近一次自动保存补丁（settings.js 保存链断言用）
const patchHandlers = [];
const itemDetailCalls = [];
const apiCalls = { getSettings: 0, getBoard: 0 };
let itemDetailImpl = () => Promise.resolve({ body: '首次正文', comments: [], pr: null });

const SETTINGS = {
  density: 'normal', landingView: 'overview', reduceMotion: false,
  hasGithubToken: true, githubToken: 'tok', aiEnabled: false,
  aiEngine: '', aiTools: [], roots: [], extraPaths: [], blacklist: [],
  themeId: 'warm', accent: '', onTop: false, autoStart: false,
  scanInterval: 0, warnDirtyDays: 3, warnDirty: true, warnUnpushed: true,
  warnCi: true, warnReview: true, warnPr: true, notifyEnabled: true,
  notifyMode: 0, trayCount: true, editor: '', terminal: '', hotkey: '',
  fEditor: '', fTerminal: '', fHotkey: '', fAccentHex: '',
};
const api = {
  getSettings: () => {
    apiCalls.getSettings++;
    return new Promise((res, rej) => {
      const cfg = Object.assign({}, SETTINGS);
      if (settingsGate) settingsGate.then(() => res(cfg), rej);
      else res(cfg);
    });
  },
  setSettings: (p) => { lastSettingsPatch = p; return Promise.resolve(Object.assign({}, SETTINGS, p)); },
  getHotkeyError: () => Promise.resolve(''),
  getAutoStartError: () => Promise.resolve(''),
  getPrefs: () => Promise.resolve({ sortMode: 'manual', branchSel: {}, pins: [], snoozes: [], theme: null, landingView: null, onboarded: true }),
  setPrefs: () => Promise.resolve({}),
  getBoard: () => { apiCalls.getBoard++; return Promise.resolve(boardPayload); },
  rescan: () => Promise.resolve(boardPayload),
  onBoardPatch: (cb) => patchHandlers.push(cb),
  onBoardScanfail() {},
  onTick() {},
  onWinShown() {},
  onShowSettings(cb) { showSettingsCb = cb; },
  aiToolsList: () => Promise.resolve([]),
  aiToolsOpen: () => Promise.resolve(true),
  aiCaps: () => Promise.resolve({ enabled: false, engine: null }),
  aiAsk: () => Promise.resolve({ empty: true }),
  aiPromptPreview: () => Promise.resolve({ text: '' }),
  setMemo: () => Promise.resolve(true),
  snooze: () => Promise.resolve(true),
  scanPreview: () => Promise.resolve({ count: 0, names: [], invalidRoots: [], invalidExtra: [] }),
  githubStatus: () => Promise.resolve({ configured: false }),
  githubAuthCaps: () => Promise.resolve({ deviceFlow: false, ghCli: false }),
  githubDeviceStart: () => Promise.resolve({ ok: false }),
  githubDevicePoll: () => Promise.resolve({ status: 'error' }),
  githubImportGh: () => Promise.resolve({ ok: false }),
  githubDisconnect: () => Promise.resolve(true),
  githubItemDetail: (payload) => { itemDetailCalls.push(payload); return itemDetailImpl(payload); },
  branchCommits: () => Promise.resolve({ lastCommitAt: null, commits: [] }),
  projectDetail: () => Promise.resolve({ readme: '', aiSessions: [] }),
  openExternal() {},
  winMin() {}, winMax() {}, winClose() {},
  quickOpen: () => Promise.resolve(true),
  checkCommand: () => Promise.resolve({ ok: true, reason: '' }),
  pickPath: () => Promise.resolve(null),
  openDataDir() {},
  exportData: () => Promise.resolve({ ok: true }),
  importData: () => Promise.resolve({ ok: true }),
  resetData: () => Promise.resolve(true),
  testGithub: () => Promise.resolve({ ok: false }),
};

const constants = require('../src/shared/constants');
const aiTools = require('../src/shared/ai-tools');
global.window = {
  devboard: api,
  devboardConsts: Object.assign({}, constants, aiTools.rendererConsts()),
  devboardThemes: require('../src/shared/themes'),
  devboardBoot: { theme: null },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
  devicePixelRatio: 1,
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://localhost/', search: '' },
  navigator: { clipboard: { writeText: async () => {} } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
// Node 22 的 global.navigator 是 getter-only：只读别名即可（app.js 不改写它）
void global.window.navigator;
global.requestAnimationFrame = global.window.requestAnimationFrame;
global.cancelAnimationFrame = global.window.cancelAnimationFrame;
global.matchMedia = global.window.matchMedia;
global.localStorage = global.window.localStorage;
global.getComputedStyle = global.window.getComputedStyle;
global.HTMLElement = function HTMLElement() {};
global.Node = function Node() {};
global.MutationObserver = function () { return { observe() {}, disconnect() {} }; };
global.ResizeObserver = function () { return { observe() {}, disconnect() {} }; };
global.IntersectionObserver = function () { return { observe() {}, disconnect() {} }; };

const BOARD_KEY = Symbol('board');
const makeBoard = (opts) => {
  opts = opts || {};
  const proj = {
    path: 'E:\\p\\alpha', name: 'alpha', branch: 'main', commits7d: 3,
    recentCommits: [{ msg: 'x', rel: '1 天前' }],
    dirtyCount: 0, dirtyAt: null, dirtyFiles: [], ahead: 0, behind: 0,
    lastCommitAt: new Date().toISOString(), headSha: 'abc123',
    activity365: new Array(365).fill(0), warnings: [],
    githubOwned: true, githubError: null,
    github: {
      owner: 'Yaemikoreal', repo: 'devboard',
      openIssues: 1, openPRs: 0, prNumbers: [],
      items: [{ type: 'issue', number: opts.itemNumber || 7, title: '修复通知卡', url: 'https://x/' + (opts.itemNumber || 7) }],
      prReviews: [], meta: null, ci: null, release: null,
    },
    memo: '', aiSessionAt: null, band: 'active',
  };
  const notif = {
    fetchedAt: Date.now(), fetchedFor: 'me', error: null,
    data: [{ id: 1, repo: 'Yaemikoreal/devboard', title: '提及', subjectType: 'Issue', reason: 'mention', reasonLabel: '提及', htmlUrl: 'https://x', updatedAt: new Date().toISOString() }],
  };
  if (opts.notifError !== undefined) notif.error = opts.notifError;
  if (opts.notifData !== undefined) notif.data = opts.notifData;
  const board = {
    scannedAt: new Date().toISOString(),
    stats: { total: 1, commits7d: 3, attentionCount: 0 },
    attention: [], projects: [proj],
    notifications: notif,
  };
  board[BOARD_KEY] = true;
  return board;
};

/* ---------- #165 时序布置（必须在 require 前就位） ----------
   app.js 在 require 时即并发发起 getSettings 与 getBoard（启动序列在 app.js 尾部）：
   gate 要拦住首次 getSettings 必须先挂上；首板要先 resolve 则 boardPayload 必须先就位。
   这正是 issue #165 的生产时序窗——settings 晚于首板 resolve。 */
boardPayload = makeBoard();
settingsGate = new Promise((r) => { releaseSettings = r; });

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
require(path.join(__dirname, '..', 'src', 'renderer', 'ai.js')); // AI 域工厂先挂 window（issue #124 渲染层拆分）
require(path.join(__dirname, '..', 'src', 'renderer', 'settings.js')); // 设置域工厂先挂 window（issue #124 渲染层拆分）
require(APP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ========== #165：settings 晚于首板 resolve，通知卡须补渲 ========== */
  // 时序在 require 前已布置：此刻首板已渲染（state.settings=null 时 renderGhNotify 判
  // 「未连接」藏卡，即生产时序窗），settings 仍挂在 gate 上
  {
    await sleep(80); // 首板已 resolve，settings 仍挂着
    const card = byId.ghNotifyCard;
    assert.ok(card.classList.contains('hidden'),
      'settings 未到位时通知卡应隐藏（复现时序窗起点）');
    releaseSettings();
    settingsGate = null;
    await sleep(80);
    assert.ok(!card.classList.contains('hidden'),
      'settings 晚于首板 resolve 时应补渲通知卡（issue #165）');
    const sub = byId.ghNotifySub;
    assert.ok(String(sub.textContent).indexOf('1 条未读') >= 0,
      '副标应展示未读数，实际: ' + JSON.stringify(sub.textContent));
    assert.ok(String(sub.textContent).indexOf('同步失败') < 0,
      '无 error 时副标不应带失败提示');
  }

  /* ========== #124 渲染层拆分：设置域（settings.js）经真实入口开合与自动保存 ========== */
  {
    assert.ok(typeof showSettingsCb === 'function', 'onShowSettings 回调应已注册（设置域工厂挂载完成）');
    showSettingsCb(); // 打开设置（等效 settingsBtn / 托盘 onShowSettings 触发）
    await sleep(60);
    assert.ok(byId.app.classList.contains('show-settings'), 'showSettings 应展示设置视图');
    assert.strictEqual(document.body.dataset.density, 'standard', '启动序列应已应用密度档位（applyStartupAppearance）');
    assert.ok(byId.themeCards.children.length >= 2, '主题卡应已渲染（自动卡 + 预设，主题域随设置域拆分后仍随打开回填）');
    assert.strictEqual(byId.fThemeLight.children.length >= 1, true, '浅色主题对下拉应有选项');
    assert.ok(String(byId.fToken.placeholder).indexOf('已保存') >= 0,
      '已配置 token 时占位符应为「已保存（输入以更换）」，实际: ' + JSON.stringify(byId.fToken.placeholder));
    assert.strictEqual(byId.rootsList.children.length, 0, '空 roots 配置应回填 0 行');
    assert.strictEqual(byId.aiToolsList.children.length, 0, '空 aiTools 配置应回填 0 行');
    // 模拟设置页输入停顿 → 自动保存链（settings.js silentSave）
    byId.fEditor.value = 'vim';
    document.querySelector('.settings-body').dispatch('input', { target: byId.fEditor });
    await sleep(850); // 停顿 700ms 落盘
    assert.ok(lastSettingsPatch && lastSettingsPatch.editorCmd === 'vim',
      '输入停顿后应经 settings.js 保存链自动落盘，实际: ' + JSON.stringify(lastSettingsPatch && lastSettingsPatch.editorCmd));
    assert.ok(lastSettingsPatch.theme && lastSettingsPatch.theme.id === 'warm',
      '自动保存应携带当前主题（主题域在 settings.js）: ' + JSON.stringify(lastSettingsPatch && lastSettingsPatch.theme));
    assert.ok(Array.isArray(lastSettingsPatch.roots) && Array.isArray(lastSettingsPatch.aiTools),
      '自动保存应包含扫描域三键与 AI 工具清单');
    byId.settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} }); // settingsBtn 切换语义 → hideSettings → flushSave
    await sleep(40);
    assert.ok(!byId.app.classList.contains('show-settings'), 'settingsBtn 再次点击应隐藏设置视图');
  }

  /* ========== #163：旧数据 + error 并存，副标追加失败提示 ========== */
  {
    // handleBoardPatch 对「同代次整板补丁」去重——补丁须带新 scanGeneration 才会落地
    let gen = 2;
    const pushPatch = (opts) => {
      const b = makeBoard(opts);
      b.scanGeneration = gen++;
      patchHandlers.forEach((cb) => cb(b));
    };
    pushPatch({ notifError: '网络错误' });
    await sleep(30);
    const card = byId.ghNotifyCard;
    const sub = byId.ghNotifySub;
    assert.ok(!card.classList.contains('hidden'),
      '有旧数据时错误不应整卡隐藏（旧数据照展）');
    assert.ok(String(sub.textContent).indexOf('同步失败，数据可能过期') >= 0,
      'error 存在时副标应追加失败提示，实际: ' + JSON.stringify(sub.textContent));
    assert.ok(sub.classList.contains('bad'), 'error 副标应染警示类');
    assert.ok(byId.ghNotifyList.children.length >= 1, '旧数据列表应照常展出');

    pushPatch({});
    await sleep(30);
    assert.ok(String(byId.ghNotifySub.textContent).indexOf('同步失败') < 0,
      'error 清除后副标不应残留失败提示');
    assert.ok(!byId.ghNotifySub.classList.contains('bad'),
      'error 清除后警示类应摘除');

    pushPatch({ notifError: '网络错误', notifData: [] });
    await sleep(30);
    assert.ok(String(byId.ghNotifySub.textContent).indexOf('同步失败：网络错误') >= 0,
      '无旧数据时应走整卡失败文案，实际: ' + JSON.stringify(byId.ghNotifySub.textContent));
  }

  /* ========== #160：错误态行点击原地重试（点击=重试而非折叠） ========== */
  {
    // renderPanel 每次整面板重建 DOM，旧行节点的闭包捕获的是旧 open 值——
    // 断言与点击必须用「当前」行引用，统一即时重取
    const findGhRow = () => {
      let row = null;
      const stack = byId.panelIn.children.slice();
      while (stack.length && !row) {
        const n = stack.shift();
        if (n.className && String(n.className).indexOf('gh-item') >= 0) row = n;
        if (n.children) stack.push.apply(stack, n.children);
      }
      return row;
    };
    const findErrNote = () => {
      let note = null;
      const stack = byId.panelIn.children.slice();
      while (stack.length && !note) {
        const n = stack.shift();
        if (n.className && String(n.className).indexOf('gh-detail-note bad') >= 0) note = n;
        if (n.children) stack.push.apply(stack, n.children);
      }
      return note;
    };
    const pushB = (opts, gen) => {
      const b = makeBoard(opts);
      b.scanGeneration = gen;
      patchHandlers.forEach((cb) => cb(b));
    };
    const clickRow = (row) => row.dispatch('click', { stopPropagation() {}, preventDefault() {} });

    pushB({}, 99);
    await sleep(30);
    assert.ok(byId.rows.children.length >= 1, '项目行应已渲染，实际 ' + byId.rows.children.length);
    byId.rows.children[0].dispatch('click', { stopPropagation() {}, preventDefault() {} });
    await sleep(30);

    // 1) 首次展开：现拉一次
    itemDetailImpl = () => Promise.resolve({ body: '首次正文', comments: [], pr: null });
    let ghRow = findGhRow();
    assert.ok(ghRow, '详情面板应渲染出 gh-item 行');
    clickRow(ghRow);
    await sleep(40);
    assert.strictEqual(itemDetailCalls.length, 1, '首次展开应发起拉取');

    // 2) 点击展开态条目应折叠（不重拉）
    ghRow = findGhRow(); // 拉取完成触发的重渲已换掉行节点，须重取
    assert.ok(ghRow && String(ghRow.className).indexOf('open') >= 0, '拉取完成后条目应处于展开态');
    clickRow(ghRow);
    await sleep(30);
    ghRow = findGhRow();
    assert.ok(ghRow && String(ghRow.className).indexOf('open') < 0, '点击展开态条目应折叠');

    // 3) 再展开：TTL 内缓存命中，不重拉
    clickRow(ghRow);
    await sleep(30);
    assert.strictEqual(itemDetailCalls.length, 1, '缓存命中不应重拉');

    // 4) 制造错误态（issue #160 前置）：换一个无缓存的新条目，拉取 reject →
    //    错误落共享缓存 → 重渲展出可重试错误行
    pushB({ itemNumber: 8 }, 100);
    await sleep(30);
    itemDetailImpl = () => Promise.reject(new Error('网络炸了'));
    ghRow = findGhRow();
    assert.ok(ghRow && String(ghRow.className).indexOf('open') < 0, '补丁换新条目后应处于折叠态');
    clickRow(ghRow);
    await sleep(40);
    ghRow = findGhRow();
    assert.ok(ghRow && String(ghRow.className).indexOf('open') >= 0, '拉取失败条目应保持展开');
    assert.ok(findErrNote() && String(findErrNote().textContent).indexOf('点击条目重试') >= 0,
      '失败应展出可重试的错误行');

    // 5) 核心断言：展开态点击错误行 → 原地重试（清错误缓存 + 保持展开 + 重新拉取），而非折叠
    const callsBefore = itemDetailCalls.length;
    itemDetailImpl = () => Promise.resolve({ body: '重试成功', comments: [], pr: null });
    clickRow(ghRow);
    await sleep(40);
    assert.ok(itemDetailCalls.length > callsBefore,
      '错误态点击应重新发起拉取（原地重试，issue #160），实际调用 ' + itemDetailCalls.length);
    ghRow = findGhRow();
    assert.ok(ghRow && String(ghRow.className).indexOf('open') >= 0,
      '错误态重试后条目应保持展开（点击语义是重试而非折叠）');
  }

  console.log('test-renderer: 全部断言通过');
}

main().catch((err) => {
  console.error('test-renderer 失败:', (err && err.stack) || err);
  process.exit(1);
});
