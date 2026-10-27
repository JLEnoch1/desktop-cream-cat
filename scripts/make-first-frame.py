#!/usr/bin/env python3
"""生成「图生视频首帧料」：walkC.jpg → 白底合成 PNG。

复刻 main.js matteImage / cropImage 管线（= scripts/walk-preview.html 同公式）：
  最长边 720 降采样 → 四边漫水「中性亮」背景（mx-mn≤14 且 mn≥190，4 邻域）
  → alpha>8 前景包围盒 → pad2 裁切。

输出（walk-video/first-frame/）：
  walkC_white_tight.png            预览页「白底下载」等效：紧裁切 + 白底（含灰斑，存档/对照用）
  walkC_video_first_frame.png      ★推荐上传：1280×1280 纯白、主体居中留边、灰斑已清除
  walkC_video_first_frame_spot.png 同构图但保留灰斑（简报 §10 原方，对照用）

用法：python3 scripts/make-first-frame.py [源图，默认 skins/default/walkC.jpg]
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "skins/default/walkC.jpg"
OUT_DIR = ROOT / "walk-video/first-frame"
MAX_SIDE = 720          # main.js matteImage
PAD = 2                 # main.js cropImage
CANVAS = 1280           # 视频首帧画布（§6：正方形 1280）
TARGET_H = 1024         # 主体高上限（≈80% 画布）
TARGET_W = 1080         # 主体宽上限（两侧各留 ≥100px 余量）
BOTTOM_Y = 1114         # 主体包围盒底边落位（底部留 166px）


def load_downscaled(path: Path, max_side: int):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    if max(w, h) > max_side:
        k = max_side / max(w, h)
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    return im


def bglike(arr: np.ndarray) -> np.ndarray:
    mx = arr.max(axis=2).astype(np.int16)
    mn = arr.min(axis=2).astype(np.int16)
    return ((mx - mn) <= 14) & (mn >= 190)


def flood_border(mask: np.ndarray) -> np.ndarray:
    """从四边漫水，只吃 bgLike 连通区（与 main.js 逐像素等价）。"""
    h, w = mask.shape
    seen = np.zeros((h, w), dtype=bool)
    dq = deque()

    def push(x, y):
        if mask[y, x] and not seen[y, x]:
            seen[y, x] = True
            dq.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    while dq:
        x, y = dq.popleft()
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)
    return seen


def bbox_of(alpha_fg: np.ndarray):
    ys, xs = np.nonzero(alpha_fg)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())  # 含端点


def pad_crop(box, w, h, pad=PAD):
    x0, y0, x1, y1 = box
    return max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + 1 + pad), min(h, y1 + 1 + pad)


def matte720(im: Image.Image):
    """720 校验通道：与运行时管线完全一致，返回 (rgb数组, 前景mask, pad2裁切框)。"""
    arr = np.asarray(im, dtype=np.uint8)
    h, w = arr.shape[:2]
    bg = flood_border(bglike(arr))
    fg = ~bg
    box = pad_crop(bbox_of(fg), w, h)
    return arr, fg, box


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"源图: {SRC}")

    # ---------- 通道 1：720 复刻（校验 + 紧裁切白底 PNG） ----------
    im720 = load_downscaled(SRC, MAX_SIDE)
    arr720, fg720, box720 = matte720(im720)
    x0, y0, x1, y1 = box720
    cw, ch = x1 - x0, y1 - y0
    print(f"[720 校验] 画布 {arr720.shape[1]}x{arr720.shape[0]}  裁切 {cw}x{ch}  "
          f"bbox底边 y={y1 - 1}  顶 y={y0}  左 x={x0}  右 x={x1 - 1}")

    # 灰斑取证（§9.4：y682–704 中性灰，RGB≈150–195）
    band = arr720[max(0, y1 - 26):y1, x0:x1].reshape(-1, 3).astype(np.int16)
    band_fg = fg720[max(0, y1 - 26):y1, x0:x1].reshape(-1)
    b = band[band_fg]
    if len(b):
        spread = b.max(axis=1) - b.min(axis=1)
        gray = b[(spread <= 20) & (b.min(axis=1) >= 120) & (b.min(axis=1) <= 206)]
        print(f"[720 校验] 底部 26 行前景 {len(b)}px，其中中性灰斑候选 {len(gray)}px"
              + (f"，中位 RGB={np.median(gray, axis=0).astype(int)}" if len(gray) else ""))

    crop720 = arr720[y0:y1, x0:x1]
    mask720 = fg720[y0:y1, x0:x1]
    tight = np.full((*crop720.shape[:2], 3), 255, np.uint8)
    tight[mask720] = crop720[mask720]
    Image.fromarray(tight).save(OUT_DIR / "walkC_white_tight.png")
    print(f"→ walkC_white_tight.png ({cw}x{ch}，预览页「白底下载」等效)")

    # ---------- 通道 2：原生分辨率合成（视频首帧料） ----------
    imN = Image.open(SRC).convert("RGB")
    arrN = np.asarray(imN, dtype=np.uint8)
    hN, wN = arrN.shape[:2]
    bgN = flood_border(bglike(arrN))
    fgN = ~bgN
    k = wN / arr720.shape[1]  # 720→原生 比例
    print(f"[原生] {wN}x{hN}  前景 {int(fgN.sum())}px  放大系数 {k:.3f}")

    # 灰斑清除：原生底部带内「中性灰」像素（spread≤20, min∈[120,206]）置白
    band_y0 = max(0, y1 - 26)
    by0, by1 = round(band_y0 * k), hN
    bx0, bx1 = round(x0 * k), round(x1 * k)
    sub = arrN[by0:by1, bx0:bx1].astype(np.int16)
    subfg = fgN[by0:by1, bx0:bx1]
    sp = sub.max(axis=2) - sub.min(axis=2)
    mn = sub.min(axis=2)
    spot = subfg & (sp <= 20) & (mn >= 120) & (mn <= 206)
    print(f"[灰斑] 原生底部带 y{by0}–{by1} 候选 {int(spot.sum())}px")

    fgN_clean = fgN.copy()
    fgN_clean[by0:by1, bx0:bx1] &= ~spot
    # 安全检查：清除后主体仍为单一形态、高度损失应仅为灰斑厚度
    boxA = bbox_of(fgN)
    boxB = bbox_of(fgN_clean)
    print(f"[灰斑] 清除前 bbox {boxA} → 清除后 {boxB}"
          f"（高度 {boxA[3]-boxA[1]+1} → {boxB[3]-boxB[1]+1}）")
    # 灰斑本身就是包围盒最低/最右点（§9.4 锚点），清除后底边应上移到脚线
    # （§8：脚线高于含斑包围盒底 61–66px@720）→ 允许 ≤70px@720 的底边上移
    top_shift = abs(boxB[1] - boxA[1])
    if top_shift > round(3 * k) or (boxA[3] - boxB[3]) > round(70 * k):
        print("!! 灰斑清除异常（伤及主体或吃掉过多底边），请人工复核", file=sys.stderr)
    else:
        print(f"[灰斑] 底边上移 {(boxA[3] - boxB[3]) / k:.0f}px@720（预期 61–66：脚线），主体完好")

    def compose(fg_mask, box, tag):
        bx0, by0, bx1, by1 = box[0], box[1], box[2] + 1, box[3] + 1
        chw, chh = bx1 - bx0, by1 - by0
        s = min(TARGET_H / chh, TARGET_W / chw, 1.0)
        nw, nh = round(chw * s), round(chh * s)
        rgba = np.dstack([arrN[by0:by1, bx0:bx1],
                          (fg_mask[by0:by1, bx0:bx1] * 255).astype(np.uint8)])
        cat = Image.fromarray(rgba).resize((nw, nh), Image.LANCZOS)
        out = Image.new("RGB", (CANVAS, CANVAS), (255, 255, 255))
        px = (CANVAS - nw) // 2
        py = BOTTOM_Y - nh
        out.paste(cat, (px, py), cat)
        out.save(OUT_DIR / tag)
        # 边缘纯度自检：四边必须全白
        e = np.asarray(out)
        edge_white = bool((e[0] == 255).all() and (e[-1] == 255).all()
                          and (e[:, 0] == 255).all() and (e[:, -1] == 255).all())
        print(f"→ {tag}  主体 {nw}x{nh}（{nh/CANVAS:.0%} 画布高）落位 x{px} y{py}，"
              f"边距 上{py}/下{CANVAS-BOTTOM_Y}/左右{px}，四边纯白 {edge_white}")

    compose(fgN, boxA, "walkC_video_first_frame_spot.png")     # 保留灰斑（§10 原方）
    compose(fgN_clean, boxB, "walkC_video_first_frame.png")    # ★清除灰斑（推荐）
    print("完成。")


if __name__ == "__main__":
    main()
