/**
 * T13 金渐层花纹 + 虹膜迁移测试。
 *
 * 裁决核心守护：
 *   ① R7 联动 —— patternOpacity/patternContrast 必须由 sat/lum 派生（禁独立常量），
 *      精力降 → 花纹对比度单调收敛（低档褪成均匀浅金灰 = 病弱猫第一视觉信号）。
 *   ② 绿眼睛三条子规则 —— 色相随精力迁移（暖翠绿→琥珀翠→蜜琥珀），
 *      🔴 任何档位绿分量 ≤30%；绿永不在低档主导。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_TIERS } from '../src/emotion/engine.js';
import { coatPatternParams, irisTone } from '../src/renderer/pet.js';

/* ─────────────────── ① 花纹：sat/lum 派生 + 单调收敛 ─────────────────── */

test('花纹: contrast/opacity 沿 BASE_TIERS 10 档单调不增（精力降 → 花纹收敛，R7 联动）', () => {
  let prevC = Infinity;
  let prevO = Infinity;
  for (const t of BASE_TIERS) {
    const { opacity, contrast } = coatPatternParams(t.sat, t.lum);
    assert.ok(contrast <= prevC + 1e-12, `${t.emotion} 档 contrast=${contrast} 出现回升（前一档 ${prevC}）`);
    assert.ok(opacity <= prevO + 1e-12, `${t.emotion} 档 opacity=${opacity} 出现回升（前一档 ${prevO}）`);
    prevC = contrast;
    prevO = opacity;
  }
});

test('花纹: 顶档接近满强度、burnt 档收敛到接近 0（褪成浅金灰，不是消失跳变）', () => {
  const top = BASE_TIERS[0];
  const bottom = BASE_TIERS[BASE_TIERS.length - 1];
  const hi = coatPatternParams(top.sat, top.lum);
  const lo = coatPatternParams(bottom.sat, bottom.lum);
  assert.ok(hi.contrast >= 0.95 && hi.opacity >= 0.95, `blissful 档应接近满强度，实际 ${JSON.stringify(hi)}`);
  assert.ok(lo.contrast <= 0.05, `burnt 档 contrast 应收敛到 ~0，实际 ${lo.contrast}`);
  assert.ok(lo.opacity >= 0.3, `burnt 档 opacity 保留底纹不跳变（裁决：褪成浅金灰而非花纹消失），实际 ${lo.opacity}`);
  assert.ok(lo.opacity * lo.contrast < hi.opacity * hi.contrast * 0.1, 'burnt 档有效花纹强度应 < 顶档 10%');
});

test('花纹: 输出恒在 [0,1]（穷举 0.5 步长全量程，含越界负值）', () => {
  for (let e = -1; e <= 10; e += 0.5) {
    const t = BASE_TIERS.find(x => e >= x.min) ?? BASE_TIERS[BASE_TIERS.length - 1];
    const { opacity, contrast } = coatPatternParams(t.sat, t.lum);
    assert.ok(opacity >= 0 && opacity <= 1, `energy=${e} opacity=${opacity} 越界`);
    assert.ok(contrast >= 0 && contrast <= 1, `energy=${e} contrast=${contrast} 越界`);
  }
});

/* ─────────────────── ③ 虹膜：绿分量 ≤30% + 色相迁移 ─────────────────── */

test('虹膜: 任何精力档位绿分量 ≤30%（裁决自设硬约束），且眼睛永不全灰（sat > 0）', () => {
  for (let e = -1; e <= 10; e += 0.5) {
    const iris = irisTone(e);
    assert.ok(iris.green <= 0.3 + 1e-12, `energy=${e} 绿分量 ${iris.green} 越过 30% 上限`);
    assert.ok(iris.sat > 0, `energy=${e} 虹膜 sat=0 —— 眼睛永不全灰（生命迹象通道）`);
  }
});

test('虹膜: 色相随精力单调迁移（0-3 蜜琥珀 → 4-7 琥珀翠 → 8-10 暖翠绿）', () => {
  const low = irisTone(1);    // 蜜琥珀段
  const mid = irisTone(5.5);  // 琥珀翠段
  const high = irisTone(9);   // 暖翠绿段
  assert.ok(low.hue < mid.hue && mid.hue < high.hue, `色相未随精力迁移：${low.hue}/${mid.hue}/${high.hue}`);
  assert.ok(low.hue <= 80, `低档应是蜜琥珀（暖黄绿），hue=${low.hue}`);
  assert.ok(high.hue >= 120, `高档应是暖翠绿，hue=${high.hue}`);
  // 绿永不在低档主导：低档绿分量显著低于高档
  assert.ok(low.green < high.green, '低档绿分量不得高于高档（绿永不在低档主导）');
  assert.ok(low.green <= 0.15, `低档绿分量 ${low.green} 过高（蜜琥珀应几乎无绿）`);
});
