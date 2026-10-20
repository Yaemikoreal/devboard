// 快照装配（设计 §2「薄适配层」三件事之二）：把 Store/config/now 组装成 tools.js 纯函数
// 入参 { store, config, now, appSpawn }，每次调用现取（进程常驻期间数据文件可能被应用更新，
// 与 MCP server 同款纪律）；并实现插件形态的进程内重扫（「请求应用执行」语义在此形态消失）。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { scanner, actionProto } from './domain.js';

// userData 解析：默认与桌面应用 userData 同目录（Windows %APPDATA%\SignalBoard；
// macOS ~/Library/Application Support/SignalBoard；linux ~/.config/SignalBoard），
// 与 mcp/server.js resolveUserDataDir 同口径；Config.userDataDir 可覆盖。
export function defaultUserDataDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'SignalBoard');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SignalBoard');
  return path.join(home, '.config', 'SignalBoard');
}

// 写后刷新适配（可选）：仅当 Config.appExe 配置了才存在。动作语义是请求——
// detached 拉起应用 exe 带 --mcp-action=refresh（second-instance/启动段处理同一动作），
// 拉起失败（exe 缺失等）不炸进程：数据已落盘，对方下个刷新周期自愈。
export function makeAppSpawn(cfg) {
  const exe = cfg && String(cfg.appExe || '').trim();
  if (!exe) return null;
  const cwd = cfg && String(cfg.appCwd || '').trim();
  return (action) => {
    const args = actionProto.buildActionArgv(action); // 未知键/缺 action 在此报 BAD_ACTION
    const child = spawn(exe, cwd ? ['.', ...args] : args, {
      cwd: cwd || undefined,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    if (child.unref) child.unref();
    return true;
  };
}

// 工具快照：store 引用 + config 现读 + now 现取 + appSpawn（未配置 appExe 时为 null，
// 查询工具不受影响，写面如实报「应用未配置刷新」走自愈）
export function makeSnapshot(store, cfg) {
  return {
    store,
    config: store.getConfig(),
    now: new Date(),
    appSpawn: makeAppSpawn(cfg),
  };
}

// 进程内全量重扫（插件自己就是扫描者）：scanner 既有并发槽/预算/降级语义原样沿用——
// HEAD 分档、单项目 3s 预算、超时降级缓存、迟到真实扫描经 onLate 回补。
export async function rescanAndCache(store) {
  const config = store.getConfig();
  const cache = store.getScanCache();
  const scope = {
    roots: Array.isArray(config.roots) ? config.roots : [],
    blacklist: Array.isArray(config.blacklist) ? config.blacklist : [],
    extraPaths: Array.isArray(config.extraPaths) ? config.extraPaths : [],
  };
  const projects = await scanner.scan(scope, {
    cache,
    warningRules: scanner.warningRulesOf(config),
    onLate: (projectPath, fresh) => {
      const cur = store.getScanCache();
      cur.projects[projectPath] = fresh;
      cur.scannedAt = new Date().toISOString();
      store.setScanCache(cur);
    },
  });
  const next = { scannedAt: new Date().toISOString(), projects: {} };
  for (const p of projects) {
    // 降级条目保留旧缓存（迟到回补会覆盖）
    next.projects[p.path] = p.degraded && cache.projects[p.path] ? cache.projects[p.path] : p;
  }
  store.setScanCache(next);
  await projects.settled; // 迟到的真实扫描经 onLate 已回补缓存
  return next;
}
