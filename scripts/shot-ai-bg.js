(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (name) => [...document.querySelectorAll('.row')].find((r) => (r.dataset.path || '').endsWith(name));
  // 先切到项目视图（行列表所在视图）
  document.querySelector('#nav button[data-view="projects"]').click();
  await sleep(600);
  // 打开 wyy2qqmusic 详情面板
  row('wyy2qqmusic').click();
  await sleep(1400);
  // 点击「生成建议」发起后台任务（mock 延迟 6 秒）；面板内 .ai-btn 唯一（避免中文经 env 传参乱码）
  const btn = document.querySelector('#panelIn .ai-btn');
  if (!btn) { console.log('[devboard] shot-ready (no btn)'); return; }
  btn.click();
  await sleep(1000);
  // 切到另一个项目再切回来：任务应仍在后台执行并恢复「生成中」状态
  row('devboard').click();
  await sleep(900);
  row('wyy2qqmusic').click();
  await sleep(1200);
  console.log('[devboard] shot-ready');
})();
