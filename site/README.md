# SignalBoard 官网（issue #69）

纯静态展示站（无构建、无外部依赖）：`index.html` + `styles.css` + `main.js` + `assets/`。
设计语言与应用本体同源——七套整体主题 token、玻璃质感表面、强调色派生阶梯、同一排版与圆角体系；
主题演示直接复刻应用的 `applyTheme` 算法，点主题卡/色板整页实时切换。

## 本地预览

```bash
cd site && python -m http.server 8000
# 打开 http://127.0.0.1:8000
```

## 部署（GitHub Pages）

仓库已带 `.github/workflows/pages.yml`（push 到 master 且 `site/**` 有改动时自动部署）。
一次性前置：仓库 **Settings → Pages → Source 选「GitHub Actions」**，随后推送即自动发布到
`https://yaemikoreal.github.io/devboard/`。

## 截图素材更新

截图全部为 mock 演示数据（不含本机真实项目信息），出图链路：

```bash
bash scripts/shot-site.sh        # 电子出图到 site/assets/raw/（需在装好依赖的仓库根目录）
python scripts/optimize-site-shots.py  # 压缩为 site/assets/*.webp（raw 不入库）
```

单张补拍见 `scripts/shot-site.sh` 内注释；前置操作脚本在 `scripts/site-shots/`。
