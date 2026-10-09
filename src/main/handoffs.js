// 交接（Handoff）领域服务（issue #147）：agent 完成一段工作后随项目写下的留言，供下一个执行者
// （人或 agent）接力。与备忘并列而不合并——agent 写交接（MCP 写入口，#149 复用），人写备忘。
// 独立模块不给 IPC 长摊：writeHandoff/markDone 是 #148（get_handoffs）与 #149（handoff_write/
// handoff_complete）直接复用的写入口；applyToProjects 是拼板层并入的纯函数（快照入参，可单测）。
'use strict';

const path = require('path');
const crypto = require('crypto');
const { bandOf } = require('../shared/constants');

const MAX_TEXT = 8000; // 交接正文上限：数百行量级足够，防 MCP 侧意外洪泛
const MAX_PER_PROJECT = 100; // 每项目条目上限：交接是接力工作台不是归档库

function normKey(projectPath) {
  return path.resolve(String(projectPath || ''));
}

// 列出某项目的交接条目（新条目在前）；无数据返回空数组（#148 get_handoffs 首版即用）
function listHandoffs(store, projectPath) {
  const all = store.getHandoffs();
  const arr = all[normKey(projectPath)];
  return Array.isArray(arr) ? arr.slice() : [];
}

// 写入一条交接：agent 名（缺省 'agent'）、正文（去空白，限长）；返回落盘后的条目
function writeHandoff(store, projectPath, payload) {
  const p = payload || {};
  const text = String(p.text || '').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('交接内容为空');
  const entry = {
    id: 'h' + crypto.randomBytes(6).toString('hex'),
    agent: String(p.agent || '').trim().slice(0, 60) || 'agent',
    text,
    createdAt: new Date().toISOString(),
  };
  const all = store.getHandoffs();
  const key = normKey(projectPath);
  if (!Array.isArray(all[key])) all[key] = [];
  all[key].unshift(entry); // 新条目在前：拼板取 [0] 即最新
  if (all[key].length > MAX_PER_PROJECT) all[key].length = MAX_PER_PROJECT;
  store.setHandoffs(all);
  return entry;
}

// 标记接力完成：doneAt 幂等（重复标记不刷新时间戳）
function markDone(store, projectPath, id) {
  const all = store.getHandoffs();
  const arr = all[normKey(projectPath)] || [];
  const hit = arr.find((e) => e && e.id === id);
  if (!hit) throw new Error('未找到该交接条目');
  if (!hit.doneAt) hit.doneAt = new Date().toISOString();
  store.setHandoffs(all);
  return hit;
}

// 拼板层并入（快照入参，纯函数，issue #147 核验方案第 3 步）：
// - p.handoffs = { latest, unreadCount } 摘要下发；未读 = createdAt > prefs.handoffReadAt[path] 游标
// - 交接写入时间计入 p.lastActivityAt 后按共享 bandOf 重算 p.band——userData 侧时间不进只读扫描器，
//   在拼板唯一汇聚点并入，排序（activity）/分带筛选/行内相对时间全部消费点自动生效
// all/store 快照：{ handoffsAll, handoffReadAt }；now 由调用方传（与扫描器口径一致，测试可注入）
function applyToProjects(projects, snapshot, now) {
  const handoffsAll = snapshot.handoffsAll || {};
  const readAt = snapshot.handoffReadAt || {};
  const at = now || new Date();
  for (const p of projects) {
    const entries = handoffsAll[normKey(p.path)] || [];
    if (!entries.length) continue;
    const latest = entries[0];
    const cursor = readAt[p.path] || null;
    const cursorMs = cursor ? Date.parse(cursor) : 0;
    let unreadCount = 0;
    for (const e of entries) {
      if (!e.doneAt && Date.parse(e.createdAt) > cursorMs) unreadCount += 1;
    }
    p.handoffs = {
      latest: { id: latest.id, agent: latest.agent, text: latest.text, createdAt: latest.createdAt, doneAt: latest.doneAt || null },
      unreadCount,
    };
    // 计入最后活动时间并重算分带（仅在交接比现有活动新时改写，避免回拨旧数据）
    if (!p.lastActivityAt || Date.parse(latest.createdAt) > Date.parse(p.lastActivityAt)) {
      p.lastActivityAt = latest.createdAt;
      p.band = bandOf(p.lastActivityAt, at);
    }
  }
  return projects;
}

module.exports = { writeHandoff, markDone, listHandoffs, applyToProjects, MAX_TEXT, MAX_PER_PROJECT };
