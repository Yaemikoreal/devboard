// AI 总结缓存（设计 §3「总结写 1」）：AI 触发链的窄写面——只写独立缓存文件
// dsh-summary-cache.json，不碰备忘/消音/prefs/ai-cache（引擎不同：宿主 agent vs 桌面 CLI）。
// Store 的 readJson/writeJson 自带损坏留证 + 内存副本 + tmp+rename 原子写，直接复用。
import { shared } from './domain.js';

const FILE = 'dsh-summary-cache.json';
const TEXT_CAP = 20000;

function fallback() {
  return { weekly: null, advice: {} };
}

export function getDshSummary(store) {
  const c = store.readJson(FILE, fallback());
  if (!c || typeof c !== 'object') return fallback();
  if (!c.advice || typeof c.advice !== 'object') c.advice = {};
  return c;
}

// kind=weekly：按当天日期覆盖复用（与桌面端 weekly 缓存键同口径）；kind=advice：按项目路径键。
// 返回落盘后的条目；非法入参抛结构化错误（工具层转 [BAD_ARGS]/[BAD_KIND]）。
export function saveSummary(store, { kind, path: projectPath, text }) {
  const k = String(kind || '');
  const body = String(text || '').trim();
  if (k !== 'weekly' && k !== 'advice') {
    const err = new Error("kind 必须是 'weekly' 或 'advice'");
    err.code = 'BAD_KIND';
    throw err;
  }
  if (!body) {
    const err = new Error('text 不能为空');
    err.code = 'BAD_ARGS';
    throw err;
  }
  const now = new Date();
  const cache = getDshSummary(store);
  let entry;
  if (k === 'weekly') {
    entry = { date: shared.localDateStr(now), text: body.slice(0, TEXT_CAP), at: now.toISOString(), engine: 'dsh-agent' };
    cache.weekly = entry;
  } else {
    const p = String(projectPath || '').trim();
    if (!p) {
      const err = new Error("kind='advice' 时 path 必填");
      err.code = 'BAD_ARGS';
      throw err;
    }
    entry = { path: p, text: body.slice(0, TEXT_CAP), at: now.toISOString(), engine: 'dsh-agent' };
    cache.advice[p] = entry;
  }
  store.writeJson(FILE, cache, true);
  return entry;
}
