// 等自动周报展出后，滚动到 AI 周报卡居中（mock 的 ai:ask 即刻返回，800ms 足够）
setTimeout(function () {
  document.getElementById('aiWeeklyCard').scrollIntoView({ block: 'center' });
}, 800);
