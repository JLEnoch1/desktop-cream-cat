/**
 * 渲染进程控制器 —— 串联 PetRenderer / 滑动确认 / 面板 / 推荐卡 / hitTest。
 *
 * 数据流：主进程 pushState(AppState) → 本模块 diff 渲染。
 * 写操作全部经 window.pet.* IPC → Coordinator → DecisionLog（事件流）。
 */

import { PetRenderer } from './pet.js';
import { tierFor, PULSE_THRESHOLD, describe as describeEmotion } from '../emotion/engine.js';
import { ENERGY_MAX } from '../core/types.js';
import type { AppState, PendingSlide, InsightRecommendation, WeeklyReportPayload, RecoveryItem, AdjustWindow, TaskDurationRequest } from '../core/types.js';

declare global {
  interface Window {
    pet: import('../preload/index.js').PetApi;
  }
}

/* ─────────────────────────── 错误黑匣子 ─────────────────────────── */

/** 渲染进程异常统一上报主进程 crash.log，闪退后可事后定位 */
window.addEventListener('error', (e) => {
  try { window.pet?.reportError({ source: 'onerror', message: e.message, stack: (e.error as Error | undefined)?.stack }); } catch { /* noop */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  try {
    window.pet?.reportError({
      source: 'unhandledrejection',
      message: r instanceof Error ? r.message : String(r),
      stack: r instanceof Error ? r.stack : undefined,
    });
  } catch { /* noop */ }
});

/* ─────────────────────────── DOM 引用 ─────────────────────────── */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const petWrap = $('pet-wrap');
const petCanvas = $<HTMLCanvasElement>('pet-canvas');
const hud = $('energy-hud');
const hudNum = $('hud-num');
const hudCells = $('hud-cells');
const hudTier = $('hud-tier');
const hudWeather = $('hud-weather');
// HUD 进度条 = 精力调节的「平时预览」入口（无窗口时拖动只预览、松手回弹）
const hudSlider = $<HTMLInputElement>('hud-slider');
const hudBarTrack = $('hud-bar-track');

/* ── HUD 精力条：10 个格子（每格 1 分，ENERGY_MAX=10）──
 * 需求 3：锁定态同样用 10 格显示；触碰精力条时样式不变（无 hover 形变）。
 * 满格全亮，当前格按小数比例填充，其余熄灭。previewing/live 态由 CSS 作用于 .cell i。 */
const HUD_CELL_COUNT = ENERGY_MAX;
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

initHudCells();
const hudAdjustBadge = $('hud-adjust-badge');
const hudAdjustCount = $('hud-adjust-count');

const slideCard = $('slide-card');
const sTitle = $('s-title');
const sSub = $('s-sub');
const sValue = $<HTMLElement>('s-value');
const sDelta = $('s-delta');
const sPredicted = $('s-predicted');
const sPredictedRow = $('s-predicted-row');
const sBaseMark = $('s-base-mark');
const sSlider = $<HTMLInputElement>('s-slider');
const sMin = $('s-min');
const sMid = $('s-mid');
const sMax = $('s-max');
const sNote = $<HTMLTextAreaElement>('s-note');
const sConfirm = $<HTMLButtonElement>('s-confirm');
const sCancel = $<HTMLButtonElement>('s-cancel');

// 任务时长确认卡（流程第一步：先确认实际时长，再调精力）
const durationCard = $('duration-card');
const dSub = $('d-sub');
const dMinutes = $<HTMLInputElement>('d-minutes');
const dEst = $('d-est');
const dConfirm = $<HTMLButtonElement>('d-confirm');
const dCancel = $<HTMLButtonElement>('d-cancel');

// 精力调节确认弹窗（7 秒窗口结束后弹出）
const adjustCard = $('adjust-card');
const aSub = $('a-sub');
const aCurrent = $('a-current');
const aDefault = $('a-default');
const aDelta = $('a-delta');
const aDefaultMark = $('a-default-mark');
const aSlider = $<HTMLInputElement>('a-slider');
const aNote = $<HTMLTextAreaElement>('a-note');
const aConfirm = $<HTMLButtonElement>('a-confirm');
const aCancel = $<HTMLButtonElement>('a-cancel');

const panel = $('panel');
const panelSub = $('panel-sub');
// 精力恢复表情菜单（dock ⚡ 唤起；炉石式径向弹出）
const recoveryPop = $('recovery-pop');
const rpRing = $('rp-ring');
const versionSlot = $('version-slot');
const taskList = $('task-list');
const taskTitle = $<HTMLInputElement>('task-title');
const taskCost = $<HTMLInputElement>('task-cost');
const taskMinutes = $<HTMLInputElement>('task-minutes');
// 周报弹窗（每天 17:30 自动弹；周五需确认）
const reportModal = $('report-modal');
const rmRange = $('rm-range');
const rmList = $('rm-list');
const rmAiSec = $('rm-ai-sec');
const rmAi = $('rm-ai');
const rmDecSec = $('rm-dec-sec');
const rmDec = $('rm-dec');
const rmNote = $('rm-note');
const recStack = $('rec-stack');
const toastEl = $('toast');

/* ─────────────────────────── 状态 ─────────────────────────── */

let pet: PetRenderer;
let state: AppState | null = null;
let slide: PendingSlide | null = null;
let previewDebounce: ReturnType<typeof setTimeout> | null = null;
let shownRecIds = new Set<string>();
/** 当前显示的周报弹窗日期（YYYY-MM-DD）；null = 未显示。用于检测主进程推送的新弹窗 */
let shownReportDate: string | null = null;
/** 精力恢复表情菜单的内容签名：未变则跳过重建 chip（避免每次 applyState 重放弹出动画） */
let lastRecoverySig = '';
let hudVisible = false;

/* ── 事件后调节窗口（渲染侧镜像） ── */
/** 主进程 AdjustWindow 的本地镜像；null = 无窗口（HUD 滑块只预览） */
let adjustWin: AdjustWindow | null = null;
/** 调节窗口的本地倒计时（remainingMs 每秒递减，到 0 切 confirming 视图） */
let adjustCountdown: ReturnType<typeof setInterval> | null = null;
/** 待确认时长的任务（流程第一步）；null = 时长卡未打开 */
let durationReq: TaskDurationRequest | null = null;
/** HUD 滑块「平时拖动」的预览态：松手回弹到滑动前的值 */
let hudPreviewing = false;
/** 滑动前 HUD 记录的真实精力（回弹目标） */
let hudRestEnergy = 0;

/* ─────────────────────────── 工具 ─────────────────────────── */

function toast(msg: string, ms = 2200): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), ms);
}

function fmtDelta(v: number): string {
  const r = Math.round(v * 2) / 2; // 0.5 步长
  return r > 0 ? `+${r}` : String(r);
}

const WEATHER_ICON: Record<string, string> = {
  sunny: '☀️', cloudy: '☁️', rain: '🌧️', thunderstorm: '⛈️',
};

/* ─────────────────────────── 命中区上报（click-through 核心） ─────��───────────────────── */

type HotRect = { x: number; y: number; w: number; h: number };

/**
 * 宠物本体在**窗口坐标系**内的矩形（已按视口裁剪）。
 *
 * 为什么必须有这个唯一换算点：`pet.petBounds()` 返回的是**画布局部坐标**
 * （原点在 pet-canvas 左上角，y≈52–104）；而 pet-wrap 在窗口内是 bottom 定位
 * （顶边落在窗口 y≈384），主进程的拖拽钳制与命中区判定要的都是**窗口坐标**
 * （本体实际 y≈436–602）。
 *
 * 上一版拖拽钳制失效正是栽在这里：dragStart 误传了画布局部坐标，
 * 导致 minY = workArea.y - 104 而非 - 436，钳制死点几乎没变，宠物仍拖不上半屏。
 * 热区上报（collectHotRects）此前是各自内联换算的，正确但与拖拽不同源——
 * 现在两处都走这个函数，坐标系永不分叉。
 */
function petBodyInWindow(): HotRect | null {
  if (!pet) return null;
  const wrapRect = petWrap.getBoundingClientRect();
  const b = pet.petBounds();
  const x = Math.max(0, Math.round(wrapRect.left + b.x));
  const y = Math.max(0, Math.round(wrapRect.top + b.y));
  const w = Math.round(Math.min(window.innerWidth - x, b.w));
  const h = Math.round(Math.min(window.innerHeight - y, b.h));
  if (w < 2 || h < 2) return null;
  return { x, y, w, h };
}

/**
 * 收集当前可交互元素的窗口内包围盒。
 * 主进程按 50ms 轮询光标判断是否命中，命中才关闭鼠标穿透。
 *
 * 注意：这里是唯一的命中来源，不要再往主进程发状态式 hitTest，
 * 两套机制并存会导致 ignore 状态打架、原生层高频切换而崩溃。
 */
function collectHotRects(): HotRect[] {
  const rects: HotRect[] = [];
  const seen = new Set<string>();

  /**
   * 是否可命中。
   *
   * display / visibility / opacity 会让整棵子树真正不可见，需要查祖先链；
   * 但 pointer-events 只能看元素自身 —— CSS 里子元素可用 auto 覆盖祖先的 none
   * （本项目的 #stage 就是 pointer-events:none，靠 [data-interactive]{auto} 打开）。
   * 早期把 pointer-events 也纳入祖先链判断，导致所有元素被过滤、窗口永久穿透。
   *
   * 显隐由 class 控制的容器（slide-card/.show、panel/.open）额外按 class 判定：
   * 关闭动画期间 computed opacity 仍 > 0，但命中区必须立刻回收，
   * 否则「对话框关了，那块区域还挡着桌面」（过渡期没有 DOM 变更事件，
   * MutationObserver 不会触发，只能等 1.5s 兜底 —— 这就是残留的来源）。
   */
  const explicitHidden = (el: Element): boolean => {
    if (el.id === 'slide-card' && !el.classList.contains('show')) return true;
    if (el.id === 'panel' && !el.classList.contains('open')) return true;
    // 精力恢复表情菜单：chip 挂在 #recovery-pop 内，收起动画期间立即回收命中区
    if ((el.id === 'recovery-pop' || el.closest?.('#recovery-pop')) && !recoveryPop.classList.contains('show')) return true;
    // 周报弹窗：同理（每天 17:30 弹出，确认后收起）
    if (el.id === 'report-modal' && !el.classList.contains('show')) return true;
    // 时长卡 / 调节弹窗 / 精力 HUD 同样按 class 判定：
    // 关闭动画期间 computed opacity 仍 > 0.05，但命中区必须立刻回收，
    // 否则「卡片关了，那块区域还挡着桌面」
    if ((el.id === 'duration-card' || el.id === 'adjust-card') && !el.classList.contains('show')) return true;
    if (el.id === 'energy-hud' && !el.classList.contains('show')) return true;
    if (el.classList.contains('leaving')) return true; // 推荐卡退场动画期间
    return false;
  };

  const hittable = (el: Element): boolean => {
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (explicitHidden(cur)) return false;
      const st = getComputedStyle(cur as HTMLElement);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (Number(st.opacity) < 0.05) return false;
      cur = cur.parentElement;
    }
    return getComputedStyle(el as HTMLElement).pointerEvents !== 'none';
  };

  const push = (el: Element | null): void => {
    if (!el || !hittable(el)) return;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    // 裁剪到视口：窗口内坐标，超出部分永远拿不到点击
    const x = Math.max(0, Math.round(r.left));
    const y = Math.max(0, Math.round(r.top));
    const w = Math.round(Math.min(window.innerWidth, r.right) - x);
    const h = Math.round(Math.min(window.innerHeight, r.bottom) - y);
    if (w < 2 || h < 2) return;
    const key = `${x},${y},${w},${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    rects.push({ x, y, w, h });
  };

  // 常驻交互容器。
  // 宠物命中区 = 实际绘制的主体范围（petBounds），而不是整个 canvas 盒子 ——
  // 透明窗口里「画布比可点击范围大」会造成点击错位与桌面遮挡。
  // 走唯一换算点 petBodyInWindow()，与拖拽钳制同源（均为窗口坐标）。
  const body = petBodyInWindow();
  if (body) rects.push(body);
  for (const sel of ['#dock', '#panel', '#report-modal', '#slide-card', '#duration-card', '#adjust-card', '#energy-hud'] as const) push(document.querySelector(sel));
  // 精力恢复表情菜单：#recovery-pop 是 inset:0 全屏**穿透容器**，绝不能整块上报
  // （否则整窗永久不可穿透）。只上报实际可见的 chip（弹出动画期间 opacity<0.05 会被
  // hittable 过滤；显隐由 recoveryPop.show 类控制，见 explicitHidden）。
  // 版本历史浮层同理，仅在存在时上报。
  if (recoveryPop.classList.contains('show')) {
    document.querySelectorAll('#recovery-pop .rp-chip').forEach(push);
    push(versionSlot.querySelector('.version-pop'));
  }
  // 推荐卡：只取实际卡片，避免空容器占位导致整块区域不可穿透
  document.querySelectorAll('#rec-stack > *').forEach(push);
  return rects;
}

/* ── 模块级热区上报 ──
 *
 * 为什么不再放在 setupHitTest 闭包里：面板/卡片收起时必须**同步立即**回收热区。
 * MutationObserver → 200ms 节流那条路太慢 —— 空窗内光标若停在旧面板区，
 * 主进程轮询仍命中过期 rect，窗口保持可交互，表现为「面板关了，那块还挡鼠标」。
 * 现在 showSlide/hideSlide/panel open/close 等状态切换点都直接调 reportHotRects()。
 */
let hotReportLastJson = '';
let hotReportPending = 0;

/** 立即重算并上报热区（内容无变化时自动跳过，可安全高频调用） */
function reportHotRects(): void {
  const rects = collectHotRects();
  const json = JSON.stringify(rects);
  if (json === hotReportLastJson) return;
  hotReportLastJson = json;
  // 调试钩子：自检/排障时可从主进程读取（不影响正常运行）
  (window as unknown as { __hotRects?: HotRect[] }).__hotRects = rects;
  window.pet.hitRects(rects);
}

/** 200ms 节流上报：布局变化通常成批到达（渲染列表、卡片显隐） */
function scheduleHotReport(): void {
  if (hotReportPending) return;
  hotReportPending = window.setTimeout(() => { hotReportPending = 0; reportHotRects(); }, 200);
}

function setupHitTest(): void {
  // 布局/内容变化即重算
  new ResizeObserver(scheduleHotReport).observe(document.body);
  new MutationObserver(scheduleHotReport).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style'],
  });
  // 兜底：低开销周期校对（CSS 过渡完成后尺寸可能与上报时有偏差）
  setInterval(reportHotRects, 1500);

  // 指针移动也会改变布局可见性（dock 悬停显隐）。mousemove 不节流会 IPC 风暴，
  // 这里只做「变化检测」：悬停态翻转时排两次上报（进入立即 + 过渡结束后），
  // 保证显/隐两个方向都不会残留过期命中区。
  let lastOverStage: boolean | null = null;
  window.addEventListener('mousemove', (e) => {
    const overStage = e.clientY >= window.innerHeight - 260;
    if (overStage !== lastOverStage) {
      lastOverStage = overStage;
      scheduleHotReport();
      window.setTimeout(reportHotRects, 450); // dock 过渡 .25s，结束后复核一次
    }
  }, { passive: true });

  // HUD 悬停：窗口只在宠物/HUD 上方接事件，指针离开时立刻收起。
  // 例外：拖动 HUD 滑块中（hudPreviewing）或调节窗口开启期间必须保持可见，
  // 否则指针一移到 HUD 上它就消失，滑块根本拖不了。
  window.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overPet = !!el?.closest('#pet-wrap') || !!el?.closest('#energy-hud');
    const keep = hudPreviewing || !!adjustWin;
    if (overPet !== hudVisible && !keep) {
      hudVisible = overPet;
      hud.classList.toggle('show', overPet);
    } else if (keep && !hudVisible) {
      hudVisible = true;
      hud.classList.add('show');
    }
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    if (hudVisible && !hudPreviewing && !adjustWin) { hudVisible = false; hud.classList.remove('show'); }
  });

  reportHotRects(); // 首个渲染帧即可交互
}

/* ─────────────────────────── 宠物拖拽 ─────────────────────────── */

function setupDrag(): void {
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  const endDrag = (treatAsClick: boolean): void => {
    if (!dragging) return;
    dragging = false;
    petWrap.classList.remove('dragging');
    window.pet.dragEnd();
    pet.dragEnd();
    if (treatAsClick && !moved) {
      // 没拖动 → 视为点击：仅触发表情/形变反应（压平 + 连点甩墙），不再弹文字气泡
      pet.poke();
    }
  };

  petWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 命中校验：只有落在宠物**实际主体**包围盒内才启动拖拽/点击。
    // 画布盒子（240×230）比本体（实测 137×166）大，透明边缘若也响应
    // 会误触发拖拽（用户想点背后/旁边的控件却被宠物抢走）。
    const wrapRect = petWrap.getBoundingClientRect();
    const b = pet.petBounds();
    const lx = e.clientX - wrapRect.left;
    const ly = e.clientY - wrapRect.top;
    if (lx < b.x || lx > b.x + b.w || ly < b.y || ly > b.y + b.h) return;
    // 若命中点实际落在更上层的交互控件（如 HUD 滑块），把事件让给它：
    // elementFromPoint 返回顶层元素，非宠物画布则不抢
    const topEl = document.elementFromPoint(e.clientX, e.clientY);
    if (topEl && topEl !== petWrap && topEl !== petCanvas && !topEl.closest('#pet-wrap')) return;
    dragging = true;
    moved = false;
    lastX = e.screenX;
    lastY = e.screenY;
    petWrap.classList.add('dragging');
    pet.dragStart();
    // 随 dragStart 上报本体几何：主进程钳制的是「宠物本体留在工作区」，
    // 而不是窗口角 —— 否则高窗底部的宠物永远拖不到屏幕上部。
    // ⚠️ 必须传**窗口坐标**（petBodyInWindow），不能传 petBounds 的画布局部坐标：
    // 上一版就是传错坐标系，钳制死点纹丝不动（minY 差了近 400px），修复形同虚设。
    const bodyWin = petBodyInWindow();
    window.pet.dragStart(e.screenX, e.screenY, bodyWin ?? { x: b.x, y: b.y, w: b.w, h: b.h });
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // 兜底①：光标在窗口外松开鼠标（mouseup 永远收不到），回到窗口时
    // buttons 位图已无左键 → 立即结束拖拽，避免主进程 dragOffset 挂起
    // 8 秒（期间整窗强制可交互，表现为「拖拽结束后一块区域还在挡鼠标」）
    if (e.buttons === 0) { endDrag(false); return; }
    moved = true;
    // 黏性形变：把光标位移喂给渲染器（速度向量驱动拉伸/挤压）
    pet.dragMoveBy(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX;
    lastY = e.screenY;
    window.pet.dragMove(e.screenX, e.screenY);
  });
  window.addEventListener('mouseup', () => endDrag(true));
  // 兜底②：拖拽中窗口失焦（点了别的应用/系统抢焦点）→ mouseup 同样收不到
  window.addEventListener('blur', () => endDrag(false));
}

/* ─────────────────────────── 滑动确认卡 ─────────────────────────── */

/**
 * 新模型（绝对精力语义）：
 *  - 滑块滑的是「事件后的真实精力值」（0–ENERGY_MAX）
 *  - predicted（事件默认消耗/恢复）只作参考展示与默认落点
 *  - manual-adjust 卡为纯预览：确认/关闭都不落库，精力保持原值
 */
function showSlide(s: PendingSlide): void {
  slide = s;
  const manual = s.kind === 'manual-adjust';
  slideCard.classList.toggle('morning', s.kind === 'morning-baseline');
  slideCard.classList.toggle('manual', manual);
  sTitle.textContent = s.title;
  sSub.textContent = s.subtitle;
  sConfirm.style.display = manual ? 'none' : '';
  sCancel.textContent = manual ? '关闭 · 恢复原状' : '先不了';
  sPredictedRow.style.display = manual ? 'none' : '';
  sPredicted.textContent = s.kind === 'morning-baseline'
    ? String(s.baseEnergy)
    : fmtDelta(s.predicted);
  sPredictedRow.querySelector('.lead')!.textContent =
    s.kind === 'morning-baseline' ? '昨日收尾' : '事件默认';
  sNote.style.display = manual ? 'none' : '';
  sSlider.min = String(s.min);
  sSlider.max = String(s.max);
  sSlider.step = '0.5';
  sSlider.value = String(clampSlider(s.baseEnergy + s.predicted));
  sMin.textContent = sSlider.min;
  sMid.textContent = String((s.min + s.max) / 2);
  sMax.textContent = sSlider.max;
  positionBaseMark(s);
  sNote.value = '';
  updateSlideVisual(Number(sSlider.value));
  slideCard.classList.add('show');
  // 卡片出现时面板与恢复弹窗收起；窗口模式同步回 pet，避免强制交互态残留
  panel.classList.remove('open');
  recoveryPop.classList.remove('show');
  void window.pet.setMode('pet');
  // 同步上报：slide-card 命中区立即生效（不等节流空窗）
  reportHotRects();
}

/** 基准刻度：在滑轨上标记「事件前的真实精力」位置，一眼看出滑了多少 */
function positionBaseMark(s: PendingSlide): void {
  const range = Math.max(0.001, s.max - s.min);
  const pct = (clampSlider(s.baseEnergy) - s.min) / range;
  const trackPad = 13; // 滑块拇指半径，轨道实际行程 = 100% - 2*thumb
  sBaseMark.style.left = `calc(${trackPad}px + ${pct} * (100% - ${trackPad * 2}px))`;
}

function clampSlider(v: number): number {
  if (!slide) return 0;
  return Math.min(slide.max, Math.max(slide.min, Math.round(v * 2) / 2));
}

function updateSlideVisual(target: number): void {
  if (!slide) return;
  const delta = Math.round((target - slide.baseEnergy) * 2) / 2;
  // 大数字 = 目标真实精力；旁边小字 = 相对事件前的变化
  sValue.textContent = target.toFixed(1);
  sValue.className = 's-value ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
  sDelta.textContent = delta === 0 ? 'Δ 0' : `Δ ${fmtDelta(delta)}`;
  sDelta.className = 's-delta ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
  // 驱动宠物表情实时变化（节流：预览走 IPC，限制频率）
  pet.setPreview(target);
  if (previewDebounce) clearTimeout(previewDebounce);
  previewDebounce = setTimeout(() => {
    void window.pet.slidePreview(target).then((pv) => {
      if (pv) pet.setPreview(pv.energy);
    });
  }, 80);
}

function hideSlide(): void {
  slideCard.classList.remove('show');
  const wasManual = slide?.kind === 'manual-adjust';
  slide = null;
  // 恢复真实情绪（manual 预览结束 → 回到原状态）
  if (state) pet.applyEmotion(state.emotion);
  // 兜底：确保窗口模式回到 pet（panel 的宽限期会让整窗短暂挡点击）
  if (!panel.classList.contains('open')) void window.pet.setMode('pet');
  if (wasManual && state) toast(`还是 ${state.energy.toFixed(1)} 分，没变～`);
  // 同步回收 slide-card 命中区（关闭动画期间 computed opacity 仍 >0.05，
  // 必须按 class 立即从热区剔除，否则那块区域继续吃鼠标）
  reportHotRects();
}

function setupSlide(): void {
  sSlider.addEventListener('input', () => updateSlideVisual(Number(sSlider.value)));
  sConfirm.addEventListener('click', async () => {
    if (!slide) return;
    const target = Number(sSlider.value);
    const note = sNote.value.trim() || undefined;
    const ev = await window.pet.slideConfirm(target, note);
    if (ev) {
      const delta = ev.actual_delta ?? 0;
      const up = delta > 0;
      if (up) pet.celebrate();
      toast(`精力 → ${target.toFixed(1)}（${fmtDelta(delta)}）`);
    }
    hideSlide();
  });
  sCancel.addEventListener('click', () => {
    void window.pet.slideCancel();
    hideSlide();
  });
  // Enter 确认（备注框内）
  sNote.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sConfirm.click(); }
    if (e.key === 'Escape') sCancel.click();
  });
}

/* ─────────────────────────── HUD 进度条调节（平时预览 / 事件后生效） ─────────────────────────── */

/**
 * 双模式滑块（调节对象 = HUD 下方进度条）：
 *
 * 1) 无调节窗口（平时）：自由滑动 → 只驱动本地预览（数字/表情/进度条），
 *    **不写任何精力值**；松手（change）→ 回弹到滑动前的真实精力。
 *    adjustDraft IPC 在无窗口时主进程返回 null，是第二重防线（即使
 *    渲染层状态错乱也不会写入）。
 *
 * 2) 有调节窗口（完成事件后）：滑动 = adjustDraft(target)，写入主进程草稿；
 *    7 秒内可反复微调（窗口不因微调延长）；到点自动切确认弹窗相位。
 */
function setupHudSlider(): void {
  const clamp01 = (v: number): number => Math.min(ENERGY_MAX, Math.max(0, Math.round(v * 2) / 2));

  const previewLocal = (v: number): void => {
    // 本地即时反馈：数字 + 表情 + 进度条填充（全部不落库）
    hudNum.textContent = v.toFixed(1);
    renderHudCells(v);
    hudTier.textContent = tierFor(v).label;
    pet.setPreview(v);
  };

  hudSlider.addEventListener('pointerdown', () => {
    if (adjustWin) return; // 窗口模式不回弹，起点就是草稿
    hudPreviewing = true;
    hudRestEnergy = state?.energy ?? 0;
    hudBarTrack.classList.add('previewing');
  });

  hudSlider.addEventListener('input', () => {
    const v = clamp01(Number(hudSlider.value));
    if (adjustWin) {
      // 事件后调节：写入草稿（主进程校验窗口存在性）
      previewLocal(v);
      void window.pet.adjustDraft(v);
    } else {
      // 平时：纯本地预览
      if (hudPreviewing) previewLocal(v);
    }
  });

  hudSlider.addEventListener('change', () => {
    if (adjustWin || !hudPreviewing) return;
    // 松手回弹：恢复滑动前的真实状态
    hudPreviewing = false;
    hudBarTrack.classList.remove('previewing');
    const rest = clamp01(hudRestEnergy);
    hudSlider.value = String(rest);
    if (state) {
      hudNum.textContent = state.energy.toFixed(1);
      renderHudCells(state.energy);
      hudTier.textContent = tierFor(state.energy).label;
      pet.applyEmotion(state.emotion);
    }
  });
}

/* ─────────────────────────── 调节窗口（7s 微调 → 确认弹窗） ─────────────────────────── */

function stopCountdown(): void {
  if (adjustCountdown) { clearInterval(adjustCountdown); adjustCountdown = null; }
}

/** 进入窗口：显示倒计时角标 + HUD 滑块切换为「可写」模式 */
function enterAdjusting(w: AdjustWindow): void {
  stopCountdown();
  adjustCard.classList.remove('show');
  hudAdjustBadge.hidden = false;
  hudBarTrack.classList.add('live');
  const render = (): void => {
    const remain = Math.max(0, Math.ceil((w.expiresAt - Date.now()) / 1000));
    hudAdjustCount.textContent = String(remain);
    if (remain <= 0) stopCountdown(); // confirming 相位由状态推送驱动
  };
  render();
  adjustCountdown = setInterval(render, 250);
  hudSlider.value = String(w.draftEnergy);
  hudNum.textContent = w.draftEnergy.toFixed(1);
  renderHudCells(w.draftEnergy);
  hudTier.textContent = tierFor(w.draftEnergy).label;
  pet.setPreview(w.draftEnergy);
  toast(`完成了「${w.label}」～ 7 秒内可微调精力`, 3200);
  // 调节期间强制 HUD 可见（用户可能把指针移开去点确认弹窗）
  hudVisible = true;
  hud.classList.add('show');
  // HUD 变为可交互（进度条现在写入草稿），同步纳入热区
  reportHotRects();
}

/** 到点：切确认弹窗（显示当前精力值 vs 事件默认精力值） */
function enterConfirming(w: AdjustWindow): void {
  stopCountdown();
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live');
  aSub.textContent = `${w.icon} ${w.label}`;
  aCurrent.textContent = w.draftEnergy.toFixed(1);
  aDefault.textContent = w.defaultEnergy.toFixed(1);
  const delta = Math.round((w.draftEnergy - w.baseEnergy) * 2) / 2;
  aDelta.textContent = `Δ ${delta === 0 ? '0' : fmtDelta(delta)} · 用时 ${w.actualMinutes !== null ? `${w.actualMinutes} 分钟` : '—'}`;
  aDelta.className = 'a-delta ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
  aSlider.value = String(w.draftEnergy);
  positionDefaultMark(w);
  adjustCard.classList.add('show');
  // 弹窗出现：命中区同步生效（不等节流空窗，用户到点即点）
  reportHotRects();
}

/** 「事件默认精力值」在滑轨上的刻度位置 */
function positionDefaultMark(w: AdjustWindow): void {
  const pct = Math.min(1, Math.max(0, w.defaultEnergy / ENERGY_MAX));
  const trackPad = 13;
  aDefaultMark.style.left = `calc(${trackPad}px + ${pct} * (100% - ${trackPad * 2}px))`;
}

function exitAdjust(): void {
  stopCountdown();
  adjustWin = null;
  adjustCard.classList.remove('show');
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live', 'previewing');
  hudPreviewing = false;
  // HUD 恢复显示真实精力（草稿从未落库，energy 一直是真值）
  if (state) {
    hudSlider.value = String(state.energy);
    hudNum.textContent = state.energy.toFixed(1);
    renderHudCells(state.energy);
    hudTier.textContent = tierFor(state.energy).label;
    pet.applyEmotion(state.emotion);
  }
  // 弹窗关闭：同步回收命中区
  reportHotRects();
}

function setupAdjustCard(): void {
  // 弹窗内滑块：仍写草稿（confirming 相位 adjustDraft 依然允许微调）
  aSlider.addEventListener('input', () => {
    const v = Math.min(ENERGY_MAX, Math.max(0, Math.round(Number(aSlider.value) * 2) / 2));
    aCurrent.textContent = v.toFixed(1);
    if (adjustWin) {
      const delta = Math.round((v - adjustWin.baseEnergy) * 2) / 2;
      aDelta.textContent = `Δ ${delta === 0 ? '0' : fmtDelta(delta)} · 用时 ${adjustWin.actualMinutes !== null ? `${adjustWin.actualMinutes} 分钟` : '—'}`;
      aDelta.className = 'a-delta ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
      pet.setPreview(v);
      void window.pet.adjustDraft(v);
    }
  });
  aConfirm.addEventListener('click', async () => {
    const note = aNote.value.trim() || undefined;
    const ev = await window.pet.adjustCommit(note);
    aNote.value = '';
    if (ev) {
      const delta = ev.actual_delta ?? 0;
      if (delta > 0) pet.celebrate();
      toast(`已记录：精力 ${delta === 0 ? '不变' : fmtDelta(delta)}`);
    }
    exitAdjust();
  });
  aCancel.addEventListener('click', () => {
    aNote.value = '';
    void window.pet.adjustCancel();
    toast('已放弃调节，事件未记录');
    exitAdjust();
  });
  aNote.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aConfirm.click(); }
    if (e.key === 'Escape') aCancel.click();
  });
}

/* ─────────────────────────── 任务时长确认卡（流程第一步） ─────────────────────────── */

function showDurationCard(req: TaskDurationRequest): void {
  durationReq = req;
  dSub.textContent = req.title;
  dEst.textContent = req.estMinutes > 0 ? `预估 ${req.estMinutes} 分钟 · 消耗 -${req.estCost}` : `未设预估时长 · 消耗 -${req.estCost}`;
  dMinutes.value = String(req.estMinutes > 0 ? req.estMinutes : 30);
  durationCard.classList.add('show');
  // 时长卡出现时面板收起，窗口模式回 pet（卡片自身在热区里，可交互）
  panel.classList.remove('open');
  void window.pet.setMode('pet');
  // 同步上报：卡片命中区立即生效
  reportHotRects();
}

function hideDurationCard(): void {
  durationReq = null;
  durationCard.classList.remove('show');
  // 同步回收命中区
  reportHotRects();
}

function setupDurationCard(): void {
  const confirm = (): void => {
    if (!durationReq) return;
    const mins = Math.max(0, Math.min(1440, Number(dMinutes.value) || 0));
    const req = durationReq;
    hideDurationCard();
    // 第二步：确认时长后才打开精力调节窗口
    void window.pet.taskCompleteWithDuration(req.taskId, mins).then(w => {
      if (!w) toast('该任务不可完成（可能已被处理）');
    });
  };
  dConfirm.addEventListener('click', confirm);
  dCancel.addEventListener('click', () => { hideDurationCard(); toast('已取消，任务保持进行中'); });
  dMinutes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') dCancel.click();
  });
}

/* ─────────────────────────── 精力恢复表情菜单（dock ⚡） ─────────────────────────── */

/** 打开前把环圆心对准宠物本体中心（宠物可能被拖到任何位置） */
function syncRingCenter(): void {
  const body = petBodyInWindow();
  // 圆心取本体上部 1/3（视觉上的「头部」），表情围绕头像展开
  const cx = body ? body.x + body.w / 2 : window.innerWidth / 2;
  const cy = body ? body.y + body.h * 0.32 : window.innerHeight - 160;
  recoveryPop.style.setProperty('--cx', `${Math.round(cx)}px`);
  recoveryPop.style.setProperty('--cy', `${Math.round(cy)}px`);
}

function openRecoveryPop(): void {
  syncRingCenter();
  recoveryPop.classList.add('show');
  document.body.classList.add('recovery-open'); // dock 淡出让位
  // 与面板互斥：表情菜单打开时收起面板，窗口模式回 pet（chip 自身在热区里）
  panel.classList.remove('open');
  void window.pet.setMode('pet');
  // 同步上报：chip 弹出动画 .3s，动画结束后复核一次最终位置的热区
  reportHotRects();
  window.setTimeout(reportHotRects, 340);
}

function closeRecoveryPop(): void {
  recoveryPop.classList.remove('show');
  document.body.classList.remove('recovery-open');
  versionSlot.innerHTML = '';
  // 同步回收命中区（收起动画期间 chip opacity 仍 >0，必须按 class 立即剔除）
  reportHotRects();
}

/** Esc 收起（炉石式菜单的标配退出键） */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recoveryPop.classList.contains('show')) closeRecoveryPop();
});

/* ─────────────────────────── 面板 ─────────────────────────── */

function setupPanel(): void {
  const open = (): void => {
    panel.classList.add('open');
    closeRecoveryPop();
    void window.pet.setMode('panel');
    hud.classList.remove('show');
    // 展开：同步排一次上报（面板 opacity 过渡中，200ms 节流路径随后补齐完整命中区；
    // panel 模式的 600ms 宽限期保证过渡期间可交互）
    scheduleHotReport();
    window.setTimeout(reportHotRects, 320); // .28s 过渡结束后复核
  };
  const close = (): void => {
    panel.classList.remove('open');
    void window.pet.setMode('pet');
    // 收起：**同步立即**回收面板命中区。不等 200ms 节流 —— 否则光标停在旧面板区时，
    // 主进程轮询仍命中过期 rect，窗口保持可交互，表现为「面板关了那块还挡鼠标」
    reportHotRects();
  };
  $('dock-panel').addEventListener('click', () => panel.classList.contains('open') ? close() : open());
  $('panel-close').addEventListener('click', close);

  // 任务添加
  const addTask = (): void => {
    const title = taskTitle.value.trim();
    if (!title) return;
    const cost = Math.max(0, Math.min(5, Number(taskCost.value) || 0));
    const mins = Math.max(0, Math.min(1440, Number(taskMinutes.value) || 0));
    void window.pet.taskCreate(title, cost, null, mins).then(() => {
      taskTitle.value = '';
      toast('任务已添加');
    });
  };
  $('task-add-btn').addEventListener('click', addTask);
  taskTitle.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

  // dock 按钮
  // ⚡ 精力恢复：左上角第一个按钮，径向弹出 6 个表情（炉石式表情菜单）
  $('dock-recovery').addEventListener('click', () =>
    recoveryPop.classList.contains('show') ? closeRecoveryPop() : openRecoveryPop());
  $('dock-weather').addEventListener('click', () => {
    // 静默刷新：仅更新 HUD 天气图标，不再弹文字气泡/toast（需求 4）
    void window.pet.weatherRefresh();
  });
  $('dock-quit').addEventListener('click', () => { void window.pet.quit(); });
}

/* ─────────────────────────── 恢复项渲染（径向表情菜单） ─────────────────────────── */

/**
 * 6 个表情沿**上半环扇形**均匀分布（炉石式表情菜单）。
 * 角度约定：0° = 正上方（CSS translateY(-R) 方向），向两侧展开。
 * - 扇区 ±60°、相邻间隔 24°：最侧边 chip 落点约 (cx±94, cy-54)，
 *   避开下方 dock（y 414–448）与 hint 条（bottom 22px），且不超窗口上沿。
 * - --i 为弹出顺序：从中间向两侧（0,1,1,2,2,3…），像扑克牌甩出。
 */
function renderRecoveries(items: RecoveryItem[]): void {
  // 内容签名守卫：恢复项未变则不重建 chip —— 否则每次 applyState（精力/天气/任务
  // 任意变动都会推送）都重放径向弹出动画，表现为「菜单一直闪」。
  const sig = items.map(i => `${i.id}:${i.icon}:${i.name}:${i.currentDelta}:${i.minutes}`).join('|');
  if (sig === lastRecoverySig && rpRing.childElementCount === items.length) return;
  lastRecoverySig = sig;
  rpRing.innerHTML = '';
  const n = Math.max(1, items.length);
  const SPAN = 150; // 扇区总张角（度）；±75° 保证相邻 chip 间距 > 直径，互不重叠
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!;
    const ang = n === 1 ? 0 : -SPAN / 2 + (SPAN / (n - 1)) * idx;
    // 弹出顺序：中间先出，向两侧扩散（idx 距中心的位次）
    const order = Math.abs(idx - (n - 1) / 2);
    const chip = document.createElement('div');
    chip.className = 'rp-chip';
    chip.style.setProperty('--ang', `${ang.toFixed(2)}deg`);
    chip.style.setProperty('--i', String(Math.round(order * 2)));
    chip.title = `${item.name} · 约 ${item.minutes} 分钟 · 长按查看默认值历史`;
    chip.innerHTML = `
      <span class="ico">${item.icon}</span>
      <span class="nm">${escapeHtml(item.name)}</span>
      <span class="dt">${fmtDelta(item.currentDelta)}</span>
    `;
    chip.addEventListener('click', () => {
      // 选中即按默认值恢复精力：收起菜单，直接进入事件后调节窗口（7s 微调 → 确认弹窗）
      closeRecoveryPop();
      void window.pet.recoveryStartAdjust(item.id).then(w => {
        if (!w) toast('已有调节进行中，请先处理');
      });
    });
    // 长按（500ms）查看版本历史
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    chip.addEventListener('mousedown', () => {
      pressTimer = setTimeout(() => { pressTimer = null; void showVersions(item); }, 500);
    });
    const clearPress = (): void => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    chip.addEventListener('mouseup', clearPress);
    chip.addEventListener('mouseleave', clearPress);
    rpRing.appendChild(chip);
  }
}

async function showVersions(item: RecoveryItem): Promise<void> {
  const versions = await window.pet.recoveryVersions(item.id);
  versionSlot.innerHTML = '';
  const pop = document.createElement('div');
  pop.className = 'version-pop';
  pop.innerHTML = `<h4>${item.icon} ${escapeHtml(item.name)} · 默认值历史</h4>`;
  if (!versions.length) {
    pop.innerHTML += '<div class="vrow"><span>暂无调整记录</span></div>';
  } else {
    for (const v of versions.slice(0, 8)) {
      const d = new Date(v.createdAt);
      pop.innerHTML += `<div class="vrow"><span>${escapeHtml(v.reason || '调整')} · ${d.getMonth() + 1}/${d.getDate()}</span><b>${fmtDelta(v.delta)}</b></div>`;
    }
  }
  versionSlot.appendChild(pop);
  setTimeout(() => { if (pop.parentNode) pop.remove(); }, 6000);
}

/* ─────────────────────────── 任务渲染 ─────────────────────────── */

function renderTasks(): void {
  if (!state) return;
  const tasks = state.tasks;
  taskList.innerHTML = '';
  if (!tasks.length) {
    taskList.innerHTML = '<div class="empty">还没有任务。添加一个，完成时我会问你感受如何。</div>';
    return;
  }
  const now = Date.now();
  const open = tasks.filter(t => t.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
  const done = tasks.filter(t => t.status !== 'open').slice(-6).reverse();
  for (const t of [...open, ...done]) {
    const row = document.createElement('div');
    const overdue = t.status === 'open' && t.dueAt !== null && t.dueAt < now;
    row.className = 'task-item' + (t.status !== 'open' ? ' done' : '') + (overdue ? ' overdue' : '');
    // 面板展示「任务名称 + 预估/实际时长」（问题 5：流程联动的信息基础）
    const dur = t.status === 'open'
      ? (t.estMinutes > 0 ? `预估 ${t.estMinutes}′` : '未设时长')
      : (t.actualMinutes !== null ? `实际 ${t.actualMinutes}′` : '已完成');
    row.innerHTML = `
      <div class="t-title">${escapeHtml(t.title)}<span class="t-dur">${dur}</span></div>
      ${overdue ? '<span class="overdue-tag">超时</span>' : ''}
      <span class="t-cost">-${t.estCost}</span>
    `;
    if (t.status === 'open') {
      const doneBtn = document.createElement('button');
      doneBtn.className = 'btn good sm';
      doneBtn.textContent = '完成';
      // 流程第一步：先弹时长确认卡（展示名称与预估时长），确认后才调精力
      doneBtn.addEventListener('click', () => {
        void window.pet.taskDurationRequest(t.id).then(req => {
          if (req) showDurationCard(req);
          else toast('该任务不可完成（可能已被处理）');
        });
      });
      const dropBtn = document.createElement('button');
      dropBtn.className = 'btn ghost sm';
      dropBtn.textContent = '放弃';
      dropBtn.addEventListener('click', () => { void window.pet.taskDrop(t.id); toast('已放弃'); });
      row.appendChild(doneBtn);
      row.appendChild(dropBtn);
    }
    taskList.appendChild(row);
  }
}

/* ─────────────────────────── 周报弹窗（每天 17:30 弹一次） ─────────────────────────── */

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 渲染并显示周报弹窗；payload 为 null 时收起 */
function applyReportModal(p: WeeklyReportPayload | null): void {
  if (!p) {
    if (shownReportDate !== null) {
      shownReportDate = null;
      reportModal.classList.remove('show');
      reportHotRects();
    }
    return;
  }
  if (shownReportDate === p.dateStr && reportModal.classList.contains('show')) return; // 已在显示同一份
  shownReportDate = p.dateStr;
  const r = p.report;

  rmRange.textContent = `${fmtDate(r.weekStart)} – ${fmtDate(r.weekEnd - 1)} · 共 ${r.totalEvents} 条留痕`;

  // 主清单：铅笔手绘条目（数据全部来自事件流 fold，非拍脑袋）
  const rows: { label: string; val: string }[] = [
    { label: '平均精力', val: `${r.avgEnergy} 分` },
    { label: '精力区间', val: `${r.minEnergy} ~ ${r.maxEnergy}` },
    { label: '完成任务', val: `${r.tasksCompleted} 件` },
    { label: '恢复次数', val: `${r.recoveriesTaken} 次` },
    { label: '最耗时段', val: r.peakDrainHour !== null ? `${r.peakDrainHour}:00 前后` : '—' },
    { label: '最有效恢复', val: r.bestRecovery ? `${r.bestRecovery.name} +${r.bestRecovery.avgDelta}` : '—' },
  ];
  rmList.innerHTML = rows.map(x =>
    `<li><span class="tick" aria-hidden="true"></span><span>${escapeHtml(x.label)}</span><b class="val">${escapeHtml(x.val)}</b></li>`,
  ).join('');

  // AI 推荐默认值：同一恢复项重复 3 次后由记忆产出的校准建议
  if (p.aiSuggestions.length) {
    rmAiSec.style.display = '';
    rmAi.innerHTML = p.aiSuggestions.map(a =>
      `<li><span class="tick" aria-hidden="true"></span><span>${escapeHtml(a.itemName)}</span><b class="val">建议 ${fmtDelta(a.suggestedDelta)}</b></li>`,
    ).join('') + p.aiSuggestions.map(a =>
      `<li style="line-height:1.6;padding:2px 0 6px 21px;font-size:10.5px;color:#6b5638;border-bottom:1px dotted rgba(120,90,45,.35)">${escapeHtml(a.message)}</li>`,
    ).join('');
  } else {
    rmAiSec.style.display = 'none';
  }

  // 历史决策留痕：近 7 天已确认的默认值变更（含来源）
  if (p.decisions.length) {
    rmDecSec.style.display = '';
    rmDec.innerHTML = p.decisions.map(d =>
      `<li><span class="tick" aria-hidden="true"></span><span class="src">${escapeHtml(d.source === 'ai' ? 'AI' : d.source === 'system' ? '系统' : '你')}</span>`
      + `<span>${escapeHtml(d.itemName)} → ${d.delta}</span>`
      + `<b class="val" style="color:rgba(107,86,56,.75);font-weight:400;font-size:10px">${fmtDate(d.createdAt)}</b></li>`,
    ).join('');
  } else {
    rmDecSec.style.display = 'none';
  }

  rmNote.innerHTML = r.narrative.map(n => escapeHtml(n)).join('<br>');

  // 周五 requireAck：隐藏随手关闭按钮，必须点「已确认」
  $('rm-close').style.display = p.requireAck ? 'none' : '';

  reportModal.classList.add('show');
  reportHotRects();
  // 金尖羽毛笔：把笔尖钉在最后一行墨迹末端（"像刚写完"）
  positionQuill();
}

/**
 * 金尖羽毛笔定位：笔尖（.rm-quill 的旋转原点）对准纸面"最后一行墨迹"的文字末端。
 * 目标优先级：变更留痕末行值 > AI 建议末行值 > 主清单末行值 > 叙述框末行文字。
 * 叙述框是整块盒子（右缘≠文字末），用 Range 取最后一个文字节点的末行矩形。
 * 笔在可滚动纸面内（随内容滚动），故换算到内容坐标需加 scrollTop；
 * 笔尖留 6px 提笔间隙，并钳在纸面内（避免被撕角裁掉 / 笔身出纸）。
 */
function positionQuill(): void {
  const sheet = reportModal.querySelector('.rm-sheet') as HTMLElement | null;
  const quill = reportModal.querySelector('.rm-quill') as HTMLElement | null;
  if (!sheet || !quill) return;
  const cands = [...reportModal.querySelectorAll<HTMLElement>('.rm-list li .val, .rm-note')]
    .filter(el => el.offsetParent !== null && el.textContent && el.textContent.trim());
  const lastInk = cands.pop();
  if (!lastInk) return;
  let ink: DOMRect = lastInk.getBoundingClientRect();
  if (lastInk.classList.contains('rm-note')) {
    // 末行文字末端：最后一个非空文字节点的尾字符矩形
    const walker = document.createTreeWalker(lastInk, NodeFilter.SHOW_TEXT);
    let tn: Text | null = null;
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      if (cur.textContent && cur.textContent.trim()) tn = cur as Text;
    }
    if (tn && tn.textContent) {
      const range = document.createRange();
      range.setStart(tn, Math.max(0, tn.textContent.length - 1));
      range.setEnd(tn, tn.textContent.length);
      ink = range.getBoundingClientRect();
    }
  }
  const sr = sheet.getBoundingClientRect();
  const nibX = Math.max(70, Math.min(ink.right - sr.left + 6, sheet.clientWidth - 16));
  const nibY = Math.max(100, Math.min(ink.bottom - sr.top + sheet.scrollTop - 2, sheet.scrollHeight - 12));
  // 笔尖 = 旋转原点（局部 (0, 50%)，即盒内垂直 +20px）：top 需补偿 -20 才落在 nibY
  quill.style.left = `${Math.round(nibX)}px`;
  quill.style.top = `${Math.round(nibY - 20)}px`;
}

function setupReportModal(): void {
  const closeIt = (): void => {
    void window.pet.reportConfirm().then(() => {
      // 主进程确认后 state 推送会驱动收起；这里也同步收，避免空窗
      shownReportDate = null;
      reportModal.classList.remove('show');
      reportHotRects();
    });
  };
  $('rm-ack').addEventListener('click', closeIt);
  $('rm-close').addEventListener('click', closeIt);
}

/* ─────────────────────────── AI 推荐卡 ─────────────────────────── */

function renderRecommendations(recs: InsightRecommendation[]): void {
  // 新增的推荐才建卡；已移除的删卡
  const currentIds = new Set(recs.map(r => r.id));
  for (const id of [...shownRecIds]) {
    if (!currentIds.has(id)) {
      const el = recStack.querySelector(`[data-rec="${id}"]`);
      if (el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }
      shownRecIds.delete(id);
    }
  }
  for (const rec of recs) {
    if (shownRecIds.has(rec.id)) continue;
    shownRecIds.add(rec.id);
    const card = document.createElement('div');
    card.className = 'rec-ai-card';
    card.setAttribute('data-rec', rec.id);
    card.innerHTML = `
      <div class="r-head"><span class="dot"></span>AI 观察</div>
      <div class="r-msg">${escapeHtml(rec.message)}</div>
      <div class="r-modify">
        <input type="range" min="-2" max="5" step="0.5" value="${rec.suggestedDelta}" />
        <span class="mv">${fmtDelta(rec.suggestedDelta)}</span>
      </div>
      <div class="r-actions">
        <button class="btn ghost" data-act="rejected">拒绝</button>
        <button class="btn" data-act="modified">按此调整</button>
        <button class="btn amber" data-act="accepted">接受</button>
      </div>
    `;
    const range = card.querySelector<HTMLInputElement>('input[type="range"]')!;
    const mv = card.querySelector<HTMLElement>('.mv')!;
    range.addEventListener('input', () => { mv.textContent = fmtDelta(Number(range.value)); });
    card.querySelectorAll<HTMLButtonElement>('.r-actions .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act as 'accepted' | 'modified' | 'rejected';
        void window.pet.recommendationResolve(rec.id, act, Number(range.value)).then(ok => {
          if (ok) {
            toast(act === 'accepted' ? '已校准默认值' : act === 'modified' ? '已按你的值校准' : '好的，先不动');
            if (act !== 'rejected') pet.celebrate();
          }
        });
      });
    });
    recStack.appendChild(card);
    // 最多同时展示 2 张，其余等待
    while (recStack.children.length > 2) recStack.firstElementChild?.remove();
  }
}

/* ─────────────────────────── 主状态渲染 ─────────────────────────── */

function applyState(s: AppState): void {
  const prev = state;
  state = s;

  // 宠物情绪（表情主体）。
  // slide / 调节窗口期间由预览驱动（setPreview），不被状态推送覆盖。
  if (!slide && !adjustWin) pet.applyEmotion(s.emotion);

  // 天气图层：**无条件应用**，与卡片门控解耦（问题 4 的渲染层修复）。
  // 旧代码把 overlay 一起塞在 `if (!slide)` 里，而晨间卡启动即弹、slide 恒非空，
  // 导致天气图层永远不渲染（数据链路其实是好的）。
  // 显示门槛（精力 ≥8 且好天气才出太阳等）已由 emotion/engine.resolveWeatherOverlay
  // 在后端算好，这里只负责忠实呈现 s.emotion.overlay。
  // 预览期间（setPreview 只改 body 不改 overlay）同样保持天气图层。
  pet.applyOverlay(s.emotion.overlay);

  // HUD（调节窗口期间 HUD 数字显示草稿值，由窗口逻辑接管，不被真值覆盖）
  if (!adjustWin) {
    hudNum.textContent = s.energy.toFixed(1);
    renderHudCells(s.energy);
    hudSlider.value = String(s.energy);
    hudRestEnergy = s.energy;
  }
  hudTier.textContent = tierFor(adjustWin ? adjustWin.draftEnergy : s.energy).label;
  hudWeather.textContent = WEATHER_ICON[s.weather.condition] ?? '🌤️';
  panelSub.textContent = describeEmotion(s.emotion, s.weather)
    + (s.emotion.pulseActive ? ` · pulse:${s.emotion.pulse}` : '');

  // 滑动卡（createdAt 参与比对：同一恢复项连续两次卡片也能正确刷新）
  const cur = s.pendingSlide;
  const old = prev?.pendingSlide;
  if (cur && (!old || old.refId !== cur.refId || old.kind !== cur.kind || old.createdAt !== cur.createdAt)) {
    showSlide(cur);
  } else if (!cur && slide) {
    hideSlide();
  }

  // 调节窗口相位驱动（adjusting → 角标倒计时；confirming → 确认弹窗）
  const aw = s.adjustWindow;
  if (aw) {
    const isNew = !adjustWin || adjustWin.refId !== aw.refId || adjustWin.openedAt !== aw.openedAt;
    adjustWin = aw;
    if (isNew) {
      if (aw.phase === 'adjusting') enterAdjusting(aw);
      else enterConfirming(aw);
    } else if (aw.phase === 'confirming' && !adjustCard.classList.contains('show')) {
      enterConfirming(aw);
    }
    // 草稿值同步（另一入口微调后，HUD 与弹窗保持一致）
    if (aw.phase === 'adjusting' && !hudPreviewing) {
      hudSlider.value = String(aw.draftEnergy);
      hudNum.textContent = aw.draftEnergy.toFixed(1);
      renderHudCells(aw.draftEnergy);
    }
  } else if (adjustWin) {
    // 窗口关闭（已提交/已取消）→ 复位 HUD 与弹窗
    exitAdjust();
  }

  // 面板内容（仅在面板打开或首次时渲染，减少无谓 DOM 操作）
  renderRecoveries(s.recoveries);
  renderTasks();
  renderRecommendations(s.recommendations);

  // 周报弹窗（主进程 17:30 调度驱动；确认后 state 推 null 收起）
  applyReportModal(s.reportModal);

  // 晨间基线：卡片本身就是问候，不再叠加文字气泡

  // 低精力提示（跨过阈值时）：仅 toast，不弹文字气泡
  if (prev && prev.energy >= PULSE_THRESHOLD && s.energy < PULSE_THRESHOLD) {
    toast(`电量低于 ${PULSE_THRESHOLD} 分了，要不要休息一下？`, 3200);
  }
}

/* ─────────────────────────── 启动 ─────────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function boot(): void {
  pet = new PetRenderer({ canvas: petCanvas });
  setupHitTest();
  setupDrag();
  setupSlide();
  setupHudSlider();
  setupAdjustCard();
  setupDurationCard();
  setupPanel();
  setupReportModal();

  window.pet.onState((s) => applyState(s));
  void window.pet.getState().then(s => { if (s) applyState(s); });

  window.addEventListener('resize', () => pet.resize());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export {};
