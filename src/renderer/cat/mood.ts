/**
 * Mood —— 领域情绪 → 奶油猫行为的映射层（融合核心，纯函数可单测）。
 *
 * 输入是 Coordinator 推送的 CatMoodPayload（精力/三层情绪/天气），输出：
 *  - MoodParams：FSM 行为参数（活力/入睡阈值/步速/眨眼/呼吸）
 *  - 气泡文案：摸头/领域事件反应（reaction）按精力档与天气抽取
 *  - 表情名：映射到皮肤 expressions（happy/surprise/tap；无素材静默跳过）
 *
 * 红线继承（DESIGN.md）：低精力表达疲惫靠「少动、快睡、慢走」与文案的温柔，
 * **绝不贬损用户**；精力再低猫也陪着你，只是先躺下了。
 */

import { tierFor } from '../../emotion/engine.js';
import type { BaseEmotion, WeatherCondition } from '../../core/types.js';
import type { CatMoodPayload } from '../../core/types.js';

export type MoodInput = CatMoodPayload;

export interface MoodParams {
  /** 行为活力乘数（0.3–1.2）：散步/舔毛/攀爬概率与节奏 */
  activity: number;
  /** 无互动多久入睡（ms）：精力高 45s → 精力低 12s */
  sleepIdleMs: number;
  /** 地面步速（px/s）：28–46 */
  walkSpeed: number;
  /** 眨眼间隔乘数（tier.blink / 4.0） */
  blinkScale: number;
  /** 呼吸周期（s，tier.breath） */
  breathPeriod: number;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** 精力 → 行为参数（单调：精力越高越活泼，跨档无跳变——全部线性插值） */
export function computeMoodParams(m: MoodInput): MoodParams {
  const e = clamp(m.energy, 0, 10);
  const tier = tierFor(e);
  // 活力：0 分 0.30 → 10 分 1.20（线性）
  const activity = 0.3 + (e / 10) * 0.9;
  // 入睡阈值：e<=2 → 12s；e>=8 → 45s；中间线性
  const sleepIdleMs = e <= 2 ? 12_000 : e >= 8 ? 45_000 : 12_000 + ((e - 2) / 6) * 33_000;
  // 步速：e<=1 → 28；e>=8 → 46；中间线性
  const walkSpeed = e <= 1 ? 28 : e >= 8 ? 46 : 28 + ((e - 1) / 7) * 18;
  return {
    activity,
    sleepIdleMs,
    walkSpeed,
    blinkScale: tier.blink / 4.0,
    breathPeriod: tier.breath,
  };
}

/** 无心情数据（领域未就绪）时的中性参数：等价 desktop-pet 原版行为 */
export const NEUTRAL_MOOD: MoodParams = {
  activity: 1,
  sleepIdleMs: 45_000,
  walkSpeed: 46,
  blinkScale: 1,
  breathPeriod: 2.8,
};

/* ─────────────────────────── 气泡文案库 ─────────────────────────── */

/** 精力三档：high >=7.5 / mid >=3 / low <3（与 HUD 低电量提醒阈值同源） */
export function energyBandOf(energy: number): 'high' | 'mid' | 'low' {
  if (energy >= 7.5) return 'high';
  if (energy >= 3) return 'mid';
  return 'low';
}

const PET_LINES: Record<'high' | 'mid' | 'low', string[]> = {
  high: ['喵!', '呼噜呼噜~', '蹭蹭', '再摸一下嘛~', '今天状态超好喵!'],
  mid: ['喵~', '呼噜…', '蹭蹭', '有点累,但摸头还是好的'],
  low: ['轻一点喵…', '嗯…', '电量低低,摸摸还是会开心的', '(小声)呼噜…'],
};

/** 摸头气泡（按精力档抽取） */
export function petLines(energy: number): string[] {
  return PET_LINES[energyBandOf(energy)];
}

const WEATHER_LINES: Record<WeatherCondition, string[]> = {
  sunny: ['太阳好舒服,晒晒毛~', '晴天喵!适合伸个懒腰'],
  cloudy: ['阴阴的,适合慢慢走', '云朵软软的,像我的肚子'],
  rain: ['下雨了,出门记得带伞喵', '雨声催眠…但我帮你盯着桌面'],
  thunderstorm: ['打雷了!我钻你怀里躲躲…', '轰隆隆…抱紧我喵'],
};

/** 天气变化吐槽 */
export function weatherLines(condition: WeatherCondition): string[] {
  return WEATHER_LINES[condition];
}

/* ─────────────────────────── 领域事件 → 猫的反应 ─────────────────────────── */

export interface ReactionEffect {
  /** 皮肤表情名（expressions 里没有则静默跳过） */
  expr: string | null;
  /** 气泡文案（null = 不说话） */
  text: string | null;
  /** 气泡时长 ms */
  ms: number;
  /** 若在睡觉是否唤醒 */
  wake: boolean;
}

/**
 * reaction 名 → 反应效果。文案与当前心情有关（天气吐槽看天气、摸头看精力档），
 * 其余是固定人设文案。未知 reaction → 全空（静默）。
 */
export function reactionFor(reaction: string, mood: MoodInput | null): ReactionEffect {
  const none: ReactionEffect = { expr: null, text: null, ms: 1800, wake: false };
  const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)] ?? '';
  switch (reaction) {
    case 'morning':
      return { expr: null, text: '早安喵~ 右下角滑一下,告诉我今天的电量', ms: 4200, wake: true };
    case 'adjust-open':
      return { expr: null, text: '做完啦?7 秒内可以微调精力值~', ms: 3600, wake: true };
    case 'committed-up':
      return { expr: 'happy', text: '呼噜呼噜~ 电量回来了!', ms: 2600, wake: true };
    case 'committed-down':
      return { expr: null, text: '辛苦了,这一笔我帮你记着了', ms: 2600, wake: false };
    case 'committed-flat':
      return { expr: null, text: '好~ 按原样记下了', ms: 2000, wake: false };
    case 'weather': {
      if (!mood) return none;
      return { expr: null, text: pick(weatherLines(mood.weather.condition)), ms: 3200, wake: false };
    }
    case 'recommendation':
      return { expr: null, text: '我发现了一个小规律,右键我看看?', ms: 4200, wake: true };
    case 'report-due':
      return { expr: null, text: '周报出炉啦~ 右下角瞄一眼?', ms: 4200, wake: true };
    case 'low-energy':
      return { expr: null, text: '电量低于 3 分了…要不要一起休息一下?', ms: 4200, wake: true };
    case 'energized':
      return { expr: 'happy', text: '电量满格!整个人都在发光喵~', ms: 3200, wake: true };
    default:
      return none;
  }
}

/** 问候语（首次拿到心情数据时）：按精力档自我介绍 */
export function greetingLine(mood: MoodInput): string {
  const band = energyBandOf(mood.energy);
  if (band === 'high') return '喵~ 我是奶油猫!今天电量很足,一起冲!';
  if (band === 'mid') return '喵~ 我是奶油猫。拖我甩我点点我,电量我都记着';
  return '喵…我是奶油猫。电量有点低,我先陪你慢慢来';
}

/** base 情绪 → 偶尔的自言自语（低频闲时气泡用；null=不说） */
export function idleLine(base: BaseEmotion, energy: number): string | null {
  const band = energyBandOf(energy);
  if (band === 'low') {
    if (base === 'burnt') return '(趴平)…充电中,别催喵';
    if (base === 'exhausted') return '好累…要不要一起躺 3 分钟?';
    return null;
  }
  if (band === 'high' && (base === 'blissful' || base === 'radiant')) {
    return Math.random() < 0.5 ? '哼~哼哼~(尾巴打拍子)' : '状态好到想追自己尾巴!';
  }
  return null;
}
