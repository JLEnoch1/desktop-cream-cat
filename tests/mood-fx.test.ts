/**
 * mood-fx 单测 —— 情绪外化 FX 层（2026-10-27 用户定稿形态：无悬浮 emoji 道具/脸）。
 *
 * 契约：
 *  1. 三层门禁：glow=sunbeam（精力门槛由 resolveWeatherOverlay 单源，不自设）/
 *     bounce=blissful（e≥9.5）/ shiver=storm-bolt&&e<4；
 *  2. R6：composite 与 pulse 永不参与（不同 pulse/composite、同 overlay/energy → 输出全等）；
 *  3. 预览联动：withPreviewEnergy 的产物直接驱动 FX（拖滑条金光/弹跳实时切换）；
 *  4. 本体位移：bounce 1.1s 峰 -9px / shiver 0.45s ±2px / 非地面平静态归零；
 *  5. 本体色温层（方案A）：energyTint 0–10 连续映射；drawEnergyTint 合成模式与像素语义。
 *
 * （原第 6 条「HUD 文字徽标 tierBadge」已随 2026-10-27 用户裁决删除：
 *   精力条上的档位文字与 emoji、以及左侧数字一并清除。）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMoodFx, moodFxBodyOffset, drawMoodFxBack, drawEnergyTint, energyTint, EMPTY_MOOD_FX,
} from '../src/renderer/cat/mood-fx.js';
import { resolveWeatherOverlay } from '../src/emotion/engine.js';
import { withPreviewEnergy, type MoodInput } from '../src/renderer/cat/mood.js';
import type { CatMoodPayload, EmotionState } from '../src/core/types.js';

/* ─────────────────────────── 工具 ─────────────────────────── */

function emotion(over: Partial<EmotionState> = {}): EmotionState {
  return {
    energy: 5, base: 'calm', overlay: 'none', pulse: 'none',
    composite: 'calm', headline: '', pulseActive: true, ...over,
  };
}

function makeMood(energy: number, condition: 'sunny' | 'rain' | 'thunderstorm' | 'cloudy' = 'sunny'): MoodInput {
  const base: CatMoodPayload = {
    energy,
    weather: { condition, tempC: 22, source: 'live', at: 0 },
    emotion: {
      energy, base: 'calm', overlay: 'none', pulse: 'none',
      composite: 'calm', headline: '', pulseActive: true,
    },
  };
  // overlay 走引擎单源（与主进程 pushMood 同一函数）
  base.emotion.overlay = resolveWeatherOverlay(energy, condition);
  return base;
}

interface StubCtx extends Record<string, unknown> {
  gradients: number;
  fills: number;
  fillRects: Array<{ w: number; h: number; fill: string; gco: string }>;
  rims: number;
}

function stubCtx(): StubCtx {
  const c: StubCtx = {
    gradients: 0, fills: 0, fillRects: [], rims: 0,
    globalAlpha: 1, fillStyle: '',
    globalCompositeOperation: 'source-over',
    canvas: { width: 360, height: 424 },
    save() {}, restore() { c.globalCompositeOperation = 'source-over'; },
    createRadialGradient() { c.gradients++; return { addColorStop() {} }; },
    beginPath() {}, ellipse() {},
    fill() {
      c.fills++;
      if (c.globalCompositeOperation === 'destination-over') c.rims++;
    },
    fillRect(_x: number, _y: number, w: number, h: number) {
      c.fillRects.push({ w, h, fill: String(c.fillStyle), gco: String(c.globalCompositeOperation) });
    },
  };
  return c;
}

const ANCHOR = { cx: 180, groundY: 350 };

/* ─────────────────────────── 1. 门禁矩阵 ─────────────────────────── */

test('computeMoodFx: glow 只认 sunbeam（精力门槛走 resolveWeatherOverlay 单源）', () => {
  // 晴 + 9.5 → sunbeam → glow；晴 + 7 → none → 无 glow（阈值不在本层重复）
  assert.equal(computeMoodFx(9.5, makeMood(9.5, 'sunny').emotion).glow, true);
  assert.equal(computeMoodFx(7, makeMood(7, 'sunny').emotion).glow, false);
  assert.equal(computeMoodFx(3, makeMood(3, 'rain').emotion).glow, false);
});

test('computeMoodFx: bounce=blissful（9.5 边界）；shiver=storm-bolt&&e<4', () => {
  assert.equal(computeMoodFx(9.4, emotion()).bounce, false);
  assert.equal(computeMoodFx(9.5, emotion()).bounce, true);
  assert.equal(computeMoodFx(3.9, emotion({ overlay: 'storm-bolt' })).shiver, true);
  assert.equal(computeMoodFx(4, emotion({ overlay: 'storm-bolt' })).shiver, false);
  assert.equal(computeMoodFx(2, emotion({ overlay: 'rain-drop' })).shiver, false);
});

test('R6：composite 与 pulse 永不参与外化（同 overlay/energy → 输出全等）', () => {
  const a = computeMoodFx(2, emotion({ overlay: 'storm-bolt', pulse: 'anxious', composite: 'burnt__soaked__anxious' }));
  const b = computeMoodFx(2, emotion({ overlay: 'storm-bolt', pulse: 'grateful', pulseActive: false, composite: 'blissful__lifted__grateful' }));
  assert.deepEqual(a, b);
  assert.deepEqual(a, { glow: false, bounce: false, shiver: true });
});

test('10 分 vs 1 分：FX + 色温组合一眼可辨（高：弹跳+金光+金润；低：全熄+暖灰蒙版）', () => {
  const hi = computeMoodFx(10, emotion({ overlay: 'sunbeam' }));
  const lo = computeMoodFx(1, emotion());
  assert.deepEqual(hi, { glow: true, bounce: true, shiver: false });
  assert.deepEqual(lo, { glow: false, bounce: false, shiver: false });
  // 差异由色温层承载：1 分暖灰黯淡 vs 10 分暖金发光
  assert.ok(energyTint(1).dim > 0.2, '1 分应有显著灰蒙版');
  assert.equal(energyTint(10).dim, 0);
  assert.equal(energyTint(10).warm, 0.1);
  assert.equal(energyTint(10).rim, 0.55);
});

test('预览联动：withPreviewEnergy(9.5→1) 后 FX 实时切换（拖动即外化）', () => {
  const m = makeMood(9.5, 'sunny');
  const hi = computeMoodFx(m.energy, m.emotion);
  assert.equal(hi.glow, true);
  assert.equal(hi.bounce, true);
  const lo = withPreviewEnergy(m, 1);
  const fx = computeMoodFx(lo.energy, lo.emotion);
  assert.equal(fx.glow, false); // overlay 已由 withPreviewEnergy 重算为 none
  assert.equal(fx.bounce, false);
});

/* ─────────────────────────── 2. 本体位移 ─────────────────────────── */

test('moodFxBodyOffset: bounce 峰 -9px（1.1s）、起点 0；仅地面平静态', () => {
  const fx = { ...EMPTY_MOOD_FX, bounce: true };
  assert.equal(moodFxBodyOffset(fx, 0, 'idle').dy, 0);
  assert.ok(Math.abs(moodFxBodyOffset(fx, 0.55, 'idle').dy + 9) < 1e-9, '半周期应在峰值 -9');
  assert.ok(Math.abs(moodFxBodyOffset(fx, 1.1, 'idle').dy) < 1e-9, '整周期回到 0');
  assert.deepEqual(moodFxBodyOffset(fx, 0.55, 'sleep'), { dx: 0, dy: 0 });
  assert.deepEqual(moodFxBodyOffset(fx, 0.55, 'drag'), { dx: 0, dy: 0 });
  assert.ok(moodFxBodyOffset(fx, 0.55, 'walk').dy < 0);
});

test('moodFxBodyOffset: shiver ±2px 有界；bounce+shiver 叠加', () => {
  const fx = { ...EMPTY_MOOD_FX, shiver: true };
  for (let t = 0; t < 2; t += 0.07) {
    const { dx } = moodFxBodyOffset(fx, t, 'idle');
    assert.ok(Math.abs(dx) <= 2 + 1e-9, `shiver 越界: ${dx}`);
  }
  assert.ok(Math.abs(moodFxBodyOffset(fx, 0.1125, 'idle').dx + 2) < 1e-9, '四分之一周期 = -2');
  const both = { ...EMPTY_MOOD_FX, shiver: true, bounce: true };
  const o = moodFxBodyOffset(both, 0.55, 'idle');
  assert.ok(o.dy < -8.9 && o.dx !== 0);
});

/* ─────────────────────────── 3. 金色背光 ─────────────────────────── */

test('drawMoodFxBack: glow 画金色背光（radial gradient），无 glow 零绘制', () => {
  const c = stubCtx();
  drawMoodFxBack(c as unknown as CanvasRenderingContext2D, EMPTY_MOOD_FX, 1, ANCHOR);
  assert.equal(c.gradients, 0);
  drawMoodFxBack(c as unknown as CanvasRenderingContext2D, { ...EMPTY_MOOD_FX, glow: true }, 1, ANCHOR);
  assert.equal(c.gradients, 1);
  assert.equal(c.fills, 1);
});

/* ─────────────────────────── 4. 本体色温层（方案A） ─────────────────────────── */

test('energyTint: 0–10 连续映射（灰蒙版 e≤6 渐入 / 金润+轮廓光 e≥7 渐入 / 中段零染色）', () => {
  assert.equal(energyTint(6).dim, 0);
  assert.equal(energyTint(0).dim, 0.28);
  assert.ok(Math.abs(energyTint(3).dim - 0.14) < 1e-9);
  assert.equal(energyTint(7).warm, 0);
  assert.equal(energyTint(10).warm, 0.1);
  assert.equal(energyTint(10).rim, 0.55);
  // 中段（6.5）三者全零：不上灰也不上金
  const mid = energyTint(6.5);
  assert.deepEqual(mid, { dim: 0, warm: 0, rim: 0 });
  // 单调性：dim 随精力递减，warm/rim 随精力递增
  let prevDim = Infinity;
  let prevWarm = -1;
  for (let e = 0; e <= 10; e += 0.5) {
    const t = energyTint(e);
    assert.ok(t.dim <= prevDim + 1e-12, `dim 非单调 @${e}`);
    assert.ok(t.warm >= prevWarm - 1e-12, `warm 非单调 @${e}`);
    prevDim = t.dim;
    prevWarm = t.warm;
  }
  // 钳制：越界输入不产生负值/超额
  assert.equal(energyTint(-2).dim, 0.28);
  assert.equal(energyTint(12).warm, 0.1);
});

test('drawEnergyTint: 低精力 source-atop 暖灰蒙版；高精力金润+destination-over 轮廓光；中段零绘制', () => {
  const lo = stubCtx();
  drawEnergyTint(lo as unknown as CanvasRenderingContext2D, 1, ANCHOR);
  assert.equal(lo.fillRects.length, 1);
  assert.equal(lo.fillRects[0]!.gco, 'source-atop');
  assert.ok(lo.fillRects[0]!.fill.includes('110,100,94'), `灰蒙版应为暖灰，实际 ${lo.fillRects[0]!.fill}`);
  assert.equal(lo.fillRects[0]!.w, 360);
  assert.equal(lo.rims, 0);

  const hi = stubCtx();
  drawEnergyTint(hi as unknown as CanvasRenderingContext2D, 10, ANCHOR);
  assert.equal(hi.fillRects.length, 1);
  assert.equal(hi.fillRects[0]!.gco, 'source-atop');
  assert.ok(hi.fillRects[0]!.fill.includes('255,214,110'), `金润层应为暖金，实际 ${hi.fillRects[0]!.fill}`);
  assert.equal(hi.rims, 1, '高精力应有轮廓光（destination-over）');

  const mid = stubCtx();
  drawEnergyTint(mid as unknown as CanvasRenderingContext2D, 6.5, ANCHOR);
  assert.equal(mid.fillRects.length, 0);
  assert.equal(mid.rims, 0);
  assert.equal(mid.gradients, 0);
});

test('drawEnergyTint: 灰蒙版透明度随精力连续加深（10 分 vs 1 分 vs 3 分可辨）', () => {
  const alphaAt = (e: number): number => {
    const c = stubCtx();
    drawEnergyTint(c as unknown as CanvasRenderingContext2D, e, ANCHOR);
    const m = /rgba\(110,100,94,([\d.]+)\)/.exec(c.fillRects[0]?.fill ?? '');
    return m ? Number(m[1]) : -1;
  };
  assert.equal(alphaAt(10), -1); // 高精力无灰蒙版
  assert.ok(alphaAt(3) > 0 && alphaAt(1) > alphaAt(3), '越低越灰');
  assert.ok(alphaAt(0.5) > alphaAt(1), '连续加深');
  assert.ok(Math.abs(alphaAt(0) - 0.28) < 1e-9);
});
