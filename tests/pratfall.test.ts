/**
 * pratfall 强意图手势判定测试（R10/R11 守护）。
 *
 * 裁决 §5.3.4：跌倒彩蛋仅由强意图手势触发（拖拽超距 + 3s 内方向反转 ≥3 次），
 * 单击 / 连点 / 普通拖拽**物理上不可命中**。
 * R10 红线：禁止以任何形式恢复「连点/拖动 → 惩罚」映射——
 * 前两条断言（单击、连点）就是这条红线的机器守护，永远不许删改。
 *
 * ─────────────────────────────────────────────
 * B4 追加区：节拍时序断言（FLY+LIE+GROOM+NUZZLE+RETURN ≤ 90s）
 * 与冷却断言（PRATFALL_COOLDOWN_MS === 600_000）加在本文件末尾。
 * ─────────────────────────────────────────────
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isPratfallGesture, type PratfallGestureSample } from '../src/renderer/pet.js';

/** 沿 x 轴按步长序列生成时间升序采样（每步 msPerStep 毫秒） */
function samplesFromDeltas(deltas: number[], msPerStep = 50): PratfallGestureSample[] {
  let x = 0;
  return deltas.map((dx, i) => {
    x += dx;
    return { x, y: 0, t: i * msPerStep };
  });
}

/** n 个重复步长 */
const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);

test('pratfall: 单击（1 个样本，无拖拽路径）不触发', () => {
  assert.equal(isPratfallGesture([{ x: 10, y: 10, t: 0 }]), false);
});

test('pratfall: 连点 3 次（同位置样本，间隔 <300ms）不触发 —— 🔴 R10 核心守护', () => {
  const taps: PratfallGestureSample[] = [
    { x: 5, y: 5, t: 0 },
    { x: 5, y: 5, t: 120 },
    { x: 5, y: 5, t: 260 },
  ];
  assert.equal(isPratfallGesture(taps), false);
});

test('pratfall: 普通单向平滑拖拽（总距 285px > 240 阈值）不触发', () => {
  // 裁决原文：「普通拖拽物理上不可命中」——超距但无方向反转
  const drag = samplesFromDeltas(rep(15, 20)); // 20 个样本，19 段 × 15px = 285px
  assert.equal(isPratfallGesture(drag), false);
});

test('pratfall: 强意图手势（超距 400px + 3s 内方向反转 3 次）触发', () => {
  // 右100 → 左100 → 右100 → 左100：3 次符号翻转，总时长 750ms < 3s
  const shake = samplesFromDeltas([
    ...rep(25, 4), ...rep(-25, 4), ...rep(25, 4), ...rep(-25, 4),
  ], 50);
  assert.equal(isPratfallGesture(shake), true);
});

test('pratfall: 同样的反转但跨度 >3s（慢速晃动）不触发', () => {
  // 同形状，每步 600ms → 相邻反转间隔 2400ms，首末反转跨度 4800ms > 3000ms
  const slow = samplesFromDeltas([
    ...rep(25, 4), ...rep(-25, 4), ...rep(25, 4), ...rep(-25, 4),
  ], 600);
  assert.equal(isPratfallGesture(slow), false);
});

test('pratfall: 超距但反转仅 2 次不触发', () => {
  // 右150 → 左150 → 右150：路径 450px 超距，但只有 2 次符号翻转 < 3
  const two = samplesFromDeltas([
    ...rep(25, 6), ...rep(-25, 6), ...rep(25, 6),
  ], 50);
  assert.equal(isPratfallGesture(two), false);
});
