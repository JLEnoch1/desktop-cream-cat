/**
 * M1 姿态解算测试 —— 尾巴 & 耳朵情绪通道（DESIGN.md §3 / M1）。
 *
 * 防的核心回归：这两条通道必须是**情绪的确定性函数**，读得出状态，
 * 不能退化成随机噪声。纯函数（resolveTailPose / resolveEarPose）只读
 * RenderParams 的连续量，不依赖 canvas/DOM，可在 node 下直接断言。
 *
 * 关键语义（断言锚点）：
 *   尾巴 lift：精力高 → 竖起；精力低 → 垂落（burnt 触地）
 *   尾巴 amp/speed：开心是「摇」（大摆幅），害怕是「抖」（高频小摆）
 *   耳朵 pose：正 = 前倾（开心/警觉），负 = 飞机耳/耷拉（累、怕）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTailPose, resolveEarPose, type TailPose } from '../src/renderer/pet.js';

/* ─────────────────────────── 尾巴 ─────────────────────────── */

test('tail: 精力越高尾巴越竖起（lift 单调上升）', () => {
  const lifts = [0, 2, 4, 6, 8, 10].map(e => resolveTailPose({ energy: e, mouthCurve: 0, tremble: 0 }).lift);
  for (let i = 1; i < lifts.length; i++) {
    assert.ok(lifts[i] > lifts[i - 1], `精力 ${i * 2} 的 lift 应高于 ${i * 2 - 2}`);
  }
});

test('tail: burnt（精力0）尾巴拖地，blissful（精力10）高高竖起', () => {
  const burnt = resolveTailPose({ energy: 0, mouthCurve: -0.85, tremble: 0.6 });
  const bliss = resolveTailPose({ energy: 10, mouthCurve: 1.0, tremble: 0 });
  assert.ok(burnt.lift <= 0, `burnt 尾巴应垂落或拖地，实际 lift=${burnt.lift}`);
  assert.ok(bliss.lift >= 0.8, `blissful 尾巴应竖起，实际 lift=${bliss.lift}`);
  assert.ok(bliss.lift > burnt.lift, '高精力尾巴明显高于低精力');
});

test('tail: 愉悦（含抚摸呼噜）叠加抬升与摆幅', () => {
  const neutral = resolveTailPose({ energy: 5, mouthCurve: 0, tremble: 0 });
  const joyful = resolveTailPose({ energy: 5, mouthCurve: 0.9, tremble: 0 });
  assert.ok(joyful.lift > neutral.lift, '愉悦应抬高尾巴');
  assert.ok(joyful.amp > neutral.amp, '愉悦应加大摆幅（摇尾巴）');
});

test('tail: 恐惧（tremble）= 高频小摆「抖」，与开心的「摇」区分', () => {
  const scared = resolveTailPose({ energy: 2, mouthCurve: -0.3, tremble: 0.6 });
  const happy = resolveTailPose({ energy: 8, mouthCurve: 0.8, tremble: 0 });
  // 抖：速度高、抬升低；摇：摆幅大、抬升高
  assert.ok(scared.speed > happy.speed * 0.9, '恐惧时摆速高频');
  assert.ok(scared.lift < happy.lift, '恐惧时尾巴不竖起');
});

test('tail: 所有输出都在硬边界内（防 NaN / 越界）', () => {
  const cases = [
    { energy: 0, mouthCurve: -1, tremble: 1 },
    { energy: 10, mouthCurve: 1, tremble: 0 },
    { energy: -5, mouthCurve: -3, tremble: 9 },   // 越界输入
    { energy: 99, mouthCurve: 5, tremble: -2 },   // 越界输入
  ];
  for (const c of cases) {
    const p: TailPose = resolveTailPose(c);
    assert.ok(Number.isFinite(p.lift) && p.lift >= -0.6 && p.lift <= 1.1, `lift 越界: ${JSON.stringify(c)} → ${p.lift}`);
    assert.ok(Number.isFinite(p.amp) && p.amp >= 0.08 && p.amp <= 0.9, `amp 越界: ${JSON.stringify(c)} → ${p.amp}`);
    assert.ok(Number.isFinite(p.speed) && p.speed >= 0.6 && p.speed <= 9, `speed 越界: ${JSON.stringify(c)} → ${p.speed}`);
    assert.ok(Number.isFinite(p.len) && p.len > 0, `len 非法: ${JSON.stringify(c)} → ${p.len}`);
  }
});

/* ─────────────────────────── 耳朵 ─────────────────────────── */

test('ear: 开心前倾（pose>0），不悦后压（pose<0），中性≈自然位', () => {
  const happy = resolveEarPose({ mouthCurve: 0.9, tremble: 0, eyeOpen: 1 });
  const sad = resolveEarPose({ mouthCurve: -0.6, tremble: 0, eyeOpen: 0.5 });
  const neutral = resolveEarPose({ mouthCurve: 0, tremble: 0, eyeOpen: 0.9 });
  assert.ok(happy > 0.3, `开心耳朵应前倾，pose=${happy}`);
  assert.ok(sad < -0.2, `低落耳朵应后压/飞机耳，pose=${sad}`);
  assert.ok(Math.abs(neutral) < 0.4, `中性应接近自然位，pose=${neutral}`);
  assert.ok(happy > sad, '开心耳朵明显高于低落');
});

test('ear: 恐惧（tremble）强力后压成飞机耳', () => {
  const scared = resolveEarPose({ mouthCurve: 0, tremble: 0.6, eyeOpen: 0.9 });
  assert.ok(scared < -0.5, `tremble 应压成飞机耳，pose=${scared}`);
});

test('ear: 眼皮耷拉（疲惫）→ 耳朵同向耷拉（读取一致性）', () => {
  const awake = resolveEarPose({ mouthCurve: 0, tremble: 0, eyeOpen: 1.0 });
  const sleepy = resolveEarPose({ mouthCurve: 0, tremble: 0, eyeOpen: 0.15 });
  assert.ok(sleepy < awake, '疲惫时耳朵应比清醒时更耷拉');
  assert.ok(sleepy < -0.4, `重度疲惫应明显飞机耳，pose=${sleepy}`);
});

test('ear: 输出恒在 [-1,1]（防 NaN / 越界）', () => {
  const cases = [
    { mouthCurve: -1, tremble: 1, eyeOpen: 0 },
    { mouthCurve: 1, tremble: 0, eyeOpen: 1 },
    { mouthCurve: -9, tremble: 9, eyeOpen: -3 },  // 越界输入
    { mouthCurve: 9, tremble: -5, eyeOpen: 99 },  // 越界输入
  ];
  for (const c of cases) {
    const pose = resolveEarPose(c);
    assert.ok(Number.isFinite(pose) && pose >= -1 && pose <= 1, `ear pose 越界: ${JSON.stringify(c)} → ${pose}`);
  }
});

test('ear+tail: 抚摸呼噜（mouthCurve↑）同时驱动耳朵前倾与尾巴摇（正向反馈一致）', () => {
  // 模拟 poke() 连点后的呼噜加成：mouthCurve 被抬到接近 1，tremble 轻微
  const petting = { energy: 5, mouthCurve: 0.95, tremble: 0.12, eyeOpen: 0.4 };
  const ear = resolveEarPose(petting);
  const tail = resolveTailPose(petting);
  assert.ok(ear > 0.3, '被抚摸时耳朵前倾');
  assert.ok(tail.amp > 0.3, '被抚摸时尾巴摇起来');
  assert.ok(tail.lift > 0, '被抚摸时尾巴抬起');
});
