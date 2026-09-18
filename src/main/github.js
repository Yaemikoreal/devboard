// GitHub issues/PR/CI 拉取 + 10 分钟 JSON 缓存。仅覆盖 owner 是使用者的仓库，fork 上游自然跳过。
'use strict';

const { execFile } = require('child_process');

const TTL_MS = 10 * 60 * 1000;
// 失败条目短 TTL：网络抖动恢复后 3 分钟内自动重试，不等完整 10 分钟（issue #46）
const FAIL_TTL_MS = 3 * 60 * 1000;

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

// GitHub REST 请求头工厂（issue #128）：issues 拉取与连接测试共用同一组头
function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'devboard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// 单仓拉取：12s 超时 + 至多 3 次尝试（递增退避）。
// 本机到 api.github.com 偶发 TLS 断连，单次失败率不低（issue #44/#46 实测），
// 多一次尝试可把「两次都撞上断连」的概率再压一个量级
// 跟随分页拉全量（返回不足整页即末页），5 页封顶防失控：issue+PR 超 500 的仓库罕见
const MAX_PAGES = 5;
async function fetchIssues(owner, repo, token) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
          {
            signal: ctrl.signal,
            headers: apiHeaders(token),
          }
        );
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        const list = await res.json();
        all.push.apply(all, list);
        if (list.length < 100) break; // 不足整页 = 已到末页
      }
      const issues = all.filter((it) => !it.pull_request);
      const prs = all.filter((it) => it.pull_request);
      const toItem = (it, type) => ({ type, number: it.number, title: it.title, url: it.html_url });
      return {
        owner,
        repo,
        openIssues: issues.length,
        openPRs: prs.length,
        prNumbers: prs.map((it) => it.number), // 开放 PR 号清单，review 逐个拉取用（issue #144）
        items: prs.map((it) => toItem(it, 'pr')).concat(issues.map((it) => toItem(it, 'issue'))).slice(0, 20),
      };
    } catch (err) {
      lastErr = err;
      if (String(err && err.message).startsWith('GitHub API 4')) break; // 4xx 重试无意义
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // 递增退避：0.8s / 1.6s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 仓库元数据（issue #143）：默认分支名是 CI 运行查询的定位参数；pushed_at/description 随手带回，
// 供详情面板元数据交叉验证（issue #146）复用
async function fetchRepoMeta(owner, repo, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      signal: ctrl.signal,
      headers: apiHeaders(token),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const d = await res.json();
    return { defaultBranch: d.default_branch || '', pushedAt: d.pushed_at || null, description: d.description || '' };
  } finally {
    clearTimeout(timer);
  }
}

// 默认分支最近一次 workflow 运行（issue #143）。无 Actions 的仓库按无数据处理：
// 404/403（Actions 禁用）等非 200 与网络失败一律返回 null 不报错，不产生失败条目
async function fetchCiRun(owner, repo, branch, token) {
  if (!branch) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
        { signal: ctrl.signal, headers: apiHeaders(token) }
      );
      if (!res.ok) return null;
      const d = await res.json();
      const run = d && d.workflow_runs && d.workflow_runs[0];
      if (!run) return null;
      return {
        conclusion: run.conclusion || null, // null = 运行中，不算失败
        status: run.status || '',
        name: run.name || '',
        url: run.html_url || '',
        createdAt: run.created_at || null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // CI 状态是锦上添花，单点失败不拖垮整仓数据
  }
}

// 开放 PR 的 review 状态与意见文本（issue #144）。REST 无批量端点，按 PR 逐个拉（reviews + 行级评论），
// 封顶前 MAX_REVIEW_PRS 个防请求失控（与 items 展示上限一致，更多 PR 的 review 延后到 #146 详情按需拉）；
// 单 PR 失败静默跳过。文本截断后仅供警示定位与意图路由 prompt（#142）作原料
const MAX_REVIEW_PRS = 20;
const REVIEW_BODY_CAP = 240;
const COMMENT_BODY_CAP = 160;
async function fetchPrReviews(owner, repo, prNumbers, token) {
  const targets = (prNumbers || []).slice(0, MAX_REVIEW_PRS);
  const list = await Promise.all(targets.map(async (n) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const [revRes, comRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}/reviews?per_page=100`, { signal: ctrl.signal, headers: apiHeaders(token) }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}/comments?per_page=100`, { signal: ctrl.signal, headers: apiHeaders(token) }),
      ]);
      // 状态取最后一条已提交的 review（PENDING 尚未提交不算决议）
      let state = null, reviewer = '', reviewBody = '';
      if (revRes.ok) {
        const revs = await revRes.json();
        const done = (Array.isArray(revs) ? revs : []).filter((x) => x.state && x.state !== 'PENDING');
        const last = done.length ? done[done.length - 1] : null;
        if (last) {
          state = last.state;
          reviewer = (last.user && last.user.login) || '';
          reviewBody = String(last.body || '').trim().slice(0, REVIEW_BODY_CAP);
        }
      }
      let commentCount = 0, lastCommentBody = '';
      if (comRes.ok) {
        const cs = await comRes.json();
        if (Array.isArray(cs)) {
          commentCount = cs.length;
          if (cs.length) lastCommentBody = String(cs[cs.length - 1].body || '').trim().slice(0, COMMENT_BODY_CAP);
        }
      }
      return { number: n, state, reviewer, reviewBody, commentCount, lastCommentBody };
    } catch {
      return null; // 单 PR 失败不拖垮整仓数据
    } finally {
      clearTimeout(timer);
    }
  }));
  return list.filter(Boolean).filter((r) => r.state || r.commentCount);
}

/* ---------- 详情面板 GitHub 深化（issue #146） ---------- */

// 最新 Release + 发布节奏：releases/latest 拿 tag 与发布时间，compare(tag...HEAD) 的 ahead_by
// 即「距上次发布 N 个提交」；无 Release 的仓库返回 null 不报错
async function fetchReleaseInfo(owner, repo, token) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let rel;
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        signal: ctrl.signal, headers: apiHeaders(token),
      });
      if (!res.ok) return null; // 404 = 尚无 Release，按无数据处理
      rel = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const info = {
      tag: rel.tag_name || '',
      name: rel.name || rel.tag_name || '',
      publishedAt: rel.published_at || null,
      url: rel.html_url || '',
      aheadBy: null,
    };
    if (info.tag) {
      try {
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 12000);
        try {
          const cmp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(info.tag)}...HEAD`,
            { signal: ctrl2.signal, headers: apiHeaders(token) }
          );
          if (cmp.ok) {
            const d = await cmp.json();
            info.aheadBy = typeof d.ahead_by === 'number' ? d.ahead_by : null;
          }
        } finally {
          clearTimeout(timer2);
        }
      } catch { /* 节奏信号拿不到只隐藏 N 提交字样，Release 本体照展 */ }
    }
    return info;
  } catch {
    return null;
  }
}

// 默认分支远程 HEAD sha（issue #146 元数据交叉验证）：与本地 headSha 比对判断「另一台机器推了」；
// 不用裸 pushed_at 是因为自己 push 后 pushed_at 也会变新（时间差 = 提交到推送的间隔），误报率高
async function fetchRemoteHead(owner, repo, branch, token) {
  if (!branch) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}?per_page=1`,
        { signal: ctrl.signal, headers: apiHeaders(token) }
      );
      if (!res.ok) return null;
      const d = await res.json();
      return d && d.sha ? d.sha : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// 单条 issue/PR 的展开详情（issue #146，按需拉取不进缓存）：正文 + 评论流 + PR 的 diff 统计
// 与 reviewer 指派。PR 用 /pulls/{n}（含 diff 统计），评论流统一走 issues/{n}/comments
// （GitHub 把 PR 视作 issue）；reviewer 指派 = requested_reviewers + 已提交 review 的作者去重
async function fetchItemDetail(owner, repo, type, number, token) {
  const n = parseInt(number, 10);
  if (!n || (type !== 'pr' && type !== 'issue')) throw new Error('参数不合法');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const itemBase = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const [mainRes, comRes] = await Promise.all([
      fetch(type === 'pr' ? `${itemBase}/pulls/${n}` : `${itemBase}/issues/${n}`, {
        signal: ctrl.signal, headers: apiHeaders(token),
      }),
      fetch(`${itemBase}/issues/${n}/comments?per_page=50`, {
        signal: ctrl.signal, headers: apiHeaders(token),
      }),
    ]);
    if (!mainRes.ok) throw new Error(`GitHub API ${mainRes.status}`);
    const main = await mainRes.json();
    let comments = [];
    if (comRes.ok) {
      const cs = await comRes.json();
      comments = (Array.isArray(cs) ? cs : []).slice(0, 30).map((c) => ({
        user: (c.user && c.user.login) || '',
        body: String(c.body || '').trim().slice(0, 400),
        createdAt: c.created_at || null,
      }));
    }
    const out = {
      type,
      number: n,
      title: main.title || '',
      body: String(main.body || '').trim().slice(0, 600),
      state: main.state || '',
      comments,
    };
    if (type === 'pr') {
      const reviewers = [];
      const seen = new Set();
      ((main.requested_reviewers && main.requested_reviewers) || []).forEach((u) => {
        if (u && u.login && !seen.has(u.login)) { seen.add(u.login); reviewers.push({ login: u.login, state: 'PENDING' }); }
      });
      try {
        const revRes = await fetch(`${itemBase}/pulls/${n}/reviews?per_page=100`, {
          signal: ctrl.signal, headers: apiHeaders(token),
        });
        if (revRes.ok) {
          const revs = await revRes.json();
          // 已提交 review 的作者取其最新决议：数组按时间升序，重复出现的后写覆盖
          // （含覆盖 requested_reviewers 先行占位的 PENDING——指派后又有决议时以决议为准）
          (Array.isArray(revs) ? revs : []).forEach((rv) => {
            if (rv && rv.user && rv.user.login && rv.state && rv.state !== 'PENDING') {
              const r = reviewers.find((x) => x.login === rv.user.login);
              if (r) r.state = rv.state;
              else { seen.add(rv.user.login); reviewers.push({ login: rv.user.login, state: rv.state }); }
            }
          });
        }
      } catch { /* reviewer 拿不到只少一行，不失败 */ }
      out.pr = {
        additions: main.additions,
        deletions: main.deletions,
        changedFiles: main.changed_files,
        reviewers,
      };
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- GitHub 通知中心（issue #145，首版仅本人仓库） ---------- */

// 通知条数上限：未读通知按最近优先截断，防跨仓库订阅多的账号拉爆缓存
const NOTIFY_CAP = 20;

// 通知原因中文化（展示用）；未知原因原样保留
const NOTIFY_REASON_LABEL = {
  mention: '提及',
  review_requested: 'review 请求',
  assign: '指派',
  author: '你发起的',
  comment: '评论',
  ci_activity: 'CI 动态',
  invitation: '邀请',
  manual: '订阅',
  subscribed: '订阅',
  security_alert: '安全警报',
  state_change: '状态变更',
  team_mention: '团队提及',
};

// 通知的 subject.url 是 API 地址，机械转成浏览器可开的页面地址；
// 未识别类型兜底仓库页（换 html_url 要多发一次详情请求，不值得）
function notifHtmlUrl(repoFull, subject) {
  const base = 'https://github.com/' + repoFull;
  const u = String((subject && subject.url) || '');
  let m = u.match(/\/pulls\/(\d+)/);
  if (m) return base + '/pull/' + m[1];
  m = u.match(/\/issues\/(\d+)/);
  if (m) return base + '/issues/' + m[1];
  m = u.match(/\/commits\/([0-9a-f]+)/);
  if (m) return base + '/commit/' + m[1];
  if (/\/releases/.test(u)) return base + '/releases';
  return base;
}

async function fetchNotifications(token, me) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://api.github.com/notifications?per_page=' + NOTIFY_CAP, {
      signal: ctrl.signal,
      headers: apiHeaders(token),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const list = await res.json();
    // 边界（issue #145）：仅本人仓库——repository.owner.login 与登录名比对（大小写不敏感），
    // 跨仓库通知不展出；警示是板上算出的事实，通知是 GitHub 推来的事件，语义在 UI 上分开
    return (Array.isArray(list) ? list : [])
      .filter((n) => n.repository && n.repository.owner
        && String(n.repository.owner.login).toLowerCase() === String(me).toLowerCase())
      .slice(0, NOTIFY_CAP)
      .map((n) => ({
        id: n.id,
        repo: n.repository.full_name,
        title: (n.subject && n.subject.title) || '',
        subjectType: (n.subject && n.subject.type) || '',
        reason: n.reason || '',
        reasonLabel: NOTIFY_REASON_LABEL[n.reason] || (n.reason || ''),
        htmlUrl: notifHtmlUrl(n.repository.full_name, n.subject),
        updatedAt: n.updated_at || null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

// 通知刷新：沿用 10 分钟 TTL / 失败 3 分钟短 TTL（独立于 per-repo 条目）；沿用静默保留旧数据。
// 通知自带 GitHub 侧已读态，这里只缓存未读快照；本地不做已读标记，消音机制不接通知（issue #145）
// 返回是否有可见变化（供落地即推补丁）
async function refreshNotifications(config, store) {
  const me = String(config.githubUsername || '');
  if (!config.githubToken || !me) return false;
  const cache = store.getGithubCache();
  const cur = cache.notifications;
  const now = Date.now();
  if (cur && now - cur.fetchedAt < (cur.error ? FAIL_TTL_MS : TTL_MS)) return false;
  let changed = !!(cur && cur.error); // 失败恢复要重推
  try {
    const data = await fetchNotifications(config.githubToken, me);
    changed = changed || JSON.stringify(data) !== JSON.stringify(cur && cur.data);
    cache.notifications = { fetchedAt: now, data, error: null };
  } catch (err) {
    const msg = String((err && err.message) || err || '网络请求失败');
    changed = changed || !(cur && cur.error === msg);
    cache.notifications = { fetchedAt: now, data: (cur && cur.data) || [], error: msg };
  }
  store.setGithubCache(cache);
  return changed;
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
    p.githubError = null;
    if (!p.originUrl) continue;
    const remote = parseGitHubRemote(p.originUrl);
    if (!remote || remote.owner.toLowerCase() !== me) continue; // fork 上游跳过
    p.githubOwned = true;
    if (!config.githubToken || !me) continue;
    const key = `${remote.owner}/${remote.repo}`;
    const entry = cache.repos[key];
    if (entry && entry.data) {
      p.github = entry.data;
      if (now - entry.fetchedAt >= TTL_MS) stale.push(remote);
    } else if (entry && entry.error) {
      // 失败条目（issue #46）：渲染层展示失败态而非永远「同步中」；短 TTL 后自动重试
      p.githubError = entry.error;
      if (now - entry.fetchedAt >= FAIL_TTL_MS) stale.push(remote);
    } else {
      stale.push(remote);
    }
  }
  return stale;
}

// 后台刷新缓存：成功条目覆盖写；失败时若已有旧数据则静默保留，
// 否则落一条失败记录（渲染层据此展示「同步失败，稍后自动重试」而非永远停在同步中，issue #46）
// 返回是否有可见变化（供主进程补推整板补丁，issue #44）
async function refreshCache(remotes, config, store) {
  if (!remotes.length || !config.githubToken) return false;
  // 按 owner/repo 去重：多项目指向同一仓库时只拉一次（stale 列表与强制刷新清单都可能带重复项）
  const seen = new Set();
  const uniq = [];
  for (const r of remotes) {
    const key = `${r.owner}/${r.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  const cache = store.getGithubCache();
  const results = await Promise.all(
    uniq.map((r) =>
      fetchIssues(r.owner, r.repo, config.githubToken).then(async (data) => {
        // CI 运行并入条目（issue #143）：元数据提供默认分支名，随后查该分支最近一次运行；
        // 元数据/CI 任一失败都只降级为无 CI 数据，不影响 issues 数据的成败与 TTL。
        // remoteHeadSha（issue #146）：与本地 headSha 交叉验证「另一台机器推了」
        try {
          const meta = await fetchRepoMeta(r.owner, r.repo, config.githubToken);
          const [ci, remoteHead] = await Promise.all([
            fetchCiRun(r.owner, r.repo, meta.defaultBranch, config.githubToken),
            fetchRemoteHead(r.owner, r.repo, meta.defaultBranch, config.githubToken),
          ]);
          data.meta = meta;
          data.meta.remoteHeadSha = remoteHead;
          data.ci = ci;
        } catch {
          data.meta = null;
          data.ci = null;
        }
        // 最新 Release + 发布节奏（issue #146）：失败/无 Release 降级为无数据
        data.release = await fetchReleaseInfo(r.owner, r.repo, config.githubToken);
        // review 状态并入（issue #144）：PR 条目挂 reviewState 供徽标，全量意见存 prReviews
        // 供警示与意图路由 prompt（#142）作原料；拉取失败降级为空清单，不影响 issues 数据
        try {
          data.prReviews = Array.isArray(data.prNumbers) && data.prNumbers.length
            ? await fetchPrReviews(r.owner, r.repo, data.prNumbers, config.githubToken)
            : [];
        } catch {
          data.prReviews = [];
        }
        const stateByNum = {};
        data.prReviews.forEach((x) => { stateByNum[x.number] = x.state; });
        data.items.forEach((it) => {
          if (it.type === 'pr') it.reviewState = stateByNum[it.number] || null;
        });
        return { data };
      }, (err) => ({ error: String((err && err.message) || err || '网络请求失败') }))
    )
  );
  const now = Date.now();
  let changed = false; // 有可见变化（新数据 / 新失败态）→ 需要推补丁
  let dirty = false; // 有任何落盘必要（含仅刷新失败时间戳）
  results.forEach((res, i) => {
    const key = `${uniq[i].owner}/${uniq[i].repo}`;
    if (res.data) {
      cache.repos[key] = { fetchedAt: now, data: res.data };
      changed = dirty = true;
      return;
    }
    const prev = cache.repos[key];
    if (prev && prev.data) return; // 有旧数据：静默保留，失败不覆盖
    if (!(prev && prev.error === res.error)) changed = true;
    cache.repos[key] = { fetchedAt: now, error: res.error };
    dirty = true;
  });
  if (dirty) {
    cache.fetchedAt = now;
    store.setGithubCache(cache);
  }
  return changed;
}

// PR 警示需要在 github 挂接后补充；同一批对象可能重复挂接（最终补丁二次拼装），先清旧值保证幂等。
// enabled=false（issue #73 警示开关之一）时只清不加
function applyPrWarnings(projects, enabled) {
  for (const p of projects) {
    p.warnings = p.warnings.filter((w) => w.type !== 'pr');
    if (enabled !== false && p.github && p.github.openPRs > 0) {
      p.warnings.push({ type: 'pr', label: `${p.github.openPRs} 个开放 PR` });
    }
  }
}

// CI 警示（issue #143）：默认分支最近一次运行 conclusion=failure 即记；
// 运行中（conclusion 为 null）与非 failure 结局不记。enabled=false 时只清不加
function applyCiWarnings(projects, enabled) {
  for (const p of projects) {
    p.warnings = p.warnings.filter((w) => w.type !== 'ci');
    if (enabled !== false && p.github && p.github.ci && p.github.ci.conclusion === 'failure') {
      p.warnings.push({ type: 'ci', label: '默认分支 CI 失败' });
    }
  }
}

// review 警示（issue #144）：任一开放 PR 最新 review 为 CHANGES_REQUESTED 即记一条，
// label 列出 PR 号便于定位。enabled=false 时只清不加
function applyReviewWarnings(projects, enabled) {
  for (const p of projects) {
    p.warnings = p.warnings.filter((w) => w.type !== 'review');
    if (enabled === false || !p.github || !Array.isArray(p.github.prReviews)) continue;
    const pending = p.github.prReviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => '#' + r.number);
    if (pending.length) p.warnings.push({ type: 'review', label: 'PR ' + pending.join('、') + ' 有待处理 review' });
  }
}

// 设置页「测试连接」：验证 token 有效性并返回实际登录名
// 10s 超时 + 失败重试一次（弱网偶发 TLS 断连，避免状态卡误报「网络错误」，issue #49）
async function testConnection(token) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch('https://api.github.com/user', {
        signal: ctrl.signal,
        headers: apiHeaders(token),
      });
      if (res.status === 401) return { ok: false, reason: 'Token 无效或已过期' };
      if (!res.ok) return { ok: false, reason: `GitHub API ${res.status}` };
      const data = await res.json();
      // 顺带带回头像与显示名，设置页账户状态卡用（issue #45）
      return { ok: true, login: data.login, name: data.name || '', avatarUrl: data.avatar_url || '' };
    } catch {
      if (attempt === 1) return { ok: false, reason: '网络错误，无法连接 GitHub' };
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      clearTimeout(timer);
    }
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 弱网挂起不再无限等（issue #107，与 testConnection 同款）
  try {
    const res = await fetch('https://github.com/login/device/code', {
      signal: ctrl.signal,
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
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return { ok: false, reason: timedOut ? '请求超时，无法连接 GitHub' : '网络错误，无法连接 GitHub' };
  } finally {
    clearTimeout(timer);
  }
}

// OAuth Device Flow 第二步：渲染层按 interval 轮询；success 时返回 token
async function devicePoll(deviceCode) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 单次轮询挂起不阻塞下一轮（issue #107）
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      signal: ctrl.signal,
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
  } catch (err) {
    // 超时按 pending 处理：渲染层下一轮会继续轮询，不因单次网络抖动终止授权流程
    return { status: err && err.name === 'AbortError' ? 'pending' : 'error', reason: '网络错误，无法连接 GitHub' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseGitHubRemote,
  fetchIssues,
  fetchRepoMeta,
  fetchCiRun,
  fetchPrReviews,
  fetchNotifications,
  notifHtmlUrl,
  fetchReleaseInfo,
  fetchRemoteHead,
  fetchItemDetail,
  attachFromCache,
  refreshCache,
  refreshNotifications,
  applyPrWarnings,
  applyCiWarnings,
  applyReviewWarnings,
  testConnection,
  ghCliAvailable,
  importGhToken,
  deviceStart,
  devicePoll,
  DEVICE_FLOW_CLIENT_ID,
};
