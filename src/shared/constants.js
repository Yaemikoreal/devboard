// 跨进程共享领域常量（issue-11 / GitHub #127）：主进程直接 require，渲染层经 preload 暴露
// （window.devboardConsts）消费，scripts/mock-board.js 亦从本文件取——同一份定义不再多份手写。
// 纯 Node，不依赖 Electron。
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// 警示严重度（issue #74）：需要关注清单与行内警示图形按值升序排（未提交超期 > 未推送 > CI 失败 > 待处理 review > 开放 PR）；
// 未知类型回退 9 排最后。CI 失败位次定在「未推送」与「开放 PR」之间（issue #143），review 紧随其后（issue #144）
const WARN_SEVERITY = { dirty: 0, ahead: 1, ci: 2, review: 3, pr: 4 };

// 活跃分带单一来源：阈值（maxDays = 最近活动距今天数上限，按数组序首个命中落带）+ 枚举 +
// 中文 label + 详情面板 pill 类名 + 筛选 chips 提示 + AI 筛选 prompt 释义。
// 调阈值或措辞只改这里：主面板 pill、筛选 chips、AI 提示词三处随之同步。
const BAND_DEFS = [
  { id: 'hot', maxDays: 3, label: '活跃', pill: 'bp-hot', chipHint: '3 天内有动静', aiDesc: '3 天内有活动' },
  { id: 'active', maxDays: 7, label: '近期', pill: 'bp-active', chipHint: '4-7 天没有动静', aiDesc: '3-7 天' },
  { id: 'cooling', maxDays: 30, label: '渐冷', pill: 'bp-cool', chipHint: '8-30 天没有动静', aiDesc: '7-30 天' },
  { id: 'stale', maxDays: 90, label: '沉睡', pill: 'bp-stall', chipHint: '31-90 天没有动静', aiDesc: '30-90 天' },
  { id: 'archive', maxDays: Infinity, label: '归档', pill: 'bp-arch', chipHint: '90 天以上没有动静，或从未有活动', aiDesc: '90 天以上' },
];

const BAND_IDS = BAND_DEFS.map((b) => b.id); // 合法枚举（AI 筛选结果校验等）
const BAND_LABEL = {}; // id -> 中文 label
const BAND_PILL = {}; // id -> 详情面板分带 pill 的 css 类名
for (const b of BAND_DEFS) {
  BAND_LABEL[b.id] = b.label;
  BAND_PILL[b.id] = b.pill;
}

// 分带判定：按最近活动距今天数落带；从未有活动归 archive
function bandOf(lastActivityAt, now) {
  if (!lastActivityAt) return 'archive';
  const days = (now.getTime() - Date.parse(lastActivityAt)) / DAY_MS;
  for (const b of BAND_DEFS) {
    if (days <= b.maxDays) return b.id;
  }
  return 'archive';
}

// 热力图色阶：0 无色，其后按提交数三档渐深（渲染层全年图与月份日历共用）
function heatLevel(n) {
  return n === 0 ? 0 : n < 3 ? 1 : n < 7 ? 2 : 3;
}

// 本地日期键 YYYY-MM-DD：AI 周报按天缓存键、activity365 构建日、数据导出文件名共用
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = {
  WARN_SEVERITY,
  BAND_DEFS,
  BAND_IDS,
  BAND_LABEL,
  BAND_PILL,
  bandOf,
  heatLevel,
  localDateStr,
};
