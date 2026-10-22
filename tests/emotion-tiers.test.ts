/**
 * R7 配色回归守护 —— 防「低精力配色倒退成蓝紫」无声发生。
 *
 * 背景（DESIGN.md §3.1）：金渐层选型的红线是**低精力不得走向蓝紫**——
 * 蓝紫在色彩心理学里自带「抑郁/病态」语义，而目标用户是 ADHD/INFP + RSD
 * 敏感人群，用非语言信号说「你病了」违反共情层原则。疲惫的表达职责在
 * 通道 1/2/4（瘫软、眼皮下垂、呼吸变慢、颤抖）与 sat/lum，**不在色相**。
 *
 * 守护策略：断言**性质**（区间、单调性、跨度、可辨差值），不硬编码具体
 * 数字——后续微调调色不会脆断，但走向蓝紫会立刻被抓到。
 * 上下界取自 engine.ts 导出的 WARM_HUE_MIN / WARM_HUE_MAX（金渐层金色色相范围），
 * 不在测试里另造一套数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_TIERS, WARM_HUE_MIN, WARM_HUE_MAX } from '../src/emotion/engine.js';

test('BASE_TIERS: hue 全程暖区间（金渐层），任何一档越界即失败（R7）', () => {
  for (const t of BASE_TIERS) {
    assert.ok(
      t.hue >= WARM_HUE_MIN && t.hue <= WARM_HUE_MAX,
      `${t.emotion} 档 hue=${t.hue} 越出暖区间 [${WARM_HUE_MIN}, ${WARM_HUE_MAX}]（R7：色相必须保持金色）`,
    );
  }
});

test('BASE_TIERS: 没有任何一档落入冷/病态区间 [180, 320]（青→蓝→紫→品红，R7 最直接断言）', () => {
  for (const t of BASE_TIERS) {
    assert.ok(
      !(t.hue >= 180 && t.hue <= 320),
      `${t.emotion} 档 hue=${t.hue} 落入冷/病态区间 [180, 320] —— R7 违规：低精力不得染成蓝紫`,
    );
  }
});

test('BASE_TIERS: sat 从高精力到低精力单调不增（去饱和表达疲惫，不回升）', () => {
  for (let i = 1; i < BASE_TIERS.length; i++) {
    const hi = BASE_TIERS[i - 1];
    const lo = BASE_TIERS[i];
    assert.ok(
      lo.sat <= hi.sat,
      `${lo.emotion}(sat=${lo.sat}) 不应比 ${hi.emotion}(sat=${hi.sat}) 更饱和 —— 疲惫靠去饱和表达`,
    );
  }
});

test('BASE_TIERS: lum 从高精力到低精力单调不增（轻微降明度，不回升）', () => {
  for (let i = 1; i < BASE_TIERS.length; i++) {
    const hi = BASE_TIERS[i - 1];
    const lo = BASE_TIERS[i];
    assert.ok(
      lo.lum <= hi.lum,
      `${lo.emotion}(lum=${lo.lum}) 不应比 ${hi.emotion}(lum=${hi.lum}) 更亮 —— 疲惫靠降明度表达`,
    );
  }
});

test('BASE_TIERS: 疲惫在视觉上可辨（blissful 与 burnt 的 sat 差 ≥40、lum 差 ≥20，防全档一个色）', () => {
  const top = BASE_TIERS[0];       // blissful（从高到低排列）
  const bottom = BASE_TIERS[BASE_TIERS.length - 1]; // burnt
  assert.ok(
    top.sat - bottom.sat >= 40,
    `sat 差值 ${top.sat - bottom.sat} < 40 —— 纠偏不能做成「全档一个色」，疲惫必须可辨`,
  );
  assert.ok(
    top.lum - bottom.lum >= 20,
    `lum 差值 ${top.lum - bottom.lum} < 20 —— 纠偏不能做成「全档一个色」，疲惫必须可辨`,
  );
});

test('BASE_TIERS: hue 总跨度 ≤ 20（色相保持暖区间而非大幅变化；疲惫表达不在色相）', () => {
  const hues = BASE_TIERS.map(t => t.hue);
  const span = Math.max(...hues) - Math.min(...hues);
  assert.ok(
    span <= 20,
    `hue 跨度 ${span} > 20 —— 色相只允许在暖区间内微移，疲惫的表达职责在通道 1/2/4 与 sat/lum`,
  );
});
