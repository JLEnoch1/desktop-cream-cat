/**
 * cell-split 单测 —— 移植自 desktop-pet test/cell-split.test.js（M1）。
 *
 * 合成 alpha 数组验证 splitCells/splitGrid 边界：空图、单组件、行优先排序、
 * 碎块/扁条过滤、overflow 回退、近邻合并、宫格切帧、空单元格保留等分矩形。
 * 真实素材用例（88e22dcf 宫格切 5 帧）需要 electron nativeImage + .cache PNG，
 * 纯 node 运行时自动 skip（与源测试语义一致）。
 *
 * 运行：npm test（或 esbuild 打包后 node --test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { splitCells, splitGrid } from '../src/main/cell-split.js';

/** 合成 alpha 数组：把列出的矩形涂成 255，其余保持 0（全透明） */
function makeAlpha(w: number, h: number, rects: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const a = new Uint8Array(w * h);
  for (const [x, y, rw, rh] of rects) {
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) {
        if (xx >= 0 && xx < w && yy >= 0 && yy < h) a[yy * w + xx] = 255;
      }
    }
  }
  return a;
}

test('splitCells: 1) 全透明 → 0 组件、无 overflow、不崩', () => {
  const r = splitCells(new Uint8Array(100 * 100), 100, 100);
  assert.equal(r.cells.length, 0);
  assert.equal(r.overflow, false);
});

test('splitCells: 2) 单组件 → 1 cell，bbox 紧贴矩形', () => {
  const r = splitCells(makeAlpha(100, 100, [[10, 10, 30, 30]]), 100, 100);
  assert.equal(r.cells.length, 1);
  assert.deepEqual([r.cells[0].x, r.cells[0].y, r.cells[0].w, r.cells[0].h], [10, 10, 30, 30]);
});

test('splitCells: 3) 行优先排序：输入乱序 → 第一行、第二行左、第二行右', () => {
  const r = splitCells(
    makeAlpha(200, 200, [[120, 120, 40, 40], [20, 120, 40, 40], [60, 20, 40, 40]]),
    200,
    200,
  );
  assert.deepEqual(
    r.cells.map((c) => [c.x, c.y]),
    [[60, 20], [20, 120], [120, 120]],
  );
});

test('splitCells: 4) 碎块过滤：<1% 面积的组件被丢弃并告警', () => {
  const r = splitCells(makeAlpha(200, 200, [[10, 10, 60, 60], [150, 150, 3, 3]]), 200, 200);
  assert.equal(r.cells.length, 1);
  assert.ok(r.warnings.some((s) => s.includes('碎块')));
});

test('splitCells: 5) 扁条过滤：宽扁条被丢弃并告警', () => {
  const r = splitCells(makeAlpha(200, 200, [[10, 10, 60, 60], [100, 100, 90, 6]]), 200, 200);
  assert.equal(r.cells.length, 1);
  assert.ok(r.warnings.some((s) => s.includes('扁条')));
});

test('splitCells: 6) 组件过多（14>12）→ overflow，cells 清空（调用方回退整图）', () => {
  const rects: [number, number, number, number][] = [];
  for (let i = 0; i < 14; i++) rects.push([(i % 7) * 28 + 2, ((i / 7) | 0) * 60 + 2, 20, 40]);
  const r = splitCells(makeAlpha(200, 200, rects), 200, 200);
  assert.equal(r.overflow, true);
  assert.equal(r.cells.length, 0);
});

test('splitCells: 6b) 近邻合并：2px 间隙的裂开组件（头/身）并为一帧，远处组件不受影响', () => {
  const r = splitCells(
    makeAlpha(200, 200, [[10, 10, 50, 20], [10, 32, 50, 20], [120, 10, 40, 40]]),
    200,
    200,
  );
  assert.equal(r.cells.length, 2);
  const big = r.cells.find((c) => c.w === 50);
  assert.ok(big, '合并后的大帧应存在');
  assert.deepEqual([big.x, big.y, big.w, big.h], [10, 10, 50, 42]);
  assert.ok(r.warnings.some((s) => s.includes('合并裂开组件')));
});

test('splitGrid: 7) 2x2 取 [0,2]，格内 alpha 收边（cell2 = 左下格）', () => {
  const a = makeAlpha(100, 100, [[10, 10, 20, 20], [10, 60, 20, 20]]);
  const r = splitGrid(a, 100, 100, { cols: 2, rows: 2, cells: [0, 2] });
  assert.equal(r.cells.length, 2);
  assert.deepEqual([r.cells[0].x, r.cells[0].y], [10, 10]);
  assert.deepEqual([r.cells[1].x, r.cells[1].y], [10, 60]);
});

test('splitGrid: 8) 空单元格 → 保留等分矩形 + 告警', () => {
  const r = splitGrid(new Uint8Array(100 * 100), 100, 100, { cols: 2, rows: 1 });
  assert.equal(r.cells.length, 2);
  assert.equal(r.cells[0].w, 50);
  assert.ok(r.warnings.length >= 1);
});

/**
 * 9) 真实素材：88e22dcf 宫格应切出 5 帧（2+1+1+1）。
 * nativeImage 只在 electron 运行时可用；纯 node 跑本用例自动跳过（与源测试一致）。
 * 完整跑法：npx electron <打包产物>；缓存路径按仓库根（process.cwd()）解析。
 */
test('splitCells: 9) 真实素材 88e22dcf 宫格切 5 帧（无 electron/缓存则 skip）', async (t) => {
  interface NativeImageLike {
    createFromPath(p: string): {
      getSize(): { width: number; height: number };
      toBitmap(): Uint8Array;
    };
  }
  let nativeImage: NativeImageLike | null = null;
  try {
    // 纯 node 下 electron 主入口导出二进制路径字符串（或解析失败），拿不到 nativeImage
    const mod = (await import('electron')) as unknown as { nativeImage?: NativeImageLike };
    nativeImage = mod?.nativeImage ?? null;
  } catch {
    nativeImage = null;
  }
  const p = join(process.cwd(), 'skins', 'default', '.cache', '88e22dcf458a68076efbd9698839e34b.png');
  if (!nativeImage) {
    t.skip('需 electron 运行时（npx electron 跑本测试）');
    return;
  }
  if (!existsSync(p)) {
    t.skip(`缓存 PNG 不存在：${p}（先跑一次 npm start 生成 .cache）`);
    return;
  }
  const img = nativeImage.createFromPath(p);
  const { width: w, height: h } = img.getSize();
  const buf = img.toBitmap();
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = buf[i * 4 + 3];
  const r = splitCells(alpha, w, h);
  t.diagnostic(`真实素材 88e22dcf: ${w}x${h} → ${r.cells.length} 帧 ${JSON.stringify(r.warnings)}`);
  assert.equal(r.overflow, false);
  assert.equal(r.cells.length, 5);
});
