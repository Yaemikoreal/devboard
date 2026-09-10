// GitHub issues/PR 拉取 + 10 分钟 JSON 缓存。仅覆盖 owner 是使用者的仓库，fork 上游自然跳过。
'use strict';

const { execFile } = require('child_process');

const TTL_MS = 10 * 60 * 1000;

// OAuth Device Flow 需要在 GitHub 注册 OAuth App 后把 Client ID 填到这里（issue #12）；
// 为空时设置页自动隐藏「设备码授权」入口，改用「从 gh CLI 导入」/ 手动粘贴 token。
const DEVICE_FLOW_CLIENT_ID = '';
// Device Flow 申请的 scope：读本人仓库（含私有）的 issues/PR 需要 repo；
// GitHub OAuth 没有更细的只读 repo scope，公开仓库场景可置空。
const DEVICE_FLOW_SCOPE = 'repo';

function parseGitHubRemote(url) {
  if (!url) return null;
  let m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// 单仓拉取：15s 超时 + 失败重试一次（本机到 api.github.com 偶发 TLS 断连，单次失败率不低，issue #44 实测）
async function fetchIssues(owner, repo, token) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`,
        {
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'devboard',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const list = await res.json();
      const issues = list.filter((it) => !it.pull_request);
      const prs = list.filter((it) => it.pull_request);
      const toItem = (it, type) => ({ type, number: it.number, title: it.title, url: it.html_url });
      return {
        owner,
        repo,
        openIssues: issues.length,
        openPRs: prs.length,
        items: prs.map((it) => toItem(it, 'pr')).concat(issues.map((it) => toItem(it, 'issue'))).slice(0, 20),
      };
    } catch (err) {
      lastErr = err;
      if (String(err && err.message).startsWith('GitHub API 4')) break; // 4xx 重试无意义
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 读缓存挂接 github 字段（不发网络请求）；返回需要刷新的 repo 列表
// 同时标记 p.githubOwned（owner 是否本人，大小写不敏感），渲染层据此区分「同步中」与「非本人仓库」（issue #44）
function attachFromCache(projects, config, store) {
  const cache = store.getGithubCache();
  const stale = [];
  const now = Date.now();
  const me = String(config.githubUsername || '').toLowerCase();
  for (const p of projects) {
    p.github = null;
    p.githubOwned = false;
    if (!p.originUrl) continue;
    const remote = parseGitHubRemote(p.originUrl);
    if (!remote || remote.owner.toLowerCase() !== me) continue; // fork 上游跳过
    p.githubOwned = true;
    if (!config.githubToken || !me) continue;
    const key = `${remote.owner}/${remote.repo}`;
    const entry = cache.repos[key];
    if (entry) {
      p.github = entry.data;
      if (now - entry.fetchedAt >= TTL_MS) stale.push(remote);
    } else {
      stale.push(remote);
    }
  }
  return stale;
}

// 后台刷新缓存：失败静默保留旧缓存；返回是否有更新（供主进程补推整板补丁，issue #44）
async function refreshCache(remotes, config, store) {
  if (!remotes.length || !config.githubToken) return false;
  const cache = store.getGithubCache();
  const results = await Promise.all(
    remotes.map((r) => fetchIssues(r.owner, r.repo, config.githubToken).catch(() => null))
  );
  let changed = false;
  results.forEach((data, i) => {
    if (!data) return;
    cache.repos[`${remotes[i].owner}/${remotes[i].repo}`] = { fetchedAt: Date.now(), data };
    changed = true;
  });
  if (changed) {
    cache.fetchedAt = Date.now();
    store.setGithubCache(cache);
  }
  return changed;
}

// PR 警示需要在 github 挂接后补充
function applyPrWarnings(projects) {
  for (const p of projects) {
    if (p.github && p.github.openPRs > 0) {
      p.warnings.push({ type: 'pr', label: `${p.github.openPRs} 个开放 PR` });
    }
  }
}

// 设置页「测试连接」：验证 token 有效性并返回实际登录名
async function testConnection(token) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'devboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) return { ok: false, reason: 'Token 无效或已过期' };
    if (!res.ok) return { ok: false, reason: `GitHub API ${res.status}` };
    const data = await res.json();
    // 顺带带回头像与显示名，设置页账户状态卡用（issue #45）
    return { ok: true, login: data.login, name: data.name || '', avatarUrl: data.avatar_url || '' };
  } catch {
    return { ok: false, reason: '网络错误，无法连接 GitHub' };
  }
}

/* ---------- 鉴权简化（issue #12） ---------- */

function ghCliAvailable() {
  return new Promise((resolve) => {
    execFile('gh', ['--version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// 从本机已登录的 gh CLI 导入 token（不离开应用的兜底授权路径）
function importGhToken() {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : (String(stdout).trim() || null));
    });
  });
}

// OAuth Device Flow 第一步：取设备码（8 位 user_code 展示给用户）
async function deviceStart() {
  if (!DEVICE_FLOW_CLIENT_ID) return { ok: false, reason: '应用尚未配置 OAuth Client ID' };
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: DEVICE_FLOW_CLIENT_ID, scope: DEVICE_FLOW_SCOPE }),
    });
    if (!res.ok) return { ok: false, reason: `GitHub API ${res.status}` };
    const d = await res.json();
    if (d.error) return { ok: false, reason: d.error_description || d.error };
    return {
      ok: true,
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri || 'https://github.com/login/device',
      interval: Math.max(1, d.interval || 5),
      expiresIn: d.expires_in || 900,
    };
  } catch {
    return { ok: false, reason: '网络错误，无法连接 GitHub' };
  }
}

// OAuth Device Flow 第二步：渲染层按 interval 轮询；success 时返回 token
async function devicePoll(deviceCode) {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: DEVICE_FLOW_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const d = await res.json();
    if (d.access_token) return { status: 'success', token: d.access_token };
    if (d.error === 'authorization_pending') return { status: 'pending' };
    if (d.error === 'slow_down') return { status: 'slow_down' };
    if (d.error === 'expired_token') return { status: 'error', reason: '设备码已过期，请重新开始' };
    if (d.error === 'access_denied') return { status: 'error', reason: '已取消授权' };
    return { status: 'error', reason: d.error_description || d.error || '授权失败' };
  } catch {
    return { status: 'error', reason: '网络错误，无法连接 GitHub' };
  }
}

module.exports = {
  parseGitHubRemote,
  fetchIssues,
  attachFromCache,
  refreshCache,
  applyPrWarnings,
  testConnection,
  ghCliAvailable,
  importGhToken,
  deviceStart,
  devicePoll,
  DEVICE_FLOW_CLIENT_ID,
};
