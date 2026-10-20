// 拼板唯一汇聚点（自 ipc.js 提取，ADR-0005 配套工程）：memos + 交接摘要 + 警示按当前规则重算
// + GitHub 缓存挂接 + 警示消音 + 统计。纯 Node 无 Electron；store 侧数据以快照入参注入
// （ipc.js 现取，DSH 插件同法），桌面应用与插件共用同一实现——「同口径」升级为结构保证。
'use strict';

const scanner = require('./scanner');
const github = require('./github');
const handoffs = require('./handoffs');
const { WARN_SEVERITY } = require('../shared/constants');

// 警示消音：签名（label）匹配的警示被过滤；状态变化导致 label 改变时自动复出
function applySnoozes(projects, snoozes) {
  for (const p of projects) {
    const s = snoozes[p.path];
    if (!s) continue;
    p.warnings = p.warnings.filter((w) => s[w.type] !== w.label);
  }
}

// snapshot: { memos, handoffsAll, handoffReadAt, snoozes, githubCache }；now 供测试注入。
// github.attachFromCache 只消费 getGithubCache()，用快照 shim 保持 github.js 零改动。
function assembleBoard(projects, config, fromCache, snapshot, now) {
  const snap = snapshot || {};
  const memos = snap.memos || {};
  const nowDate = now || new Date();
  for (const p of projects) p.memo = memos[p.path] || '';

  // 交接并入（issue #147）：latest + 未读数下发，写入时间计入最后活动并重算分带——
  // userData 侧时间不进只读扫描器，全板产出（缓存拼板/重扫补丁/GitHub 刷新补丁）唯一汇聚点在此
  handoffs.applyToProjects(projects, {
    handoffsAll: snap.handoffsAll || {},
    handoffReadAt: snap.handoffReadAt || {},
  }, nowDate);

  // 警示按当前规则重算（issue #73）：缓存/降级条目里的 warnings 是旧规则产物，
  // 依赖的事实字段（dirtyCount/lastCommitAt/ahead/github.openPRs）都在，重算零 IO，
  // 设置改动后无需等重扫即反映到需要关注清单与行内警示点；消音签名按新 label 照常匹配
  const rules = scanner.warningRulesOf(config);
  for (const p of projects) p.warnings = scanner.localWarnings(p, nowDate, rules);

  const stale = github.attachFromCache(projects, config, { getGithubCache: () => snap.githubCache || { repos: {} } });
  github.applyPrWarnings(projects, rules.types.pr);
  github.applyCiWarnings(projects, rules.types.ci); // 默认分支 CI 失败（issue #143）
  github.applyReviewWarnings(projects, rules.types.review); // PR 有待处理 review（issue #144）
  applySnoozes(projects, snap.snoozes || {});

  // originUrl 仅为内部解析用，不下发渲染层
  const out = projects.map((p) => {
    const q = Object.assign({}, p);
    delete q.originUrl;
    return q;
  });

  // 需要关注清单携带警示类型（issue #77）并按严重度排序（issue #74）：
  // 未提交超期 > 未推送 > CI 失败 > 待处理 review > 开放 PR，同级按项目名稳定排序
  const severityOf = (types) => Math.min.apply(null, types.map((t) => (t in WARN_SEVERITY ? WARN_SEVERITY[t] : 9)));
  const attention = out
    .filter((p) => p.warnings.length > 0)
    .map((p) => ({
      path: p.path,
      name: p.name,
      label: p.warnings.map((w) => w.label).join('，'),
      types: p.warnings.map((w) => w.type),
    }))
    .sort((a, b) => severityOf(a.types) - severityOf(b.types) || a.name.localeCompare(b.name));

  return {
    board: {
      scannedAt: nowDate.toISOString(),
      fromCache: !!fromCache,
      stats: {
        total: out.length,
        commits7d: out.reduce((s, p) => s + p.commits7d, 0),
        attentionCount: attention.length,
      },
      attention,
      projects: out,
      // GitHub 通知快照（issue #145）：未读事件跨项目注意力流；增量补丁不带此字段时渲染层保留旧值
      notifications: (snap.githubCache && snap.githubCache.notifications) || { fetchedAt: 0, data: [], error: null },
    },
    stale,
  };
}

module.exports = { assembleBoard, applySnoozes };
