/**
 * 猫窗口入口 —— 装配 FSM × 皮肤渲染器 × 心情层 × 壳层 IPC。
 *
 * 数据流（docs/cream-fusion.md §3）：
 *   window.cat.onMood(领域心情) → mood.ts 参数 → FSM 活力/表情/overlay/光晕
 *   window.cat.onReact(领域事件) → 表情插播 + 气泡文案
 *   window.cat.onCmd(壳层命令)  → FSM.applyCmd / 皮肤热重载
 *   FSM px/py → window.cat.moveWindow（渲染层拥有窗口位置）
 */

import type { CatApi, PetApi } from '../../preload/index.js';
import type { AdjustWindow, AppState, CatMoodPayload, CatReactPayload, CustomPoseDef } from '../../core/types.js';
import { ENERGY_MAX } from '../../core/types.js';
import { CatFsm, CAT_W, CAT_H, CAT_GROUND, CAT_CX } from './cat-fsm.js';
import { createSpriteSkin, type SpriteSkin, type SkinAssetsV2 } from './sprite-skin.js';
import { drawFallbackCat } from './fallback-cat.js';
import { computeMoodParams, withPreviewEnergy, reactionFor, petLines, NEUTRAL_MOOD, type MoodParams } from './mood.js';
import { computeMoodFx, moodFxBodyOffset, drawMoodFxBack, drawEnergyTint, energyTint, EMPTY_MOOD_FX, type MoodFx } from './mood-fx.js';
import { pulseIntensity } from '../../emotion/pulse-contract.js';

declare global {
  interface Window {
    cat: CatApi;
    pet: PetApi; // 与 uiWin 共享同一 preload：HUD 迁移后领域 API 直接在猫窗口可用
    petDebug?: Record<string, unknown>;
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
document.addEventListener('dragstart', (e) => e.preventDefault());

/* ── HUD 元素（原 uiWin #energy-hud 原样迁移到桌宠下方） ── */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const hud = $('energy-hud');
const hudNum = $('hud-num');
const hudCells = $('hud-cells');
const hudWeather = $('hud-weather');
const hudSlider = $<HTMLInputElement>('hud-slider');
const hudBarTrack = $('hud-bar-track');
const hudAdjustBadge = $('hud-adjust-badge');
const hudAdjustCount = $('hud-adjust-count');

let DPR = 1;
function fit(): void {
  DPR = window.devicePixelRatio || 1;
  canvas.width = CAT_W * DPR;
  canvas.height = CAT_H * DPR;
  canvas.style.width = `${CAT_W}px`;
  canvas.style.height = `${CAT_H}px`;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
fit();
window.addEventListener('resize', fit);

/* ─────────────────────────── 精力 HUD（原 uiWin 组件整体迁移到桌宠下方） ───────────────────────────
 * 位置错了就搬家，不重新设计：10 格电量条 + 数值 + 档位 + 天气 + 双模式滑条
 * + 调节倒计时角标，渲染逻辑与 uiWin 版逐行等价；仅显隐规则不同——
 * 悬浮桌宠显示（静止 1.2s 收起），事件后调节窗期间强制显示。 */

const WEATHER_ICON: Record<string, string> = {
  sunny: '☀️', cloudy: '☁️', rain: '🌧️', thunderstorm: '⛈️',
};
const HUD_CELL_COUNT = ENERGY_MAX;

let uiState: AppState | null = null;
/** 调节窗镜像（与 uiWin 各自维护；数据同源自 state 推送） */
let adjustWin: AdjustWindow | null = null;
/** 倒计时 interval（按镜像 expiresAt 每 250ms 重算） */
let adjustCountdown: ReturnType<typeof setInterval> | null = null;
/** HUD 滑块「平时拖动」预览态：松手回弹到滑动前的值 */
let hudPreviewing = false;
/** 滑动前记录的真实精力（回弹目标） */
let hudRestEnergy = 0;
/** HUD 滑块平时拖动的预览值（仅 hudPreviewing 期间非 null，回弹即清零） */
let hudPreviewValue: number | null = null;
/** uiWin 滑动卡预览中：HUD 显示预览值，不被状态推送的真值覆盖 */
let slidePreviewActive = false;
/** 滑动卡预览值镜像（仅 slidePreviewActive 期间非 null） */
let slidePreviewValue: number | null = null;

const hudCellFills: HTMLElement[] = [];

function initHudCells(): void {
  hudCells.innerHTML = '';
  hudCellFills.length = 0;
  for (let i = 0; i < HUD_CELL_COUNT; i++) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    const fill = document.createElement('i');
    cell.appendChild(fill);
    hudCells.appendChild(cell);
    hudCellFills.push(fill);
  }
}

function renderHudCells(v: number): void {
  const val = Math.min(ENERGY_MAX, Math.max(0, v));
  const full = Math.floor(val);
  const frac = val - full;
  for (let i = 0; i < HUD_CELL_COUNT; i++) {
    const fill = hudCellFills[i];
    if (!fill) continue;
    fill.style.width = i < full ? '100%' : i === full ? `${frac * 100}%` : '0%';
  }
}

/** 本地即时反馈：数字 + 格子填充（不落库；档位徽标已按 2026-10-27 用户裁决清除） */
function renderHud(v: number): void {
  hudNum.textContent = v.toFixed(1);
  renderHudCells(v);
}

/** HUD 恢复显示真实精力（预览/草稿从未落库，energy 一直是真值） */
function restoreHudFromState(): void {
  if (!uiState) return;
  hudSlider.value = String(uiState.energy);
  hudRestEnergy = uiState.energy;
  renderHud(uiState.energy);
}

function stopCountdown(): void {
  if (adjustCountdown) { clearInterval(adjustCountdown); adjustCountdown = null; }
}

/** 倒计时角标：始终读最新镜像的 expiresAt（拖动微调后主进程重置窗口，回执刷新镜像） */
function renderAdjustCountdown(): void {
  if (!adjustWin) return;
  const remain = Math.max(0, Math.ceil((adjustWin.expiresAt - Date.now()) / 1000));
  hudAdjustCount.textContent = String(remain);
  if (remain <= 0) stopCountdown(); // confirming 相位由状态推送驱动
}

/* ── 显隐：悬浮桌宠 or 调节窗强制 ── */

let hoverActive = false;
let hudHideTimer: ReturnType<typeof setTimeout> | null = null;

function syncHudVisibility(): void {
  const show = hoverActive || !!adjustWin;
  if (show === hud.classList.contains('show')) return;
  hud.classList.toggle('show', show);
  // 显隐翻转 → 命中区同步（滑条显示时必须可交互；收起后绝不挡桌面）
  reportCatHotRects();
}

// 命中区轮询保证光标在猫身上时窗口可交互 → mousemove 即悬浮信号；
// 光标离开热区后主进程切回穿透，事件流停止，靠定时器收起。
window.addEventListener('mousemove', () => {
  hoverActive = true;
  syncHudVisibility();
  if (hudHideTimer) clearTimeout(hudHideTimer);
  hudHideTimer = setTimeout(() => { hoverActive = false; syncHudVisibility(); }, 1200);
});
window.addEventListener('mouseleave', () => {
  if (hudHideTimer) clearTimeout(hudHideTimer);
  hoverActive = false;
  syncHudVisibility();
});

/* ── 命中区上报：猫体 + 显示中的 HUD ── */

const CAT_BODY_RECT = { x: CAT_CX - 88, y: CAT_GROUND - 262, w: 176, h: 268 };

function reportCatHotRects(): void {
  const rects = [CAT_BODY_RECT];
  if (hud.classList.contains('show')) {
    const r = hud.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) {
      rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  window.cat.hotRect(rects);
}

/* ── 双模式滑块（与 uiWin 版等价）：平时拖动只预览、松手回弹；调节窗内写草稿 ── */

function setupHudSlider(): void {
  const clamp01 = (v: number): number => Math.min(ENERGY_MAX, Math.max(0, Math.round(v * 2) / 2));

  hudSlider.addEventListener('pointerdown', () => {
    if (adjustWin) return; // 窗口模式不回弹，起点就是草稿
    hudPreviewing = true;
    hudRestEnergy = uiState?.energy ?? 0;
    hudBarTrack.classList.add('previewing');
  });

  hudSlider.addEventListener('input', () => {
    const v = clamp01(Number(hudSlider.value));
    if (adjustWin) {
      // 事件后调节：写入草稿（主进程校验窗口存在性）；
      // 回执刷新镜像 → 倒计时立刻体现「拖动重置」
      renderHud(v);
      setPreviewEnergy(v); // 乐观更新：草稿回执前宠物情绪先跟上手指
      void window.pet.adjustDraft(v).then((w) => {
        if (w) { adjustWin = w; renderAdjustCountdown(); resolvePreviewEnergy(); }
      });
    } else {
      // 平时：纯本地预览
      if (hudPreviewing) {
        renderHud(v);
        hudPreviewValue = v;
        resolvePreviewEnergy(); // 宠物情绪随预览实时变化
      }
    }
  });

  hudSlider.addEventListener('change', () => {
    if (adjustWin || !hudPreviewing) return;
    // 松手回弹：恢复滑动前的真实状态
    hudPreviewing = false;
    hudPreviewValue = null;
    hudBarTrack.classList.remove('previewing');
    const rest = clamp01(hudRestEnergy);
    hudSlider.value = String(rest);
    if (uiState) renderHud(uiState.energy);
    resolvePreviewEnergy(); // 情绪随之恢复到落库真值（或滑动卡预览值）
  });
}

/* ── 状态驱动（state:update 双窗共享推送） ── */

function enterHudAdjusting(w: AdjustWindow): void {
  stopCountdown();
  hudAdjustBadge.hidden = false;
  hudBarTrack.classList.add('live');
  renderAdjustCountdown();
  adjustCountdown = setInterval(renderAdjustCountdown, 250);
  hudSlider.value = String(w.draftEnergy);
  renderHud(w.draftEnergy);
  syncHudVisibility(); // 调节窗期间强制显示
  resolvePreviewEnergy(); // 调节窗打开：宠物情绪先落到草稿档位（取消/超时即恢复）
}

function exitHudAdjust(): void {
  stopCountdown();
  adjustWin = null;
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live', 'previewing');
  hudPreviewing = false;
  hudPreviewValue = null;
  if (uiState && !slidePreviewActive) restoreHudFromState();
  syncHudVisibility();
  resolvePreviewEnergy(); // 草稿作废或已落库：情绪恢复到真值（落库时随后的 cat:mood 推送接管）
}

function applyHudState(s: AppState): void {
  uiState = s;

  // 数字 + 格子填充（调节窗期间草稿优先、滑动卡预览期间不被真值覆盖；
  // 档位徽标已按 2026-10-27 用户裁决清除）
  if (!adjustWin && !slidePreviewActive) {
    hudNum.textContent = s.energy.toFixed(1);
    renderHudCells(s.energy);
    hudSlider.value = String(s.energy);
    hudRestEnergy = s.energy;
  }
  hudWeather.textContent = WEATHER_ICON[s.weather.condition] ?? '🌤️';

  // 调节窗相位（adjusting → 角标倒计时 + 可写滑条；confirming → 收起角标，弹窗在 uiWin）
  const aw = s.adjustWindow;
  if (aw) {
    const isNew = !adjustWin || adjustWin.refId !== aw.refId || adjustWin.openedAt !== aw.openedAt;
    adjustWin = aw;
    resolvePreviewEnergy(); // 草稿跟随（uiWin 卡片滑条微调也经此到达）；confirming 相位草稿仍有效
    if (isNew && aw.phase === 'adjusting') enterHudAdjusting(aw);
    if (aw.phase === 'adjusting') {
      if (!hudPreviewing) {
        hudSlider.value = String(aw.draftEnergy);
        hudNum.textContent = aw.draftEnergy.toFixed(1);
        renderHudCells(aw.draftEnergy);
      }
      syncHudVisibility();
    } else {
      stopCountdown();
      hudAdjustBadge.hidden = true;
      hudBarTrack.classList.remove('live');
    }
  } else if (adjustWin) {
    exitHudAdjust();
  }
}

// uiWin 滑动卡拖动 → 主进程转发的预览值（null = 预览结束）
window.cat.onHudPreview((v) => {
  if (adjustWin) return; // 调节窗优先，草稿不被预览覆盖
  if (v == null) {
    slidePreviewActive = false;
    slidePreviewValue = null;
    restoreHudFromState();
    resolvePreviewEnergy(); // 滑动卡收起：宠物情绪恢复落库真值
  } else {
    slidePreviewActive = true;
    slidePreviewValue = v;
    renderHud(v);
    resolvePreviewEnergy(); // 晨间卡/临时调节卡拖动：宠物情绪同步预览
  }
});

// 天气图标：点击 = 手动刷新实时天气（失败静默）。天气语义真的变了 → 主进程重推
// cat:mood → 头顶挂件即时切换（雨=落小雨 / 精力≥8+晴=出太阳），猫会吐槽一句；
// 没变则只静默同步图标与状态，不打扰。
hudWeather.addEventListener('click', () => {
  void window.pet.weatherRefresh().catch(() => { /* 静默 */ });
});

/* ── HUD 快捷入口（v1.x dock 回归）：任务面板 🎛️ / 精力恢复 ⚡ ──
 * 与猫右键菜单走同一主进程入口（cat:openEntry → openTasksPanel / openRecoveryMenu）。
 * 按钮在 HUD 胶囊内：命中区随「显示中的 HUD」整体上报，无需额外 hotRect 处理。 */
$('hud-panel').addEventListener('click', () => window.cat.openEntry('tasks'));
$('hud-recovery').addEventListener('click', () => window.cat.openEntry('recovery'));

initHudCells();
setupHudSlider();
window.pet.onState(applyHudState);
void window.pet.getState().then((s) => {
  if (!s) return;
  applyHudState(s);
  // 初始心情自取兜底：主进程启动期的 cat:mood 推送可能先于渲染层监听器注册
  //（IPC 即发即弃），而 cat:ready 触发的 pushMood 又被 JSON 去重吞掉 →
  // 猫可能整场跑在 NEUTRAL_MOOD 上（无 overlay/无脉冲/中性参数）。
  // getState 是 invoke（可靠请求/应答），AppState 恰好是 CatMoodPayload 的超集投影。
  if (!mood) adoptMood({ energy: s.energy, emotion: s.emotion, weather: s.weather });
}).catch(() => { /* noop */ });

/* ─────────────────────────── 心情层 ─────────────────────────── */

let mood: CatMoodPayload | null = null;
let moodParams: MoodParams = NEUTRAL_MOOD;
/** 情绪外化 FX 开关（computeMoodFx 产物；applyEffectiveMood 驱动，预览感知） */
let moodFx: MoodFx = EMPTY_MOOD_FX;
/** FX 绘制锚点：与皮肤 createSpriteSkin 的 cx/ground 同源 */
const FX_ANCHOR = { cx: CAT_CX, groundY: CAT_GROUND };
let lastIdleLineAt = 0;

/* ── 情绪预览层：宠物情绪随精力值调节实时变化，调节结束即恢复 ──
 * 三个预览源共用一个生效值（优先级：调节窗草稿 > HUD 平时拖动 > 滑动卡预览）：
 *   · HUD 滑块平时拖动 → 松手回弹即恢复（与 hudRestEnergy 回弹语义对齐）
 *   · uiWin 滑动卡预览（晨间卡/临时调节卡）→ hud:preview(null) 即恢复
 *   · 事件后调节窗草稿 → 打开即跟随草稿档位；取消/超时关闭恢复，落库由 cat:mood 接管
 * 预览只重算能量派生量（行为参数/天气挂件门槛/脉冲强度，走 withPreviewEnergy），
 * 不改 pulse 种类与叙事字段——草稿未进事件流，落库真值才是唯一事实源。 */

let previewEnergy: number | null = null;
/** 预览期间被「拖睡」的标记：预览结束未落库时必须撤销（恢复须彻底） */
let sleepOnsetDuringPreview = false;

function setPreviewEnergy(v: number | null): void {
  if (previewEnergy === v) return;
  if (v == null) {
    // 预览结束（回弹/取消/关闭调节窗）：若睡眠是预览压出来的，撤销它——
    // wakeUp 重置 lastAct，之后是否再睡由落库真值的 sleepIdleMs 决定
    if (sleepOnsetDuringPreview && fsm.st === 'sleep') fsm.wakeUp();
    sleepOnsetDuringPreview = false;
  }
  previewEnergy = v;
  applyEffectiveMood();
}

/** 三源合一 → 单一预览精力值（全空 = 无预览，走落库心情） */
function resolvePreviewEnergy(): void {
  const v = adjustWin ? adjustWin.draftEnergy : (hudPreviewValue ?? slidePreviewValue);
  setPreviewEnergy(v ?? null);
}

/** 有效心情 = 预览精力（调节中）?? 落库精力；行为参数与皮肤层同步重算 */
function applyEffectiveMood(): void {
  if (!mood) return;
  const eff = withPreviewEnergy(mood, previewEnergy);
  moodParams = computeMoodParams(eff);
  // 情绪外化 FX（原版 composeAppearance 移植）：预览同样驱动 —— 拖滑条 👻/✨/金光实时切换
  moodFx = computeMoodFx(eff.energy, eff.emotion);
  if (!spriteSkin) return;
  spriteSkin.setOverlay(eff.emotion.overlay);
  const intensity = eff.emotion.pulseActive ? pulseIntensity(eff.emotion.pulse, eff.energy) : 0;
  spriteSkin.setPulse(eff.emotion.pulse, intensity);
}

/* ─────────────────────────── FSM ─────────────────────────── */

const fsm = new CatFsm({
  moveWindow: (x, y) => window.cat.moveWindow(x, y),
  setDragActive: (on) => window.cat.setDragActive(on),
  bubble: () => {}, // 气泡台词已按用户要求移除（2026-10-27）：猫不再说话，情绪全部由身体语言表达
  playExpr: (name) => (spriteSkin ? spriteSkin.playExpression(name) : false),
  moodParams: () => moodParams,
  petLines: () => petLines(mood?.energy ?? 7),
});
fsm.attachMouse(canvas);

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.cat.showMenu();
});

window.cat.onKey((d) => fsm.onKey(d));

let keyWarned = false;
window.cat.onCmd((d) => {
  fsm.applyCmd(d, (ok) => {
    if (!ok && !keyWarned) {
      keyWarned = true;
      console.warn('[cat] 敲键监听缺权限（辅助功能）；右键菜单可打开系统设置');    } else if (ok) keyWarned = false;
  });
  if (d.type === 'skins-updated') void loadSkin();
});

/** 采纳一份心情（cat:mood 推送 或 getState 兜底投影）：首帧问候只触发一次 */
function adoptMood(m: CatMoodPayload): void {
  mood = m;
  applyEffectiveMood(); // 调节窗草稿仍在时，落库推送不打断预览（预览值优先）
}

window.cat.onMood(adoptMood);

window.cat.onReact((r: CatReactPayload) => {
  const fx = reactionFor(r.reaction, mood);
  if (fx.wake) fsm.wakeUp();
  if (fx.expr && spriteSkin) spriteSkin.playExpression(fx.expr);
});

/* ─────────────────────────── 皮肤 ─────────────────────────── */

let spriteSkin: SpriteSkin | null = null;

async function loadSkin(): Promise<void> {
  try {
    const skin = (await window.cat.getSkin()) as { fps?: number; assets?: SkinAssetsV2 } | null;
    if (!skin) return;
    spriteSkin = await createSpriteSkin(skin.assets ?? {}, {
      ctx,
      cx: CAT_CX,
      ground: CAT_GROUND,
      fps: skin.fps ?? 8,
      targetHeight: 250,
    });
    applyEffectiveMood();
    console.log('[skin] 皮肤就绪');
  } catch (e) {
    console.warn('[skin] 加载失败,回退程序化猫', e);
  }
}

/* ─────────────────────────── 主循环 ─────────────────────────── */

let prev = performance.now();
let prevFrameSt = fsm.st;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  fsm.update(dt);
  // 预览期间入睡 = 草稿压出来的睡眠：打标记，预览结束未落库时由 setPreviewEnergy(null) 撤销
  if (previewEnergy != null && fsm.st === 'sleep' && prevFrameSt !== 'sleep') sleepOnsetDuringPreview = true;
  prevFrameSt = fsm.st;
  const pose = fsm.computePose();
  // 程序化回退猫的睡眠补偿：原版靠 sy*=0.74 画出蜷缩感；图像皮肤 sleep 帧已是卧姿，
  // FSM 不再统一压扁（用户反馈 2026-10-27），仅回退渲染器在此补偿
  const fbPose = fsm.st === 'sleep' ? { ...pose, sy: pose.sy * 0.74 } : pose;
  ctx.clearRect(0, 0, CAT_W, CAT_H);
  // 窗口只能整数步进(Math.round)，把亚像素余量交给画布层补偿 → 不再有 0/1px 交替微跳
  const subX = fsm.subX();
  // 情绪 FX 本体级位移（狂喜弹跳/雷暴发抖）：皮肤与回退猫都随 translate 整体动
  const fxOff = moodFxBodyOffset(moodFx, fsm.t, fsm.st);
  if (spriteSkin) {
    try {
      const perchWalk = fsm.st === 'perch' && fsm.perchMode === 'walk';
      // 自定义姿势：皮肤帧源走 def.useState（缺省 idle），姿势变换由 pose 参数承载
      const poseState = fsm.poseSkinState;
      ctx.save();
      ctx.translate(fxOff.dx, fxOff.dy);
      drawMoodFxBack(ctx, moodFx, fsm.t, FX_ANCHOR); // 金色背光（本体之后会盖住中心，先画）
      spriteSkin.draw(pose, fsm.t, {
        state: poseState ?? (perchWalk ? 'walk' : fsm.st),
        stateT: fsm.stT,
        dt,
        squashT: fsm.squashT,
        air: fsm.air(),
        speed: fsm.currentVelocity(), // 真实平滑步速：加减速阶段步频随位移锁定（报巡航值会脚滑）
        subX,
      });
      // 本体色温（方案A）：低精力暖灰黯淡 / 高精力暖金+轮廓光；用平滑 vitality，与体态同 τ=0.55s 渐变
      drawEnergyTint(ctx, fsm.vitality() * 10, FX_ANCHOR);
      ctx.restore();
    } catch (e) {
      // 皮肤异常时回退程序化猫，保证循环不断
      console.warn('[skin] 渲染异常,回退程序化猫', e);
      spriteSkin = null;
      ctx.save();
      ctx.translate(subX, 0);
      drawFallbackCat(ctx, fbPose, { t: fsm.t, air: fsm.air() });
      ctx.restore();
    }
  } else {
    ctx.save();
    ctx.translate(subX + fxOff.dx, fxOff.dy);
    drawMoodFxBack(ctx, moodFx, fsm.t, FX_ANCHOR);
    drawFallbackCat(ctx, fbPose, { t: fsm.t, air: fsm.air() });
    drawEnergyTint(ctx, fsm.vitality() * 10, FX_ANCHOR);
    ctx.restore();
  }
  fsm.syncWindow();

  // 闲时低频表情点缀（约每 90s+ 一次机会，只在 idle 且非 UI hold 时）：
  // 猫不再说话（气泡台词已按用户要求移除 2026-10-27）——高精力档偶尔闪一段开心表情，纯身体语言
  if (
    mood && fsm.st === 'idle' && !fsm.uiHold && !fsm.paused
    && fsm.t - lastIdleLineAt > 90 && Math.random() < 0.0003
    && moodParams.vitality >= 0.75 && spriteSkin
  ) {
    lastIdleLineAt = fsm.t;
    spriteSkin.playExpression('happy');
  }

  requestAnimationFrame(frame);
}

/* ─────────────────────────── 启动 ─────────────────────────── */

// 错误黑匣子：渲染进程异常上报主进程 crash.log
window.addEventListener('error', (e) => {
  window.cat.reportError({ source: 'cat-window', message: e.message, stack: e.error?.stack as string | undefined });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.cat.reportError({ source: 'cat-window', message: String(r?.message ?? r), stack: r?.stack as string | undefined });
});

void window.cat.getLayout().then((l) => {
  fsm.initLayout(l);
  fsm.syncWindow();
  window.cat.ready();
  // 命中区：猫体（窗口坐标恒定：猫画在固定锚点，窗口随猫走）+ HUD（显示时追加）
  reportCatHotRects();
  void loadSkin();
  requestAnimationFrame(frame);
});

// 调试/自测把手：devtools 里 petDebug.play('surprise') / petDebug.climb(id) 可直接触发
window.petDebug = {
  fsm,
  state: () => fsm.st,
  play: (n: string) => (spriteSkin ? spriteSkin.playExpression(n) : false),
  exprLoaded: () => !!spriteSkin,
  gait: () => spriteSkin?.gaitInfo() ?? null,
  mood: () => mood,
  moodParams: () => moodParams,
  moodFx: () => moodFx,
  tint: () => energyTint(fsm.vitality() * 10),
  ledges: () => fsm.ledges,
  surface: () => fsm.surfaceId,
  climb: (id: number | string) => {
    const l = fsm.ledgeById(id);
    if (l) fsm.startClimb(l);
    return !!l;
  },
  fall: () => fsm.startFall(),
  /** 自定义姿势：petDebug.playPose({ id:'x', name:'测试', duration:2, pose:{sx:1.2} }) */
  playPose: (def: CustomPoseDef) => fsm.playPose(def),
  poseSkinState: () => fsm.poseSkinState,
  setMood: (m: CatMoodPayload) => {
    mood = m;
    applyEffectiveMood();
  },
  /** 情绪预览把手：petDebug.preview(2.5) 模拟调节草稿；petDebug.preview(null) 恢复落库心情 */
  preview: (v: number | null) => { setPreviewEnergy(v == null ? null : Number(v) || 0); return previewEnergy; },
  previewEnergy: () => previewEnergy,
};
