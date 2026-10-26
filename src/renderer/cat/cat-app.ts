/**
 * 猫窗口入口 —— 装配 FSM × 皮肤渲染器 × 心情层 × 壳层 IPC。
 *
 * 数据流（docs/cream-fusion.md §3）：
 *   window.cat.onMood(领域心情) → mood.ts 参数 → FSM 活力/表情/overlay/光晕
 *   window.cat.onReact(领域事件) → 表情插播 + 气泡文案
 *   window.cat.onCmd(壳层命令)  → FSM.applyCmd / 皮肤热重载
 *   FSM px/py → window.cat.moveWindow（渲染层拥有窗口位置）
 */

import type { CatApi } from '../../preload/index.js';
import type { CatMoodPayload, CatReactPayload } from '../../core/types.js';
import { CatFsm, CAT_W, CAT_H, CAT_GROUND, CAT_CX } from './cat-fsm.js';
import { createSpriteSkin, type SpriteSkin, type SkinAssetsV2 } from './sprite-skin.js';
import { drawFallbackCat } from './fallback-cat.js';
import { computeMoodParams, reactionFor, petLines, greetingLine, idleLine, NEUTRAL_MOOD, type MoodParams } from './mood.js';
import { pulseIntensity } from '../../emotion/pulse-contract.js';
import { tierFor } from '../../emotion/engine.js';

declare global {
  interface Window {
    cat: CatApi;
    petDebug?: Record<string, unknown>;
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const bubbleEl = document.getElementById('bubble') as HTMLDivElement;
const pillEl = document.getElementById('energy-pill') as HTMLDivElement;
const pillNum = document.getElementById('ep-num') as HTMLSpanElement;
const pillTier = document.getElementById('ep-tier') as HTMLSpanElement;
document.addEventListener('dragstart', (e) => e.preventDefault());

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

/* ─────────────────────────── 精力值胶囊（绑定桌宠下方，悬浮显示） ─────────────────────────── */

let pillHideTimer: ReturnType<typeof setTimeout> | null = null;

/** 鼠标悬浮到猫身上 → 显示精力值；离开/静止 1.2s 后自动收起 */
function showPill(): void {
  pillEl.classList.add('show');
  if (pillHideTimer) clearTimeout(pillHideTimer);
  pillHideTimer = setTimeout(() => pillEl.classList.remove('show'), 1200);
}

function updatePill(): void {
  if (!mood) return;
  pillNum.textContent = mood.energy.toFixed(1);
  pillTier.textContent = tierFor(mood.energy).label;
}

// 命中区轮询保证光标在猫身上时窗口可交互 → mousemove 即悬浮信号；
// 光标离开热区后主进程切回穿透，事件流停止，靠定时器收起。
window.addEventListener('mousemove', showPill);
window.addEventListener('mouseleave', () => {
  if (pillHideTimer) clearTimeout(pillHideTimer);
  pillEl.classList.remove('show');
});

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
  updatePill(); // 悬浮胶囊的数值/档位随心情推送实时刷新
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
  // 猫体命中区（窗口坐标恒定：猫画在固定锚点，窗口随猫走）
  window.cat.hotRect({ x: CAT_CX - 88, y: CAT_GROUND - 262, w: 176, h: 268 });
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
