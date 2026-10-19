// 拼板回归断言（ADR-0005 配套工程）：assembleBoard 提取为纯模块前，把现 ipc.js 行为
// 手算成期望值固化在这里——重构前后拼板输出必须一致，口径漂移在测试层兜底。
// 运行：node scripts/test-board.js（纯 Node，无 Electron 依赖）
'use strict';

const assert = (cond, msg) => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  console.log('✓ ' + msg);
};

const deepEq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg);

// ---- fixture（期望值按提取前 ipc.js 的 assembleBoard 实现手算）----
// now 固定为 2026-10-19T04:00:00Z（北京时间 12:00）
const now = new Date('2026-10-19T04:00:00.000Z');

const pathA = require('path').resolve('E:/work/alpha');
const pathB = require('path').resolve('E:/work/beta');

const projectA = {
  path: pathA, name: 'alpha', branch: 'main', branches: [],
  lastCommitAt: '2026-10-13T04:00:00.000Z', // 6 天前：超 dirtyDays=3 → dirty 警示
  commits7d: 5,
  recentCommits: [{ msg: 'feat: x', rel: '2 小时前' }],
  dirtyCount: 4, dirtyFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
  dirtyAt: '2026-10-19T03:00:00.000Z',
  ahead: 2, behind: 0, hasUpstream: true, // ahead>0 → 未推送警示
  activity365: new Array(365).fill(0), activityDate: '2026-10-19',
  headSha: 'aaaa', degraded: false, aiSessionAt: null,
  lastActivityAt: '2026-10-19T03:00:00.000Z', // 1 小时前 → hot
  memo: '', band: 'hot', warnings: [],
  github: null, originUrl: 'https://github.com/me/alpha.git',
};

const projectB = {
  path: pathB, name: 'beta', branch: 'dev', branches: [],
  lastCommitAt: '2026-07-11T04:00:00.000Z', // ~100 天前
  commits7d: 0, recentCommits: [],
  dirtyCount: 0, dirtyFiles: [], dirtyAt: null,
  ahead: 0, behind: 0, hasUpstream: false,
  activity365: new Array(365).fill(0), activityDate: '2026-10-19',
  headSha: 'bbbb', degraded: false, aiSessionAt: null,
  lastActivityAt: '2026-07-11T04:00:00.000Z', // 落 stale；交接并入后重算 hot
  memo: '', band: 'stale', warnings: [],
  github: null, originUrl: 'https://github.com/me/beta.git',
};

const config = {
  roots: ['E:/work'], blacklist: ['node_modules'], extraPaths: [],
  githubToken: 't0k', githubUsername: 'me',
  warningDirtyDays: 3,
  warningTypes: { dirty: true, unpushed: true, ci: true, review: true, pr: true },
};

const githubCache = {
  fetchedAt: Date.now() - 60 * 1000,
  repos: {
    'me/alpha': {
      fetchedAt: Date.now() - 5 * 60 * 1000, // TTL 10 分钟内：alpha 不进 stale
      data: {
        openIssues: 1, openPRs: 3, prNumbers: [7],
        items: [], meta: null, ci: { conclusion: 'failure', status: 'completed', name: 'ci', url: '', createdAt: null },
        prReviews: [{ number: 7, state: 'CHANGES_REQUESTED', reviewer: 'rev', reviewBody: '', commentCount: 0, lastCommentBody: '' }],
        release: null,
      },
    },
  },
  notifications: { fetchedAt: 123, data: [{ id: 'n1' }], error: null },
};

const snapshot = {
  memos: { [pathA]: '记得发版' },
  handoffsAll: {
    [pathA]: [
      { id: 'h1', agent: 'agent', text: '交接一', createdAt: '2026-10-19T03:00:00.000Z' }, // 1h 前，晚于游标 → 未读
      { id: 'h2', agent: 'agent', text: '交接二', createdAt: '2026-10-18T00:00:00.000Z', doneAt: '2026-10-18T01:00:00.000Z' }, // 已完成不计未读
    ],
    [pathB]: [
      { id: 'hb1', agent: 'agent', text: 'beta 交接', createdAt: '2026-10-19T02:00:00.000Z' }, // 2h 前，比 lastCommitAt 新 → band 重算
    ],
  },
  handoffReadAt: { [pathA]: '2026-10-19T02:00:00.000Z' }, // 游标 2h 前：h1 未读，h2 已完成不计
  snoozes: { [pathA]: { ahead: '2 提交未推送' } }, // 消音掉 ahead 警示
  githubCache,
};

// ---- 执行 ----
const { assembleBoard, applySnoozes } = require('../src/main/board');
const { bandOf } = require('../src/shared/constants');

const projects = [projectA, projectB];
const { board, stale } = assembleBoard(projects, config, true, snapshot, now);

// memo 并入
assert(board.projects[0].memo === '记得发版', 'A 备忘并入');
assert(board.projects[1].memo === '', 'B 无备忘为空串');

// 交接摘要并入 + 未读数 + band 重算
deepEq(board.projects[0].handoffs, {
  latest: { id: 'h1', agent: 'agent', text: '交接一', createdAt: '2026-10-19T03:00:00.000Z', doneAt: null },
  unreadCount: 1,
}, 'A 交接摘要 latest+unreadCount');
deepEq(board.projects[1].handoffs, {
  latest: { id: 'hb1', agent: 'agent', text: 'beta 交接', createdAt: '2026-10-19T02:00:00.000Z', doneAt: null },
  unreadCount: 1,
}, 'B 交接摘要 latest+unreadCount');
assert(board.projects[1].band === 'hot', 'B 交接新于最后提交 → band 重算为 hot');
assert(board.projects[1].lastActivityAt === '2026-10-19T02:00:00.000Z', 'B lastActivityAt 被交接改写');

// 警示重算：本地规则（dirty 6 天 > 3、ahead 2）→ GitHub 附加（PR/CI/review）→ 消音过滤 ahead
deepEq(
  board.projects[0].warnings.map((w) => w.type),
  ['dirty', 'pr', 'ci', 'review'],
  'A 警示 = 本地重算 + GitHub 附加，ahead 被消音'
);
deepEq(
  board.projects[0].warnings.map((w) => w.label),
  ['4 文件未提交超3天', '3 个开放 PR', '默认分支 CI 失败', 'PR #7 有待处理 review'],
  'A 警示标签逐条'
);
assert(board.projects[1].warnings.length === 0, 'B 无警示');
assert(board.projects[0].github && board.projects[0].github.openPRs === 3, 'A github 缓存挂接');
assert(board.projects[1].github === null, 'B 无缓存条目 github 为 null');
assert(board.projects[1].githubOwned === true, 'B githubOwned 标记本人仓库');

// 需要关注：严重度升序（A: dirty=0）
assert(board.attention.length === 1, 'attention 仅 A');
assert(board.attention[0].path === pathA, 'attention 指向 A');
deepEq(board.attention[0].types, ['dirty', 'pr', 'ci', 'review'], 'attention 携带类型');
assert(board.attention[0].label.indexOf('4 文件未提交超3天') === 0, 'attention 标签拼接');

// 统计与透传
assert(board.stats.total === 2, 'stats.total');
assert(board.stats.commits7d === 5, 'stats.commits7d');
assert(board.stats.attentionCount === 1, 'stats.attentionCount');
assert(board.fromCache === true, 'fromCache 透传');
assert(board.scannedAt === now.toISOString(), 'scannedAt = now');
assert(board.notifications.data.length === 1 && board.notifications.data[0].id === 'n1', 'notifications 透传');
assert(board.projects.every((p) => !('originUrl' in p)), 'originUrl 不下发');

// stale：alpha 新鲜不进，beta 无缓存条目进
deepEq(stale, [{ owner: 'me', repo: 'beta' }], 'stale 清单 = 待刷新 remotes');

// bandOf 共享口径抽查：2h 前 → hot，100 天前 → stale
assert(bandOf(new Date(Date.now() - 2 * 3600 * 1000).toISOString(), new Date()) === 'hot', 'bandOf 2h → hot（共享常量口径）');

// applySnoozes 独立导出可用
const ps = [{ path: 'p', warnings: [{ type: 'dirty', label: 'x' }] }];
applySnoozes(ps, { p: { dirty: 'x' } });
assert(ps[0].warnings.length === 0, 'applySnoozes 过滤签名匹配项');

console.log('\ntest-board: all assertions passed');
