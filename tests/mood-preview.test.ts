/**
 * 情绪预览层守护 —— 「宠物情绪随精力值调节变化恢复」的纯函数半边。
 *
 * withPreviewEnergy() 是猫窗口调节预览（HUD 平时拖动 / 滑动卡预览 / 调节窗草稿）
 * 的唯一叠加入口，契约：
 *  1. null 预览 = 原样返回已落库心情（引用不变，恢复零成本）；
 *  2. 非 null 预览只重算能量派生字段（energy / emotion.energy / base / overlay），
 *     overlay 必须走 resolveWeatherOverlay 唯一门槛入口（R6：禁止各自复制阈值）；
 *  3. pulse / composite / headline / pulseActive 保持落库真值——草稿未进事件流，
 *     叙事层跟预览走会在回弹后留下「图文互相打脸」的残影；
 *  4. 输入对象绝不被就地修改（预览层与落库层共享同一 mood 引用）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withPreviewEnergy, computeMoodParams, type MoodInput } from '../src/renderer/cat/mood.js';
import { resolveWeatherOverlay, tierFor } from '../src/emotion/engine.js';
import type { EmotionState, WeatherCondition } from '../src/core/types.js';

function makeMood(energy: number, condition: WeatherCondition, over?: Partial<EmotionState>): MoodInput {
  const tier = tierFor(energy);
  return {
    energy,
    weather: { condition, tempC: 22, source: 'live', at: 0 },
    emotion: {
      energy,
      base: tier.emotion,
      overlay: resolveWeatherOverlay(energy, condition),
      pulse: 'guilty',
      composite: `${tier.emotion}__guilty`,
      headline: '事情堆着没做完…',
      pulseActive: true,
      ...over,
    },
  };
}

test('withPreviewEnergy: null 预览原样返回（同一引用，恢复即无操作）', () => {
  const m = makeMood(5, 'sunny');
  assert.equal(withPreviewEnergy(m, null), m);
});

test('withPreviewEnergy: 预览重算 energy / emotion.energy / base（查 tier 表）', () => {
  const m = makeMood(5, 'cloudy');
  const eff = withPreviewEnergy(m, 9.5);
  assert.equal(eff.energy, 9.5);
  assert.equal(eff.emotion.energy, 9.5);
  assert.equal(eff.emotion.base, 'blissful');
  const low = withPreviewEnergy(m, 0.5);
  assert.equal(low.emotion.base, 'burnt');
});

test('withPreviewEnergy: overlay 走 resolveWeatherOverlay 唯一门槛（与直算逐点一致）', () => {
  for (const cond of ['sunny', 'cloudy', 'rain', 'thunderstorm'] as WeatherCondition[]) {
    for (const e of [0, 1.5, 3, 5, 7.5, 7.9, 8, 9, 10]) {
      const eff = withPreviewEnergy(makeMood(5, cond), e);
      assert.equal(
        eff.emotion.overlay,
        resolveWeatherOverlay(e, cond),
        `overlay 门槛分叉：weather=${cond} preview=${e}`,
      );
    }
  }
  // 语义抽查：晴天拖到 8+ 头顶出太阳，回落即消失；雨天低精力挂雨滴
  assert.equal(withPreviewEnergy(makeMood(5, 'sunny'), 9).emotion.overlay, 'sunbeam');
  assert.equal(withPreviewEnergy(makeMood(9, 'sunny'), 5).emotion.overlay, 'none');
  assert.equal(withPreviewEnergy(makeMood(5, 'rain'), 2).emotion.overlay, 'rain-drop');
});

test('withPreviewEnergy: pulse / composite / headline / pulseActive / weather 保持落库真值', () => {
  const m = makeMood(5, 'rain', { pulse: 'anxious', composite: 'weary__soaked__anxious', headline: '一直推掉休息，有点慌' });
  const eff = withPreviewEnergy(m, 9);
  assert.equal(eff.emotion.pulse, 'anxious');
  assert.equal(eff.emotion.composite, 'weary__soaked__anxious');
  assert.equal(eff.emotion.headline, '一直推掉休息，有点慌');
  assert.equal(eff.emotion.pulseActive, true);
  assert.equal(eff.weather, m.weather);
});

test('withPreviewEnergy: 不就地修改输入（预览层与落库层共享 mood 引用）', () => {
  const m = makeMood(5, 'sunny');
  const snapshot = JSON.stringify(m);
  withPreviewEnergy(m, 9);
  withPreviewEnergy(m, 1);
  assert.equal(JSON.stringify(m), snapshot);
});

test('withPreviewEnergy: 越界草稿被钳到量程 0–10（与 computeMoodParams 同界）', () => {
  const m = makeMood(5, 'sunny');
  assert.equal(withPreviewEnergy(m, 99).energy, 10);
  assert.equal(withPreviewEnergy(m, -5).energy, 0);
  assert.equal(withPreviewEnergy(m, 99).emotion.base, 'blissful');
  assert.equal(withPreviewEnergy(m, -5).emotion.base, 'burnt');
});

test('computeMoodParams(预览心情): 行为参数随草稿精力单调变化（情绪「变化」的实体）', () => {
  const m = makeMood(5, 'sunny');
  const hi = computeMoodParams(withPreviewEnergy(m, 10));
  const lo = computeMoodParams(withPreviewEnergy(m, 0));
  assert.ok(hi.walkSpeed > lo.walkSpeed, '步速：高精力更快');
  assert.ok(hi.activity > lo.activity, '活力：高精力更活泼');
  assert.ok(hi.sleepIdleMs > lo.sleepIdleMs, '入睡阈值：低精力更快入睡');
  assert.ok(hi.breathPeriod < lo.breathPeriod, '呼吸：低精力更沉');
  // 与直接以该精力落库的心情完全一致（预览无特殊路径）
  assert.deepEqual(computeMoodParams(withPreviewEnergy(m, 2)), computeMoodParams(makeMood(2, 'sunny')));
});
