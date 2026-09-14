// userData 迁移（issue #11）：更名 SignalBoard 后 userData 从 %APPDATA%/devboard 变为 %APPDATA%/SignalBoard。
// 新目录还没有 config.json 而旧目录有，则把旧目录的数据文件逐个拷贝过来。
// 加密 GitHub token 不受目录影响（safeStorage 与路径无关），随 config.json 一起迁移。
// 独立成模块是为了能用纯 node 做单测（不依赖 electron 运行时）。
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILES = ['config.json', 'prefs.json', 'memos.json', 'scan-cache.json', 'github-cache.json', 'meta.json', 'ai-cache.json'];

// 迁移完成标记：写入后不再补拷（幂等，issue #106）。不在 data:reset 的清除清单里，
// 「清空全部数据」后也不会把旧目录数据迁回来
const MIGRATED_FLAG = '.migrated';

// oldDirs 按优先级排列，使用第一个含 config.json 的目录
function migrateUserData(newDir, oldDirs, log = console.log) {
  if (fs.existsSync(path.join(newDir, MIGRATED_FLAG))) return { migrated: false, reason: 'done' };
  const oldDir = oldDirs.find((d) => fs.existsSync(path.join(d, 'config.json')));
  if (!oldDir) return { migrated: false, reason: 'no-old' };
  fs.mkdirSync(newDir, { recursive: true });
  // 逐文件只补缺失（issue #106）：上次迁移中断（config 已拷、其余未拷）时续迁，
  // 新目录已有的任何文件都不覆盖
  const copied = [];
  for (const f of DATA_FILES) {
    const to = path.join(newDir, f);
    if (fs.existsSync(to)) continue;
    const from = path.join(oldDir, f);
    if (!fs.existsSync(from)) continue;
    try {
      fs.copyFileSync(from, to);
      copied.push(f);
    } catch (err) {
      console.error(`[devboard] userData 迁移失败: ${f}`, err.message);
    }
  }
  try {
    fs.writeFileSync(path.join(newDir, MIGRATED_FLAG), '', 'utf8');
  } catch { /* 标记写失败仅影响下次的幂等短路，不影响数据 */ }
  if (!copied.length) return { migrated: false, reason: 'new-exists' };
  log(`[devboard] userData 迁移自 ${oldDir}: ${copied.join(', ')}`);
  return { migrated: true, from: oldDir, copied };
}

module.exports = { migrateUserData, DATA_FILES };
