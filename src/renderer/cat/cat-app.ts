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
import type { AdjustWindow, AppState, CatMoodPayload, CatReactPayload } from '../../core/types.js';
import { ENERGY_MAX } from '../../core/types.js';
import { CatFsm, CAT_W, CAT_H, CAT_GROUND, CAT_CX } from './cat-fsm.js';
import { createSpriteSkin, type SpriteSkin, type SkinAssetsV2 } from './sprite-skin.js';
import { drawFallbackCat } from './fallback-cat.js';
import { computeMoodParams, reactionFor, petLines, greetingLine, idleLine, NEUTRAL_MOOD, type MoodParams } from './mood.js';
import { pulseIntensity } from '../../emotion/pulse-contract.js';
import { tierFor } from '../../emotion/engine.js';

declare global {
  interface Window {
    cat: CatApi;
    pet: PetApi; // 与 uiWin 共享同一 preload：HUD 迁移后领域 API 直接在猫窗口可用
    petDebug?: Record<string, unknown>;
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const bubbleEl = document.getElementById('bubble') as HTMLDivElement;
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
const hudTier = $('hud-tier');
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

/* ─────────────────────────── 气泡 ─────────────────────────── */

let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
function bubble(text: string, ms = 1600): void {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms);
}

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
/** uiWin 滑动卡预览中：HUD 显示预览值，不被状态推送的真值覆盖 */
let slidePreviewActive = false;

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

/** 本地即时反馈：数字 + 格子 + 档位（全部不落库） */
function renderHud(v: number): void {
  hudNum.textContent = v.toFixed(1);
  renderHudCells(v);
  hudTier.textContent = tierFor(v).label;
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
      void window.pet.adjustDraft(v).then((w) => {
        if (w) { adjustWin = w; renderAdjustCountdown(); }
      });
    } else {
      // 平时：纯本地预览
      if (hudPreviewing) renderHud(v);
    }
  });

  hudSlider.addEventListener('change', () => {
    if (adjustWin || !hudPreviewing) return;
    // 松手回弹：恢复滑动前的真实状态
    hudPreviewing = false;
    hudBarTrack.classList.remove('previewing');
    const rest = clamp01(hudRestEnergy);
    hudSlider.value = String(rest);
    if (uiState) renderHud(uiState.energy);
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
}

function exitHudAdjust(): void {
  stopCountdown();
  adjustWin = null;
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live', 'previewing');
  hudPreviewing = false;
  if (uiState && !slidePreviewActive) restoreHudFromState();
  syncHudVisibility();
}

function applyHudState(s: AppState): void {
  uiState = s;

  // 数值/档位（调节窗期间显示草稿档位、滑动卡预览期间不被真值覆盖）
  if (adjustWin) {
    hudTier.textContent = tierFor(adjustWin.draftEnergy).label;
  } else if (!slidePreviewActive) {
    hudNum.textContent = s.energy.toFixed(1);
    renderHudCells(s.energy);
    hudSlider.value = String(s.energy);
    hudRestEnergy = s.energy;
    hudTier.textContent = tierFor(s.energy).label;
  }
  hudWeather.textContent = WEATHER_ICON[s.weather.condition] ?? '🌤️';

  // 调节窗相位（adjusting → 角标倒计时 + 可写滑条；confirming → 收起角标，弹窗在 uiWin）
  const aw = s.adjustWindow;
  if (aw) {
    const isNew = !adjustWin || adjustWin.refId !== aw.refId || adjustWin.openedAt !== aw.openedAt;
    adjustWin = aw;
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
    restoreHudFromState();
  } else {
    slidePreviewActive = true;
    renderHud(v);
  }
});

// 天气图标：点击 = 静默刷新（只更新图标，沿旧需求 4）
hudWeather.addEventListener('click', () => {
  void window.pet.weatherRefresh().catch(() => { /* 静默 */ });
});

initHudCells();
setupHudSlider();
window.pet.onState(applyHudState);
void window.pet.getState().then((s) => { if (s) applyHudState(s); }).catch(() => { /* noop */ });

/* ─────────────────────────── 心情层 ─────────────────────────── */

let mood: CatMoodPayload | null = null;
let moodParams: MoodParams = NEUTRAL_MOOD;
let greeted = false;
let lastIdleLineAt = 0;

function applyMoodToSkin(): void {
  if (!mood || !spriteSkin) return;
  spriteSkin.setOverlay(mood.emotion.overlay);
  const intensity = mood.emotion.pulseActive ? pulseIntensity(mood.emotion.pulse, mood.energy) : 0;
  spriteSkin.setPulse(mood.emotion.pulse, intensity);
}

/* ─────────────────────────── FSM ─────────────────────────── */

const fsm = new CatFsm({
  moveWindow: (x, y) => window.cat.moveWindow(x, y),
  setDragActive: (on) => window.cat.setDragActive(on),
  bubble,
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
      bubble('敲键监听没权限,右键我可打开设置', 3200);
    } else if (ok) keyWarned = false;
  });
  if (d.type === 'skins-updated') void loadSkin();
});

window.cat.onMood((m) => {
  mood = m;
  moodParams = computeMoodParams(m);
  applyMoodToSkin();
  if (!greeted) {
    greeted = true;
    setTimeout(() => bubble(greetingLine(m), 3200), 1400);
  }
});

window.cat.onReact((r: CatReactPayload) => {
  const fx = reactionFor(r.reaction, mood);
  if (fx.wake) fsm.wakeUp();
  if (fx.expr && spriteSkin) spriteSkin.playExpression(fx.expr);
  const text = r.text ?? fx.text;
  if (text) bubble(text, fx.ms);
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
    applyMoodToSkin();
    console.log('[skin] 皮肤就绪');
  } catch (e) {
    console.warn('[skin] 加载失败,回退程序化猫', e);
  }
}

/* ─────────────────────────── 主循环 ─────────────────────────── */

let prev = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  fsm.update(dt);
  const pose = fsm.computePose();
  ctx.clearRect(0, 0, CAT_W, CAT_H);
  if (spriteSkin) {
    try {
      const perchWalk = fsm.st === 'perch' && fsm.perchMode === 'walk';
      spriteSkin.draw(pose, fsm.t, {
        state: perchWalk ? 'walk' : fsm.st,
        stateT: fsm.stT,
        dt,
        squashT: fsm.squashT,
        air: fsm.air(),
        speed: fsm.currentSpeed(), // 供步态引擎做速度同步
      });
    } catch (e) {
      // 皮肤异常时回退程序化猫，保证循环不断
      console.warn('[skin] 渲染异常,回退程序化猫', e);
      spriteSkin = null;
      drawFallbackCat(ctx, pose, { t: fsm.t, air: fsm.air() });
    }
  } else {
    drawFallbackCat(ctx, pose, { t: fsm.t, air: fsm.air() });
  }
  fsm.syncWindow();

  // 闲时低频自言自语（约每 2–3 分钟一次机会，只在 idle 且非 UI hold 时；
  // 文案是否真说由 idleLine 按情绪档决定——中间档基本沉默）
  if (
    mood && fsm.st === 'idle' && !fsm.uiHold && !fsm.paused
    && fsm.t - lastIdleLineAt > 90 && Math.random() < 0.0003
  ) {
    const line = idleLine(mood.emotion.base, mood.energy);
    if (line) {
      lastIdleLineAt = fsm.t;
      bubble(line, 3000);
    }
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
  setTimeout(() => bubble('喵~ 拖我甩我点点我', 2600), 800);
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
  ledges: () => fsm.ledges,
  surface: () => fsm.surfaceId,
  climb: (id: number | string) => {
    const l = fsm.ledgeById(id);
    if (l) fsm.startClimb(l);
    return !!l;
  },
  fall: () => fsm.startFall(),
  setMood: (m: CatMoodPayload) => {
    mood = m;
    moodParams = computeMoodParams(m);
    applyMoodToSkin();
  },
};
