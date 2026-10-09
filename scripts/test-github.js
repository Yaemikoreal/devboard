// github.js 单元验证（issue #153/#154）：remote 解析全格式回归 / fetch 出口注入 /
// 证书类失败识别（testConnection、refreshCache 针对性提示）/ attachFromCache SSH over 443 挂接。
// 不起 Electron、不真连网络（网络出口全部注入假 fetch）。
'use strict';

const assert = require('assert');
const github = require('../src/main/github');

// 模拟 store：仅 getGithubCache/setGithubCache 两个内存方法
function fakeStore(initialRepos) {
  const state = { repos: initialRepos || {} };
  return {
    getGithubCache: () => state,
    setGithubCache: (c) => Object.assign(state, c),
    state,
  };
}

async function main() {
  // --- parseGitHubRemote（issue #154）：官方四形态全回归 ---
  const CASES = [
    // [remote, expect]
    ['git@github.com:Yaemikoreal/devboard.git', { owner: 'Yaemikoreal', repo: 'devboard' }], // scp 常规（原有）
    ['https://github.com/yaemikoreal/devboard.git', { owner: 'yaemikoreal', repo: 'devboard' }], // https（原有）
    ['ssh://git@ssh.github.com:443/Yaemikoreal/devboard.git', { owner: 'Yaemikoreal', repo: 'devboard' }], // #154 主形态：SSH over 443
    ['git@ssh.github.com:Yaemikoreal/devboard.git', { owner: 'Yaemikoreal', repo: 'devboard' }], // ssh.github.com scp 风格别名
    ['ssh://git@github.com/Yaemikoreal/devboard.git', { owner: 'Yaemikoreal', repo: 'devboard' }], // 显式 ssh:// 无端口
    ['ssh://git@github.com:22/Yaemikoreal/devboard', { owner: 'Yaemikoreal', repo: 'devboard' }], // 显式 ssh:// 自选端口
    ['git@github.com:o/r', { owner: 'o', repo: 'r' }], // 无 .git 后缀
    ['https://github.com/o/r/', { owner: 'o', repo: 'r' }], // 尾斜杠
  ];
  for (const [url, expect] of CASES) {
    assert.deepStrictEqual(github.parseGitHubRemote(url), expect, `解析失败: ${url}`);
  }
  // 负例：非 GitHub 主机与残缺输入一律 null（fork 上游/非本人项目判定的安全边界）
  for (const bad of ['', null, undefined, '   ', 'git@gitee.com:o/r.git', 'ssh://git@gitee.com:443/o/r.git',
    'https://gitlab.com/o/r.git', 'git@github.com:only-segment', 'not a url',
    'ssh://git@evil.example.com/o/r.git', 'git@github.com:']) {
    assert.strictEqual(github.parseGitHubRemote(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }

  // --- testConnection（issue #153）：注入出口 + 成功路径 + 出口确被使用 ---
  let seenUrl = null;
  github.setFetchImpl(async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ({ login: 'me', name: 'Me', avatar_url: 'http://a/x.png' }) };
  });
  const ok = await github.testConnection('tok');
  assert.strictEqual(ok.ok, true, '注入成功响应应通过');
  assert.strictEqual(ok.login, 'me');
  assert.strictEqual(seenUrl, 'https://api.github.com/user', '请求应走注入的 fetch 出口');

  // 401：token 无效
  github.setFetchImpl(async () => ({ ok: false, status: 401 }));
  assert.strictEqual((await github.testConnection('tok')).reason, 'Token 无效或已过期');

  // Node 侧证书错误（issue #153 实测形态）：真实 TLS 原因藏在 err.cause.code
  github.setFetchImpl(async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  });
  const cert = await github.testConnection('tok');
  assert.strictEqual(cert.ok, false);
  assert.ok(cert.reason.includes('Watt Toolkit'), '证书类失败应给针对性提示，而非「网络错误」');
  assert.ok(cert.reason.includes('NODE_EXTRA_CA_CERTS'), '提示应含缓解路径');

  // Chromium 侧证书错误（net.fetch 形态）：net::ERR_CERT_* 混在 message
  github.setFetchImpl(async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); });
  assert.ok((await github.testConnection('tok')).reason.includes('Watt Toolkit'), 'net::ERR_CERT_* 同样识别');

  // 普通网络错误：重试一次后仍回落「网络错误」（重试退避约 1s）
  let calls = 0;
  github.setFetchImpl(async () => { calls++; throw new Error('ECONNRESET'); });
  assert.strictEqual((await github.testConnection('tok')).reason, '网络错误，无法连接 GitHub');
  assert.strictEqual(calls, 2, '普通网络错误应重试一次');

  // --- refreshCache（issue #153）：证书失败落缓存的错误信息也带针对性提示（「同步失败」态可见原因）---
  github.setFetchImpl(async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
  });
  const store = fakeStore();
  const changed = await github.refreshCache([{ owner: 'Yaemikoreal', repo: 'devboard' }], { githubToken: 'tok' }, store);
  assert.strictEqual(changed, true, '新失败态应推补丁');
  assert.ok(store.state.repos['Yaemikoreal/devboard'].error.includes('Watt Toolkit'),
    '缓存失败条目应写针对性提示');

  // --- attachFromCache（issue #154 回归）：SSH over 443 remote 正常挂接本人仓库 ---
  const store2 = fakeStore({
    'Yaemikoreal/devboard': { fetchedAt: Date.now(), data: { openIssues: 3, items: [] } },
  });
  const config = { githubToken: 'tok', githubUsername: 'yaemikoreal' };
  const projects = [
    { originUrl: 'ssh://git@ssh.github.com:443/Yaemikoreal/devboard.git' },
    { originUrl: 'git@ssh.github.com:Yaemikoreal/other.git' },
    { originUrl: 'https://github.com/someone/forked.git' }, // fork 上游跳过
  ];
  const stale = github.attachFromCache(projects, config, store2);
  assert.strictEqual(projects[0].githubOwned, true, 'SSH over 443 remote 应判定为本人仓库');
  assert.ok(projects[0].github && projects[0].github.openIssues === 3, '缓存数据应挂接（不再恒显「非本人项目」）');
  assert.strictEqual(projects[1].githubOwned, true, 'ssh.github.com scp 形态同判本人');
  assert.ok(stale.some((r) => r.owner === 'Yaemikoreal' && r.repo === 'other'), '无缓存条目应进刷新清单');
  assert.strictEqual(projects[2].githubOwned, false, 'fork 上游仍跳过');
  assert.strictEqual(projects[2].github, null);

  // 还原缺省出口（null → globalThis.fetch），不影响同进程后续用例
  github.setFetchImpl(null);
  assert.strictEqual(typeof github.DEVICE_FLOW_CLIENT_ID, 'string'); // 模块仍可用

  /* ---------- 审查批次回归（issue #155–#167） ---------- */

  // --- fetchPrReviews 决议聚合（issue #156）：后来的 COMMENTED 不得掩盖未解决的 CHANGES_REQUESTED ---
  github.setFetchImpl(async (url) => {
    if (url.includes('/pulls/9/reviews')) {
      return {
        ok: true,
        json: async () => [
          { state: 'CHANGES_REQUESTED', user: { login: 'a' }, body: '请改这里' },
          { state: 'COMMENTED', user: { login: 'b' }, body: '看起来不错' },
        ],
      };
    }
    if (url.includes('/pulls/9/comments')) return { ok: true, json: async () => [] };
    throw new Error('unexpected: ' + url);
  });
  let reviews = await github.fetchPrReviews('o', 'r', [9], 'tok');
  assert.strictEqual(reviews[0].state, 'CHANGES_REQUESTED', '双审查者序列（A 待改 → B 评论）整体应为待改');
  assert.strictEqual(reviews[0].reviewer, 'a', '决议应取阻塞 review 的审查者');
  // A 的请求被 dismiss（DISMISSED 条目落在其后）→ 阻塞解除
  github.setFetchImpl(async (url) => {
    if (url.includes('/pulls/9/reviews')) {
      return {
        ok: true,
        json: async () => [
          { state: 'CHANGES_REQUESTED', user: { login: 'a' }, body: '请改这里' },
          { state: 'DISMISSED', user: { login: 'a' }, body: '' },
          { state: 'COMMENTED', user: { login: 'b' }, body: 'ok' },
        ],
      };
    }
    if (url.includes('/pulls/9/comments')) return { ok: true, json: async () => [] };
    throw new Error('unexpected: ' + url);
  });
  reviews = await github.fetchPrReviews('o', 'r', [9], 'tok');
  assert.notStrictEqual(reviews[0].state, 'CHANGES_REQUESTED', 'dismiss 后的审查者不再阻塞');
  // 每人取「最新」决议：A 待改后改批准 → A 不阻塞
  github.setFetchImpl(async (url) => {
    if (url.includes('/pulls/9/reviews')) {
      return {
        ok: true,
        json: async () => [
          { state: 'CHANGES_REQUESTED', user: { login: 'a' }, body: '请改' },
          { state: 'APPROVED', user: { login: 'a' }, body: '改好了' },
        ],
      };
    }
    if (url.includes('/pulls/9/comments')) return { ok: true, json: async () => [] };
    throw new Error('unexpected: ' + url);
  });
  reviews = await github.fetchPrReviews('o', 'r', [9], 'tok');
  assert.strictEqual(reviews[0].state, 'APPROVED', '同一审查者的旧待改请求被其新决议覆盖');

  // --- fetchNotifications 拉取口径（issue #157）：per_page=50 分页拉全后过滤本人仓库，再截断 20 ---
  {
    const seenUrls = [];
    const makeNotif = (ownerLogin, i) => ({
      id: 'n' + i,
      repository: { full_name: ownerLogin + '/r' + i, owner: { login: ownerLogin } },
      subject: { title: 't' + i, type: 'Issue', url: 'https://api.github.com/repos/x/y/issues/1' },
      reason: 'subscribed',
      updated_at: '2026-01-01T00:00:00Z',
    });
    let page = 0;
    github.setFetchImpl(async (url) => {
      seenUrls.push(url);
      // 前两页 50 条全为他人仓库，第 3 页（不足整页）才有本人未读
      page++;
      const list = [];
      for (let i = 0; i < (page < 3 ? 50 : 5); i++) list.push(makeNotif('otheruser', page * 50 + i));
      if (page === 3) list.push(makeNotif('me', 1), makeNotif('me', 2));
      return { ok: true, json: async () => list };
    });
    const mine = await github.fetchNotifications('tok', 'me');
    assert.ok(seenUrls[0].includes('per_page=50'),
      '通知请求应为 per_page=50（notifications 端点封顶 50），实际: ' + seenUrls[0]);
    assert.strictEqual(mine.length, 2, '本人未读不应被前 100 条他人通知挤掉（issue #157）');
    assert.ok(mine.every((n) => n.repo.startsWith('me/')), '过滤后只含本人仓库');
  }

  // --- refreshNotifications 相同错误抑制 + 错误恢复判定（issue #159）---
  {
    let failCount = 0;
    github.setFetchImpl(async () => { failCount++; throw new Error('GitHub API 503'); });
    const st = fakeStore();
    const cfg = { githubToken: 'tok', githubUsername: 'me' };
    const c1 = await github.refreshNotifications(cfg, st);
    assert.strictEqual(c1, true, '首轮失败（无旧失败态）应推补丁');
    // 第二轮：TTL 未到，直接跳过
    failCount = 0;
    const c2 = await github.refreshNotifications(cfg, st);
    assert.strictEqual(c2, false, 'TTL 内不刷新');
    assert.strictEqual(failCount, 0, 'TTL 内不应发起请求');
    // 模拟 TTL 过期（fetchedAt 回拨 4 分钟 > FAIL_TTL 3 分钟）后再失败：与上次相同错误 → 不推
    st.state.notifications.fetchedAt = Date.now() - 4 * 60 * 1000;
    const c3 = await github.refreshNotifications(cfg, st);
    assert.strictEqual(c3, false, '相同错误重复失败不应重推整板补丁（issue #159）');
    // 错误恢复：成功 + 数据为空 → 错误清除本身是可见变化，应推（先把失败态 TTL 再熬过期）
    github.setFetchImpl(async () => ({ ok: true, json: async () => [] }));
    st.state.notifications.fetchedAt = Date.now() - 4 * 60 * 1000;
    const c4 = await github.refreshNotifications(cfg, st);
    assert.strictEqual(c4, true, '错误恢复（error→null）应推补丁');
    // 成功后的同数据刷新：TTL 过期后重拉，数据一致 → 不推
    st.state.notifications.fetchedAt = Date.now() - 11 * 60 * 1000;
    const c5 = await github.refreshNotifications(cfg, st);
    assert.strictEqual(c5, false, '数据无变化不推补丁');
    assert.strictEqual(st.state.notifications.fetchedFor, 'me', '快照应记录拉取账号（issue #158）');
  }

  // --- refreshNotifications 账号边界（issue #158）：换号无视 TTL 强制刷新 ---
  {
    let hits = 0;
    github.setFetchImpl(async () => { hits++; return { ok: true, json: async () => [] }; });
    const st = fakeStore();
    await github.refreshNotifications({ githubToken: 'tok', githubUsername: 'a' }, st);
    assert.ok(hits >= 1, '首轮应刷新');
    const hitsBefore = hits;
    // 账号换成 b：即使 fetchedAt 刚刚（TTL 内）也必须强制刷新
    await github.refreshNotifications({ githubToken: 'tok', githubUsername: 'b' }, st);
    assert.ok(hits > hitsBefore, '换号后 fetchedFor 不一致应强制刷新（issue #158）');
    assert.strictEqual(st.state.notifications.fetchedFor, 'b', '刷新后快照归属新账号');
  }

  // --- applyCiWarnings 失败结局集合（issue #162）---
  {
    const ciOf = (conclusion) => {
      const projects = [{ warnings: [], github: { ci: { conclusion } } }];
      github.applyCiWarnings(projects, true);
      return projects[0].warnings.length;
    };
    assert.strictEqual(ciOf('failure'), 1, 'failure 应记警示');
    assert.strictEqual(ciOf('timed_out'), 1, 'timed_out 应记警示');
    assert.strictEqual(ciOf('startup_failure'), 1, 'startup_failure 应记警示');
    assert.strictEqual(ciOf('action_required'), 1, 'action_required 应记警示');
    assert.strictEqual(ciOf('cancelled'), 0, 'cancelled 不应记警示');
    assert.strictEqual(ciOf(null), 0, '运行中不记警示');
    const off = [{ warnings: [], github: { ci: { conclusion: 'failure' } } }];
    github.applyCiWarnings(off, false);
    assert.strictEqual(off[0].warnings.length, 0, '开关关闭时只清不加');
  }

  // --- refreshCache 装饰数据保留（issue #155）：issues 成功 + 次级拉取失败 → 沿用旧装饰 ---
  {
    const prevData = {
      openIssues: 1, openPRs: 1, prNumbers: [7], items: [],
      meta: { defaultBranch: 'main', remoteHeadSha: 'abc', pushedAt: null, description: '' },
      ci: { conclusion: 'failure', status: 'completed', name: 'CI', url: '', createdAt: null },
      release: { tag: 'v1', name: 'v1', publishedAt: '2026-01-01T00:00:00Z', url: 'u', aheadBy: 3 },
      prReviews: [{ number: 7, state: 'CHANGES_REQUESTED', reviewer: 'a', reviewBody: '改', commentCount: 1, lastCommentBody: 'x' }],
    };
    const st = fakeStore({ 'Yaemikoreal/devboard': { fetchedAt: Date.now() - 20 * 60 * 1000, data: prevData } });
    github.setFetchImpl(async (url) => {
      if (url.includes('/issues?')) {
        return {
          ok: true,
          json: async () => [{ number: 1, title: 'i', html_url: 'u' }, { number: 7, title: 'p', html_url: 'u', pull_request: {} }],
        };
      }
      // 元数据/CI/remoteHead/release/reviews 全部失败：网络抖动场景
      throw new Error('ECONNRESET');
    });
    const changed = await github.refreshCache([{ owner: 'Yaemikoreal', repo: 'devboard' }], { githubToken: 'tok' }, st);
    assert.strictEqual(changed, true, 'issues 本体成功应推补丁');
    const d = st.state.repos['Yaemikoreal/devboard'].data;
    assert.deepStrictEqual(d.ci, prevData.ci, '次级拉取失败应沿用旧 CI（issue #155）');
    assert.deepStrictEqual(d.prReviews, prevData.prReviews, '次级拉取失败应沿用旧 review 清单（issue #155）');
    assert.deepStrictEqual(d.release, prevData.release, 'release 拉取失败应沿用旧值（issue #155）');
    assert.deepStrictEqual(d.meta, prevData.meta, '元数据失败应沿用旧值（issue #155）');
    assert.strictEqual(d.openIssues, 1, 'issues 本体数据照常刷新');
  }

  // --- refreshCache CI 查询单点失败（issue #155 补充）：meta 成功、CI 5xx → ci 沿旧值，meta 用新值 ---
  {
    const prevData = {
      openIssues: 1, openPRs: 0, prNumbers: [], items: [],
      meta: { defaultBranch: 'main', remoteHeadSha: 'abc', pushedAt: null, description: '' },
      ci: { conclusion: 'failure', status: 'completed', name: 'CI', url: '', createdAt: null },
      release: null,
      prReviews: [],
    };
    const st = fakeStore({ 'Yaemikoreal/devboard': { fetchedAt: Date.now() - 20 * 60 * 1000, data: prevData } });
    github.setFetchImpl(async (url) => {
      if (url.includes('/issues?')) return { ok: true, json: async () => [{ number: 1, title: 'i', html_url: 'u' }] };
      if (/\/repos\/[^/]+\/[^/?]+$/.test(url)) return { ok: true, json: async () => ({ default_branch: 'main', pushed_at: null, description: '' }) };
      if (url.includes('/actions/runs')) return { ok: false, status: 500 }; // CI 查询 5xx（网络抖动等价场景）
      if (url.includes('/commits/')) return { ok: true, json: async () => ({ sha: 'def234' }) };
      if (url.includes('/releases/latest')) return { ok: false, status: 404 };
      throw new Error('unexpected: ' + url);
    });
    await github.refreshCache([{ owner: 'Yaemikoreal', repo: 'devboard' }], { githubToken: 'tok' }, st);
    const d = st.state.repos['Yaemikoreal/devboard'].data;
    assert.deepStrictEqual(d.ci, prevData.ci, 'CI 查询 5xx 应沿旧值不清空既有警示（issue #155）');
    assert.strictEqual(d.meta.defaultBranch, 'main', 'meta 成功应用新值');
    assert.strictEqual(d.meta.remoteHeadSha, 'def234', '远程 HEAD 成功应用新值');
    assert.strictEqual(d.release, null, 'releases/latest 404 = 无 Release 照常落 null');
  }

  // --- refreshCache 次级成功路径回归：装饰数据正常刷新不沿旧值 ---
  {
    const st = fakeStore();
    let releaseAsked = 0;
    github.setFetchImpl(async (url) => {
      if (url.includes('/issues?')) return { ok: true, json: async () => [] };
      if (url.includes('/meta') || (url.match(/\/repos\/[^/]+\/[^/?]+$/))) {
        // 仓库元数据端点（无尾路径）
        if (!/\/(actions|compare|releases|commits|pulls)\b/.test(url)) return { ok: true, json: async () => ({ default_branch: 'main', pushed_at: null, description: '' }) };
      }
      if (url.includes('/releases/latest')) { releaseAsked++; return { ok: false, status: 404 }; }
      if (url.includes('/actions/runs')) return { ok: true, json: async () => ({ workflow_runs: [{ conclusion: 'success', status: 'completed', name: 'CI', html_url: '', created_at: null }] }) };
      if (url.includes('/commits/')) return { ok: true, json: async () => ({ sha: 'deadbeef' }) };
      throw new Error('unexpected: ' + url);
    });
    await github.refreshCache([{ owner: 'o', repo: 'r' }], { githubToken: 'tok' }, st);
    const d = st.state.repos['o/r'].data;
    assert.strictEqual(d.meta.defaultBranch, 'main', '元数据应正常挂接');
    assert.strictEqual(d.meta.remoteHeadSha, 'deadbeef', '远程 HEAD 应正常挂接');
    assert.strictEqual(d.ci.conclusion, 'success', 'CI 应正常挂接');
    assert.strictEqual(releaseAsked, 1, '无 Release 仓库应请求 releases/latest 且落 null');
    assert.strictEqual(d.release, null, '404 = 无 Release 是正常态，不沿旧值');
  }

  // --- fetchReleaseInfo 斜杠 tag 回落 + ahead_by 阈值（issue #166/#167）---
  {
    const asked = [];
    github.setFetchImpl(async (url) => {
      asked.push(url);
      if (url.includes('/releases/latest')) {
        return { ok: true, json: async () => ({ tag_name: 'release/v1.2', name: 'v1.2', published_at: '2026-01-01T00:00:00Z', html_url: 'u' }) };
      }
      if (url.includes('/compare/')) {
        const ref = decodeURIComponent(url.split('/compare/')[1].split('...')[0]);
        if (ref === 'release/v1.2') return { ok: false, status: 404 }; // 斜杠内联形式 404
        if (ref === 'sha123') return { ok: true, json: async () => ({ ahead_by: 12 }) }; // 回落 sha 成功
        return { ok: false, status: 404 };
      }
      if (url.includes('/git/ref/tags/')) {
        return { ok: true, json: async () => ({ ref: 'refs/tags/release/v1.2', object: { sha: 'sha123', type: 'commit' } }) };
      }
      throw new Error('unexpected: ' + url);
    });
    const info = await github.fetchReleaseInfo('o', 'r', 'tok');
    assert.strictEqual(info.tag, 'release/v1.2', 'Release 本体应照常返回');
    assert.strictEqual(info.aheadBy, 12, '斜杠 tag 回落 sha 解析后 aheadBy 应取到（issue #166）');
    assert.ok(asked.some((u) => u.includes('/git/ref/tags/release%2Fv1.2')), '应先试 %2F 编码的 ref 解析');
  }
  {
    // ahead_by 超阈值降级（issue #167）：release 分支打 tag 的分叉计数不可信
    github.setFetchImpl(async (url) => {
      if (url.includes('/releases/latest')) {
        return { ok: true, json: async () => ({ tag_name: 'v1', name: 'v1', published_at: null, html_url: 'u' }) };
      }
      if (url.includes('/compare/')) return { ok: true, json: async () => ({ ahead_by: 3470 }) };
      throw new Error('unexpected: ' + url);
    });
    const info = await github.fetchReleaseInfo('o', 'r', 'tok');
    assert.strictEqual(info.aheadBy, null, 'ahead_by 超过 500 应降级为不展示（issue #167）');
  }

  // --- fetchItemDetail 行级评论合并（issue #164）---
  {
    github.setFetchImpl(async (url) => {
      if (url.includes('/pulls/5') && !url.includes('/comments') && !url.includes('/reviews')) {
        return { ok: true, json: async () => ({ title: 'PR', body: 'b', state: 'open', additions: 1, deletions: 1, changed_files: 2, requested_reviewers: [] }) };
      }
      if (url.includes('/issues/5/comments')) {
        return { ok: true, json: async () => [{ user: { login: 'u' }, body: '对话评论', created_at: '2026-01-02T00:00:00Z' }] };
      }
      if (url.includes('/pulls/5/comments')) {
        return { ok: true, json: async () => [{ user: { login: 'v' }, body: '行级评论', created_at: '2026-01-03T00:00:00Z', path: 'src/a.js' }] };
      }
      if (url.includes('/pulls/5/reviews')) return { ok: true, json: async () => [] };
      throw new Error('unexpected: ' + url);
    });
    const d = await github.fetchItemDetail('o', 'r', 'pr', 5, 'tok');
    assert.strictEqual(d.comments.length, 2, '行级评论应合并进评论流（issue #164）');
    assert.strictEqual(d.comments[0].source, 'conv', '先到的对话评论排前');
    assert.strictEqual(d.comments[1].source, 'line', '行级评论应带 source=line 标注');
    assert.strictEqual(d.comments[1].path, 'src/a.js', '行级评论应带所评文件路径');
    // 只有行级评论的 PR 不再显示「无评论」（口径与板上 commentCount 一致）
    github.setFetchImpl(async (url) => {
      if (url.includes('/pulls/5') && !url.includes('/comments') && !url.includes('/reviews')) {
        return { ok: true, json: async () => ({ title: 'PR', body: '', state: 'open', additions: 1, deletions: 1, changed_files: 2, requested_reviewers: [] }) };
      }
      if (url.includes('/issues/5/comments')) return { ok: true, json: async () => [] };
      if (url.includes('/pulls/5/comments')) {
        return { ok: true, json: async () => [{ user: { login: 'v' }, body: '唯一的行级评论', created_at: '2026-01-03T00:00:00Z', path: 'src/a.js' }] };
      }
      if (url.includes('/pulls/5/reviews')) return { ok: true, json: async () => [] };
      throw new Error('unexpected: ' + url);
    });
    const d2 = await github.fetchItemDetail('o', 'r', 'pr', 5, 'tok');
    assert.strictEqual(d2.comments.length, 1, '只有行级评论的 PR 应展出评论（issue #164）');
  }

  // 还原缺省出口
  github.setFetchImpl(null);

  console.log('test-github: 全部断言通过');
}

main().catch((err) => {
  console.error('test-github 失败:', err);
  process.exit(1);
});
