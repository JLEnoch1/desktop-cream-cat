/**
 * 情绪外化 FX 层 —— 原版 energy-pet composeAppearance 的「肉眼可见」外化移植。
 *
 * 原版参考（只读）：/Users/zcy/Desktop/energy-pet/src/renderer/src/pet/mood.ts + PetFace.tsx
 *   face emoji（🤩😄🙂😪😩😵）   → 全部移除（2026-10-27 用户裁决：头顶不做悬浮脸；
 *                                 HUD 档位徽标「😵 枯竭」与精力数字一并清除——精力条只留格子填充）
 *   fx-soul 👻 / fx-sweat 💧 / fx-sparkle ✨ → 已按用户要求移除（2026-10-27：不做悬浮 emoji 道具）
 *   fx-glow（晴金黄光）            → glow（sunbeam overlay，本体后金色背光）
 *   fx-bounce（full 档整体弹跳）   → bounce（blissful e≥9.5，1.1s -9px，仅地面平静态）
 *   fx-shiver（storm+e<4 发抖）    → shiver（storm-bolt overlay && e<4，0.45s ±2px）
 *   fx-droop / fx-slow            → 由 cat-fsm vitality 姿态与 mood.ts 行为参数承载（不重复实现）
 *   本体色温（方案A 2026-10-27 用户选型）→ energyTint/drawEnergyTint：低精力暖灰蒙版（黯淡）↔ 高精力暖金+轮廓光（发光），0–10 连续
 *   天气 rain/snow/umbrella/skyIcon → 由 sprite-skin weather overlay 承载（墨线风，优于 emoji）
 *
 * 架构：纯函数 computeMoodFx + 无状态 draw/offset 函数；cat-app 在 skin.draw 前后包裹调用，
 * **零侵入 sprite-skin/cat-fsm**（并行会话领地不动）。
 *
 * 红线：R6 —— 只读 overlay 字段与 energy，永不读 emotion.composite；
 *       overlay 直接用 resolveWeatherOverlay 的产物（精力门槛单源，不自设阈值）；
 *       R7 —— 色温层仅暖色系（暖灰/金），禁蓝紫。
 */

import type { EmotionState } from '../../core/types.js';

export interface MoodFx {
  /** sunbeam：金色背光（晴且 e≥8，门槛在 resolveWeatherOverlay 单源） */
  glow: boolean;
  /** 狂喜（e≥9.5）：整体弹跳 */
  bounce: boolean;
  /** 雷阵雨 overlay 且 e<4：发抖 */
  shiver: boolean;
}

export const EMPTY_MOOD_FX: MoodFx = {
  glow: false, bounce: false, shiver: false,
};

/** 三层情绪 → FX 开关（纯函数；R6：composite 永不参与） */
export function computeMoodFx(
  energy: number,
  emotion: Pick<EmotionState, 'overlay'>,
): MoodFx {
  const e = Math.max(0, Math.min(10, energy));
  return {
    glow: emotion.overlay === 'sunbeam',
    bounce: e >= 9.5,
    shiver: emotion.overlay === 'storm-bolt' && e < 4,
  };
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

export interface MoodFxAnchor {
  /** 猫身体中线 x（窗口坐标） */
  cx: number;
  /** 地面 y（窗口坐标） */
  groundY: number;
}

/** bounce/shiver 是否生效的状态门：地面平静态（睡眠/拖拽/空中不打折） */
const FX_BODY_STATES = new Set(['idle', 'walk', 'perch', 'groom']);

/**
 * 本体级位移（cat-app 在 skin.draw 外层 translate 应用）：
 * bounce = 原版 fx-bounce（1.1s、峰值 -9px、ease-in-out≈(1-cos)/2）；
 * shiver = 原版 fx-shiver（0.45s、±2px 正弦）。
 */
export function moodFxBodyOffset(fx: MoodFx, t: number, state: string): { dx: number; dy: number } {
  if (!FX_BODY_STATES.has(state)) return { dx: 0, dy: 0 };
  let dx = 0;
  let dy = 0;
  if (fx.bounce) dy += -9 * (1 - Math.cos((t / 1.1) * Math.PI * 2)) / 2;
  if (fx.shiver) dx += -2 * Math.sin((t / 0.45) * Math.PI * 2);
  return { dx, dy };
}

/** 金色背光（本体之前绘制）：原版 fx-glow drop-shadow(rgba(255,214,110,.85)) 的画布版 */
export function drawMoodFxBack(
  ctx: CanvasRenderingContext2D, fx: MoodFx, t: number, a: MoodFxAnchor,
): void {
  if (!fx.glow) return;
  const breathe = 0.75 + 0.25 * Math.sin(t * 1.6);
  const cy = a.groundY - 118;
  const g = ctx.createRadialGradient(a.cx, cy, 18, a.cx, cy, 132);
  g.addColorStop(0, `rgba(255,214,110,${(0.34 * breathe).toFixed(3)})`);
  g.addColorStop(1, 'rgba(255,214,110,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(a.cx, cy, 120, 138, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ─────────────────── 本体色温层（方案A：猫本身随精力变化） ─────────────────── */

/** 暖灰蒙版色（R7：暖色 only，禁蓝紫）/ 金润色（与 glow 同族）/ 轮廓光色 */
const DIM_RGB = '110,100,94';
const WARM_RGB = '255,214,110';
const RIM_RGB = '255,205,110';

/**
 * 精力 → 色温强度（0–10 连续映射，纯函数）：
 * dim  = e≤6 起线性渐入，e=0 暖灰蒙版 0.28（原版 fx-droop grayscale(0.3) 的画布版，黯淡无光）；
 * warm = e≥7 起线性渐入，e=10 暖金微亮 0.10（容光焕发）；
 * rim  = 与 warm 同门槛，本体边缘金色轮廓光（destination-over 只露出轮廓外的部分）。
 */
export function energyTint(energy: number): { dim: number; warm: number; rim: number } {
  const e = Math.max(0, Math.min(10, energy));
  const lo = Math.max(0, Math.min(1, (6 - e) / 6));
  const hi = Math.max(0, Math.min(1, (e - 7) / 3));
  return { dim: lo * 0.28, warm: hi * 0.1, rim: hi * 0.55 };
}

/**
 * 绘制次序：drawMoodFxBack（glow 背光）→ skin.draw → drawEnergyTint（source-atop 本体染色 + destination-over 轮廓光）。
 * source-atop 只命中已画像素（本体/阴影/天气挂件），透明背景不受影响；
 * 传入精力请用平滑 vitality（fsm.vitality()*10），色温与体态同 τ=0.55s 同步渐变。
 */
export function drawEnergyTint(ctx: CanvasRenderingContext2D, energy: number, a: MoodFxAnchor): void {
  const { dim, warm, rim } = energyTint(energy);
  const w = ctx.canvas?.width ?? 360;
  const h = ctx.canvas?.height ?? 424;
  if (dim > 0.004 || warm > 0.004) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    // dim 与 warm 门槛互斥（e<6 / e>7），取大者即当前生效层
    ctx.fillStyle = dim >= warm ? `rgba(${DIM_RGB},${dim.toFixed(3)})` : `rgba(${WARM_RGB},${warm.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  if (rim > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    const cy = a.groundY - 115;
    const g = ctx.createRadialGradient(a.cx, cy, 55, a.cx, cy, 148);
    g.addColorStop(0, `rgba(${RIM_RGB},${rim.toFixed(3)})`);
    g.addColorStop(0.62, `rgba(${RIM_RGB},${(rim * 0.45).toFixed(3)})`);
    g.addColorStop(1, `rgba(${RIM_RGB},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(a.cx, cy, 148, 162, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

