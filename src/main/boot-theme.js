// 冷启动防闪（issue #101）：首帧关键 token 表与按主题的解析。
// 主进程入口建窗定底色 + preload 同步桥共用；截图脚本 mock 链路也取同一份（单一事实源）。
// 色值与 app.js THEMES 对齐，新增主题时需同步维护此表
'use strict';

const { nativeTheme } = require('electron');

const BOOT_COLORS = {
  warm:   { bg: '#f5f2e8', card: '#fdfcf8', ink: '#181818', bgArt: '#f2eee2' },
  mist:   { bg: '#edf0f4', card: '#fbfcfd', ink: '#181c22', bgArt: '#e9edf3' },
  meadow: { bg: '#eef3ec', card: '#fcfdfb', ink: '#17201a', bgArt: '#e9efe5' },
  sakura: { bg: '#f6eff0', card: '#fdfbf9', ink: '#211a1c', bgArt: '#f3e9ea' },
  iris:   { bg: '#f1f0f6', card: '#fbfbfd', ink: '#1e1b26', bgArt: '#eceaf2' },
  dark:   { bg: '#1b1915', card: '#26231d', ink: '#f0ece1', bgArt: '#16140f' },
  abyss:  { bg: '#151a21', card: '#1e242e', ink: '#e9edf3', bgArt: '#10141a' },
};

// 首帧关键色：按主题解析；跟随系统（mode=auto）时按系统明暗取浅/深主题对
function bootThemePayload(cfgTheme) {
  const t = cfgTheme || {};
  let id = BOOT_COLORS[t.id] ? t.id : 'warm';
  if (t.mode === 'auto') {
    const want = nativeTheme.shouldUseDarkColors ? t.darkId : t.lightId;
    if (BOOT_COLORS[want]) id = want;
  }
  return Object.assign({ id }, BOOT_COLORS[id]);
}

module.exports = { BOOT_COLORS, bootThemePayload };
