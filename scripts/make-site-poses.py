#!/usr/bin/env python3
"""生成官网姿态素材：skins/default 的奶油猫姿态 → site/assets/poses/*.webp（透明底）。

来源优先级：
  1. skins/default/.cache/*.png —— 运行时（app 启动一次）漫水抠图产物，与游戏内完全一致；
  2. 缺失时回退：直接读 skins/default/*.jpg|.png，用与 src/main/skins.ts 相同的
     漫水抠图参数（四边漫水，中性灰白 max-min<=14 且 min>=190 判背景）现场抠图。

处理：alpha 包围盒裁剪 + padding → 最长边缩到 CAP → WebP(q90, method 6)。
散步（walk）：24 帧视频步态环 → 全帧并集 bbox 归一 → 竖排雪碧图
cat-walk-sheet.webp + 同名 .json（cw/ch/n/fps），网页用 steps(24) 逐帧播放。
用法：python3 scripts/make-site-poses.py
"""
import json
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
WALK_N = 24     # 视频步态环帧数
CELL_H = 264    # 雪碧图单帧高（姿态卡显示 176px 的 1.5x，兼顾清晰度与体积）

# 缓存文件名（去扩展名）→ 网页语义名
JOBS = {
    "idle":  "cat-idle",
    "sleep": "cat-sleep",
    "drag":  "cat-drag",
    "pet":   "cat-pet",
    "tap":   "cat-tap",
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
    base = src_name.split("-cell-")[0]
    for ext in (".jpg", ".png"):
        src = os.path.join(SKIN, base + ext)
        if os.path.exists(src):
            return matte_jpg(src), f"现场抠图 {base + ext}"
    sys.exit(f"缺少素材：{cached} 与 {SKIN}/{base}.jpg|.png 都不存在（先启动一次 app 生成 .cache）")


def build_walk_sheet() -> float:
    """24 帧视频步态环 → 竖排雪碧图（全帧并集 bbox 归一，杜绝帧间跳动）。"""
    frames = []
    for i in range(1, WALK_N + 1):
        img, origin = load(f"walkV{i:02d}")
        frames.append(img)
        if i == 1:
            print(f"walk-sheet       ← {origin} 等 {WALK_N} 帧")
    # 并集 bbox：所有帧共用同一画布 → 播放时猫体不漂移
    x0 = y0 = 10**9
    x1 = y1 = -1
    for img in frames:
        ys, xs = np.where(np.asarray(img.getchannel("A")) > 8)
        if len(xs) == 0:
            sys.exit("walkV 帧整张被判为背景")
        x0, y0 = min(x0, xs.min()), min(y0, ys.min())
        x1, y1 = max(x1, xs.max()), max(y1, ys.max())
    x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
    bw, bh = x1 - x0 + 1 + PAD, y1 - y0 + 1 + PAD
    k = CELL_H / bh
    cw = round(bw * k)
    sheet = Image.new("RGBA", (cw, CELL_H * WALK_N), (0, 0, 0, 0))
    for i, img in enumerate(frames):
        cell = img.crop((x0, y0, x0 + bw, y0 + bh)).resize((cw, CELL_H), Image.LANCZOS)
        sheet.paste(cell, (0, i * CELL_H), cell)
    dst = os.path.join(OUT, "cat-walk-sheet.webp")
    sheet.save(dst, "WEBP", quality=90, method=6)
    meta = {"cw": cw, "ch": CELL_H, "n": WALK_N, "fps": 24, "cycle": 1.0}
    with open(os.path.join(OUT, "cat-walk-sheet.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    kb = os.path.getsize(dst) / 1024
    # mock 姿态帧（scripts/cat-skin-api.mjs MOCK_FILES 联调用）：
    # 取步态环第 1/13 帧（前后半步交替的两帧走姿）
    for idx, name in ((0, "cat-walk-1"), (WALK_N // 2, "cat-walk-2")):
        cell = frames[idx].crop((x0, y0, x0 + bw, y0 + bh))
        if max(cell.size) > CAP:
            k2 = CAP / max(cell.size)
            cell = cell.resize((round(cell.width * k2), round(cell.height * k2)), Image.LANCZOS)
        p = os.path.join(OUT, name + ".webp")
        cell.save(p, "WEBP", quality=90, method=6)
        kb += os.path.getsize(p) / 1024
        print(f"{name:16s} {cell.width}x{cell.height}  {os.path.getsize(p) / 1024:6.1f} KB  ← walkV{idx + 1:02d}（mock）")
    # 两个使用点的建议尺寸（保持宽高比）：姿态卡高 176 / 漫步带宽 128
    card_cw = round(176 * cw / CELL_H)
    strip_ch = round(128 * CELL_H / cw)
    print(f"cat-walk-sheet   {cw}x{CELL_H * WALK_N}  {kb:6.1f} KB  单帧 {cw}x{CELL_H}")
    print(f"  姿态卡: --cw:{card_cw}px; --ch:176px   漫步带: --cw:128px; --ch:{strip_ch}px")
    return kb


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
    total += build_walk_sheet()
    print(f"合计 {total:.0f} KB → site/assets/poses/")


if __name__ == "__main__":
    main()
