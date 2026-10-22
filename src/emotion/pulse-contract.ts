/**
 * PulseContract —— 脉冲（瞬时反应）的强度契约层。
 *
 * 全项目关于「脉冲多强、谁被豁免」的唯一真源。渲染层 / 领域层 / 测试
 * 一律走 pulseIntensity()，禁止各自复制分段边界（同 resolveWeatherOverlay
 * 之于天气门槛的做法：阈值集中一处，杜绝图文互相打脸）。
 *
 * 裁决 Q1 的两条结论：
 *   1. 激活门槛废除 —— 脉冲全档触发，不再有「精力够高就不响应」的闸门。
 *   2. 调制用查表不用连续函数 —— 精力越高、脉冲越克制（压缩），
 *      精力越低、脉冲越全幅。方向不可反：低精力时的反应要被完整看见，
 *      高精力时的反应只是轻轻点一下。
 */

import type { PulseReaction } from '../core/types.js';

/* ─────────────────────────── 强度分级 ─────────────────────────── */

/**
 * 四档强度，从最克制到全幅。
 * 这是唯一的数值声明处，下面的分段表按索引引用它，避免两处硬编码漂移。
 */
export const INTENSITY_LEVELS = [0.25, 0.5, 0.75, 1.0] as const;

/**
 * 精力 → 强度的分段表（从高到低排列，取第一个 energy >= minEnergy 的档）。
 *
 * 🔴 为什么用「下界包含」而不是裁决原文的字面区间：
 * 原文写的是 [8,10] / [6,7] / [4,5] / [0,3]，但精力是 step=0.5 的浮点值，
 * 3.5 / 5.5 / 7.5 是高频取值，却落在字面区间的**空隙**里（不属于任何一段）。
 * 若照字面实现，这些值会掉进兜底分支，得到与相邻档完全不同的强度 —— 表现为
 * 「精力 7.5 时脉冲满幅，7.0 时却减半」的跳变。
 * 取法：以每段下界为准（>=8 / >=6 / >=4 / else），空隙自然并入下一档的
 * 较高强度侧，单调不增、无跳变。等价于把字面区间读作左闭右开 [下界, 次段下界)。
 *
 * 注意 else 分支覆盖 0–3 **以及**越界负值（BASE_TIERS 的 burnt 档 min = -1），
 * 一律全幅 —— 越界只会更糟，没有理由反而收敛。
 */
const INTENSITY_TABLE: readonly { minEnergy: number; level: number }[] = [
  { minEnergy: 8, level: INTENSITY_LEVELS[0] },
  { minEnergy: 6, level: INTENSITY_LEVELS[1] },
  { minEnergy: 4, level: INTENSITY_LEVELS[2] },
];

/** 全幅档（else 分支）：0–3 区间内部不再细分 */
const FULL_AMPLITUDE: number = INTENSITY_LEVELS[3];

/**
 * 精力 → 脉冲强度。
 *
 * 🔴 0–3 内部刻意**不做**细分：那是全幅区，再切一刀就等于重新引入
 * 「区间内递减」，而「低精力区内部细分」方案已被明确否决。
 * 因此 intensity(2.9) === intensity(0.2) === 1.0 是契约，不是巧合。
 */
export function intensity(energy: number): number {
  for (const seg of INTENSITY_TABLE) {
    if (energy >= seg.minEnergy) return seg.level;
  }
  return FULL_AMPLITUDE;
}

/* ─────────────────────────── 绑定分类与豁免 ─────────────────────────── */

/**
 * 脉冲反应的驱动来源：
 *   - 'energy'  : 由自身精力状态驱动 → 强度走 intensity() 查表（高精力压缩）
 *   - 'empathy' : 由共情/外部语义驱动 → 强度恒 1.0，**豁免**压缩
 *
 * 为什么 empathy 必须豁免：压缩的理由是「状态好的时候别大惊小怪」，
 * 这个理由只对自身的精力波动成立。共情反应的对象不是宠物自己的电量，
 * 拿精力去衰减它，等于「我状态好所以对你的事不那么在意」——语义反了。
 */
export type PulseBinding = 'energy' | 'empathy';

/**
 * 每个 PulseReaction 的绑定分类。
 *
 * Record<PulseReaction, …> 是穷尽映射：将来 core/types 里新增反应而忘了
 * 在此登记，tsc 会直接报错 —— 分类不允许有静默缺口。
 *
 * 🔴 G1 现状：empathy 槽位**暂空**。当前 6 条 PULSE_RULES 全部由精力/日志
 * 信号驱动，engine 也从不读取事件的 note 字段，项目里不存在负面词词典。
 * 本文件只交付「豁免机制」（分类表 + 旁路 + 桩测试），不发明词典。
 * empathy 集合待用户给词典后填充。
 */
export const PULSE_BINDING: Record<PulseReaction, PulseBinding> = {
  none: 'energy',       // 无反应：不参与调制，归 energy 侧以保持映射穷尽
  anxious: 'energy',
  guilty: 'energy',
  numb: 'energy',
  restless: 'energy',
  grateful: 'energy',
  determined: 'energy',
};

/**
 * 唯一入口：给定反应与精力，返回该反应的脉冲强度。
 *
 * empathy → 恒 1.0（豁免）；energy → 走 intensity() 查表。
 * 下游（渲染层 drawPulseAura / 偏移量计算）只准调这个函数，
 * 不准直接调 intensity()，否则 empathy 豁免会被绕过。
 */
export function pulseIntensity(reaction: PulseReaction, energy: number): number {
  if (PULSE_BINDING[reaction] === 'empathy') return FULL_AMPLITUDE;
  return intensity(energy);
}
