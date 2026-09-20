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

  console.log('test-github: 全部断言通过');
}

main().catch((err) => {
  console.error('test-github 失败:', err);
  process.exit(1);
});
