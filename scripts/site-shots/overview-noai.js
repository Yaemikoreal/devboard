// 无 AI 引擎（DEVBOARD_MOCK_AI=off）：周报卡整卡隐藏，滚动到「活动流 + 需要关注 + 工作台」区域
setTimeout(function () {
  document.querySelector('.ov-grid').scrollIntoView({ block: 'start' });
}, 400);
