# 官网截图压缩：site/assets/raw/*.png -> site/assets/*.webp（issue #69）
# PNG 原图体积大且含 mock 之外的冗余，统一转 WebP；raw 目录不入站。
# 用法：python scripts/optimize-site-shots.py
from pathlib import Path

from PIL import Image

RAW = Path(__file__).resolve().parent.parent / "site" / "assets" / "raw"
OUT = RAW.parent
QUALITY = 84


def main():
    """把 raw 目录下全部 PNG 转成同名 WebP，打印压缩比。"""
    pngs = sorted(RAW.glob("*.png"))
    if not pngs:
        raise SystemExit(f"未找到 PNG：{RAW}（先运行 bash scripts/shot-site.sh）")
    total_raw = total_out = 0
    for p in pngs:
        img = Image.open(p).convert("RGB")
        dst = OUT / (p.stem + ".webp")
        img.save(dst, "WEBP", quality=QUALITY, method=6)
        raw_kb, out_kb = p.stat().st_size // 1024, dst.stat().st_size // 1024
        total_raw, total_out = total_raw + raw_kb, total_out + out_kb
        print(f"{p.name}: {raw_kb}KB -> {out_kb}KB")
    print(f"合计: {total_raw}KB -> {total_out}KB")


if __name__ == "__main__":
    main()
