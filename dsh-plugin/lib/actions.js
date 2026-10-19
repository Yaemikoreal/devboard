// 动作直执行适配（设计 §6「语义适配」：shell.openPath → spawn）：quickopen/open_cli 在插件
// 形态下不经应用、直接在本机拉起可见终端/编辑器（人在环保留）。启动失败返回 ok:false 不抛。
import { spawn } from 'node:child_process';
import { aiTools } from './domain.js';

// 与 ipc.js spawnResult 同款：shell:true + 引号转义 + 3s 存活窗口判成败
const SHELL_ARG_NEEDS_QUOTE = /[\s"&|<>^%()]/;
function quoteShellArg(a) {
  const s = String(a);
  return !s || SHELL_ARG_NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
const SPAWN_ALIVE_MS = 3000;
function spawnResult(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args.map(quoteShellArg), Object.assign({ detached: true, stdio: 'ignore', shell: true }, opts));
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let aliveTimer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (aliveTimer) clearTimeout(aliveTimer);
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    aliveTimer = setTimeout(() => done(true), SPAWN_ALIVE_MS);
    if (aliveTimer.unref) aliveTimer.unref();
    child.unref();
  });
}

// 快捷打开：folder=explorer；editor=editorCmd；terminal=terminalCmd || wt -d || cmd start
export async function quickOpen(projectPath, kind, config) {
  const p = String(projectPath || '');
  if (!p) return { ok: false, reason: '缺少项目路径' };
  if (kind === 'editor') {
    const ok = await spawnResult(config.editorCmd || 'code', [p]);
    return ok ? { ok: true } : { ok: false, reason: '编辑器启动失败（editorCmd=' + (config.editorCmd || 'code') + '）' };
  }
  if (kind === 'terminal') {
    const custom = (config.terminalCmd || '').trim();
    if (custom) {
      const ok = await spawnResult(custom, [], { cwd: p });
      return ok ? { ok: true } : { ok: false, reason: '自定义终端启动失败' };
    }
    if (await spawnResult('wt', ['-d', p])) return { ok: true };
    const ok = await spawnResult('cmd', ['/c', 'start', 'cmd'], { cwd: p });
    return ok ? { ok: true } : { ok: false, reason: '终端启动失败（wt 不可用且 start 失败）' };
  }
  // folder（缺省）
  if (await spawnResult('explorer', [p])) return { ok: true };
  return { ok: false, reason: '资源管理器启动失败' };
}

// 在项目目录的可见终端里启动 AI CLI（可带 prompt 预填）。
// prefill 管线镜像 ipc-ai.openCliInTerminal 的 arg 模式；none 模式桌面端走 Electron 剪贴板兜底，
// 宿主进程无剪贴板能力——如实注明 prompt 未传递（v1 行为，设计「可见 OS 终端 + 人在环」保留）。
export async function openCli(cmd, projectPath, prompt, config) {
  const c = String(cmd || '').trim();
  const p = String(projectPath || '');
  if (!c) return { ok: false, reason: '缺少 AI CLI 命令' };
  if (!p) return { ok: false, reason: '缺少项目路径' };
  const tool = aiTools.toolById(c);
  const prefillMode = (tool && tool.prefill && tool.prefill.mode) || 'none';
  const promptText = String(prompt || '').trim();
  let note = '';
  if (promptText && prefillMode === 'arg') {
    const ok = await spawnResult('wt', ['-d', p, 'cmd', '/k', c, promptText]);
    if (ok) return { ok: true };
    const ok2 = await spawnResult('cmd', ['/c', 'start', 'cmd', '/k', c, promptText], { cwd: p });
    if (ok2) return { ok: true };
    return { ok: false, reason: '终端启动失败' };
  }
  if (promptText && prefillMode !== 'arg') {
    note = '该 CLI 不支持 prompt 预填（宿主进程无剪贴板兜底），prompt 未传递';
  }
  const ok = await spawnResult('wt', ['-d', p, 'cmd', '/k', c]);
  if (ok) return { ok: true, note };
  const ok2 = await spawnResult('cmd', ['/c', 'start', 'cmd', '/k', c], { cwd: p });
  if (ok2) return { ok: true, note };
  return { ok: false, reason: '终端启动失败' };
}
