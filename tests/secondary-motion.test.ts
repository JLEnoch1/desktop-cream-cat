/**
 * F · 次级运动测试（生命感来源的确定性守护）。
 *
 * 不变式 #13：姿态解算纯函数、无随机。次级运动是**时间的确定性函数**——
 * 同参数必须同输出（这两条断言就是「禁 Math.random」的机器守护）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { tailLagAngle, earTwitch } from '../src/renderer/pet.js';

test('次级运动: 确定性——同参数两次调用输出逐位相同（禁随机的机器守护）', () => {
  for (const t of [0, 1.234, 7.77, 42]) {
    assert.equal(tailLagAngle(t, 3, 0.5, 0.7), tailLagAngle(t, 3, 0.5, 0.7));
    assert.equal(earTwitch(t, 1), earTwitch(t, 1));
    assert.equal(earTwitch(t, -1), earTwitch(t, -1));
  }
});

test('次级运动: 尾根(s=0)零延迟——滞后只向尾梢生长（鞭状语义）', () => {
  for (const t of [0, 0.5, 2, 9]) {
    // 用 === 而非 assert.equal：sin(…)×0 会产生 -0，Object.is 语义下 -0≠0 属误报
    assert.ok(tailLagAngle(t, 4, 0.6, 0) === 0);
  }
});

test('次级运动: 尾延迟幅度有界 |lag| ≤ amp×0.12（微扰动，不是第二条尾巴）', () => {
  for (let s = 0; s <= 1; s += 0.1) {
    for (const t of [0.3, 1.7, 5.1]) {
      const lag = tailLagAngle(t, 5, 0.8, s);
      assert.ok(Math.abs(lag) <= 0.8 * 0.12 + 1e-12, `s=${s} t=${t} lag=${lag} 越界`);
    }
  }
});

test('次级运动: 耳微颤有界 ±0.02rad 且左右相位错开（避免镜像感）', () => {
  let maxAbs = 0;
  let phaseDiffers = false;
  for (let t = 0; t <= 8; t += 0.25) {
    const l = earTwitch(t, -1);
    const r = earTwitch(t, 1);
    maxAbs = Math.max(maxAbs, Math.abs(l), Math.abs(r));
    if (Math.abs(l - r) > 0.005) phaseDiffers = true;
  }
  assert.ok(maxAbs <= 0.02, `耳微颤幅度 ${maxAbs} 越出 ±0.02rad（底噪不能读作抽搐）`);
  assert.ok(phaseDiffers, '左右耳相位完全同步 = 镜像感，生命感失效');
});
