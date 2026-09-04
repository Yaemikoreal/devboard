// 截图密度验证用：8 个 mock 项目，覆盖四个分带与各类警示。仅 DEVBOARD_MOCK=1 时使用。
'use strict';

function isoDaysAgo(days, hours = 0) {
  return new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();
}

function activity(seed) {
  // 生成确定性的 30 天活动数组
  const arr = new Array(30).fill(0);
  for (let i = 0; i < 30; i++) arr[i] = (i * 7 + seed * 13) % 5 === 0 ? 0 : ((i * 7 + seed * 13) % 5);
  return arr;
}

function commits(list) {
  return list.map(([msg, rel]) => ({ msg, rel }));
}

function mockBoard() {
  const projects = [
    {
      path: 'E:\\myproject\\wyy2qqmusic', name: 'wyy2qqmusic', branch: 'main',
      lastCommitAt: isoDaysAgo(0, 2), commits7d: 14,
      recentCommits: commits([
        ['fix: 修复歌单解析空指针', '2小时前'], ['feat: 支持 QQ 歌单批量导入', '5小时前'],
        ['refactor: 拆分登录模块', '昨天'], ['wip: 迁移脚本联调', '昨天'],
      ]),
      dirtyCount: 3, dirtyFiles: ['_t7_migrate.py', '_t3_login.py', 'README.md'],
      ahead: 2, behind: 0, hasUpstream: true,
      activity30: [0, 0, 1, 0, 2, 1, 0, 1, 2, 1, 0, 2, 1, 3, 2, 1, 2, 3, 2, 4, 1, 2, 3, 4, 3, 4, 2, 3, 4, 4],
      aiSessionAt: isoDaysAgo(0, 1), memo: '迁移脚本联调中，QQ 登录 cookie 老失效',
      band: 'hot',
      warnings: [{ type: 'ahead', label: '2 提交未推送' }],
      github: {
        owner: 'me', repo: 'wyy2qqmusic', openIssues: 2, openPRs: 1,
        items: [
          { type: 'pr', number: 7, title: 'feat: 批量导入接口', url: 'https://github.com/me/wyy2qqmusic/pull/7' },
          { type: 'issue', number: 3, title: 'cookie 失效后无法自动刷新', url: 'https://github.com/me/wyy2qqmusic/issues/3' },
          { type: 'issue', number: 5, title: '支持导出 csv', url: 'https://github.com/me/wyy2qqmusic/issues/5' },
        ],
      },
    },
    {
      path: 'E:\\myproject\\devboard', name: 'devboard', branch: 'main',
      lastCommitAt: isoDaysAgo(1), commits7d: 6,
      recentCommits: commits([['docs: 确定设计方向与色彩规范', '1天前'], ['feat: 项目扫描器初版', '2天前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: true,
      activity30: activity(2), aiSessionAt: isoDaysAgo(0, 3), memo: '概况板本体，刚定完设计方向',
      band: 'active', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\chat-analysis', name: 'chat-analysis', branch: 'feat/pdf-v2',
      lastCommitAt: isoDaysAgo(5), commits7d: 4,
      recentCommits: commits([['feat: PDF 模板 v2 布局', '5天前'], ['fix: 长图分页溢出', '6天前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 1, hasUpstream: true,
      activity30: activity(3), aiSessionAt: isoDaysAgo(3), memo: '报告模板第二版待确认',
      band: 'active',
      warnings: [{ type: 'pr', label: '1 个开放 PR' }],
      github: {
        owner: 'me', repo: 'chat-analysis', openIssues: 0, openPRs: 1,
        items: [{ type: 'pr', number: 7, title: 'feat: PDF 模板 v2', url: 'https://github.com/me/chat-analysis/pull/7' }],
      },
    },
    {
      path: 'E:\\myproject\\corpgraph-tool', name: 'corpgraph-tool', branch: 'main',
      lastCommitAt: isoDaysAgo(12), commits7d: 0,
      recentCommits: commits([['feat: 批量关系查询', '12天前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: false,
      activity30: activity(4), aiSessionAt: null, memo: '',
      band: 'cooling', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\kimi-skill-lab', name: 'kimi-skill-lab', branch: 'main',
      lastCommitAt: isoDaysAgo(18), commits7d: 0,
      recentCommits: commits([['feat: 新增 skill 骨架', '18天前']]),
      dirtyCount: 5, dirtyFiles: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
      ahead: 0, behind: 0, hasUpstream: true,
      activity30: activity(5), aiSessionAt: isoDaysAgo(10), memo: '实验性 skill 集合',
      band: 'cooling',
      warnings: [{ type: 'dirty', label: '5 文件未提交超3天' }], github: null,
    },
    {
      path: 'E:\\myproject\\GithubHarticipant\\httpie-cli', name: 'httpie-cli', branch: 'master',
      lastCommitAt: isoDaysAgo(90), commits7d: 0,
      recentCommits: commits([['chore: upstream sync', '3个月前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: true,
      activity30: new Array(30).fill(0), aiSessionAt: null, memo: 'fork 上游，仅学习源码',
      band: 'stale', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\old-crawler', name: 'old-crawler', branch: 'main',
      lastCommitAt: isoDaysAgo(74), commits7d: 0,
      recentCommits: commits([['fix: 反爬绕过', '74天前']]),
      dirtyCount: 8, dirtyFiles: ['spider.py', 'proxy.py'],
      ahead: 0, behind: 0, hasUpstream: false,
      activity30: new Array(30).fill(0), aiSessionAt: null, memo: '',
      band: 'stale',
      warnings: [{ type: 'dirty', label: '8 文件未提交超3天' }], github: null,
    },
    {
      path: 'E:\\myproject\\note-dump', name: 'note-dump', branch: 'main',
      lastCommitAt: isoDaysAgo(45), commits7d: 0,
      recentCommits: commits([['docs: 杂记归档', '45天前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: false,
      activity30: new Array(30).fill(0), aiSessionAt: null, memo: '',
      band: 'stale', warnings: [], github: null,
    },
  ];

  const attention = projects
    .filter((p) => p.warnings.length > 0)
    .map((p) => ({ path: p.path, name: p.name, label: p.warnings.map((w) => w.label).join('，') }));

  return {
    scannedAt: new Date().toISOString(),
    stats: {
      total: projects.length,
      commits7d: projects.reduce((s, p) => s + p.commits7d, 0),
      attentionCount: attention.length,
    },
    attention,
    projects,
  };
}

module.exports = { mockBoard };
