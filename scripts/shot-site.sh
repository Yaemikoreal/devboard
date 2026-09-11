#!/usr/bin/env bash
# 官网素材出图：用 mock 数据批量截取应用各视图（避免泄露本机真实项目信息，issue #69）。
# 产物写入 site/assets/raw/，随后由 scripts/optimize-site-shots.py 压缩为 WebP。
# 前置操作脚本在 scripts/site-shots/ 下（经 DEVBOARD_SHOT_JS 注入，避免命令行空格/引号转义问题）。
# 用法：bash scripts/shot-site.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=site/assets/raw
SHOTS=scripts/site-shots

run() { # $1=输出名，其余 env 叠加
  local name=$1; shift
  echo "== $name =="
  env DEVBOARD_MOCK=1 DEVBOARD_SHOT_OUT="$RAW/$name.png" "$@" npx electron scripts/screenshot.js
}

# 总览（暖阳，hero 用）：默认视图，周报自动生成后直接出图
run overview-warm

# 项目页：行列表 + 分带 + 图钉
run board-warm DEVBOARD_SHOT_JS="$(cat "$SHOTS/board.js")"

# 详情面板：切项目页后点开首行（图钉置顶的是 mock 数据最丰富的 wyy2qqmusic）
run detail-warm DEVBOARD_SHOT_JS="$(cat "$SHOTS/detail.js")"

# AI 周报：等自动周报展出后滚动到周报卡居中
run ai-warm DEVBOARD_SHOT_JS="$(cat "$SHOTS/ai.js")"

# 七套整体主题（4 浅 + 1 深 + 2 新增）各拍一张项目页视图：统一构图，且避开深色主题下
# 总览周报高亮行（.ai-key）的已知对比度问题
for t in warm mist meadow sakura iris dark abyss; do
  run "theme-$t" DEVBOARD_MOCK_THEME="$t" DEVBOARD_SHOT_JS="$(cat "$SHOTS/board.js")"
done

# 设置·外观：主题卡 + 强调色板
run settings-appearance \
  DEVBOARD_SHOT_SETTINGS=1 \
  DEVBOARD_SHOT_JS="$(cat "$SHOTS/settings-appearance.js")"

echo "全部完成 -> $RAW"
