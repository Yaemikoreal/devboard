// 工作台 AI CLI 探测（设计 §4 总览「工作台」）：镜像 ipc-ai.probeAiTools——默认注册表清单
// + config.aiTools 自定义行，逐项 where 探测 PATH。ipc-ai.js 依赖 Electron 不可复用，
// 本实现只依赖 shared/ai-tools 纯数据注册表（图标数据行一并下发供面板内联渲染）。
import { execFile } from 'node:child_process';
import { aiTools } from './domain.js';

function probe(cmd) {
  return new Promise((resolve) => {
    execFile('where', [String(cmd)], { timeout: 10000 }, (err, stdout) => {
      if (err) resolve(false);
      else resolve(Boolean(String(stdout).trim()));
    });
  });
}

// 60s 缓存（键含默认清单 + 自定义清单，设置变更即重探）；在飞去重（与 detectAiTools 同款）
let cache = { at: 0, key: '', list: null, promise: null };

export function detectAiTools(config) {
  const cfg = config || {};
  const custom = (cfg.aiTools || []).map((t, i) => ({
    id: 'custom-' + i,
    label: String(t.label || t.cmd || ''),
    cmd: String(t.cmd || '').trim(),
    logoKey: typeof t.logo === 'string' ? t.logo : '',
  })).filter((t) => t.cmd);
  const key = JSON.stringify([aiTools.defaultToolList().map((t) => t.cmd), custom]);
  if (cache.key === key) {
    if (cache.list && Date.now() - cache.at < 60000) return Promise.resolve(cache.list);
    if (cache.promise) return cache.promise;
  }
  const run = (async () => {
    const tools = aiTools.defaultToolList().concat(custom);
    const list = await Promise.all(tools.map(async (t) => {
      const icon = aiTools.iconFor(t.logoKey, t.id);
      return {
        id: t.id,
        label: t.label,
        cmd: t.cmd,
        installed: await probe(t.cmd),
        logo: { bg: icon.bg, svg: icon.svg },
      };
    }));
    return list;
  })();
  cache = { at: 0, key, list: null, promise: run };
  return run.then((list) => {
    cache = { at: Date.now(), key, list, promise: null };
    return list;
  }, (err) => {
    cache = { at: 0, key: '', list: null, promise: null };
    throw err;
  });
}
