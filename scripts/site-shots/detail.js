// 切到项目视图后点开首行（图钉置顶的是 mock 数据最丰富的 wyy2qqmusic），展开详情面板
document.querySelector('#nav button[data-view="projects"]').click();
setTimeout(function () {
  var r = document.querySelector('#rows .row');
  if (r) r.click();
}, 400);
