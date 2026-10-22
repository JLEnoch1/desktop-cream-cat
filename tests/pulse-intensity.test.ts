/**
 * PulseContract 测试 —— 强度查表 / 0-3 不细分 / empathy 豁免。
 *
 * 契约层是 Q1 裁决的落点，这里的每条断言都是裁决原文的可机检形式：
 * 分段边界、空隙取法、全幅区不细分、越界兜底、豁免旁路。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTENSITY_LEVELS, intensity, pulseIntensity, PULSE_BINDING,
} from '../src/emotion/pulse-contract.js';
import type { PulseBinding } from '../src/emotion/pulse-contract.js';
import type { PulseReaction } from '../src/core/types.js';

/* ─────────────────────────── 分段查表（下界包含） ─────────────────────────── */

test('intensity: 四段下界包含，返回值为四档之一', () => {
  assert.equal(intensity(10), 0.25);
  assert.equal(intensity(8), 0.25);
  assert.equal(intensity(6), 0.5);
  assert.equal(intensity(4), 0.75);
  assert.equal(intensity(0), 1.0);
});

/**
 * G4 空隙点守护：3.5 / 5.5 / 7.5 是 step=0.5 的高频取值，
 * 在裁决字面区间 [8,10]/[6,7]/[4,5]/[0,3] 里**不属于任何一段**。
 * 采用下界包含后它们必须并入较高强度侧，不得掉进兜底分支。
 */
test('intensity: G4 空隙点（3.5/5.5/7.5）落入相邻较高强度档', () => {
  assert.equal(intensity(7.5), 0.5);   // 字面空隙 → 并入 >=6 档
  assert.equal(intensity(5.5), 0.75);  // 字面空隙 → 并入 >=4 档
  assert.equal(intensity(3.5), 1.0);   // 字面空隙 → 全幅档
});

test('intensity: 0-3 全幅区内部不细分（细分=重新引入区间内递减，已否决）', () => {
  assert.equal(intensity(2.9), 1.0);
  assert.equal(intensity(0.2), 1.0);
  // 契约：全幅区内任意两点强度必须相等，不是「碰巧都返回 1.0」
  for (const a of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
    for (const b of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      assert.equal(intensity(a), intensity(b), `${a} 与 ${b} 强度必须相同`);
    }
  }
});

test('intensity: 越界负值仍落全幅（BASE_TIERS 的 burnt 档 min = -1）', () => {
  assert.equal(intensity(-1), 1.0);
  assert.equal(intensity(-5), 1.0);
});

test('intensity: 单调不增 —— 精力越高脉冲越克制', () => {
  let prev = Infinity;
  for (let e = 0; e <= 10; e += 0.5) {
    const cur = intensity(e);
    assert.ok(cur <= prev, `energy=${e} 强度 ${cur} 不得高于 ${prev}`);
    prev = cur;
  }
});

test('intensity: 全域取值只可能是 INTENSITY_LEVELS 里的四档', () => {
  assert.deepEqual([...INTENSITY_LEVELS], [0.25, 0.5, 0.75, 1.0]);
  for (let e = -2; e <= 12; e += 0.5) {
    assert.ok(
      (INTENSITY_LEVELS as readonly number[]).includes(intensity(e)),
      `energy=${e} 返回了表外强度 ${intensity(e)}`,
    );
  }
});

/* ─────────────────────────── 绑定分类 ─────────────────────────── */

test('PULSE_BINDING: 穷尽覆盖全部 PulseReaction，当前 6 个反应全归 energy', () => {
  const all: readonly PulseReaction[] = [
    'none', 'anxious', 'guilty', 'numb', 'restless', 'grateful', 'determined',
  ];
  for (const r of all) {
    assert.equal(PULSE_BINDING[r], 'energy', `${r} 未正确登记`);
  }
  // 分类表不得有多余键（防止改名后残留幽灵条目）
  assert.deepEqual(Object.keys(PULSE_BINDING).sort(), [...all].sort());
});

/**
 * G1 现状守护：empathy 槽位**必须是空的**。
 * 项目里不存在负面词词典，engine 也从不读 note 字段；
 * 谁往这里塞了 empathy 反应，就必须同时给出词典来源 —— 用这条断言逼他显式改测试。
 */
test('PULSE_BINDING: empathy 槽位当前为空（G1，待用户给词典后填充）', () => {
  const empathy = Object.entries(PULSE_BINDING).filter(([, b]) => b === 'empathy');
  assert.deepEqual(empathy, [], 'empathy 集合不应有成员，除非词典已落地');
});

/* ─────────────────────────── empathy 豁免（桩测试） ─────────────────────────── */

test('pulseIntensity: energy 绑定走查表（高精力被压缩）', () => {
  assert.equal(pulseIntensity('grateful', 10), 0.25);
  assert.equal(pulseIntensity('grateful', 8), 0.25);
  assert.equal(pulseIntensity('anxious', 6), 0.5);
  assert.equal(pulseIntensity('guilty', 4), 0.75);
  assert.equal(pulseIntensity('numb', 2), 1.0);
  assert.equal(pulseIntensity('none', 0), 1.0);
});

/**
 * empathy 豁免的桩测试。
 *
 * 用局部 Record 覆盖构造一个 binding='empathy' 的 stub 反应，临时注入
 * 活体分类表后走真实旁路，测完在 finally 里删除还原 —— 不改动契约实现，
 * 也不污染其他测试。断言的核心是「豁免生效时恒 1.0，且不影响 energy 侧」。
 */
test('pulseIntensity: empathy 绑定恒 1.0，不被精力压缩', () => {
  const STUB_EMPATHY = 'stub-empathy' as unknown as PulseReaction;
  const live = PULSE_BINDING as unknown as Record<string, PulseBinding>;

  // 局部 Record 覆盖：在现有分类之上叠加一个 empathy stub
  const overridden: Record<PulseReaction, PulseBinding> = { ...PULSE_BINDING };
  (overridden as unknown as Record<string, PulseBinding>)[STUB_EMPATHY] = 'empathy';
  assert.equal(overridden[STUB_EMPATHY], 'empathy');
  assert.equal(overridden.grateful, 'energy'); // 覆盖不得改动既有分类

  live[STUB_EMPATHY] = 'empathy';
  try {
    // 豁免：任何精力下都是全幅，包括本该压缩到 0.25 的 10 分
    assert.equal(pulseIntensity(STUB_EMPATHY, 10), 1.0);
    assert.equal(pulseIntensity(STUB_EMPATHY, 8), 1.0);
    assert.equal(pulseIntensity(STUB_EMPATHY, 0), 1.0);
    // 同时 energy 侧不受影响，仍走查表
    assert.equal(pulseIntensity('grateful', 10), 0.25);
  } finally {
    delete live[STUB_EMPATHY];
  }

  // 还原守护：桩不得残留在活体分类表里
  assert.equal(STUB_EMPATHY in live, false);
  assert.deepEqual(Object.keys(PULSE_BINDING).length, 7);
});
