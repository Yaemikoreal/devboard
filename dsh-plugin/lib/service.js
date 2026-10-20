// 面板数据服务（设计 §4「一个操作，两个调用方」的服务侧汇聚）：boardPayload 供 web 路由
// 与命令共用；rescan 在飞去重。数据通路纪律：读 = 板缓存拼板（与 agent 工具同源同实现），
// 写 = commands-host / tools-host 共用的域函数。
import { board, scanner } from './domain.js';
import { rescanAndCache } from './snap.js';
import { getDshSummary } from './summary.js';
import { detectAiTools } from './detect.js';

export function createService(ctx, store, cfg) {
  let scanPromise = null;

  // 在飞去重的进程内重扫
  function rescan() {
    if (scanPromise) return scanPromise;
    scanPromise = rescanAndCache(store).finally(() => { scanPromise = null; });
    return scanPromise;
  }

  // store 侧快照现取（与 ipc.js 拼板薄壳同款）
  function snapshotOf() {
    return {
      memos: store.getMemos(),
      handoffsAll: store.getHandoffs(),
      handoffReadAt: store.getPrefs().handoffReadAt,
      snoozes: store.getPrefs().snoozes,
      githubCache: store.getGithubCache(),
    };
  }

  // 面板数据载荷：拼板（缓存路径）+ prefs + AI 总结缓存 + 工作台探测 + 引导态。
  // 注意：不触发网络（GitHub 刷新是桌面应用自身周期的事），插件只读展示缓存数据龄。
  async function boardPayload() {
    const config = store.getConfig();
    const cache = store.getScanCache();
    const cachedProjects = Object.values(cache.projects);
    const { board: assembled } = board.assembleBoard(cachedProjects, config, true, snapshotOf(), new Date());
    const prefs = store.getPrefs();
    const summary = getDshSummary(store);
    let aiList = [];
    try {
      aiList = await detectAiTools(config);
    } catch { /* 探测失败工作台置空，不炸路由 */ }
    return {
      board: assembled,
      scannedAt: cache.scannedAt || null,
      prefs: {
        pinned: Array.isArray(prefs.pinned) ? prefs.pinned : [],
        cardOrder: Array.isArray(prefs.cardOrder) ? prefs.cardOrder : [],
        sortMode: prefs.sortMode || 'manual',
        snoozes: prefs.snoozes || {}, // path -> { warningType: label }（详情面板已消音清单 + 取消）
      },
      summary,
      aiTools: aiList,
      guide: {
        rootsConfigured: (config.roots || []).length > 0 || (config.extraPaths || []).length > 0,
        userDataDir: store.baseDir,
        hasGithubToken: Boolean(config.githubToken),
        githubUsername: config.githubUsername || '',
        editorCmd: config.editorCmd || 'code',
        terminalCmd: config.terminalCmd || '',
      },
    };
  }

  // 详情深区数据（详情面板懒取）：README 摘要 + AI 会话痕迹——scanner.projectDetail 既有实现，
  // 目录不可读时其内部已容错；这里兜底空值不抛
  async function projectDetail(projectPath) {
    const p = String(projectPath || '');
    if (!p) return { readme: '', aiSessions: [] };
    try {
      return await scanner.projectDetail(p);
    } catch {
      return { readme: '', aiSessions: [] };
    }
  }

  return { rescan, boardPayload, projectDetail, snapshotOf };
}
