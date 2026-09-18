// 截图密度验证用：8 个 mock 项目，覆盖五个分带与各类警示。仅 DEVBOARD_MOCK=1 时使用。
'use strict';

const { WARN_SEVERITY } = require('../src/shared/constants'); // 严重度与真实板同源（issue-11 / #127）

function isoDaysAgo(days, hours = 0) {
  return new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();
}

function yearActivity(seed, hotRecently = false) {
  // 生成确定性的全年活动数组：老底子稀疏，hotRecently 时近几周加密
  const arr = new Array(365).fill(0);
  for (let i = 0; i < 365; i++) {
    const v = (i * 7 + seed * 13) % 9;
    arr[i] = v < 5 ? 0 : v - 4; // 0~4 量级
  }
  if (hotRecently) {
    for (let i = 365 - 28; i < 365; i++) {
      arr[i] = (i + seed) % 4 === 0 ? 0 : ((i * 3 + seed) % 8) + 1; // 近 4 周高量
    }
  }
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
      activity365: yearActivity(1, true), aiSessionAt: isoDaysAgo(0, 1), memo: '迁移脚本联调中，QQ 登录 cookie 老失效',
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
      activity365: yearActivity(2, true), aiSessionAt: isoDaysAgo(0, 3), memo: '概况板本体，刚定完设计方向',
      band: 'active', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\chat-analysis', name: 'chat-analysis', branch: 'feat/pdf-v2',
      lastCommitAt: isoDaysAgo(5), commits7d: 4,
      recentCommits: commits([['feat: PDF 模板 v2 布局', '5天前'], ['fix: 长图分页溢出', '6天前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 1, hasUpstream: true,
      activity365: yearActivity(3, true), aiSessionAt: isoDaysAgo(3), memo: '报告模板第二版待确认',
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
      activity365: yearActivity(4), aiSessionAt: null, memo: '',
      band: 'cooling', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\kimi-skill-lab', name: 'kimi-skill-lab', branch: 'main',
      lastCommitAt: isoDaysAgo(18), commits7d: 0,
      recentCommits: commits([['feat: 新增 skill 骨架', '18天前']]),
      dirtyCount: 5, dirtyFiles: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
      ahead: 0, behind: 0, hasUpstream: true,
      activity365: yearActivity(5), aiSessionAt: isoDaysAgo(10), memo: '实验性 skill 集合',
      band: 'cooling',
      warnings: [{ type: 'dirty', label: '5 文件未提交超3天' }], github: null,
      githubOwned: true, githubError: '网络请求失败', // GitHub 同步失败态演示（issue #46）
    },
    {
      path: 'E:\\myproject\\GithubHarticipant\\httpie-cli', name: 'httpie-cli', branch: 'master',
      lastCommitAt: isoDaysAgo(90), commits7d: 0,
      recentCommits: commits([['chore: upstream sync', '3个月前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: true,
      activity365: new Array(365).fill(0), aiSessionAt: null, memo: 'fork 上游，仅学习源码',
      band: 'stale', warnings: [], github: null,
    },
    {
      path: 'E:\\myproject\\old-crawler', name: 'old-crawler', branch: 'main',
      lastCommitAt: isoDaysAgo(74), commits7d: 0,
      recentCommits: commits([['fix: 反爬绕过', '74天前']]),
      dirtyCount: 8, dirtyFiles: ['spider.py', 'proxy.py'],
      ahead: 0, behind: 0, hasUpstream: false,
      activity365: new Array(365).fill(0), aiSessionAt: null, memo: '',
      band: 'stale',
      warnings: [{ type: 'dirty', label: '8 文件未提交超3天' }], github: null,
    },
    {
      path: 'E:\\myproject\\note-dump', name: 'note-dump', branch: 'main',
      lastCommitAt: isoDaysAgo(120), commits7d: 0,
      recentCommits: commits([['docs: 杂记归档', '4个月前']]),
      dirtyCount: 0, dirtyFiles: [], ahead: 0, behind: 0, hasUpstream: false,
      activity365: new Array(365).fill(0), aiSessionAt: null, memo: '',
      band: 'archive', warnings: [], github: null,
    },
  ];

  // 最近动静 = max(最后提交, AI 会话痕迹)；scanner 另有 dirtyAt 第三路（未提交改动文件 mtime），mock 未建模文件 mtime 且 band 已硬编码，此处省略
  projects.forEach((p) => {
    p.lastActivityAt = [p.lastCommitAt, p.aiSessionAt].filter(Boolean).sort().pop() || null;
  });

  // DEVBOARD_MOCK_CALM=1：清零全部警示，验证需要关注卡的平静态（issue #74）
  if (process.env.DEVBOARD_MOCK_CALM === '1') projects.forEach((p) => { p.warnings = []; });

  // 携带警示类型（issue #77）并按严重度排序（issue #74），与主进程 assembleBoard 共用 WARN_SEVERITY
  const severityOf = (types) => Math.min.apply(null, types.map((t) => (t in WARN_SEVERITY ? WARN_SEVERITY[t] : 9)));
  const attention = projects
    .filter((p) => p.warnings.length > 0)
    .map((p) => ({
      path: p.path,
      name: p.name,
      label: p.warnings.map((w) => w.label).join('，'),
      types: p.warnings.map((w) => w.type),
    }))
    .sort((a, b) => severityOf(a.types) - severityOf(b.types) || a.name.localeCompare(b.name));

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

// 详情面板深区数据 mock（issue #17）：README 首段摘要 + AI 会话痕迹明细
function mockProjectDetail(projectPath) {
  const table = {
    'E:\\myproject\\wyy2qqmusic': {
      readme: '网易云歌单迁移到 QQ 音乐的小工具，支持批量导入与断点续传。',
      aiSessions: [
        { tool: 'kimi', at: isoDaysAgo(0, 1) },
        { tool: 'claude', at: isoDaysAgo(0, 14) },
        { tool: 'codex', at: isoDaysAgo(2, 5) },
        { tool: 'grok', at: isoDaysAgo(9, 3) },
      ],
    },
    'E:\\myproject\\devboard': {
      readme: '本地桌面端项目概况板：聚合各项目事实近况，防止决策漂移。',
      aiSessions: [{ tool: 'kimi', at: isoDaysAgo(0, 3) }],
    },
    'E:\\myproject\\chat-analysis': {
      readme: '群聊 JSON 结构化分析，生成单页卡式 PDF 长图报告。',
      aiSessions: [
        { tool: 'kimi', at: isoDaysAgo(3) },
        { tool: 'codex', at: isoDaysAgo(3, 6) },
      ],
    },
    'E:\\myproject\\corpgraph-tool': {
      readme: '企业上下游关系批量查询工具。',
      aiSessions: [],
    },
    'E:\\myproject\\kimi-skill-lab': {
      readme: '',
      aiSessions: [{ tool: 'kimi', at: isoDaysAgo(10) }],
    },
  };
  return table[projectPath] || { readme: '', aiSessions: [] };
}

module.exports = { mockBoard, mockProjectDetail };
