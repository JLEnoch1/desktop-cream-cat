# `src/emotion/engine.ts` — 三层情绪合成

> 模块存根（原 STRUCTURE_MAP §3.8）· 层级 **L2** · 测试：tests/core.test.ts + tests/emotion-tiers.test.ts（6 例，R7 守护）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：纯函数，无副作用无 IO。
 *   base    10 档精力状态表      → 主体表情
 *   weather 独立 overlay 精灵    → 锚定头顶，不参与表情状态机
 *   pulse   日志驱动的瞬时反应   → 全档激活（门槛已废除，强度由 pulse-contract 调制）
 */

/* ── base 层 ── */
export interface BaseTier {
  emotion: BaseEmotion;
  min: number;         // 区间下界（含），上界为下一档下界
  label: string;       // 中文档位名
  headline: string;    // 一句话状态
  breath: number;      // 呼吸周期 s
  bounce: number;      // 弹跳幅度 px
  blink: number;       // 眨眼间隔 s
  hue: number;         // 主色调（全程 33–46 暖区间，R7）
  sat: number;         // 饱和度（72 → 26，疲惫主要靠它表达；E3 参考图校色后）
  lum: number;         // 🆕 v1.2 明度基线（86 → 58；E3 校色后）。R7 用：低精力降饱和+降明度，
                       //    色相不退暖。pet.ts 的 bodyGrad / 眼皮遮罩参数化读它
                       //    （原硬编码 lightness 78/64/48 已废除）
}

export const BASE_TIERS: readonly BaseTier[];
// ⟨10 档，从高到低排列；min 依次为 9.5/8.5/7.5/6.5/5.5/4.5/3.5/2.5/1.5/-1⟩
// ⟨实测 hue = 46/44/42/40/38/37/36/35/34/33⟩
// ⟨实测 sat = 96/94/92/88/78/66/54/42/32/24⟩
// ⟨实测 lum = 80/78/76/74/72/70/67/63/58/52⟩

export const WARM_HUE_MIN = 30;   // 🆕 v1.2 导出（engine.ts:40）。R7 守护锚点：
export const WARM_HUE_MAX = 46;   //    任何档位 hue 不得落在此区间外（禁蓝紫病态色）

~~export const PULSE_THRESHOLD = 3~~ 已废除（2026-10-22 Q1 裁决），pulse 全档激活；调制见 [emotion-pulse-contract.md](emotion-pulse-contract.md)
                                    // 🔴 红线常量，勿自行调整（DESIGN.md §4.3）

export function tierFor(energy: number): BaseTier;
// ⟨查表取第一个 energy >= min 的档；全不匹配返回末档 burnt⟩

// 🔴 R7 守护测试：tests/emotion-tiers.test.ts（6 条性质断言，非逐值快照）
//   ① 全部 hue ∈ [WARM_HUE_MIN, WARM_HUE_MAX]  ② 无档位 hue ∈ [180,320]（冷病态区）
//   ③ sat 与 lum 随档位单调不增  ④ blissful vs burnt 差值 sat≥40 且 lum≥20（可辨）
//   ⑤ hue 跨度 ≤20（"去饱和"而非"变色相"）  ⑥ 变异验证：hue 46→250 触发 3 条失败
//   ⚠️ 改 BASE_TIERS 数值前先看这个文件，否则会在 CI 撞上守护。

/* ── weather 层 ── */
export const WEATHER_OVERLAY: Record<WeatherCondition, WeatherOverlay>;
// ⟨sunny→sunbeam, cloudy→cloud-puff, rain→rain-drop, thunderstorm→storm-bolt⟩
export const WEATHER_LABEL: Record<WeatherCondition, string>;   // 晴/阴/雨/雷阵雨

/* ── 天气 × 精力 复合规则 ── */
export type EnergyBand = 'high' | 'mid' | 'low';
export type CompositeModifier =
  | 'lifted' | 'neutral' | 'cozy' | 'heavy' | 'soaked' | 'startled' | 'charged';

export const COMPOSITE_TABLE: Record<WeatherCondition, Record<EnergyBand, CompositeModifier>>;
// ⟨4×3 全覆盖。语义：同样下雨，精力高是「惬意听雨(cozy)」，精力低是「雪上加霜(soaked)」⟩

export function energyBand(energy: number): EnergyBand;
// ⟨>=6.5 high；>=3 mid；否则 low。low(<3) 是 composite 查表用的独立分档，与已废除的 pulse 门槛无关⟩

export const MODIFIER_LABEL: Record<CompositeModifier, string>;

/* ── pulse 层：6 信号 → 6 反应 ── */
export interface PulseSignals {
  rejectedStreak: number;              // 连续拒绝恢复建议次数
  overdueTasks: number;                // 超时未完成任务数
  msSinceLastChange: number;           // 距上次精力变化事件 ms
  recentAdjustCount: number;           // 近 30min energy.delta 次数
  recentAdjustAvgAbs: number;          // 近 30min energy.delta 平均绝对值
  lastRecoveryDeviation: number | null; // 最近一次 recovery.taken 的 actual-predicted
}

export interface PulseRule {
  reaction: PulseReaction;
  priority: number;                    // 数字小先判定
  test: (s: PulseSignals) => boolean;
  headline: string;
}

export const PULSE_RULES: readonly PulseRule[];
// ⟨6 条，priority 1→6：
//   grateful(dev>=1) · determined(-1<dev<1) · anxious(rejectedStreak>=2)
//   guilty(overdue>=1) · restless(count>=4 且 avgAbs<=1.5) · numb(>=90min 无变化)⟩

export function extractPulseSignals(events: DomainEvent[], now?: number): PulseSignals;
// ⟨纯函数便于单测。WINDOW = 30min；rejectedStreak 从后往前扫，遇 accepted/modified 中断；
//   overdueTasks = created 且 dueAt<now 且无对应 completed/dropped⟩

export function resolvePulse(
  signals: PulseSignals, pulseActive: boolean,
): { reaction: PulseReaction; headline: string | null };
// ⟨pulseActive=false 直接返回 none；否则按 priority 首个命中生效（单一反应，不叠加）⟩

/* ── 合成入口 ── */
export interface ResolveInput {
  energy: number;
  weather: WeatherState;
  events: DomainEvent[];   // 今日或近段，按 id 升序
  now?: number;
}

export function resolve(input: ResolveInput): EmotionState;
// ⟨三层合成主入口。pulseActive 恒 true（门槛已废除，字段保留以维持 EmotionState 形状）；
//   headline 取 pulse headline，无则取 base tier headline⟩

export function buildComposite(
  base: BaseEmotion, modifier: CompositeModifier, pulse: PulseReaction,
): string;
// ⟨'__' 连接；modifier='neutral' 与 pulse='none' 均跳过。例：'drained__soaked__anxious'⟩

export function describe(state: EmotionState, weather: WeatherState): string;
// ⟨UI 摘要，格式「{档位label} · {天气label}，{修饰说明}」⟩
```
