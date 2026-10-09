// GitHub 鉴权/账号域 IPC（issue #124 第一刀）：github:test / authCaps / deviceStart / devicePoll /
// importGh / status / disconnect / itemDetail 八个 handler + 通知快照清理 + 登录名自愈，从 ipc.js 分出。
// deps: { store, onAuthChanged }——onAuthChanged(connected) 由主干注入（refreshGithubNow），
// 保住「连接/导入后立即拉一轮、断开立即重推拼板」（issue #118）的板域语义；
// 通道名与 payload 全程不变。挂载由主干 registerIpc 在 handle 包错 patch 之后统一调用。
'use strict';

const { ipcMain } = require('electron');
const github = require('./github');

module.exports = function registerGithub({ store, onAuthChanged }) {
  // 通知快照随账号失效（issue #158）：断开/换号/新 token 落盘时清掉 github-cache 的 notifications，
  // 未读快照属于拉它的账号，TTL 内残留会被新账号看到（refreshNotifications 的 fetchedFor 兜底之外的主清理口）
  function clearGithubNotifyCache() {
    const cache = store.getGithubCache();
    if (cache.notifications) {
      delete cache.notifications;
      store.setGithubCache(cache);
    }
  }

  // 历史安装自愈：token 已配置但 username 为空（旧版导入不落登录名，issue #44）时，
  // 用 token 反查登录名落盘，GitHub 数据挂接随之恢复。buildBoard 在主干调用，经返回值暴露
  let ghHealTried = false;
  function healGithubUsername(config) {
    if (ghHealTried || !config.githubToken || config.githubUsername) return;
    ghHealTried = true;
    github.testConnection(config.githubToken).then((r) => {
      if (r && r.ok && r.login) store.setConfig({ githubUsername: r.login });
    }).catch(() => {});
  }

  // 设置页辅助：GitHub Token 测试连接，并校验登录名与填写用户名一致
  ipcMain.handle('github:test', async (_e, token, username) => {
    const cfg = store.getConfig();
    const t = String(token || '').trim() || cfg.githubToken;
    const u = String(username || '').trim() || cfg.githubUsername;
    if (!t) return { ok: false, reason: 'Token 为空' };
    const r = await github.testConnection(t);
    if (!r.ok) return r;
    if (u && r.login.toLowerCase() !== u.toLowerCase()) {
      return { ok: false, reason: `Token 有效，但登录名是 ${r.login}，与填写的不一致` };
    }
    return r;
  });

  // 鉴权入口能力探测：设备码授权需已配置 Client ID；gh 导入需本机 gh CLI 可用（issue #12）
  ipcMain.handle('github:authCaps', async () => ({
    deviceFlow: !!github.DEVICE_FLOW_CLIENT_ID,
    ghCli: await github.ghCliAvailable(),
  }));

  ipcMain.handle('github:deviceStart', () => github.deviceStart());

  // 设备码轮询；成功即加密落盘 token + 登录名（username 缺失会导致 GitHub 数据永不挂接，issue #44）
  ipcMain.handle('github:devicePoll', async (_e, deviceCode) => {
    const r = await github.devicePoll(String(deviceCode || ''));
    if (r.status !== 'success') return r;
    const t = await github.testConnection(r.token);
    if (!t.ok) return { status: 'error', reason: t.reason };
    store.setConfig({ githubToken: r.token, githubUsername: t.login });
    clearGithubNotifyCache(); // 新 token 落盘即弃旧账号通知快照（issue #158），随后的强制拉取立即补新
    onAuthChanged(true); // 授权成功立即拉一轮并走「落地即推补丁」链路（issue #118），不等下一个刷新触发点
    return { status: 'success', login: t.login };
  });

  // 从 gh CLI 导入 token：验证有效后加密落盘 token + 登录名（issue #44）
  ipcMain.handle('github:importGh', async () => {
    const token = await github.importGhToken();
    if (!token) return { ok: false, reason: '未检测到 gh CLI 登录（gh auth login 后重试）' };
    const t = await github.testConnection(token);
    if (!t.ok) return { ok: false, reason: t.reason };
    store.setConfig({ githubToken: token, githubUsername: t.login });
    clearGithubNotifyCache(); // 同 devicePoll：旧账号未读不得在 TTL 内冒充新账号的（issue #158）
    onAuthChanged(true); // 导入成功立即拉一轮并走「落地即推补丁」链路（issue #118）
    return { ok: true, login: t.login };
  });

  // 账户状态卡（issue #45）：已配置 token 时在线验证并返回头像/显示名/连通性
  ipcMain.handle('github:status', async () => {
    const cfg = store.getConfig();
    if (!cfg.githubToken) return { configured: false };
    const r = await github.testConnection(cfg.githubToken);
    if (!r.ok) return { configured: true, ok: false, login: cfg.githubUsername || '', reason: r.reason };
    return { configured: true, ok: true, login: r.login, name: r.name, avatarUrl: r.avatarUrl };
  });

  // 断开连接：清除 token 与登录名（GitHub 数据挂接随之停止）
  ipcMain.handle('github:disconnect', () => {
    store.setConfig({ githubToken: '', githubUsername: '' });
    clearGithubNotifyCache(); // 通知快照随账号失效（issue #158）：断开后残留未读会被下一账号在 TTL 内看到
    onAuthChanged(false); // 立即重推一次拼板，渲染层即时清掉 GitHub 区块（issue #118）
    return true;
  });

  // 单条 issue/PR 展开详情（issue #146）：按需拉取不进缓存，展开时现拉现用；
  // 仅本人仓库可达（渲染层只在 github 挂接成功时展出入口），这里仍校验 token 兜底
  ipcMain.handle('github:itemDetail', async (_e, payload) => {
    const { owner, repo, type, number } = payload || {};
    const cfg = store.getConfig();
    if (!cfg.githubToken) throw new Error('未配置 GitHub');
    return github.fetchItemDetail(String(owner || ''), String(repo || ''), String(type || ''), number, cfg.githubToken);
  });

  return { healGithubUsername };
};
