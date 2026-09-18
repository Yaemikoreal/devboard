// 不起 Electron，直接跑 scanner 打印 BoardData JSON，用于验证扫描与分带逻辑
'use strict';

const path = require('path');
const scanner = require('../src/main/scanner');
const { DEFAULT_CONFIG } = require('../src/main/store');

(async () => {
  // 缺省扫本仓的父目录（出厂 roots 已改为空，不再内置任何本机路径）
  const roots = process.argv[2] ? [process.argv[2]] : [path.join(__dirname, '..', '..')];
  // 扫描域对象（issue #12 第 8 条）：extraPaths 缺省即不补逐项路径，与原三参调用的 undefined 一致
  const projects = await scanner.scan({ roots, blacklist: DEFAULT_CONFIG.blacklist });
  for (const p of projects) delete p.originUrl; // 内部字段，不在契约内

  const attention = projects
    .filter((p) => p.warnings.length > 0)
    .map((p) => ({ path: p.path, name: p.name, label: p.warnings.map((w) => w.label).join('，') }));

  const board = {
    scannedAt: new Date().toISOString(),
    stats: {
      total: projects.length,
      commits7d: projects.reduce((s, p) => s + p.commits7d, 0),
      attentionCount: attention.length,
    },
    attention,
    projects,
  };
  console.log(JSON.stringify(board, null, 2));
})().catch((err) => {
  console.error('扫描失败:', err);
  process.exit(1);
});
