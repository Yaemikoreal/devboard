// GitHub issues/PR 拉取 + 10 分钟 JSON 缓存。仅覆盖 owner 是使用者的仓库，fork 上游自然跳过。
'use strict';

const TTL_MS = 10 * 60 * 1000;

function parseGitHubRemote(url) {
  if (!url) return null;
  let m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function fetchIssues(owner, repo, token) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`,
    {
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
}

// 读缓存挂接 github 字段（不发网络请求）；返回需要刷新的 repo 列表
function attachFromCache(projects, config, store) {
  const cache = store.getGithubCache();
  const stale = [];
  const now = Date.now();
  for (const p of projects) {
    p.github = null;
    if (!config.githubToken || !config.githubUsername || !p.originUrl) continue;
    const remote = parseGitHubRemote(p.originUrl);
    if (!remote || remote.owner !== config.githubUsername) continue; // fork 上游跳过
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

// 后台刷新缓存：失败静默保留旧缓存
async function refreshCache(remotes, config, store) {
  if (!remotes.length || !config.githubToken) return;
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
    return { ok: true, login: data.login };
  } catch {
    return { ok: false, reason: '网络错误，无法连接 GitHub' };
  }
}

module.exports = { parseGitHubRemote, fetchIssues, attachFromCache, refreshCache, applyPrWarnings, testConnection };
