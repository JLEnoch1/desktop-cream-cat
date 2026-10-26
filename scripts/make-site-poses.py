#!/usr/bin/env python3
"""生成官网姿态素材：skins/default 的奶油猫姿态 → site/assets/poses/*.webp（透明底）。

来源优先级：
  1. skins/default/.cache/*.png —— 运行时（app 启动一次）漫水抠图产物，与游戏内完全一致；
  2. 缺失时回退：直接读 skins/default/*.jpg，用与 src/main/skins.ts 相同的
     漫水抠图参数（四边漫水，中性灰白 max-min<=14 且 min>=190 判背景）现场抠图。

处理：alpha 包围盒裁剪 + padding → 最长边缩到 CAP → WebP(q90, method 6)。
用法：python3 scripts/make-site-poses.py
"""
import os
import sys

from PIL import Image
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SKIN = os.path.join(ROOT, "skins", "default")
CACHE = os.path.join(SKIN, ".cache")
OUT = os.path.join(ROOT, "site", "assets", "poses")
CAP = 440       # 网页最长边（2x 屏下卡片约 220px 高，足够清晰）
PAD = 8         # 裁剪留白
MATT = 720      # 与运行时一致：抠图前先缩到最长边 720

# 缓存文件名（去 .png）→ 网页语义名
JOBS = {
    "idle":  "cat-idle",
    "walk1": "cat-walk-1",
    "walk2": "cat-walk-2",
    "sleep": "cat-sleep",
    "drag":  "cat-drag",
    "pet":   "cat-pet",
    "tap":   "cat-tap",
    "88e22dcf458a68076efbd9698839e34b-cell-02": "cat-walkside-1",
    "88e22dcf458a68076efbd9698839e34b-cell-03": "cat-walkside-2",
    "88e22dcf458a68076efbd9698839e34b-cell-04": "cat-walkside-3",
}


def matte_jpg(src: str) -> Image.Image:
    """回退路径：复刻 skins.ts matteImage 的漫水抠图（numpy BFS）。"""
    img = Image.open(src).convert("RGB")
    w0, h0 = img.size
    if max(w0, h0) > MATT:
        k = MATT / max(w0, h0)
        img = img.resize((max(1, round(w0 * k)), max(1, round(h0 * k))), Image.LANCZOS)
    a = np.asarray(img).astype(np.int16)
    h, w, _ = a.shape
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    bg_like = (mx - mn <= 14) & (mn >= 190)
    seen = np.zeros((h, w), dtype=bool)
    frontier = np.zeros((h, w), dtype=bool)
    frontier[0, :] = bg_like[0, :]
    frontier[-1, :] = bg_like[-1, :]
    frontier[:, 0] |= bg_like[:, 0]
    frontier[:, -1] |= bg_like[:, -1]
    seen |= frontier
    while frontier.any():
        grow = np.zeros_like(frontier)
        grow[1:, :] |= frontier[:-1, :]
        grow[:-1, :] |= frontier[1:, :]
        grow[:, 1:] |= frontier[:, :-1]
        grow[:, :-1] |= frontier[:, 1:]
        frontier = grow & bg_like & ~seen
        seen |= frontier
    rgba = np.dstack([np.asarray(img), (~seen * 255).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def load(src_name: str) -> Image.Image:
    cached = os.path.join(CACHE, src_name + ".png")
    if os.path.exists(cached):
        return Image.open(cached).convert("RGBA"), f".cache/{src_name}.png"
    jpg = os.path.join(SKIN, src_name.split("-cell-")[0] + ".jpg")
    if not os.path.exists(jpg):
        sys.exit(f"缺少素材：{cached} 与 {jpg} 都不存在（先启动一次 app 生成 .cache）")
    return matte_jpg(jpg), f"现场抠图 {os.path.basename(jpg)}"


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for src_name, out_name in JOBS.items():
        img, origin = load(src_name)
        alpha = np.asarray(img.getchannel("A"))
        ys, xs = np.where(alpha > 8)
        if len(xs) == 0:
            sys.exit(f"{src_name}: 整张被判为背景")
        x0, x1 = max(0, xs.min() - PAD), min(img.width, xs.max() + 1 + PAD)
        y0, y1 = max(0, ys.min() - PAD), min(img.height, ys.max() + 1 + PAD)
        img = img.crop((x0, y0, x1, y1))
        if max(img.size) > CAP:
            k = CAP / max(img.size)
            img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
        dst = os.path.join(OUT, out_name + ".webp")
        img.save(dst, "WEBP", quality=90, method=6)
        kb = os.path.getsize(dst) / 1024
        total += kb
        print(f"{out_name:16s} {img.width}x{img.height}  {kb:6.1f} KB  ← {origin}")
    print(f"合计 {total:.0f} KB → site/assets/poses/")


if __name__ == "__main__":
    main()
