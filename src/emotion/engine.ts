/**
 * EmotionEngine —— 三层情绪合成（纯函数，无副作用、无 IO）。
 *
 *   base   : 10 档精力状态表      → 决定宠物主体表情
 *   weather: 独立 overlay 精灵     → 锚定头顶，不参与表情状态机
 *   pulse  : 决策日志驱动的瞬时反应 → 全档激活，强度由 pulse-contract 调制
 *
 * resolve(energy, weather, events) → EmotionState
 */

import type { DomainEvent } from '../core/events.js';
import type {
  BaseEmotion, EmotionState, PulseReaction, WeatherCondition, WeatherOverlay, WeatherState,
} from '../core/types.js';
import { round2 } from '../core/events.js';

/* ─────────────────────────── base：10 档精力状态表 ─────────────────────────── */

export interface BaseTier {
  emotion: BaseEmotion;
  /** 区间下界（含），上界为下一档下界 */
  min: number;
  label: string;
  headline: string;
  /** 动画参数：呼吸周期(s) / 弹跳幅度(px) / 眨眼间隔(s) */
  breath: number;
  bounce: number;
  blink: number;
  /** 主色调（渲染层用） */
  hue: number;
  sat: number;
  /** 明度基线（渲染层 bodyGrad 的 lightness 锚点） */
  lum: number;
}

/**
 * 暖色相区间（R7 / DESIGN.md §3.1）。
 * 低精力表达疲惫靠 sat + lum + 轮廓/眼/节律，**绝不靠色相漂到蓝紫**。
 */
export const WARM_HUE_MIN = 30;
export const WARM_HUE_MAX = 46;

/** 从高到低排列；查表时取第一个 energy >= min 的档（量程 0–10，每档 1 分）
 *  sat/lum 列按参考图（用户提供的金渐层实物照，本地 golden-ref/，不入库）校色：
 *  顶档从「柠檬黄」拉向「奶油金」（sat 96→72、lum 80→86），burnt 同步提亮，
 *  保持 sat/lum 双降结构与所有结构性断言（差值≥40/≥20、单调、跨度）不变。 */
export const BASE_TIERS: readonly BaseTier[] = [
  { emotion: 'blissful',  min: 9.5, label: '狂喜', headline: '整个人都在发光！', breath: 1.6, bounce: 7, blink: 5.5, hue: 46, sat: 72, lum: 86 },
  { emotion: 'radiant',   min: 8.5, label: '神采奕奕', headline: '状态拉满，随时开干', breath: 2.0, bounce: 6, blink: 5.0, hue: 44, sat: 70, lum: 84 },
  { emotion: 'cheerful',  min: 7.5, label: '愉快', headline: '心情不错，节奏刚好', breath: 2.4, bounce: 5, blink: 4.6, hue: 42, sat: 68, lum: 82 },
  { emotion: 'content',   min: 6.5, label: '满足', headline: '稳稳的，很舒服', breath: 2.8, bounce: 4, blink: 4.2, hue: 40, sat: 65, lum: 80 },
  { emotion: 'calm',      min: 5.5, label: '平和', headline: '平静在线，不急不躁', breath: 3.2, bounce: 3, blink: 4.0, hue: 38, sat: 60, lum: 78 },
  { emotion: 'steady',    min: 4.5, label: '平稳', headline: '正常续航中', breath: 3.6, bounce: 2.5, blink: 3.8, hue: 37, sat: 54, lum: 76 },
  { emotion: 'weary',     min: 3.5, label: '有点累', headline: '电量开始报警了', breath: 4.2, bounce: 2, blink: 3.4, hue: 36, sat: 47, lum: 73 },
  { emotion: 'drained',   min: 2.5, label: '透支', headline: '需要喘口气…', breath: 4.8, bounce: 1.5, blink: 3.0, hue: 35, sat: 40, lum: 69 },
  { emotion: 'exhausted', min: 1.5, label: '疲惫', headline: '快撑不住了，请救救我', breath: 5.6, bounce: 1, blink: 2.6, hue: 34, sat: 32, lum: 64 },
  { emotion: 'burnt',     min: -1,  label: '枯竭', headline: '已关机边缘…', breath: 6.5, bounce: 0.5, blink: 2.2, hue: 33, sat: 26, lum: 58 },
] as const;

export function tierFor(energy: number): BaseTier {
  for (const t of BASE_TIERS) {
    if (energy >= t.min) return t;
  }
  return BASE_TIERS[BASE_TIERS.length - 1]!;
}

/* ─────────────────────────── weather：独立 overlay ─────────────────────────── */

/** 天气语义 → 精灵的原始映射（不含精力门槛，仅供 HUD/文案查表） */
export const WEATHER_OVERLAY: Record<WeatherCondition, WeatherOverlay> = {
  sunny: 'sunbeam',
  cloudy: 'cloud-puff',
  rain: 'rain-drop',
  thunderstorm: 'storm-bolt',
};

export const WEATHER_LABEL: Record<WeatherCondition, string> = {
  sunny: '晴',
  cloudy: '阴',
  rain: '雨',
  thunderstorm: '雷阵雨',
};

/* ─────────────────────────── 天气显示门槛（唯一判定入口） ─────────────────────────── */

/**
 * 显示太阳所需的最低精力。全项目只此一处定义阈值。
 *
 * 规则（量程 0–10）：
 *   精力 >= 8 且晴       → sunbeam（只有「晴空万里 + 状态好」才挂太阳）
 *   精力 >= 8 但多云/雨/雷 → none（好状态时不显示任何天气元素）
 *   精力 <  8 且雨/雷     → rain-drop / storm-bolt（只显示不良天气）
 *   精力 <  8 且晴/多云   → none
 *
 * 为什么必须集中：此前 overlay 直接查 WEATHER_OVERLAY，与精力完全无关，
 * 于是「精力枯竭时头顶还挂着太阳」「多云也画云」——语义与直觉相反。
 * 渲染层 / HUD / 测试一律走 resolveWeatherOverlay()，禁止各自复制阈值。
 */
export const WEATHER_DISPLAY_ENERGY_MIN = 8;

/** 不良天气：低精力区唯一允许显示的一类 */
const BAD_WEATHER: ReadonlySet<WeatherCondition> = new Set<WeatherCondition>(['rain', 'thunderstorm']);

export function isGoodWeather(condition: WeatherCondition): boolean {
  return condition === 'sunny';
}

export function isBadWeather(condition: WeatherCondition): boolean {
  return BAD_WEATHER.has(condition);
}

/** 精力 >= 8 视为「状态好」，才有资格显示好天气元素 */
export function isHighEnergy(energy: number): boolean {
  return energy >= WEATHER_DISPLAY_ENERGY_MIN;
}

/**
 * 唯一判定入口：给定精力与天气，返回应当显示的 overlay（可能是 none）。
 *
 * 注意：天气数据本身（condition/tempC/source）由 WeatherSensor 负责，
 * 这里只做「要不要显示、显示哪一个」的门槛判定，不碰数据源。
 */
export function resolveWeatherOverlay(energy: number, condition: WeatherCondition): WeatherOverlay {
  if (isHighEnergy(energy)) {
    return isGoodWeather(condition) ? 'sunbeam' : 'none';
  }
  return isBadWeather(condition) ? WEATHER_OVERLAY[condition] : 'none';
}

/* ─────────────────────────── 天气 × 精力 复合规则表 ─────────────────────────── */

/**
 * 精力分 3 档：high(>=6.5) / mid(3–6.4) / low(<3)
 * 值 = 复合表情后缀，**仅供周报叙事与托盘 tooltip 查表**，渲染层禁止读它
 * （DESIGN.md §4.4 / R6：composite 一旦驱动表情，天气就从共情层退化为评价层）。
 *
 * 语义：同样下雨，精力高时是「惬意听雨」，精力低时是「雪上加霜」。
 * 量程 0–10：low 档（<3）是 composite 查表用的独立分档，与已废除的
 * pulse 激活门槛无关（后者全档激活，见 pulse-contract.ts）；high 从「满足」档起步。
 */
export type EnergyBand = 'high' | 'mid' | 'low';

export type CompositeModifier =
  | 'lifted'      // 心情被天气托了一把（更亮）
  | 'neutral'     // 无显著影响
  | 'cozy'        // 慵懒舒适（雨天+中高精力）
  | 'heavy'       // 压抑（阴天/晴天+低精力）
  | 'soaked'      // 雪上加霜（雨+低精力）
  | 'startled';   // 被雷声惊到（雷阵雨+低精力）

/**
 * thunderstorm × high 刻意取 neutral，**不得**再引入「反差兴奋」类修饰。
 *
 * 两个理由，缺一不可：
 *
 * 1. **语义冲突**。thunderstorm + 高精力在 overlay 层是「无特效」
 *    （resolveWeatherOverlay：精力 >= 8 只显示好天气，坏天气一律 none）。
 *    叙事层却给它编一个「被点燃」，等于同一组输入在两层得出相反结论。
 *
 * 2. **档位错配放大器**。energyBand 的 high 门槛是 6.5，而 overlay 的门槛是 8。
 *    精力 7 + 雷阵雨 ⇒ 头顶挂着 storm-bolt（7 < 8），band 却是 high。
 *    旧表在这一格给出 charged，于是周报会写「反而被点燃」，
 *    而用户看到的是一只头顶乌云闪电的猫——图文互相打脸。
 *
 * 低精力侧的 startled（被雷声惊到）保留：它是「雷声把我吓了一跳」的
 * 外部归因，不指向自我价值，符合 R4 的共情层原则。
 */
export const COMPOSITE_TABLE: Record<WeatherCondition, Record<EnergyBand, CompositeModifier>> = {
  sunny:        { high: 'lifted',   mid: 'neutral', low: 'heavy'    },
  cloudy:       { high: 'neutral',  mid: 'neutral', low: 'heavy'    },
  rain:         { high: 'cozy',     mid: 'cozy',    low: 'soaked'   },
  thunderstorm: { high: 'neutral',  mid: 'neutral', low: 'startled' },
};

export function energyBand(energy: number): EnergyBand {
  if (energy >= 6.5) return 'high';
  if (energy >= 3) return 'mid';
  return 'low';
}

/**
 * 叙事词汇表（周报 / 托盘 tooltip 用）。
 * 刻意不含任何「被点燃」类正向雷阵雨修饰，见 COMPOSITE_TABLE 注释。
 */
export const MODIFIER_LABEL: Record<CompositeModifier, string> = {
  lifted: '被阳光托着',
  neutral: '平常',
  cozy: '听雨的惬意',
  heavy: '有点压抑',
  soaked: '雪上加霜',
  startled: '被雷声惊到',
};

/* ─────────────────────────── pulse：6 种日志信号 → 6 种情绪反应 ─────────────────────────── */

export interface PulseSignals {
  /** 连续拒绝恢复建议次数（recommendation.rejected 连击） */
  rejectedStreak: number;
  /** 超时未完成任务数 */
  overdueTasks: number;
  /** 距上次精力变化事件的毫秒数 */
  msSinceLastChange: number;
  /** 近 30 分钟内 energy.delta 次数（高频小幅调整） */
  recentAdjustCount: number;
  /** 近 30 分钟内 energy.delta 的平均绝对值 */
  recentAdjustAvgAbs: number;
  /** 最近一次 recovery.taken 的偏差（actual - predicted），null 表示无 */
  lastRecoveryDeviation: number | null;
}

export interface PulseRule {
  reaction: PulseReaction;
  /** 优先级（数字小先判定），命中即返回 */
  priority: number;
  test: (s: PulseSignals) => boolean;
  headline: string;
}

/**
 * 6 种日志信号 → 6 种情绪反应。
 * 判定顺序按 priority，首个命中生效（pulse 是单一瞬时反应，不叠加）。
 */
export const PULSE_RULES: readonly PulseRule[] = [
  {
    reaction: 'grateful', priority: 1,
    headline: '还好听了身体的话',
    test: s => s.lastRecoveryDeviation !== null && s.lastRecoveryDeviation >= 1,
  },
  {
    reaction: 'determined', priority: 2,
    headline: '缓过来了，能继续',
    test: s => s.lastRecoveryDeviation !== null
      && s.lastRecoveryDeviation > -1
      && s.lastRecoveryDeviation < 1,
  },
  {
    reaction: 'anxious', priority: 3,
    headline: '一直推掉休息，有点慌',
    test: s => s.rejectedStreak >= 2,
  },
  {
    reaction: 'guilty', priority: 4,
    headline: '事情堆着没做完…',
    test: s => s.overdueTasks >= 1,
  },
  {
    reaction: 'restless', priority: 5,
    headline: '心里毛毛的，坐不住',
    test: s => s.recentAdjustCount >= 4 && s.recentAdjustAvgAbs <= 1.5,
  },
  {
    reaction: 'numb', priority: 6,
    headline: '好像已经麻了…',
    test: s => s.msSinceLastChange >= 90 * 60 * 1000,
  },
] as const;

/** 从事件流提取 pulse 信号（纯函数，便于单测） */
export function extractPulseSignals(events: DomainEvent[], now = Date.now()): PulseSignals {
  const WINDOW = 30 * 60 * 1000;
  let rejectedStreak = 0;
  // 从后往前扫，连续 rejected 计数（遇到 accepted/modified 即中断）
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === 'recommendation.rejected') rejectedStreak++;
    else if (t === 'recommendation.accepted' || t === 'recommendation.modified') break;
    else if (t === 'recommendation.shown') continue;
    else if (rejectedStreak > 0) break;
  }

  // 超时任务：created 且 dueAt < now，且未见对应 completed/dropped
  const doneOrDropped = new Set<string>();
  const openDue: string[] = [];
  for (const ev of events) {
    const p = ev.payload;
    if (p.kind === 'task.completed' || p.kind === 'task.dropped') doneOrDropped.add(p.taskId);
    if (p.kind === 'task.created' && p.task.dueAt !== null) openDue.push(p.task.id);
  }
  const overdueTasks = openDue.filter(id => !doneOrDropped.has(id)).length;

  let msSinceLastChange = Number.MAX_SAFE_INTEGER;
  const recentDeltas: number[] = [];
  let lastRecoveryDeviation: number | null = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const isChange = ev.actual_delta !== null && ev.actual_delta !== 0;
    if (isChange && msSinceLastChange === Number.MAX_SAFE_INTEGER) {
      msSinceLastChange = now - ev.at;
    }
    if (ev.at >= now - WINDOW && ev.type === 'energy.delta' && ev.actual_delta !== null) {
      recentDeltas.push(ev.actual_delta);
    }
    if (lastRecoveryDeviation === null && ev.type === 'recovery.taken') {
      const pred = ev.predicted_delta ?? 0;
      const act = ev.actual_delta ?? 0;
      lastRecoveryDeviation = round2(act - pred);
    }
  }

  const recentAdjustAvgAbs = recentDeltas.length
    ? round2(recentDeltas.reduce((s, d) => s + Math.abs(d), 0) / recentDeltas.length)
    : 0;

  return {
    rejectedStreak,
    overdueTasks,
    msSinceLastChange,
    recentAdjustCount: recentDeltas.length,
    recentAdjustAvgAbs,
    lastRecoveryDeviation,
  };
}

export function resolvePulse(signals: PulseSignals, pulseActive: boolean): { reaction: PulseReaction; headline: string | null } {
  if (!pulseActive) return { reaction: 'none', headline: null };
  for (const rule of PULSE_RULES) {
    if (rule.test(signals)) return { reaction: rule.reaction, headline: rule.headline };
  }
  return { reaction: 'none', headline: null };
}

/* ─────────────────────────── 合成入口 ─────────────────────────── */

export interface ResolveInput {
  energy: number;
  weather: WeatherState;
  /** 事件流（今日或近段，按 id 升序） */
  events: DomainEvent[];
  now?: number;
}

/**
 * 三层合成 —— 纯函数。
 * base 决定主体表情，weather 贡献 overlay（受显示门槛约束）与复合修饰，
 * pulse 全档叠加瞬时反应，其**强度**由 pulse-contract.intensity() 调制
 * （高精力压缩、低精力全幅）。
 *
 * 重要区分：
 *   - `overlay`  = 「头顶要不要画东西」→ 走 resolveWeatherOverlay()，含精力门槛
 *   - `composite`= 「天气对心情的语义影响」→ 走 COMPOSITE_TABLE，不含门槛
 * 两者刻意解耦：精力低时头顶不挂太阳，但「晴天却提不起劲」的压抑语义
 * 仍应体现在 composite / describe() 文案里，供周报与气泡使用。
 */
export function resolve(input: ResolveInput): EmotionState {
  const now = input.now ?? Date.now();
  const energy = round2(input.energy);
  const tier = tierFor(energy);
  const overlay = resolveWeatherOverlay(energy, input.weather.condition);
  const band = energyBand(energy);
  const modifier = COMPOSITE_TABLE[input.weather.condition][band];

  // 门槛已废除（Q1 裁决），全档激活；字段保留以维持 EmotionState 形状，
  // 下游可安全忽略。激活与否不再由精力决定，脉冲的「轻重」交给
  // pulse-contract.pulseIntensity() 按精力调制。
  const pulseActive = true;
  const signals = extractPulseSignals(input.events, now);
  const { reaction, headline: pulseHeadline } = resolvePulse(signals, pulseActive);

  const composite = buildComposite(tier.emotion, modifier, reaction);

  return {
    energy,
    base: tier.emotion,
    overlay,
    pulse: reaction,
    composite,
    headline: pulseHeadline ?? tier.headline,
    pulseActive,
  };
}

/** 复合表情标签：base + 天气修饰 + pulse 反应 */
export function buildComposite(base: BaseEmotion, modifier: CompositeModifier, pulse: PulseReaction): string {
  const parts: string[] = [base];
  if (modifier !== 'neutral') parts.push(modifier);
  if (pulse !== 'none') parts.push(pulse);
  return parts.join('__');
}

/** 供 UI 展示的情绪摘要（含天气复合说明） */
export function describe(state: EmotionState, weather: WeatherState): string {
  const tier = tierFor(state.energy);
  const band = energyBand(state.energy);
  const modifier = COMPOSITE_TABLE[weather.condition][band];
  const wLabel = WEATHER_LABEL[weather.condition];
  const suffix = modifier === 'neutral' ? '' : `，${MODIFIER_LABEL[modifier]}`;
  return `${tier.label} · ${wLabel}${suffix}`;
}
