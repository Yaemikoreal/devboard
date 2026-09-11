// GUI 启动 PATH 增补（issue #87）：macOS 上经 Finder/Dock/npm start 启动的 GUI 应用不继承 shell rc 的 PATH，
// npm/homebrew 安装的 CLI（claude、code、gh 等）在探测与调用时全部找不到。启动时经 login shell 取一次
// 真实 PATH（覆盖 nvm 等只在 rc 中生效的目录），合并常见安装路径后写回 process.env.PATH——主进程所有
// 子进程（scanner 的 git、github 的 gh、ai 的 CLI、quickopen 的 open/编辑器）统一受益。仅 darwin 生效。
'use strict';

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// 常见 CLI 安装位：login shell 取 PATH 失败（无 SHELL / rc 超时）时的兜底
function commonPaths() {
  const home = os.homedir();
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];
}

// 去重保序合并 PATH 片段
function mergePath(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(':');
}

let inflight = null;

// 返回 Promise 供主进程启动时 await，保证 registerIpc 之后的全部子进程都拿到增补后的 PATH
function augmentGuiPath() {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    const sh = process.env.SHELL || '/bin/zsh';
    // -il：nvm/pyenv 等只在 login/interactive rc 里改 PATH 的场景才拿得到
    execFile(sh, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 4000 }, (err, stdout) => {
      let shellPath = '';
      if (!err && stdout) {
        // rc 偶尔向 stdout 混入提示语：取含 ":" 与 "/" 的最长行作为 PATH
        const lines = String(stdout).split('\n').filter((l) => l.includes(':') && l.includes('/'));
        shellPath = lines.sort((a, b) => b.length - a.length)[0] || '';
      }
      process.env.PATH = mergePath([...shellPath.split(':'), ...commonPaths(), ...process.env.PATH.split(':')]);
      resolve(true);
    });
  });
  return inflight;
}

module.exports = { augmentGuiPath, commonPaths, mergePath };
