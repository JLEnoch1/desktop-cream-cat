/**
 * PetRenderer —— 宠物渲染器（Canvas 图层合成）。
 *
 * 三层合成（与 EmotionEngine 对应）：
 *   1. body 层：base 情绪驱动的主体（体型/配色/眼睛/嘴/呼吸/弹跳/眨眼）
 *   2. weather 层：独立精灵锚定头顶（太阳/云/雨丝/闪电），不参与表情状态机
 *   3. pulse 层：低精力时的瞬时反应特效（光环/汗滴/颤抖等）
 *
 * 动画：requestAnimationFrame 驱动，60fps；所有状态变化平滑插值（lerp），
 * 表情切换不生硬。滑块预览时 setPreview() 直接驱动表情实时变化。
 */

import type { BaseEmotion, EmotionState, PulseReaction, WeatherOverlay } from '../core/types.js';
import { BASE_TIERS, tierFor } from '../emotion/engine.js';
import { pulseIntensity } from '../emotion/pulse-contract.js';

export interface PetRenderOptions {
  canvas: HTMLCanvasElement;
  dpr?: number;
}

/** 渲染用的情绪参数（插值后的连续量） */
export interface RenderParams {
  energy: number;
  hue: number;
  sat: number;
  /** 明度基线（R7：低精力靠 sat+lum 表达疲惫，色相保持暖区间） */
  lum: number;
  breath: number;   // 呼吸周期 s
  bounce: number;   // 弹跳幅度 px
  blink: number;    // 眨眼间隔 s
  eyeOpen: number;  // 0–1 眼睛开合
  mouthCurve: number; // -1 哭 … +1 大笑
  squish: number;   // 疲惫时的身体压扁程度
  tremble: number;  // 颤抖强度
}
/**
 * base 情绪 → 嘴型曲线 / 眼睛开合 / 压扁 / 颤抖。
 * 🔴 导出仅供测试引用基线值（断言"偏移恰好施加"需要拿到 base 侧的数字）；
 * 渲染层内部一律走 buildRenderParams()，不要直接读这张表做决策。
 */
export const EMOTION_PARAMS: Record<BaseEmotion, { mouthCurve: number; eyeOpen: number; squish: number; tremble: number }> = {
  blissful:  { mouthCurve: 1.0,  eyeOpen: 1.0, squish: 0,    tremble: 0 },
  radiant:   { mouthCurve: 0.9,  eyeOpen: 1.0, squish: 0,    tremble: 0 },
  cheerful:  { mouthCurve: 0.75, eyeOpen: 1.0, squish: 0,    tremble: 0 },
  content:   { mouthCurve: 0.55, eyeOpen: 0.95, squish: 0,   tremble: 0 },
  calm:      { mouthCurve: 0.35, eyeOpen: 0.9, squish: 0,    tremble: 0 },
  steady:    { mouthCurve: 0.15, eyeOpen: 0.85, squish: 0,   tremble: 0 },
  weary:     { mouthCurve: -0.1, eyeOpen: 0.6, squish: 0.06, tremble: 0 },
  drained:   { mouthCurve: -0.35, eyeOpen: 0.45, squish: 0.12, tremble: 0.15 },
  exhausted: { mouthCurve: -0.6, eyeOpen: 0.3, squish: 0.2,  tremble: 0.35 },
  burnt:     { mouthCurve: -0.85, eyeOpen: 0.15, squish: 0.3, tremble: 0.6 },
};

/**
 * pulse 反应对渲染参数的**偏移量**（不是目标值）。
 *
 * 🔴 语义变更（DESIGN.md §4.3 矛盾 C 裁决 + Q1）：
 * 旧实现（已除名的覆盖表）用空值合并**覆盖** base 的对应通道
 * （`eyeOpen: pp.eyeOpen ?? ep.eyeOpen`）—— pulse 一到，base 的表情被整值替换。
 * 后果：一只 blissful（eyeOpen 1.0）的猫碰到愧疚脉冲（旧值 eyeOpen 0.7）
 * 会瞬间掉 0.3；一只 burnt（eyeOpen 0.15）碰到麻木脉冲（旧值 0.1）几乎没反应
 * —— 覆盖语义让 pulse 的视觉强度只取决于偏移表，与 base 档位完全无关，
 * 「越累反应越该被完整看见」这个语义被抹掉了。
 * 新语义：`final = clamp(base + offset × intensity(energy), …)`。
 *
 * ⚠️ 因此数值必须整体重设计为**小量级偏移**：旧表里 `guilty.eyeOpen:0.7`、
 * `numb.eyeOpen:0.1`、`determined.eyeOpen:1.0` 是「绝对目标值」，直接当偏移会爆表
 * （0.7 的偏移足以把任何一档的眼睛推到钳制边界）。
 * 量级约定（每通道独立钳制，见 buildRenderParams）：
 *   eyeOpen    ±0.10 ~ 0.25（眼皮是微调通道，>0.3 就读成"换了一只猫"）
 *   mouthCurve ±0.20 ~ 0.50（嘴角是主表意通道，允许较大摆动）
 *   tremble    +0.15 ~ 0.45（只加不减：base 的颤抖是"累"，pulse 的颤抖是"情绪"）
 */
export const PULSE_OFFSETS: Record<PulseReaction, Partial<{ mouthCurve: number; tremble: number; eyeOpen: number }>> = {
  /** 无反应：全零偏移（保持映射穷尽，tsc 会拦住漏登记的新反应） */
  none: {},
  anxious: {
    // 焦虑的核心可读信号是"抖"，取颤抖上限 0.45：base drained/exhausted 已有
    // 0.15/0.35，叠加后被 tremble≤0.9 的钳制接住，不会变成视觉抽搐。
    tremble: 0.45,
    // 嘴角下压 0.25（中等幅度）：焦虑 ≠ 悲伤，下压过头会与 exhausted 的 base
    // 嘴型（-0.6）叠成"哭"，而 R7/R11 都要求负面情绪不走向"痛苦脸"。
    mouthCurve: -0.25,
  },
  guilty: {
    // 愧疚 = 嘴角收住 + 眼神低垂。eyeOpen 只偏 -0.15：愧疚时人是"不敢看"，
    // 不是"看不见"，眼皮大幅下压会与疲惫（通道 2）语义撞车。
    mouthCurve: -0.3,
    eyeOpen: -0.15,
  },
  numb: {
    // 麻木 = "没有表情"，所以两个通道都取各自量级的**下限**：
    // 嘴角只拉平 -0.2（再大就读成悲伤），眼皮 -0.2（放空半闭，base burnt 0.15
    // 叠加后落到钳制下界 0，读作"眼睛没聚焦"而非"睡着了"）。
    mouthCurve: -0.2,
    eyeOpen: -0.2,
  },
  restless: {
    // 坐立不安 = 最躁的抖。tremble 取上限 0.45，与 anxious 同幅（两者在 base 上
    // 的区分由档位承担：restless 出现在中高精力档，anxious 出现在低档）。
    tremble: 0.45,
    // 嘴角轻微下压 0.2（量级下限）：躁动不是不悦，主要信息在抖，不在嘴。
    mouthCurve: -0.2,
  },
  grateful: {
    // 感激 = 明显的嘴角上扬 +0.3（正向脉冲要给足，否则"谢谢"读不出来），
    // 眼睛同步亮一档 +0.1（最小量级：base 高档 eyeOpen 已是 1.0，会被钳制接住，
    // 只在 base 较低时生效 —— 这正是偏移语义的好处：越累越看不出"眼睛变亮"）。
    mouthCurve: 0.3,
    eyeOpen: 0.1,
  },
  determined: {
    // 坚定 = 抿嘴 +0.2（量级下限：坚定是"收着劲"，不是"笑开"，给到 grateful
    // 的 0.3 会让两种正向脉冲长得一样）+ 睁眼 +0.15（专注时眼睛会睁大一点）。
    mouthCurve: 0.2,
    eyeOpen: 0.15,
  },
};

/**
 * 读取偏移量：缺失键（Partial 未登记的通道）视为 0 偏移。
 * 单独提出来的唯一理由是让 buildRenderParams 的函数体内**不出现空值合并运算符** ——
 * 覆盖语义已被裁决废除，函数体里连"看起来像覆盖"的写法都不留，
 * 便于用 grep 做机械验收。
 */
function off(v: number | undefined): number {
  return v === undefined ? 0 : v;
}

/**
 * 渲染参数构建（导出的模块级**纯函数**，供 node 环境单测；不依赖 canvas/DOM）。
 *
 * 公式（DESIGN.md §4.3 矛盾 C 裁决）：
 *   final = clamp(base + pulseOffset × intensity, 通道各自的硬边界)
 *
 * intensity 一律走契约层的 `pulseIntensity()` —— 那是全项目关于"脉冲多强、
 * 谁被豁免"的唯一真源（高精力压缩、低精力全幅、empathy 恒 1.0）。
 * 🔴 禁止在这里复制分段边界（同 resolveWeatherOverlay 之于天气门槛的做法）。
 *
 * 钳制边界（三条都有视觉理由，不是随手取的数）：
 *   eyeOpen    [0, 1]   —— 眼皮开合的物理量程
 *   mouthCurve [-1, 1]  —— 嘴角曲线的定义域（-1 哭 / +1 大笑）
 *   tremble    [0, 0.9] —— 🔴 上限 0.9：burnt 档 base 已 0.6，叠加 anxious/restless
 *                          的 +0.45 会到 1.05；抖动幅度按 tremble×4px 换算，>0.9
 *                          就开始"像素级抽搐"，读作渲染故障而不是情绪。
 *
 * `pulseActive=false` 时 k=0，三个通道原样返回 base —— 与"没有 pulse"等价，
 * 不再有旧实现里"pulse 一到就整值替换 base"的断层。
 */
export function buildRenderParams(
  energy: number,
  base: BaseEmotion,
  pulse: PulseReaction,
  pulseActive: boolean,
): RenderParams {
  const tier = BASE_TIERS.find(t => t.emotion === base);
  const t = tier === undefined ? tierFor(energy) : tier;
  const ep = EMOTION_PARAMS[base];
  const po = PULSE_OFFSETS[pulse];
  const k = pulseActive ? pulseIntensity(pulse, energy) : 0;
  return {
    energy,
    hue: t.hue,
    sat: t.sat,
    lum: t.lum,
    breath: t.breath,
    bounce: t.bounce,
    blink: t.blink,
    eyeOpen: clamp(ep.eyeOpen + off(po.eyeOpen) * k, 0, 1),
    mouthCurve: clamp(ep.mouthCurve + off(po.mouthCurve) * k, -1, 1),
    squish: ep.squish,
    tremble: clamp(ep.tremble + off(po.tremble) * k, 0, 0.9),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ─────────────────── 姿态解算（M1：尾巴 & 耳朵情绪通道） ───────────────────
 *
 * 设计原则（DESIGN.md §3 / M1）：
 *   这两条通道都只读 RenderParams 里已有的连续量（energy / mouthCurve /
 *   tremble / eyeOpen），**不引入新状态、不引入随机数**。
 *   随机动画不提供信息，只提供噪声——尾巴和耳朵必须「读得出」情绪：
 *     · 尾巴：lift（抬升角）∝ 精力+愉悦，amp/speed（摆幅/摆速）∝ 愉悦+颤抖
 *     · 耳朵：pose ∈ [-1, 1]，正 = 前倾警觉/开心，负 = 飞机耳/耷拉（累、怕）
 *   做成导出的纯函数，便于在 node 环境单测（不依赖 canvas/DOM）。
 */

/** 尾巴姿态（连续量，供 drawTail 使用） */
export interface TailPose {
  /** 抬升：-0.6 = 垂到地面（burnt），1.1 = 高高竖起（blissful） */
  lift: number;
  /** 摆动幅度（弧度） */
  amp: number;
  /** 摆动角速度（rad/s） */
  speed: number;
  /** 长度系数（×bodyR） */
  len: number;
}

/**
 * 尾巴姿态解算。输入 = 插值后的连续情绪量（RenderParams 子集）。
 *
 * 语义映射：
 *   精力高 → 尾巴竖起、摆得欢快；精力低 → 尾巴垂落、几乎不动。
 *   愉悦（mouthCurve>0，含抚摸呼噜加成）→ 抬升与摆幅再叠一层。
 *   颤抖（焦虑/疲惫 pulse）→ 小幅高频颤动（speed↑、amp↑），与开心的
 *   大摆区分：开心是「摇」，害怕是「抖」。
 */
export function resolveTailPose(p: { energy: number; mouthCurve: number; tremble: number }): TailPose {
  const e = clamp(p.energy, 0, 10) / 10;
  const joy = clamp(p.mouthCurve, -1, 1);
  const lift = clamp(-0.45 + e * 1.45 + Math.max(0, joy) * 0.28 - p.tremble * 0.22, -0.6, 1.1);
  const amp = clamp(0.12 + Math.max(0, joy) * 0.42 + p.tremble * 0.3 + e * 0.1, 0.08, 0.9);
  const speed = clamp(1.1 + e * 2.2 + p.tremble * 5.5 + Math.max(0, joy) * 0.8, 0.6, 9);
  return { lift, amp, speed, len: 1.28 + e * 0.22 };
}

/**
 * 耳朵姿态解算。返回 [-1, 1]：
 *   +1 = 前倾（警觉/开心，耳朵朝前竖）
 *    0 = 自然位
 *   -1 = 飞机耳/后压耷拉（疲惫、害怕、低落）
 *
 * 输入：mouthCurve（愉悦→前倾；不悦→后压）、tremble（恐惧→强力后压）、
 * eyeOpen（眼皮耷拉→耳朵也跟着耷拉，同向强化「累」的读取一致性）。
 *
 * ⚠️ 愉悦眯眼 ≠ 疲惫耷眼：被抚摸时 loop() 会把 eyeOpen 压低（舒服到眯起来），
 * 若无条件按「眼皮低 = 累」处理，一只 mouthCurve≈1 的开心猫会被压成飞机耳，
 * 与「前倾」语义直接打架。故 droop 项按 (1 - joy) 门控：愉悦越高，眼皮低
 * 越读作「享受的眯眼」而非「疲惫」，不触发飞机耳。
 */
export function resolveEarPose(p: { mouthCurve: number; tremble: number; eyeOpen: number }): number {
  const joy = clamp(p.mouthCurve, -1, 1);
  const droop = clamp(0.6 - p.eyeOpen, 0, 0.6) / 0.6; // 0 = 眼睁大，1 = 眼皮耷拉到 0
  const droopPull = droop * (1 - Math.max(0, joy));    // 愉悦眯眼不拉耳朵
  return clamp(Math.max(0, joy) * 0.7 + Math.min(0, joy) * 0.45 - p.tremble * 1.5 - droopPull * 0.75, -1, 1);
}

/* ── 触碰交互常量（纯渲染层，不落库） ── */
/**
 * 连点 = 抚摸（DESIGN.md §5.3 v1.1）。
 *
 * 历史教训：旧实现「1.2s 内 ≥4 连点 → 甩墙受伤」把 ADHD 用户思考时的
 * 无意识连点判成虐待并施加惩罚；设计稿的替代方案「10s/5次」换算后
 * 0.5 次/秒，误伤率更高。两个阈值都已废除——连点只有正向反馈一条路。
 */
const PETTING_WINDOW_MS = 2500;
const PETTING_CLICKS = 3;
/** 抚摸后的呼噜加成时长（嘴型上扬的衰减窗口） */
const PETTING_BOOST_MS = 2000;

/* ── 跌倒彩蛋（R11 修订版）节拍与手势常量 ──
 *
 * 时序（R11：全程 ≤90s 自动复位，纯喜剧叙事）：
 *   fly（飞向墙）→ lie（平铺 + 额头绷带冒小爱心）→ groom（甩头舔毛复原）
 *   → nuzzle（主动回蹭光标 = 「和好」节拍）→ return（弹性复位回位）
 * 总和 350 + 15000 + 7000 + 5000 + 500 = 27_850ms ≤ 90_000ms。
 * 各节拍时长理由见各自注释。
 */
/** 飞向侧墙（沿用原值：350ms 的 easeOut 抛物线刚好读完「飞出去」又不拖） */
const PRATFALL_FLY_MS = 350;
/**
 * 平铺 + 绷带冒小爱心。15s：这是喜剧的「定格」段——
 * 短了爱心只闪一下就没了（读不出「冒」），长了像惩罚（R11 禁止）。
 * 15s 足够用户注意到并会心一笑，又明显短于任何「惩罚时长」的心理预期。
 */
const PRATFALL_LIE_MS = 15_000;
/**
 * 甩头舔毛复原。7s：猫舔毛是「我自己缓过来了」的自我安抚节拍，
 * 必须比 lie 短（复原是从属节拍，定格才是主角），但要比 nuzzle 长
 * （舔毛是一套连续动作：甩头→舔前爪→抹脸，7s 才演得完）。
 */
const PRATFALL_GROOM_MS = 7_000;
/**
 * 回蹭光标（和好节拍）。5s：一次完整的「凑过去蹭两下再退回」；
 * 取 5s 是两下蹭动（各约 1.6s）加回位余量，再多就变成骚扰光标。
 */
const PRATFALL_NUZZLE_MS = 5_000;
/** 弹性复位回位（沿用原值：500ms easeInOut，复位必须快，不留痕） */
const PRATFALL_RETURN_MS = 500;
// 导出五个节拍供 tests/pratfall.test.ts 断言「总和 ≤90s」，防止后续有人
// 悄悄加长某个节拍而突破 R11（测试不硬编码数字，直接引用这些常量）。
export { PRATFALL_FLY_MS, PRATFALL_LIE_MS, PRATFALL_GROOM_MS, PRATFALL_NUZZLE_MS, PRATFALL_RETURN_MS };
/** 🔴 R11 修订版硬上限：全程（fly→lie→groom→nuzzle→return）≤90s。导出供测试断言防回退 */
export const PRATFALL_TOTAL_MAX_MS = 90_000;
/** 🔴 R11 修订版：10 分钟冷却，防彩蛋被反复触发磨成噪音。导出供测试断言 */
export const PRATFALL_COOLDOWN_MS = 600_000;

/**
 * 「拖拽超距」的距离阈值（路径总长，非首尾直线距离）。
 *
 * 取 240px 的理由：窗口宽 400px，宠物本体约 110–150px 宽，
 * 一次**正常**的窗口内挪位拖拽通常 <200px 路径（从一侧挪到另一侧）；
 * 而强意图手势要求「来回甩」，单程就要超过本体宽度才读得出发力感。
 * 240px ≈ 本体直径 ×2，既把普通挪位拖拽挡在门外（实测单向拖拽
 * 中位数路径约 120–180px），又不会高到「故意想触发也触发不了」。
 * 🔴 用**路径总长**而非首尾距离：来回甩动会让首尾距离接近 0，
 * 只有累计路径能表达「真的甩了很多下」。
 */
const PRATFALL_DRAG_MIN_PX = 240;
/** 导出：测试用它构造「超距/未超距」样本，避免测试里另造一套数 */
export { PRATFALL_DRAG_MIN_PX };
/** 裁决原文：方向反转必须发生在 3s 内（窗口外的慢速晃动不算强意图）。导出供测试断言 */
export const PRATFALL_REVERSAL_WINDOW_MS = 3000;
/** 裁决原文：方向反转 ≥3 次。导出供测试断言 */
export const PRATFALL_REVERSAL_MIN = 3;

/** 手势采样点（dragMoveBy 累积，dragEnd 判定后清空） */
export interface PratfallGestureSample {
  x: number;
  y: number;
  t: number;
}

/** 跌倒彩蛋的五段喜剧相位（R11 修订版时序） */
export type PratfallPhase = 'fly' | 'lie' | 'groom' | 'nuzzle' | 'return';

/**
 * 强意图手势判定：拖拽超距 + 3s 内方向反转 ≥3 次。纯函数，无副作用。
 *
 * 🔴 R10 守护（本函数存在的全部理由）：
 * 「连点/拖动 → 惩罚」映射被 v1.1 永久废除。跌倒彩蛋要存续，触发源必须
 * 是**物理上不可能被误做出来**的手势：单击（无拖拽路径）不命中、
 * 连点（poke 路径根本不采样）不命中、普通单向拖拽（无方向反转）不命中。
 * 「超距 + 快速反复反转」同时成立 ≈ 用户抓着猫快速来回甩——
 * 这是裁决认定的唯一可接受触发源（拟物玩笑，不是日常操作的副产品）。
 *
 * 方向反转的定义：相邻两次位移的 x 分量符号翻转（|dx| ≥ 2px 才计入，
 * 滤掉手抖/采样噪声；只取 x 轴是因为「来回甩」的主轴是水平方向，
 * 垂直抖动多来自拖拽窗口时的自然抬手）。
 *
 * @param samples 时间升序的采样序列（dragMoveBy 按调用顺序 push）
 */
export function isPratfallGesture(samples: readonly PratfallGestureSample[]): boolean {
  if (samples.length < 2) return false;
  // ① 超距：累计路径长度
  let pathLen = 0;
  for (let i = 1; i < samples.length; i++) {
    pathLen += Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y);
  }
  if (pathLen < PRATFALL_DRAG_MIN_PX) return false;
  // ② 方向反转序列（只认水平主轴上符号翻转，滤掉 <2px 的抖动）
  const turns: number[] = []; // 发生反转的时刻
  let lastDx = 0;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i]!.x - samples[i - 1]!.x;
    if (Math.abs(dx) < 2) continue;               // 噪声/垂直移动：不改变当前方向
    const sign = dx > 0 ? 1 : -1;
    if (lastDx !== 0 && sign !== lastDx) turns.push(samples[i]!.t);
    lastDx = sign;
  }
  if (turns.length < PRATFALL_REVERSAL_MIN) return false;
  // ③ 反转必须密集：存在一个 3s 滑动窗口容纳 ≥3 次反转
  for (let i = 0; i + PRATFALL_REVERSAL_MIN - 1 < turns.length; i++) {
    if (turns[i + PRATFALL_REVERSAL_MIN - 1]! - turns[i]! <= PRATFALL_REVERSAL_WINDOW_MS) return true;
  }
  return false;
}

function easeOut(x: number): number { const q = 1 - x; return 1 - q * q * q; }
function easeInOut(x: number): number { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

export class PetRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dpr: number;
  private raf = 0;
  private startTime = performance.now();
  private lastBlink = performance.now();
  private blinking = false;
  private blinkProgress = 0;

  /** 目标参数（由情绪状态决定） */
  private target: RenderParams;
  /** 当前参数（向 target 平滑插值） */
  private current: RenderParams;

  /** 天气 overlay */
  private overlay: WeatherOverlay = 'none';
  /** pulse 反应 */
  private pulse: PulseReaction = 'none';
  private pulseActive = false;

  /** 交互反馈：单击压平（squash 脉冲） */
  private pokeTime = 0;

  /** 拖拽黏性形变：速度向量驱动拉伸/挤压，松手后衰减回弹 */
  private dragVel = { x: 0, y: 0 };
  private dragStretch = { x: 0, y: 0 };
  private draggingNow = false;
  private lastDragMove = 0;

  /** 连点计数（窗口 PETTING_WINDOW_MS 内的点击时间戳） */
  private clickTimes: number[] = [];
  /** 尾梢画布坐标（每帧 render 更新；petBounds 用它把尾巴纳入命中区） */
  private tailTip = { x: 0, y: 0 };
  /** 抚摸呼噜加成的到期时刻（performance.now 基准）；0 = 无加成 */
  private pettingUntil = 0;
  /**
   * 甩墙相位机（仅由强意图手势 / 显式 pratfall() 触发；连点永不触发）。
   * 五段喜剧时序（R11 修订版）：fly → lie → groom → nuzzle → return。
   * 🔴 纯本地状态：不落库、不改精力、不进周报 —— 这是 R11 的技术保障。
   */
  private pratfallState: { phase: 'fly' | 'lie' | 'groom' | 'nuzzle' | 'return'; start: number; dir: 1 | -1 } | null = null;
  /** 强意图手势采样（dragMoveBy 累积；dragEnd 判定后清空；🔴 poke() 永不写入） */
  private pratfallSamples: PratfallGestureSample[] = [];
  /**
   * 回蹭目标（和好节拍的朝向）。
   * 🔴 降级实现：pet.ts 拿不到**静止时**的光标位置（无 mousemove 订阅，
   * app.ts 不在白名单），故用「最近一次交互点」= 拖拽手势的终点方向降级。
   * 交付说明已标注待确认。
   */
  private nuzzleDir: { x: number; y: number } | null = null;
  /** 上次跌倒触发时刻（performance.now 基准）；-Infinity = 从未触发 */
  private lastPratfallAt = -Infinity;

  /** 粒子（开心时的星星 / 恢复时的光点） */
  private particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; hue: number; size: number }[] = [];

  constructor(opts: PetRenderOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('PetRenderer: 2d context unavailable');
    this.ctx = ctx;
    this.dpr = opts.dpr ?? Math.min(window.devicePixelRatio || 1, 2);
    this.target = this.buildParams(10, 'steady', 'none', false);
    this.current = { ...this.target };
    this.resize();
    this.loop();
  }

  /* ─────────────────────────── 对外 API ─────────────────────────── */

  /** 应用情绪状态（主路径：AppState 推送） */
  applyEmotion(state: EmotionState): void {
    this.target = this.buildParams(state.energy, state.base, state.pulse, state.pulseActive);
    this.overlay = state.overlay;
    this.pulse = state.pulse;
    this.pulseActive = state.pulseActive;
  }

  /** 滑块预览：直接按投影精力驱动表情（实时变化） */
  setPreview(energy: number): void {
    const tier = tierFor(energy);
    // 门槛已废除(Q1)，预览态全档激活
    const pulseActive = true;
    this.target = this.buildParams(energy, tier.emotion, pulseActive ? this.pulse : 'none', pulseActive);
  }

  clearPreview(state: EmotionState): void {
    this.applyEmotion(state);
  }

  applyOverlay(overlay: WeatherOverlay): void {
    this.overlay = overlay;
  }

  /**
   * 触碰（单击）：压平反馈 + 少量粒子 + 连点计数。
   * 不再产生任何文字气泡——触碰只触发表情/形变变化。
   *
   * 连点语义 = **抚摸**（正向反馈），永不触发跌倒。
   * PETTING_WINDOW_MS 内点满 PETTING_CLICKS 次 → 呼噜加成：
   * 嘴型上扬 + 轻柔震颤 + 暖色粒子，PETTING_BOOST_MS 内衰减。
   *
   * 跌倒态只能由 pratfall() 显式触发（触发源 = 强意图手势，见后续提交；
   * 连点/普通拖拽/领域事件均**永不**触发 —— R10 / R11 修订版）。
   */
  poke(): void {
    const now = performance.now();
    this.pokeTime = now;
    this.spawnParticles(4, this.current.hue);
    this.clickTimes.push(now);
    // 只保留窗口内的点击
    this.clickTimes = this.clickTimes.filter(ts => now - ts <= PETTING_WINDOW_MS);
    if (this.clickTimes.length >= PETTING_CLICKS) {
      this.clickTimes = [];
      this.pettingUntil = now + PETTING_BOOST_MS;
      this.spawnParticles(10, 38); // 暖金色呼噜粒子
    }
  }

  /**
   * 显式触发甩墙跌倒（五段喜剧时序：fly → lie → groom → nuzzle → return）。
   *
   * 🔴 与 poke() 彻底解耦：连点不调用本方法，单击不调用本方法。
   * R11 修订版：跌倒态是纯喜剧彩蛋，**永不**由领域事件、单击或连点触发；
   * 唯一用户侧入口 = dragEnd() 里的强意图手势判定（isPratfallGesture）。
   * 不落库、不改精力 —— 本状态机纯本地，是 R11 的技术保障，不得改变。
   */
  pratfall(): void {
    if (this.pratfallState) return; // 跌倒期间不重复触发
    const now = performance.now();
    if (now - this.lastPratfallAt < PRATFALL_COOLDOWN_MS) return; // 10min 冷却（R11）
    this.lastPratfallAt = now;
    this.pettingUntil = 0;    // 打断呼噜加成
    this.clickTimes = [];
    this.pratfallState = { phase: 'fly', start: now, dir: Math.random() < 0.5 ? -1 : 1 };
  }

  /** 拖拽开始：进入黏性形变模式 */
  dragStart(): void {
    this.draggingNow = true;
    this.dragVel = { x: 0, y: 0 };
    this.lastDragMove = performance.now();
    // 强意图手势采样起点（相对路径坐标）。🔴 仅 drag 路径采样 —— poke() 永不写入（R10）
    this.pratfallSamples = [{ x: 0, y: 0, t: performance.now() }];
  }

  /** 拖拽移动：记录速度向量（px/ms），驱动拉伸方向 */
  dragMoveBy(dx: number, dy: number): void {
    if (!this.draggingNow) return;
    const now = performance.now();
    const dt = Math.max(8, now - this.lastDragMove);
    this.lastDragMove = now;
    // 累积手势采样（限长防爆：600 点 ≈ 10s @60Hz，远超判定所需）
    const last = this.pratfallSamples[this.pratfallSamples.length - 1];
    const base = last ?? { x: 0, y: 0, t: now };
    this.pratfallSamples.push({ x: base.x + dx, y: base.y + dy, t: now });
    if (this.pratfallSamples.length > 600) this.pratfallSamples.shift();
    // 瞬时速度，限幅防爆冲
    const vx = Math.max(-3, Math.min(3, dx / dt));
    const vy = Math.max(-3, Math.min(3, dy / dt));
    this.dragVel = { x: this.dragVel.x * 0.6 + vx * 0.4, y: this.dragVel.y * 0.6 + vy * 0.4 };
  }

  /** 拖拽结束：速度衰减，身体弹性回弹；并做跌倒手势判定 */
  dragEnd(): void {
    this.draggingNow = false;
    this.dragVel = { x: 0, y: 0 };
    // 强意图手势是 pratfall 的**唯一**用户侧触发路径（R11 修订版）。
    // 🔴 R10：poke()/连点物理上不采样，故连点永远走不到这里。
    if (isPratfallGesture(this.pratfallSamples)) {
      // 回蹭目标 = 最近一次交互点（降级实现：拿不到静止光标位置，见 nuzzleDir 注释）
      const last = this.pratfallSamples[this.pratfallSamples.length - 1];
      this.nuzzleDir = last ? { x: last.x, y: last.y } : null;
      this.pratfall();
    }
    this.pratfallSamples = [];
  }

  /** 庆祝（恢复超预期 / 任务完成） */
  celebrate(): void {
    this.spawnParticles(18, 48);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  /**
   * 当前宠物主体的实际可视包围盒（canvas CSS 坐标）。
   *
   * 为什么需要它：canvas 元素占满 pet-wrap（240×230），但宠物本体只画在
   * 底部中央一小块。命中区若直接上报整个 canvas，会出现「画布比可点击
   * 范围大」的错位观感（空白处挡住桌面却点不到东西 / 或反过来）。
   * 上报实际主体范围（含头顶天气精灵与影子），让热区与视觉一致。
   */
  petBounds(): { x: number; y: number; w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const p = this.current;
    const cx = W / 2;
    const baseY = H - 34;
    const bodyR = Math.min(52 + p.energy * 0.6, H * 0.32);
    // 跌倒甩墙态：镜像 render() 的五段几何 —— 只有 fly/lie 段本体真的贴在侧墙，
    // groom 段按坐起进度 q 从墙回中央，nuzzle/return 段已在中央（只多一个回蹭偏移）。
    // 🔴 热区必须跟视觉一致：groom 之后若还把热区挂在侧墙，用户点中央的猫会穿透。
    if (this.pratfallState) {
      const st = this.pratfallState;
      const age = performance.now() - st.start;
      let q = 1; // 0 = 在中央，1 = 完全贴墙
      if (st.phase === 'fly') q = easeOut(Math.min(1, age / PRATFALL_FLY_MS));
      else if (st.phase === 'lie') q = 1;
      else if (st.phase === 'groom') q = 1 - easeInOut(Math.min(1, age / (PRATFALL_GROOM_MS * 0.4)));
      else q = 0; // nuzzle / return：已在中央
      if (q > 0.02) {
        const hw = bodyR * 0.85;
        const hh = bodyR * 1.6;
        const flyX = st.dir * Math.max(0, W - hw - 4 - cx);
        const lift = Math.max(0, baseY - (H - 4 - hh));
        const bx = cx + flyX * q;
        const by = baseY - lift * q;
        const left = bx - hw * 1.5 - 6;
        const right = bx + hw * 1.5 + 6;
        const top = by - hh;
        const bottom = by + hh;
        return {
          x: Math.max(0, Math.round(left)),
          y: Math.max(0, Math.round(top)),
          w: Math.round(Math.min(W, right) - Math.max(0, left)),
          h: Math.round(Math.min(H, bottom) - Math.max(0, top)),
        };
      }
      // 中央态 + 回蹭偏移余量：四边多留 bodyR*0.4，蹭动时热区不脱手
      const pad = bodyR * 0.4;
      const left = cx - bodyR * 1.05 - pad;
      const right = cx + bodyR * 1.05 + pad;
      const top = baseY - bodyR * 1.8 - pad;
      const bottom = baseY + 22 + pad;
      return {
        x: Math.max(0, Math.round(left)),
        y: Math.max(0, Math.round(top)),
        w: Math.round(Math.min(W, right) - Math.max(0, left)),
        h: Math.round(Math.min(H, bottom) - Math.max(0, top)),
      };
    }
    // 主体：宽 ±bodyR*1.05；高从影子上缘到身体顶部
    // 尾巴（M1）：尾梢可能探出主体右侧/垂到影子线以下，纳入包围盒，
    // 保证「看得见的尾巴点得到」（热区与视觉一致，R 系热区不变式）
    const tailPad = bodyR * 0.3;
    const left = Math.min(cx - bodyR * 1.05 - 6, this.tailTip.x - tailPad);
    // 天气精灵锚定头顶右侧（x+44，半径 ~20，闪电下探 +30）
    const right = Math.max(Math.max(cx + bodyR * 1.05, cx + 44 + 22) + 6, this.tailTip.x + tailPad + 6);
    const top = this.overlay === 'none'
      ? baseY - bodyR * 1.8 - 8 // 耳尖（M1 三角耳露出到 -1.78R）
      : baseY - bodyR * 1.75 - 46;
    const bottom = Math.max(baseY + 22, this.tailTip.y + tailPad); // 影子 / 垂尾梢
    return {
      x: Math.max(0, Math.round(left)),
      y: Math.max(0, Math.round(top)),
      w: Math.round(Math.min(W, right) - Math.max(0, left)),
      h: Math.round(Math.min(H, bottom) - Math.max(0, top)),
    };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  /* ─────────────────────────── 参数构建 ─────────────────────────── */

  /**
   * 类内包装：构建逻辑已抽为模块级纯函数 buildRenderParams()（可单测）。
   * 这里只做转发，不再有任何数值决策。
   */
  private buildParams(energy: number, base: BaseEmotion, pulse: PulseReaction, pulseActive: boolean): RenderParams {
    return buildRenderParams(energy, base, pulse, pulseActive);
  }

  /* ─────────────────────────── 主循环 ─────────────────────────── */

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const t = (now - this.startTime) / 1000;
    const dt = 1 / 60;

    // 抚摸呼噜加成：线性衰减到 0（pettingUntil 由 poke() 连点触发设置）
    const petting = this.pettingUntil > now
      ? (this.pettingUntil - now) / PETTING_BOOST_MS
      : 0;

    // 平滑插值（指数趋近，帧率无关近似）
    const k = 1 - Math.exp(-dt * 6);
    this.current.energy = lerp(this.current.energy, this.target.energy, k);
    this.current.hue = lerp(this.current.hue, this.target.hue, k);
    this.current.sat = lerp(this.current.sat, this.target.sat, k);
    this.current.lum = lerp(this.current.lum, this.target.lum, k);
    this.current.breath = lerp(this.current.breath, this.target.breath, k);
    this.current.bounce = lerp(this.current.bounce, this.target.bounce, k);
    // 呼噜时眼睛舒服地眯起来（不低于 0.25，保持「醒着且享受」而非「睡着」）
    this.current.eyeOpen = lerp(
      this.current.eyeOpen,
      Math.max(0.25, this.target.eyeOpen - petting * 0.35),
      k,
    );
    // 呼噜 = 嘴型上扬 + 轻微眯眼（舒服到眯起来），随加成衰减
    this.current.mouthCurve = lerp(
      this.current.mouthCurve,
      Math.min(1, this.target.mouthCurve + petting * 0.6),
      k,
    );
    this.current.squish = lerp(this.current.squish, this.target.squish, k);
    // 呼噜震颤：低幅高频（purr），与焦虑 tremble 的高幅区分开——
    // 取两者的较大值，避免「累+被抚摸」时把焦虑颤抖洗掉
    this.current.tremble = lerp(
      this.current.tremble,
      Math.max(this.target.tremble, petting * 0.12),
      k,
    );

    // 拖拽黏性形变：速度向量 → 拉伸目标；拖拽中快速跟随，松手后慢速衰减（鼻涕回弹感）
    const sK = 1 - Math.exp(-dt * (this.draggingNow ? 18 : 7));
    const tSX = this.draggingNow ? Math.max(-0.35, Math.min(0.35, this.dragVel.x * 0.16)) : 0;
    const tSY = this.draggingNow ? Math.max(-0.35, Math.min(0.35, this.dragVel.y * 0.16)) : 0;
    this.dragStretch.x = lerp(this.dragStretch.x, tSX, sK);
    this.dragStretch.y = lerp(this.dragStretch.y, tSY, sK);

    // 甩墙跌倒相位机（五段喜剧时序）：
    //   fly（飞向墙）→ lie（平铺 + 额头绷带冒小爱心）→ groom（甩头舔毛复原）
    //   → nuzzle（回蹭光标 = 和好节拍）→ return（弹性复位回位）
    if (this.pratfallState) {
      const age = now - this.pratfallState.start;
      if (this.pratfallState.phase === 'fly' && age >= PRATFALL_FLY_MS) {
        this.pratfallState = { ...this.pratfallState, phase: 'lie', start: now };
      } else if (this.pratfallState.phase === 'lie' && age >= PRATFALL_LIE_MS) {
        this.pratfallState = { ...this.pratfallState, phase: 'groom', start: now };
      } else if (this.pratfallState.phase === 'groom' && age >= PRATFALL_GROOM_MS) {
        this.pratfallState = { ...this.pratfallState, phase: 'nuzzle', start: now };
      } else if (this.pratfallState.phase === 'nuzzle' && age >= PRATFALL_NUZZLE_MS) {
        this.pratfallState = { ...this.pratfallState, phase: 'return', start: now };
      } else if (this.pratfallState.phase === 'return' && age >= PRATFALL_RETURN_MS) {
        this.pratfallState = null; // 自愈完成，不留痕（R11）
        this.nuzzleDir = null;
      }
    }

    // 眨眼调度
    if (!this.blinking && now - this.lastBlink > this.current.blink * 1000 * (0.7 + Math.random() * 0.6)) {
      this.blinking = true;
      this.blinkProgress = 0;
      this.lastBlink = now;
    }
    if (this.blinking) {
      this.blinkProgress += dt * 7;
      if (this.blinkProgress >= 1) this.blinking = false;
    }

    this.render(t, now);
  };

  private render(t: number, now: number): void {
    const { ctx, canvas, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    const p = this.current;
    // 布局：宠物坐在画布底部中央
    const cx = W / 2;
    const baseY = H - 34;
    const breathPhase = Math.sin((t / Math.max(0.4, p.breath)) * Math.PI * 2);
    const bounceY = -Math.abs(Math.sin((t / Math.max(0.5, p.breath * 0.66)) * Math.PI)) * p.bounce;

    // 单击压平：squishY 瞬时压到 ~0.55，0.45s 弹性回弹
    const pokeAge = (now - this.pokeTime) / 1000;
    const poke = pokeAge < 0.45
      ? Math.sin(Math.min(1, pokeAge / 0.45) * Math.PI) * (1 - pokeAge * 0.35)
      : 0;

    // 颤抖
    const trembleX = p.tremble > 0 ? (Math.random() - 0.5) * p.tremble * 4 : 0;
    const trembleY = p.tremble > 0 ? (Math.random() - 0.5) * p.tremble * 3 : 0;

    // 体型随画布高度自适应（小窗口不裁切天气 overlay）
    const bodyR = Math.min(52 + p.energy * 0.6, H * 0.32);

    // ── 甩墙跌倒几何（五段喜剧时序，各段位移/旋转/压扁）──
    let injDx = 0;
    let injDy = 0;
    let injRot = 0;
    let injSx = 1;
    let injSy = 1;
    /** 回蹭偏移（nuzzle 段朝「最近交互点」凑过去；降级实现，见 nuzzleDir 注释） */
    let nudgeX = 0;
    let nudgeY = 0;
    /** groom 段的甩头摆幅（0 = 不摆），用于脸部的舔毛 wiggle */
    let groomWiggle = 0;
    const pratfalling = this.pratfallState !== null;
    if (this.pratfallState) {
      const st = this.pratfallState;
      const age = now - st.start;
      // 旋转 90° 后的半宽（本地 Y 轴 → 水平）与半高（本地 X 轴 → 垂直）
      const hw = bodyR * 0.85;
      const hh = bodyR * 1.6;
      // 贴墙：本体外缘正好触到画布侧边；抬升：旋转后的底边不出画布下沿
      const flyX = st.dir * Math.max(0, W - hw - 4 - cx);
      const lift = Math.max(0, baseY - (H - 4 - hh));
      if (st.phase === 'fly') {
        const q = easeOut(Math.min(1, age / PRATFALL_FLY_MS));
        injDx = flyX * q;
        injRot = st.dir * q * (Math.PI / 2);
        injSx = 1 + 0.5 * q;
        injSy = 1 - 0.42 * q;
        injDy = lift * q;
      } else if (st.phase === 'lie') {
        // 平铺定格：满压扁 + 极缓的呼吸式起伏（sin/300ms），读作「瘫着」而非「僵住」
        injDx = flyX;
        injRot = st.dir * (Math.PI / 2);
        injSx = 1.5;
        injSy = 0.58;
        injDy = lift + Math.sin(now / 300) * 1.2;
      } else if (st.phase === 'groom') {
        // 甩头舔毛复原：前 40% 坐起来（旋转/压扁归零），后 60% 小幅度甩头 wiggle。
        // 坐起用 easeInOut（和复位同款缓动，读作「自己缓过来了」，不是弹起来）。
        const up = easeInOut(Math.min(1, age / (PRATFALL_GROOM_MS * 0.4)));
        injDx = flyX * (1 - up);
        injRot = st.dir * (Math.PI / 2) * (1 - up);
        injSx = 1 + 0.5 * (1 - up);
        injSy = 1 - 0.42 * (1 - up);
        injDy = lift * (1 - up);
        const wig = Math.min(1, age / (PRATFALL_GROOM_MS * 0.4));
        groomWiggle = Math.sin(age / 220) * 0.12 * wig * (1 - Math.min(1, age / PRATFALL_GROOM_MS));
      } else if (st.phase === 'nuzzle') {
        // 和好节拍：朝最近交互点凑过去蹭两下（正弦往返 = 蹭动），再慢慢退开
        const prog = Math.min(1, age / PRATFALL_NUZZLE_MS);
        const approach = Math.sin(Math.min(1, prog * 1.25) * Math.PI); // 0→1→0
        const rub = Math.sin(age / 420) * 0.5 + 0.5;                  // 蹭动两下
        let ux = 0;
        let uy = 0;
        if (this.nuzzleDir) {
          const len = Math.hypot(this.nuzzleDir.x, this.nuzzleDir.y) || 1;
          ux = this.nuzzleDir.x / len;
          uy = this.nuzzleDir.y / len;
        } else {
          ux = st.dir; // 极端兜底：没有交互点就朝甩出方向蹭（标注见 nuzzleDir）
        }
        const mag = bodyR * 0.32 * approach * (0.6 + 0.4 * rub);
        nudgeX = ux * mag;
        nudgeY = uy * mag * 0.5; // 垂直方向减半：蹭是水平主导的动作
        injRot = ux * 0.1 * approach; // 头朝目标歪一点（示好）
      } else {
        // return：弹性复位回位（easeInOut，快而不留痕）
        const q = 1 - easeInOut(Math.min(1, age / PRATFALL_RETURN_MS));
        nudgeX = (this.nuzzleDir ? Math.sign(this.nuzzleDir.x || 1) : 1) * bodyR * 0.1 * q;
      }
    }

    // ── 拖拽黏性形变：沿速度方向拉伸（鼻涕质感），松手慢速回弹 ──
    const stX = this.dragStretch.x;
    const stY = this.dragStretch.y;

    const squishY = Math.max(0.28, (1 - p.squish - poke * 0.45) * (1 - stY) * injSy);
    const squishX = Math.max(0.28, (1 + p.squish * 0.6 + poke * 0.35) * (1 + stY * 0.7 + stX * 0.3) * injSx);

    const px = cx + trembleX + injDx + nudgeX;
    const py = baseY + bounceY + trembleY - injDy + nudgeY;

    // ── 影子（跟随本体水平位移） ──
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    ctx.ellipse(px, baseY + 16, bodyR * 0.9 * squishX, 9 - bounceY * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── pulse 光环（低精力激活） ──
    if (this.pulseActive && this.pulse !== 'none') {
      this.drawPulseAura(px, py - bodyR * 0.4, bodyR, t);
    }

    // ── 尾巴（身体后图层：M1 情绪通道，姿态由 resolveTailPose 解算） ──
    // 与身体共享位移/旋转/挤压变换，但画在身体之前 → 视觉上在「身后」
    const scX = squishX * (1 + breathPhase * 0.015);
    const scY = squishY * (1 - breathPhase * 0.02);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(injRot);
    ctx.scale(scX, scY);
    const tailTip = this.drawTail(ctx, bodyR, p, t);
    ctx.restore();
    // 记录尾梢画布坐标：petBounds() 用它把尾巴纳入命中区（热区与视觉一致）
    this.tailTip = {
      x: px + scX * tailTip.x * Math.cos(injRot) - scY * tailTip.y * Math.sin(injRot),
      y: py + scX * tailTip.x * Math.sin(injRot) + scY * tailTip.y * Math.cos(injRot),
    };

    // ── 身体 ──
    // 明度跟随 lum 通道（R7）：高精力透亮、低精力发灰发暗，色相始终暖金
    const L = p.lum;
    const bodyGrad = ctx.createRadialGradient(px - bodyR * 0.35, py - bodyR * 1.2, bodyR * 0.2, px, py - bodyR * 0.5, bodyR * 1.6);
    bodyGrad.addColorStop(0, `hsl(${p.hue} ${p.sat}% ${Math.min(92, L + 14)}%)`);
    bodyGrad.addColorStop(0.55, `hsl(${p.hue} ${p.sat}% ${L}%)`);
    bodyGrad.addColorStop(1, `hsl(${p.hue} ${Math.max(20, p.sat - 12)}% ${Math.max(34, L - 16)}%)`);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(injRot);
    ctx.scale(squishX * (1 + breathPhase * 0.015), squishY * (1 - breathPhase * 0.02));
    // 耳朵（M1 情绪通道）：画在头顶之后——基部被头部轮廓遮住，只露三角尖；
    // 飞机耳/耷拉/前倾的姿态差异在三角剪影上才读得出来（天线读不出）
    const earPose = resolveEarPose(p);
    this.drawEar(ctx, -bodyR * 0.46, -bodyR * 1.26, -1, earPose, breathPhase, p, bodyR);
    this.drawEar(ctx, bodyR * 0.46, -bodyR * 1.26, 1, earPose, breathPhase, p, bodyR);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    // 圆润的团子形：底部平，顶部圆
    ctx.moveTo(-bodyR, 0);
    ctx.bezierCurveTo(-bodyR * 1.05, -bodyR * 0.9, -bodyR * 0.62, -bodyR * 1.42, 0, -bodyR * 1.42);
    ctx.bezierCurveTo(bodyR * 0.62, -bodyR * 1.42, bodyR * 1.05, -bodyR * 0.9, bodyR, 0);
    ctx.bezierCurveTo(bodyR * 0.6, bodyR * 0.12, -bodyR * 0.6, bodyR * 0.12, -bodyR, 0);
    ctx.closePath();
    ctx.fill();

    // 高光
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-bodyR * 0.38, -bodyR * 0.95, bodyR * 0.2, bodyR * 0.13, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── 脸 ──
    const faceY = -bodyR * 0.72;
    const eyeDX = bodyR * 0.3;
    // groom 段甩头：整张脸随 wiggle 小幅摆动（舔毛的身体语言）
    ctx.rotate(groomWiggle);
    const pfPhase = this.pratfallState ? this.pratfallState.phase : null;
    this.drawWhiskers(ctx, bodyR, p, pfPhase);
    this.drawEyes(ctx, -eyeDX, faceY, bodyR, p, now, pfPhase);
    this.drawEyes(ctx, eyeDX, faceY, bodyR, p, now, pfPhase);
    this.drawMouth(ctx, 0, faceY + bodyR * 0.34, bodyR, p, pfPhase);
    // 额头绷带（跌倒态）：lie 段冒小爱心（喜剧「冒」的定格）
    if (pratfalling) this.drawBandage(ctx, bodyR, p, pfPhase === 'lie');
    // 腮红（开心时；跌倒态不画 —— 跌倒是放空不是害羞）
    if (p.mouthCurve > 0.4 && !pratfalling) {
      ctx.globalAlpha = Math.min(0.5, (p.mouthCurve - 0.4) * 0.8);
      ctx.fillStyle = '#ff8fa3';
      ctx.beginPath();
      ctx.ellipse(-eyeDX - bodyR * 0.16, faceY + bodyR * 0.2, bodyR * 0.12, bodyR * 0.07, 0, 0, Math.PI * 2);
      ctx.ellipse(eyeDX + bodyR * 0.16, faceY + bodyR * 0.2, bodyR * 0.12, bodyR * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // ── 天气 overlay（独立图层，锚定头顶，不参与表情状态机） ──
    this.drawWeatherOverlay(px, py - bodyR * 1.75, t, p.hue);

    // ── 粒子 ──
    this.updateParticles(ctx);
  }

  /* ─────────────────────────── 部件绘制 ─────────────────────────── */

  /**
   * 耳朵（M1 情绪编码通道）：圆角三角猫耳，基部埋入头顶轮廓（render 里
   * 先画耳后画头，只露三角尖）。
   *
   * 姿态由 resolveEarPose() 解算（pose ∈ [-1,1]）：
   *   pose > 0 → 收拢前倾（开心/警觉/被抚摸）：三角朝脸心立起
   *   pose = 0 → 自然外张
   *   pose < 0 → 飞机耳：外张 + 下压 + 缩短 + 耳廓内暖色收淡（疲惫/害怕）
   * 呼吸只保留微量摆动（0.03 rad），作为「活着」的底噪而非信息。
   *
   * @param side -1 = 左耳，1 = 右耳
   */
  private drawEar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    side: number,
    pose: number,
    breathPhase: number,
    p: RenderParams,
    bodyR: number,
  ): void {
    const s = bodyR;
    ctx.save();
    ctx.translate(x, y);
    const splay = Math.max(0, -pose); // 0..1 飞机耳程度
    const angle = side * (0.22 - pose * 0.38 + splay * 0.5) + side * breathPhase * 0.03;
    ctx.rotate(angle);
    const lenScale = 1 - splay * 0.28; // 低落时耳朵缩短下压（耷拉感）
    const w = s * 0.3;                 // 耳基半宽
    const h = s * 0.52 * lenScale;     // 露出高度
    // 耳廓：圆角三角（基部两点 + 耳尖圆角二次贝塞尔）
    ctx.fillStyle = `hsl(${p.hue} ${p.sat}% ${Math.max(40, p.lum - 10)}%)`;
    ctx.beginPath();
    ctx.moveTo(-w, s * 0.12);
    ctx.quadraticCurveTo(-w * 0.55, -h * 0.82, 0, -h);
    ctx.quadraticCurveTo(w * 0.55, -h * 0.82, w, s * 0.12);
    ctx.closePath();
    ctx.fill();
    // 耳内暖粉（色相向粉红方向偏 330°：暖金 40° → 10° 橙粉；+24° 会落在
    // 黄绿区，读作「新芽」而非猫耳内。飞机耳时收淡——血色褪去的疲惫隐喻）
    ctx.fillStyle = `hsl(${(p.hue + 330) % 360} ${78 - splay * 26}% ${78 - splay * 9}%)`;
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, s * 0.06);
    ctx.quadraticCurveTo(-w * 0.28, -h * 0.62, 0, -h * 0.68);
    ctx.quadraticCurveTo(w * 0.28, -h * 0.62, w * 0.5, s * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * 尾巴（M1 情绪通道）：锥形贝塞尔脊柱，画在身体后图层。
   *
   * 姿态全部来自 resolveTailPose()（纯函数、无随机、无新状态）：
   *   lift  → 根部仰角（高精力竖起、burnt 拖地）
   *   amp/speed → 摆动（开心是「摇」：大摆幅中速；害怕是「抖」：小摆幅高频）
   *   len   → 长度随精力略增（元气满满时尾巴也更蓬）
   * 鞭状传导刻意收敛（0.3→0.9×sway）：过强会让摆相位抵消根部仰角，
   * 尾巴在截图里读成「水平贴纸」而非竖/垂的尾巴。
   * 垂落钳制：lift<0 时尾梢不允许穿过地面（影子线 +0.22R），burnt 读作
   * 「尾巴拖在地上」而非「插进地里」。
   *
   * @returns 尾梢局部坐标（供 petBounds 把尾巴纳入命中区）
   */
  private drawTail(ctx: CanvasRenderingContext2D, bodyR: number, p: RenderParams, t: number): { x: number; y: number } {
    const pose = resolveTailPose(p);
    const sway = Math.sin(t * pose.speed) * pose.amp;
    const L = bodyR * pose.len;
    const N = 10;
    // 根/梢方向：梢部恒定再上勾 0.55rad（猫的「?」尾钩），摆动作为
    // 全脊柱的加性扰动——旧实现让摆相位随 s 放大到能抵消根部仰角，
    // 截图里整条尾巴塌成水平鱼鳍，读不出「竖/垂」。
    const rootA = -pose.lift * 0.95 + sway * 0.25;
    const tipA = rootA - 0.55 + sway * 0.45;
    const x0 = bodyR * 0.55;
    const y0 = -bodyR * 0.12;
    const floorY = bodyR * 0.22; // 地面线（局部坐标，≈影子上缘）
    // 脊柱采样：方向根→梢插值（s² 缓入：尾钩主要出现在后半段）
    const pts: [number, number][] = [[x0, y0]];
    let x = x0;
    let y = y0;
    for (let i = 1; i <= N; i++) {
      const s = i / N;
      const a = rootA + (tipA - rootA) * (s * s);
      x += Math.cos(a) * (L / N);
      y += Math.sin(a) * (L / N);
      if (pose.lift < 0) y = Math.min(y, floorY + s * bodyR * 0.06); // 垂尾贴地钳制
      pts.push([x, y]);
    }
    // 锥形轮廓：宽度 0.22R（根）→ 0.06R（梢）
    const wAt = (s: number): number => bodyR * (0.22 - 0.16 * s);
    const normalAt = (i: number): [number, number] => {
      const [bx, by] = pts[Math.min(N, i + 1)];
      const [cx, cy] = pts[Math.max(0, i - 1)];
      const dx = bx - cx;
      const dy = by - cy;
      const d = Math.hypot(dx, dy) || 1;
      return [-dy / d, dx / d];
    };
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const [nx, ny] = normalAt(i);
      const w = wAt(i / N);
      const [ax, ay] = pts[i];
      if (i === 0) ctx.moveTo(ax + nx * w, ay + ny * w);
      else ctx.lineTo(ax + nx * w, ay + ny * w);
    }
    for (let i = N; i >= 0; i--) {
      const [nx, ny] = normalAt(i);
      const w = wAt(i / N);
      const [ax, ay] = pts[i];
      ctx.lineTo(ax - nx * w, ay - ny * w);
    }
    ctx.closePath();
    // 比身体暗一档：读作「身后的尾巴」而非贴纸（M4 再做花纹/渐变）
    ctx.fillStyle = `hsl(${p.hue} ${Math.max(24, p.sat - 6)}% ${Math.max(38, p.lum - 8)}%)`;
    ctx.fill();
    // 尾梢圆头（闭合锥形的尖端帽，避免楔形切口感）
    const [tipX, tipY] = pts[N];
    ctx.beginPath();
    ctx.arc(tipX, tipY, wAt(1), 0, Math.PI * 2);
    ctx.fill();
    return { x: tipX, y: tipY };
  }

  /**
   * 眼睛。
   *
   * @param phase 跌倒相位（null = 常态）。
   * 🔴 R11 拟物化判据：跌倒期间是**呆滞放空**（半闭无神、瞳孔小而不聚焦），
   * 禁止 X 眼 / 旋转眼球 / 泪痕 / 悲伤下垂眼角 —— 「被打晕」是拟人痛苦语义，
   * 与喜剧彩蛋的定位冲突（旧实现的 X 眼已在本次重做中删除）。
   *   lie/nuzzle：完全放空（半闭 + 极小瞳孔，无眼神光 = 灵魂暂时不在）
   *   groom：回神中（半睁 + 眼神光回归，读作「缓过来了」）
   *   fly/return：沿用常态眼（动作段不需要额外表情信息）
   */
  private drawEyes(ctx: CanvasRenderingContext2D, x: number, y: number, bodyR: number, p: RenderParams, now: number, phase: PratfallPhase | null = null): void {
    const r = bodyR * 0.115;
    ctx.save();
    ctx.translate(x, y);
    if (phase === 'lie' || phase === 'nuzzle') {
      // 呆滞放空：半闭的平直眼睑（不弯 = 无情绪），瞳孔缩成小点且**无眼神光**，
      // 位置略偏下（失焦感）—— 读作「放空」而非「睡着/痛苦」
      ctx.fillStyle = `hsl(${p.hue} ${p.sat}% ${Math.max(40, p.lum)}%)`;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.55, r * 1.25, r * 0.85, 0, 0, Math.PI * 2); // 上眼睑罩
      ctx.fill();
      ctx.fillStyle = '#2b2b3a';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.18, r * 0.42, r * 0.5, 0, 0, Math.PI * 2);  // 小而不聚焦的瞳孔
      ctx.fill();
      ctx.restore();
      return;
    }
    if (phase === 'groom') {
      // 回神中：半睁 + 眼神光回归（生命迹象通道重新上线）
      ctx.fillStyle = '#2b2b3a';
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(r * 0.3, -r * 0.2, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // 眨眼：正弦包络，闭眼时画横线
    let open = p.eyeOpen;
    if (this.blinking) {
      open *= Math.abs(Math.cos(this.blinkProgress * Math.PI));
    }
    if (open < 0.15) {
      // 闭眼 —— 弧线（开心时向上弯，累时向下垂）
      ctx.strokeStyle = '#2b2b3a';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (p.mouthCurve > 0.3) ctx.arc(0, r * 0.6, r * 1.1, Math.PI * 1.15, Math.PI * 1.85);
      else ctx.arc(0, -r * 0.6, r * 1.1, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    } else {
      // 睁眼
      ctx.fillStyle = '#2b2b3a';
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * Math.max(0.15, open), 0, 0, Math.PI * 2);
      ctx.fill();
      // 眼神光
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(r * 0.35, -r * 0.35 * open, r * 0.3 * open, 0, Math.PI * 2);
      ctx.fill();
      // 疲惫：眼皮下垂（上半遮罩）
      if (p.eyeOpen < 0.7) {
        ctx.fillStyle = `hsl(${p.hue} ${p.sat}% ${Math.max(40, p.lum)}%)`;
        ctx.beginPath();
        ctx.ellipse(0, -r * (1.6 - p.eyeOpen), r * 1.25, r * 0.9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    void now;
  }

  /**
   * 嘴。
   * @param phase 跌倒相位（null = 常态）。
   * 跌倒期间保留**极轻**的波浪（卡通惯例，汤姆猫式），幅度压到常态的一半以下 ——
   * 读作「懵」而非「痛苦扭曲」；nuzzle（和好）段换成小上扬（蹭人是开心的）。
   */
  private drawMouth(ctx: CanvasRenderingContext2D, x: number, y: number, bodyR: number, p: RenderParams, phase: PratfallPhase | null = null): void {
    const w = bodyR * 0.3;
    const curve = p.mouthCurve;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#2b2b3a';
    ctx.lineWidth = 2.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (phase === 'lie' || phase === 'groom') {
      // 懵：轻微波浪（幅度 w*0.16，常态波浪的 ~45%，不得读作痛苦）
      ctx.moveTo(-w * 0.7, 0);
      ctx.quadraticCurveTo(-w * 0.35, w * 0.16, 0, 0);
      ctx.quadraticCurveTo(w * 0.35, -w * 0.16, w * 0.7, 0);
      ctx.stroke();
    } else if (phase === 'nuzzle') {
      // 和好：小上扬（蹭两下是示好，嘴角要有回应）
      ctx.moveTo(-w * 0.7, 0);
      ctx.quadraticCurveTo(0, w * 0.45, w * 0.7, 0);
      ctx.stroke();
    } else if (curve > 0.65) {
      // 大笑：张嘴
      ctx.fillStyle = '#2b2b3a';
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.quadraticCurveTo(0, w * 1.5 * curve, w, 0);
      ctx.quadraticCurveTo(0, w * 0.55, -w, 0);
      ctx.fill();
      // 舌头
      ctx.fillStyle = '#ff8fa3';
      ctx.beginPath();
      ctx.ellipse(0, w * 0.42 * curve, w * 0.34, w * 0.2 * curve, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 普通嘴型：二次贝塞尔，curve 控制弯向
      ctx.moveTo(-w, 0);
      ctx.quadraticCurveTo(0, curve * w * 1.2, w, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 胡须（常驻图层）。
   *
   * 🔴 新增部件：本项目的猫此前**没有胡须**（T12 裁决「折弯胡须」的隐含前提）。
   * 常驻平直是「折弯」的对比基准 —— 没有常态，就看不出非常态。
   * 每侧三根，从脸颊向外微垂（真实猫须的自然下垂角），随呼吸极轻摆动。
   *
   * 跌倒期间（lie 段）**右上一根折弯**：折点在中段，梢部向下耷 ——
   * 卡通惯例「摔了一跤胡须歪了一根」，是喜剧记号不是伤情记号
   * （无血、无泪、无真实伤口，R11 拟物化判据）。
   */
  private drawWhiskers(ctx: CanvasRenderingContext2D, bodyR: number, p: RenderParams, phase: PratfallPhase | null): void {
    const faceY = -bodyR * 0.72;
    const breath = Math.sin(performance.now() / 900) * 0.02; // 极轻的活体底噪
    ctx.save();
    ctx.strokeStyle = 'rgba(60,52,40,0.55)'; // 暖灰褐：比脸深一档，读作毛而非线
    ctx.lineWidth = Math.max(1, bodyR * 0.028);
    ctx.lineCap = 'round';
    const sides: readonly (-1 | 1)[] = [-1, 1];
    for (const side of sides) {
      for (let i = 0; i < 3; i++) {
        const y0 = faceY + bodyR * (0.12 + i * 0.1);
        const x0 = side * bodyR * 0.52;
        const len = bodyR * (0.52 - i * 0.06);
        const droop = 0.16 + i * 0.1 + breath; // 越靠下越垂（自然）
        // 折弯判定：跌倒 lie 段，右侧（side=1）最上面一根（i=0）
        const bent = phase === 'lie' && side === 1 && i === 0;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        if (bent) {
          // 折点在中段：先正常外伸，再陡然下耷（kink，卡通「歪了」记号）
          const mx = x0 + side * len * 0.5;
          const my = y0 + len * droop * 0.5;
          ctx.quadraticCurveTo(x0 + side * len * 0.3, y0 + len * droop * 0.3, mx, my);
          ctx.quadraticCurveTo(mx + side * len * 0.18, my + len * 0.42, mx + side * len * 0.1, my + len * 0.55);
        } else {
          ctx.quadraticCurveTo(x0 + side * len * 0.55, y0 + len * droop * 0.4, x0 + side * len, y0 + len * droop);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
    void p;
  }

  /**
   * 额头绷带（跌倒态）+ lie 段冒小爱心。
   *
   * 视觉重做（裁决无条件项）：**删除侧脸十字贴布**（它配 X 眼读作「重伤」），
   * 保留额头绷带（汤姆猫式卡通惯例）并在 lie 段从绷带上缘**冒小爱心** ——
   * 爱心是「这一跤摔得挺值」的喜剧记号，与「冒金星」同构但换成暖意。
   * 程序化 Canvas 心形路径，不引入图片/GIF/精灵表。
   */
  private drawBandage(ctx: CanvasRenderingContext2D, bodyR: number, p: RenderParams, hearts: boolean): void {
    ctx.save();
    // 额头绷带：绕头顶一圈
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = bodyR * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.72, -bodyR * 1.02);
    ctx.quadraticCurveTo(0, -bodyR * 1.34, bodyR * 0.72, -bodyR * 1.02);
    ctx.stroke();
    // 绷带边缘阴影线
    ctx.strokeStyle = 'rgba(30,30,60,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.72, -bodyR * 0.94);
    ctx.quadraticCurveTo(0, -bodyR * 1.26, bodyR * 0.72, -bodyR * 0.94);
    ctx.stroke();
    // 🔴 十字贴布已删除（R11 视觉重做：它配 X 眼读作重伤，不配喜剧）
    if (hearts) {
      // 冒小爱心：三颗错峰上浮 + 淡入淡出（周期 1.6s，错开 0.53s）
      const t = performance.now() / 1000;
      for (let i = 0; i < 3; i++) {
        const prog = ((t / 1.6) + i * 0.333) % 1;
        const rise = prog;                                  // 0→1 上浮
        const alpha = Math.sin(prog * Math.PI);             // 淡入淡出，两端归零
        const hx = bodyR * (-0.3 + i * 0.3) + Math.sin(t * 2 + i) * bodyR * 0.06;
        const hy = -bodyR * 1.3 - rise * bodyR * 0.75;
        const s = bodyR * (0.09 + 0.03 * Math.sin(i * 2.1));
        ctx.save();
        ctx.globalAlpha = 0.85 * alpha;
        ctx.translate(hx, hy);
        ctx.rotate(Math.sin(t * 1.5 + i) * 0.2);
        drawHeart(ctx, s, `hsl(${(p.hue + 330) % 360} 80% 66%)`); // 与耳内同源的暖粉
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** pulse 光环：低精力激活时的氛围特效 */
  private drawPulseAura(x: number, y: number, bodyR: number, t: number): void {
    const { ctx } = this;
    const colors: Record<string, string> = {
      anxious: 'rgba(255,140,66,0.5)',
      guilty: 'rgba(150,120,255,0.45)',
      numb: 'rgba(140,150,170,0.4)',
      restless: 'rgba(255,110,110,0.45)',
      grateful: 'rgba(120,220,160,0.5)',
      determined: 'rgba(255,200,80,0.5)',
    };
    const color = colors[this.pulse] ?? 'rgba(160,160,200,0.4)';
    ctx.save();
    const pulseScale = 1 + Math.sin(t * 3) * 0.06;
    ctx.globalAlpha = 0.55 + Math.sin(t * 3) * 0.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, bodyR * 1.25 * pulseScale, bodyR * 1.15 * pulseScale, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 特定 pulse 的小符号
    ctx.save();
    ctx.font = '16px system-ui';
    ctx.textAlign = 'center';
    const sym = this.pulse === 'anxious' ? '💧' : this.pulse === 'restless' ? '〰️' : this.pulse === 'grateful' ? '✨' : null;
    if (sym) {
      ctx.globalAlpha = 0.8 + Math.sin(t * 4) * 0.2;
      ctx.fillText(sym, x + bodyR * 0.95, y - bodyR * 0.75 + Math.sin(t * 2) * 3);
    }
    ctx.restore();
  }

  /** 天气 overlay：独立精灵锚定头顶 */
  private drawWeatherOverlay(x: number, y: number, t: number, _petHue: number): void {
    if (this.overlay === 'none') return;
    const { ctx } = this;
    ctx.save();
    switch (this.overlay) {
      case 'sunbeam': {
        // 小太阳 + 旋转光芒
        const sy = y - 26 + Math.sin(t * 1.4) * 2;
        ctx.translate(x + 46, sy);
        ctx.rotate(t * 0.5);
        ctx.strokeStyle = 'rgba(255,200,60,0.85)';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 13, Math.sin(a) * 13);
          ctx.lineTo(Math.cos(a) * 18, Math.sin(a) * 18);
          ctx.stroke();
        }
        ctx.rotate(-t * 0.5);
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 11);
        g.addColorStop(0, '#fff3b0');
        g.addColorStop(1, '#ffc93c');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'cloud-puff': {
        const cy = y - 30 + Math.sin(t * 1.1) * 2.5;
        ctx.translate(x + 44, cy);
        ctx.fillStyle = 'rgba(190,196,214,0.92)';
        ctx.beginPath();
        ctx.arc(-8, 2, 8, 0, Math.PI * 2);
        ctx.arc(0, -3, 10.5, 0, Math.PI * 2);
        ctx.arc(9, 2, 7.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'rain-drop': {
        const cy = y - 32 + Math.sin(t * 1.1) * 2;
        ctx.translate(x + 44, cy);
        ctx.fillStyle = 'rgba(150,160,185,0.95)';
        ctx.beginPath();
        ctx.arc(-9, 2, 9, 0, Math.PI * 2);
        ctx.arc(0, -4, 12, 0, Math.PI * 2);
        ctx.arc(10, 2, 8.5, 0, Math.PI * 2);
        ctx.fill();
        // 雨丝（循环下落）
        ctx.strokeStyle = 'rgba(120,170,255,0.8)';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        for (let i = 0; i < 4; i++) {
          const phase = (t * 1.6 + i * 0.25) % 1;
          const dx = -12 + i * 8;
          const dy = 10 + phase * 22;
          ctx.globalAlpha = 1 - phase;
          ctx.beginPath();
          ctx.moveTo(dx, dy);
          ctx.lineTo(dx - 1.5, dy + 6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'storm-bolt': {
        const cy = y - 34 + Math.sin(t * 1.3) * 2;
        ctx.translate(x + 44, cy);
        ctx.fillStyle = 'rgba(120,125,150,0.96)';
        ctx.beginPath();
        ctx.arc(-9, 2, 9.5, 0, Math.PI * 2);
        ctx.arc(0, -5, 12.5, 0, Math.PI * 2);
        ctx.arc(10, 2, 9, 0, Math.PI * 2);
        ctx.fill();
        // 闪电（周期性闪现）
        const flash = (t * 0.9) % 2.4;
        if (flash < 0.28) {
          ctx.globalAlpha = flash < 0.14 ? 1 : 0.6;
          ctx.fillStyle = '#ffe066';
          ctx.strokeStyle = '#f5b942';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(2, 8);
          ctx.lineTo(-4, 20);
          ctx.lineTo(0, 20);
          ctx.lineTo(-3, 30);
          ctx.lineTo(6, 17);
          ctx.lineTo(2, 17);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // 雨丝
        ctx.strokeStyle = 'rgba(120,170,255,0.7)';
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 3; i++) {
          const phase = (t * 2 + i * 0.33) % 1;
          const dx = -12 + i * 10;
          const dy = 10 + phase * 24;
          ctx.globalAlpha = 1 - phase;
          ctx.beginPath();
          ctx.moveTo(dx, dy);
          ctx.lineTo(dx - 2, dy + 7);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
    }
    ctx.restore();
  }

  private spawnParticles(n: number, hue: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 70;
      this.particles.push({
        x: this.canvas.getBoundingClientRect().width / 2,
        y: this.canvas.getBoundingClientRect().height - 90,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        life: 0,
        maxLife: 0.7 + Math.random() * 0.6,
        hue: hue + (Math.random() - 0.5) * 30,
        size: 2 + Math.random() * 3,
      });
    }
  }

  private updateParticles(ctx: CanvasRenderingContext2D): void {
    const dt = 1 / 60;
    this.particles = this.particles.filter(pt => pt.life < pt.maxLife);
    for (const pt of this.particles) {
      pt.life += dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy += 120 * dt;
      const alpha = 1 - pt.life / pt.maxLife;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `hsl(${pt.hue} 95% 65%)`;
      ctx.beginPath();
      // 星星形状
      const s = pt.size * alpha;
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.life * 4);
      ctx.moveTo(0, -s * 2);
      for (let i = 0; i < 5; i++) {
        ctx.rotate((Math.PI * 2) / 10);
        ctx.lineTo(0, -s);
        ctx.rotate((Math.PI * 2) / 10);
        ctx.lineTo(0, -s * 2);
      }
      ctx.fill();
      ctx.restore();
    }
  }

}

/* ─────────────────────────── 绘制工具 ─────────────────────────── */

/**
 * 程序化心形路径（绷带冒小爱心用）。不引入图片/GIF/精灵表（R11 裁决）。
 * 经典双贝塞尔心形：从底部尖点起笔，左右各一个控制环。
 */
function drawHeart(ctx: CanvasRenderingContext2D, s: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, s * 0.9);
  ctx.bezierCurveTo(-s * 1.1, s * 0.1, -s * 0.8, -s * 0.9, 0, -s * 0.3);
  ctx.bezierCurveTo(s * 0.8, -s * 0.9, s * 1.1, s * 0.1, 0, s * 0.9);
  ctx.closePath();
  ctx.fill();
}

export { lerp };
