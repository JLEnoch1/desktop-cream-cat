/**
 * Pulse 偏移化测试 —— 覆盖语义废除 + 偏移 × intensity 加权叠加（DESIGN.md §4.3 / Q1）。
 *
 * 守护的核心回归：pulse 必须是 base 的**偏移量**，不是**目标值**。
 * 旧实现用空值合并覆盖（`eyeOpen: pp.eyeOpen ?? ep.eyeOpen`），pulse 一到
 * base 的表情被整值替换，导致「越累反应越该被完整看见」的语义丢失。
 *
 * 三条最容易无声退化的性质，各有一条断言盯着：
 *   ① 施加幅度 === 偏移 × intensity（不是"差不多"，是精确相等）
 *   ② intensity 来自契约层 pulseIntensity()，pet.ts 不自己复制分段边界
 *   ③ 钳制边界（eyeOpen [0,1] / mouthCurve [-1,1] / tremble [0,0.9]）
 *
 * 纯函数级测试，不起 Electron、不依赖 canvas/DOM。运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRenderParams, PULSE_OFFSETS, EMOTION_PARAMS,
} from '../src/renderer/pet.js';
import { pulseIntensity, INTENSITY_LEVELS } from '../src/emotion/pulse-contract.js';
import type { PulseReaction } from '../src/core/types.js';

/** 量出某个通道相对 base 的**施加幅度**（绝对值），用于比对"偏移 × k" */
function applied(energy: number, base: Parameters<typeof buildRenderParams>[1], pulse: PulseReaction, ch: 'eyeOpen' | 'mouthCurve' | 'tremble'): number {
  const withPulse = buildRenderParams(energy, base, pulse, true)[ch];
  const baseOnly = buildRenderParams(energy, base, 'none', false)[ch];
  return Math.abs(withPulse - baseOnly);
}

/* ─────────────────── ① 全幅：低精力偏移完整施加 ─────────────────── */

test('偏移: energy=2（全幅档 k=1.0）偏移**完整**施加，不衰减', () => {
  const base = 'drained';
  const off = PULSE_OFFSETS.anxious;
  const p = buildRenderParams(2, base, 'anxious', true);
  // mouthCurve: -0.35 + (-0.25) × 1.0 = -0.6
  assert.ok(Math.abs(p.mouthCurve - (EMOTION_PARAMS[base].mouthCurve + off.mouthCurve!)) < 1e-9,
    `mouthCurve 应为 base+偏移全幅，实际 ${p.mouthCurve}`);
  // tremble: 0.15 + 0.45 × 1.0 = 0.6
  assert.ok(Math.abs(p.tremble - (EMOTION_PARAMS[base].tremble + off.tremble!)) < 1e-9,
    `tremble 应为 base+偏移全幅，实际 ${p.tremble}`);
  assert.equal(pulseIntensity('anxious', 2), 1.0); // 确认 k 就是 1.0
});

test('偏移: 裁决验收「2 分状态同事件 → 全幅瘫倒」—— 低档偏移幅度 === 偏移表原值', () => {
  const off = PULSE_OFFSETS.anxious;
  // 施加幅度必须**精确等于**偏移表里的数字（k=1.0，无衰减、无插值）
  assert.ok(Math.abs(applied(2, 'drained', 'anxious', 'tremble') - off.tremble!) < 1e-9);
  assert.ok(Math.abs(applied(2, 'drained', 'anxious', 'mouthCurve') - Math.abs(off.mouthCurve!)) < 1e-9);
  // 0.2 与 2.9 同属全幅区（契约层：0-3 内部不细分）⇒ 幅度必须完全相同
  assert.equal(applied(0.2, 'burnt', 'anxious', 'tremble'), applied(2.9, 'burnt', 'anxious', 'tremble'));
});

/* ─────────────────── ② 压缩但非零：高精力 ─────────────────── */

test('偏移: energy=10 施加幅度恰为 0.25 倍，且 **≠ 0**（0.25 不是关掉）', () => {
  const off = PULSE_OFFSETS.anxious;
  const k = pulseIntensity('anxious', 10);
  assert.equal(k, 0.25);
  const got = applied(10, 'radiant', 'anxious', 'tremble');
  // 恰 0.25 倍
  assert.ok(Math.abs(got - off.tremble! * 0.25) < 1e-9, `应为偏移 × 0.25，实际 ${got}`);
  // 🔴 裁决守护：若为 0 则等于在高精力区关掉了 pulse
  assert.ok(got > 0, 'energy=10 的 pulse 施加幅度不得为 0 —— 0.25 ≠ 0');
  // 四档全部非零（任何一个档退化成 0 都等于悄悄重新引入门槛）
  for (const lvl of INTENSITY_LEVELS) {
    assert.ok(lvl > 0, `强度档 ${lvl} 不得为 0`);
  }
});

test('偏移: 高精力档每个通道都"可见但微弱"（幅度 > 0 且 < 全幅）', () => {
  for (const pulse of ['anxious', 'guilty', 'numb', 'restless', 'grateful', 'determined'] as const) {
    const off = PULSE_OFFSETS[pulse];
    for (const ch of ['eyeOpen', 'mouthCurve', 'tremble'] as const) {
      if (off[ch] === undefined) continue;
      const hi = applied(10, 'content', pulse, ch);
      const lo = applied(3, 'content', pulse, ch);
      assert.ok(hi > 0, `${pulse}.${ch} 在 energy=10 施加幅度为 0 —— pulse 被关掉了`);
      assert.ok(hi < lo, `${pulse}.${ch} 高精力(${hi}) 应比低精力(${lo}) 更克制`);
    }
  }
});

/* ─────────────────── ③ 覆盖语义已废除（回归守护） ─────────────────── */

/**
 * 🔴 这是本任务最核心的一条断言。
 * 旧实现下 `numb{eyeOpen:0.1}` 是**目标值**：一只 blissful（eyeOpen 1.0）的猫
 * 碰到麻木脉冲会被整值替换成 0.1（眼睛几乎闭上）—— 高档位信息被抹掉。
 * 新实现是偏移：1.0 + (-0.2) × 0.25 = 0.95，"状态好的猫只是稍微失焦一点"。
 * 若有人把偏移表改回目标值语义，这条会立刻抓到。
 */
test('覆盖语义废除: pulse 不得整值替换 base（blissful + numb 仍接近睁眼）', () => {
  const p = buildRenderParams(10, 'blissful', 'numb', true);
  assert.ok(p.eyeOpen > 0.8, `blissful 碰到 numb 后 eyeOpen=${p.eyeOpen}，被替换成了目标值`);
  // 精确值：1.0 + (-0.2) × 0.25 = 0.95
  assert.ok(Math.abs(p.eyeOpen - 0.95) < 1e-9);
  // 旧实现里 determined.eyeOpen 是 1.0（目标值）；新实现是 +0.15 偏移，
  // 作用在 base=0.85（steady）上应得 0.85+0.15k，而不是被顶到 1.0
  const d = buildRenderParams(4, 'steady', 'determined', true);
  assert.ok(Math.abs(d.eyeOpen - (0.85 + 0.15 * 0.75)) < 1e-9, `determined 走了偏移而非覆盖，实际 ${d.eyeOpen}`);
});

test('覆盖语义废除: 同一 pulse 在不同 base 上产生**不同**结果（覆盖语义下会相同）', () => {
  // 覆盖语义的病理特征：无论 base 是什么，pulse 一到就变成同一个值
  const a = buildRenderParams(5, 'blissful', 'numb', true).eyeOpen;
  const b = buildRenderParams(5, 'weary', 'numb', true).eyeOpen;
  assert.notEqual(a, b, '两个 base 的结果相同 ⇒ 偏移退化成了覆盖');
  assert.ok(a > b, '高档 base 的结果仍应高于低档 base（档位信息未被抹掉）');
});

/* ─────────────────── ④ 钳制边界 ─────────────────── */

test('钳制: mouthCurve ∈ [-1, 1]（burnt -0.85 叠加负偏移不得越界）', () => {
  const p = buildRenderParams(2, 'burnt', 'anxious', true); // -0.85 - 0.25 = -1.1 → -1
  assert.equal(p.mouthCurve, -1);
  const q = buildRenderParams(2, 'blissful', 'grateful', true); // 1.0 + 0.3 = 1.3 → 1
  assert.equal(q.mouthCurve, 1);
});

test('钳制: tremble ∈ [0, 0.9]（burnt 0.6 + restless 0.45 = 1.05 → 0.9，防像素级抽搐）', () => {
  const p = buildRenderParams(2, 'burnt', 'restless', true);
  assert.equal(p.tremble, 0.9);
  // 全域扫描：任何 base × 任何 pulse × 任何 energy 都不得越界
  for (const base of Object.keys(EMOTION_PARAMS) as (keyof typeof EMOTION_PARAMS)[]) {
    for (const pulse of Object.keys(PULSE_OFFSETS) as PulseReaction[]) {
      for (let e = -1; e <= 11; e += 0.5) {
        const r = buildRenderParams(e, base, pulse, true);
        assert.ok(r.tremble >= 0 && r.tremble <= 0.9, `tremble 越界 ${base}/${pulse}/${e} → ${r.tremble}`);
        assert.ok(r.eyeOpen >= 0 && r.eyeOpen <= 1, `eyeOpen 越界 ${base}/${pulse}/${e} → ${r.eyeOpen}`);
        assert.ok(r.mouthCurve >= -1 && r.mouthCurve <= 1, `mouthCurve 越界 ${base}/${pulse}/${e} → ${r.mouthCurve}`);
        assert.ok(Number.isFinite(r.eyeOpen) && Number.isFinite(r.mouthCurve) && Number.isFinite(r.tremble),
          `出现 NaN ${base}/${pulse}/${e}`);
      }
    }
  }
});

test('钳制: eyeOpen 下界 0（burnt 0.15 + numb -0.2 → -0.05 → 0，不出现负眼皮）', () => {
  const p = buildRenderParams(2, 'burnt', 'numb', true);
  assert.equal(p.eyeOpen, 0);
});

/* ─────────────────── ⑤ 单调性：方向不得被改回「低精力压制」 ─────────────────── */

test('单调性: energy 10→0 扫描，各通道施加幅度**单调不减**', () => {
  for (const pulse of ['anxious', 'guilty', 'numb', 'restless', 'grateful', 'determined'] as const) {
    for (const ch of ['eyeOpen', 'mouthCurve', 'tremble'] as const) {
      if (PULSE_OFFSETS[pulse][ch] === undefined) continue;
      let prev = -Infinity;
      for (let e = 10; e >= 0; e -= 0.5) {
        // 用 steady 作 base：三通道都不触钳制，量出来的是纯施加幅度
        const cur = applied(e, 'steady', pulse, ch);
        assert.ok(cur >= prev - 1e-9,
          `${pulse}.${ch} 在 energy=${e} 的施加幅度 ${cur} 小于更高精力档的 ${prev} —— 方向被改回了「低精力压制」`);
        prev = cur;
      }
    }
  }
});

test('单调性: 施加幅度只取四档（intensity 是查表不是连续 ramp）', () => {
  const off = Math.abs(PULSE_OFFSETS.anxious.tremble!);
  const levels = new Set<number>();
  for (let e = 0; e <= 10; e += 0.5) {
    levels.add(Number((applied(e, 'steady', 'anxious', 'tremble') / off).toFixed(6)));
  }
  // 只可能是 {0.25, 0.5, 0.75, 1.0} —— 连续 ramp 会产生几十个不同值
  assert.deepEqual([...levels].sort((a, b) => a - b), [...INTENSITY_LEVELS].sort((a, b) => a - b));
});

/* ─────────────────── ⑥ 契约层唯一真源 ─────────────────── */

/**
 * 🔴 守护「不得在 pet.ts 复制分段边界」：
 * 施加幅度 / 偏移原值 必须**恒等于** pulseIntensity()。
 * 若有人在渲染层自己写了一套 if/else 分段，边界值（3.5/5.5/7.5 这些
 * 字面区间空隙点）上一定会与契约层出现偏差，这条会抓到。
 */
test('契约层: 施加幅度 ÷ 偏移原值 === pulseIntensity()（含 G4 空隙点 3.5/5.5/7.5）', () => {
  const off = Math.abs(PULSE_OFFSETS.anxious.tremble!);
  for (let e = -1; e <= 11; e += 0.5) {
    const ratio = applied(e, 'steady', 'anxious', 'tremble') / off;
    assert.ok(Math.abs(ratio - pulseIntensity('anxious', e)) < 1e-9,
      `energy=${e}: pet.ts 算出的强度 ${ratio} ≠ 契约层 ${pulseIntensity('anxious', e)}`);
  }
});

/* ─────────────────── ⑦ 未激活 / none 反应 ─────────────────── */

test('pulseActive=false → k=0，三通道原样返回 base（与"没有 pulse"等价）', () => {
  for (const pulse of Object.keys(PULSE_OFFSETS) as PulseReaction[]) {
    for (const base of ['blissful', 'steady', 'burnt'] as const) {
      const inactive = buildRenderParams(2, base, pulse, false);
      const none = buildRenderParams(2, base, 'none', false);
      assert.equal(inactive.eyeOpen, none.eyeOpen, `${base}/${pulse} eyeOpen`);
      assert.equal(inactive.mouthCurve, none.mouthCurve, `${base}/${pulse} mouthCurve`);
      assert.equal(inactive.tremble, none.tremble, `${base}/${pulse} tremble`);
    }
  }
});

test("none 反应 → 全零偏移（任何档位都不改变 base 表情）", () => {
  assert.deepEqual(PULSE_OFFSETS.none, {});
  for (let e = 0; e <= 10; e += 1) {
    const p = buildRenderParams(e, 'weary', 'none', true);
    // eyeOpen 在低档会叠加趴窝变体的 lidDroop（base 层增强，非 pulse 偏移），
    // 故与「无 pulse 的 base 渲染」比较，而非与裸 EMOTION_PARAMS 比较。
    const baseOnly = buildRenderParams(e, 'weary', 'none', false);
    assert.equal(p.eyeOpen, baseOnly.eyeOpen);
    assert.equal(p.mouthCurve, EMOTION_PARAMS.weary.mouthCurve);
    assert.equal(p.tremble, EMOTION_PARAMS.weary.tremble);
  }
});

test('偏移表: 穷尽覆盖全部 PulseReaction，且量级不越出约定区间', () => {
  const all: readonly PulseReaction[] = [
    'none', 'anxious', 'guilty', 'numb', 'restless', 'grateful', 'determined',
  ];
  assert.deepEqual(Object.keys(PULSE_OFFSETS).sort(), [...all].sort(),
    '偏移表必须穷尽全部反应（漏登记会让 tsc 报错，这里再加一道运行时守护）');
  // 量级约定（见 PULSE_OFFSETS 注释）：越界说明有人把它当目标值用了
  for (const pulse of all) {
    const o = PULSE_OFFSETS[pulse];
    if (o.eyeOpen !== undefined) {
      assert.ok(Math.abs(o.eyeOpen) >= 0.1 && Math.abs(o.eyeOpen) <= 0.25,
        `${pulse}.eyeOpen=${o.eyeOpen} 越出 ±0.1~0.25（眼皮是微调通道，>0.3 读成换了一只猫）`);
    }
    if (o.mouthCurve !== undefined) {
      assert.ok(Math.abs(o.mouthCurve) >= 0.2 && Math.abs(o.mouthCurve) <= 0.5,
        `${pulse}.mouthCurve=${o.mouthCurve} 越出 ±0.2~0.5`);
    }
    if (o.tremble !== undefined) {
      assert.ok(o.tremble > 0 && o.tremble <= 0.45,
        `${pulse}.tremble=${o.tremble} 越出 +0.15~0.45（只加不减）`);
    }
  }
});

/**
 * R7 守护（配色不碰 hue/sat/lum）在偏移化语境下的等价形式：
 * pulse 只许动 eyeOpen / mouthCurve / tremble 三个通道，
 * hue / sat / lum / breath / bounce / blink / squish 一律来自 base 档位。
 */
test('R7: pulse 不得触碰 hue/sat/lum/breath/bounce/blink/squish（只走三个表情通道）', () => {
  for (const pulse of Object.keys(PULSE_OFFSETS) as PulseReaction[]) {
    for (const base of ['blissful', 'steady', 'burnt'] as const) {
      const withP = buildRenderParams(2, base, pulse, true);
      const without = buildRenderParams(2, base, 'none', false);
      for (const ch of ['hue', 'sat', 'lum', 'breath', 'bounce', 'blink', 'squish'] as const) {
        assert.equal(withP[ch], without[ch], `R7 违规：pulse ${pulse} 改动了 ${ch}`);
      }
    }
  }
});

/* ─────────────────── 钳制：全组合穷举 ─────────────────── */

/**
 * 上方三条钳制断言各只抽查一个组合（mouthCurve 的 burnt+负偏移、tremble 的
 * burnt+restless、eyeOpen 的 burnt+numb）。抽查能抓到当前这版数值的越界，
 * 但抓不到「换数值后某个没被抽到的组合」—— 而越界在渲染层的表现不是崩溃，
 * 是几何走形（负眼皮、反向嘴型、抖动到散架），截图很难一眼看出。
 *
 * 所以这里把全部 base × pulse × energy 穷举一遍。energy 从 **-1** 起扫：
 * BASE_TIERS 的 burnt 档 min = -1，契约层注释也明写「else 分支覆盖 0–3
 * 以及越界负值」，而其余测试的 energy 循环都是 0–10，负值边界一直没人守。
 * 步长 0.5 与精力写入的精度一致（step=0.5 的浮点档是高频取值）。
 */
test('钳制: 全组合穷举 —— 10 base × 全部 pulse × energy -1~10（步长 0.5）', () => {
  const bases = [
    'blissful', 'radiant', 'cheerful', 'content', 'calm',
    'steady', 'weary', 'drained', 'exhausted', 'burnt',
  ] as const;
  const RANGE = {
    eyeOpen: [0, 1],
    mouthCurve: [-1, 1],
    tremble: [0, 0.9],
  } as const;
  const channels = ['eyeOpen', 'mouthCurve', 'tremble'] as const;
  const pulses = Object.keys(PULSE_OFFSETS) as PulseReaction[];

  for (const base of bases) {
    for (const pulse of pulses) {
      for (let energy = -1; energy <= 10; energy += 0.5) {
        const p = buildRenderParams(energy, base, pulse, true);
        for (const ch of channels) {
          const [lo, hi] = RANGE[ch];
          assert.ok(
            p[ch] >= lo - 1e-9 && p[ch] <= hi + 1e-9,
            `${base}/${pulse}/energy=${energy}: ${ch}=${p[ch]} 越出 [${lo}, ${hi}]`,
          );
        }
      }
    }
  }
});
