// 冷启动防闪（issue #101）：首帧关键 token 与按主题的解析。
// 主进程入口建窗定底色 + preload 同步桥共用；截图脚本 mock 链路也取同一份（单一事实源）。
// 色值表已收敛进共享模块（issue #122）：BOOT_COLORS 从 src/shared/themes.js 的 THEMES 全量 token 派生，
// 新增主题只改共享模块，无需再同步此文件
'use strict';

const { nativeTheme } = require('electron');
const { BOOT_COLORS } = require('../shared/themes');

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
