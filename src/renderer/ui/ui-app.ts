/**
 * uiWin 渲染进程主控 —— 奶油猫卡片流（v2.0 融合，交互逻辑与旧 app.ts 等价）。
 *
 * 数据流：主进程 pushState(AppState) → 本模块 diff 渲染。
 * 写操作全部经 window.pet.* IPC → Coordinator → DecisionLog（事件流唯一入口）。
 *
 * 猫本体住在 catWin：本窗口（400×620，锚定屏幕右下角，主进程按需 show/hide）
 * 只承载领域 UI —— 滑动卡 / 时长卡 / 调节窗（7s 倒计时 + confirming 弹窗）/
 * 周报弹窗 / AI 推荐卡 / 任务面板 / 恢复扇形菜单 / HUD 精力条 / hotRects / toast。
 * 窗口显隐由主进程按 state 决定；渲染层只对「主进程看不见的本地活动 UI」
 * （恢复扇形、周报查看态）调 uiHint(true/false) 协同保持窗口可见。
 */

import { tierFor, describe as describeEmotion } from '../../emotion/engine.js';
import { ENERGY_MAX } from '../../core/types.js';
import type {
  AppState, PendingSlide, InsightRecommendation, WeeklyReportPayload, WeeklyReport,
  RecoveryItem, AdjustWindow, TaskDurationRequest, UiCmd,
} from '../../core/types.js';
import type { PetApi } from '../../preload/index.js';

declare global {
  interface Window {
    pet: PetApi;
  }
}

/* ─────────────────────────── 错误黑匣子 ─────────────────────────── */

/** 渲染进程异常统一上报主进程 crash.log，闪退后可事后定位 */
window.addEventListener('error', (e) => {
  try { window.pet?.reportError({ source: 'ui-window', message: `onerror: ${e.message}`, stack: (e.error as Error | undefined)?.stack }); } catch { /* noop */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  try {
    window.pet?.reportError({
      source: 'ui-window',
      message: `unhandledrejection: ${r instanceof Error ? r.message : String(r)}`,
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

const hud = $('energy-hud');
const hudNum = $('hud-num');
const hudCells = $('hud-cells');
const hudTier = $('hud-tier');
const hudWeather = $('hud-weather');
// HUD 进度条 = 精力调节的「平时预览」入口（无窗口时拖动只预览、松手回弹）
const hudSlider = $<HTMLInputElement>('hud-slider');
const hudBarTrack = $('hud-bar-track');
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
// 精力恢复扇形菜单（onUiCmd openRecovery 唤起；径向 chips 围绕窗口底部中心）
const recoveryPop = $('recovery-pop');
const rpRing = $('rp-ring');
const rpClose = $('rp-close');
const versionSlot = $('version-slot');
const taskList = $('task-list');
const taskTitle = $<HTMLInputElement>('task-title');
const taskCost = $<HTMLInputElement>('task-cost');
const taskMinutes = $<HTMLInputElement>('task-minutes');
// 周报弹窗（state.reportModal 驱动 / onUiCmd showWeekly 主动查看）
const reportModal = $('report-modal');
const rmRange = $('rm-range');
const rmList = $('rm-list');
const rmAiSec = $('rm-ai-sec');
const rmAi = $('rm-ai');
const rmDecSec = $('rm-dec-sec');
const rmDec = $('rm-dec');
const rmNote = $('rm-note');
const rmAck = $<HTMLButtonElement>('rm-ack');
const rmClose = $<HTMLButtonElement>('rm-close');
const recStack = $('rec-stack');
const toastEl = $('toast');

/* ─────────────────────────── 状态 ─────────────────────────── */

let state: AppState | null = null;
let slide: PendingSlide | null = null;
let previewDebounce: ReturnType<typeof setTimeout> | null = null;
let shownRecIds = new Set<string>();
/** 当前显示的周报弹窗日期（YYYY-MM-DD）；null = 未显示。用于检测主进程推送的新弹窗 */
let shownReportDate: string | null = null;
/** 「主动查看态」周报（onUiCmd showWeekly）：关闭不触发 reportConfirm，需 uiHint 保窗口 */
let weeklyViewOpen = false;
/** 精力恢复扇形菜单的内容签名：未变则跳过重建 chip（避免每次 applyState 重放弹出动画） */
let lastRecoverySig = '';

/* ── 事件后调节窗口（渲染侧镜像） ── */
/** 主进程 AdjustWindow 的本地镜像；null = 无窗口（HUD 滑块只预览） */
let adjustWin: AdjustWindow | null = null;
/** 调节窗口的本地倒计时（按镜像 expiresAt 每 250ms 重算，到 0 等状态推送切 confirming） */
let adjustCountdown: ReturnType<typeof setInterval> | null = null;
/** 待确认时长的任务（流程第一步）；null = 时长卡未打开 */
let durationReq: TaskDurationRequest | null = null;
/** HUD 滑块「平时拖动」的预览态：松手回弹到滑动前的值 */
let hudPreviewing = false;
/** 滑动前 HUD 记录的真实精力（回弹目标） */
let hudRestEnergy = 0;
/** 滑动卡预览态：HUD 显示预览值，不被状态推送的真值覆盖（卡关闭即复位） */
let slidePreviewActive = false;
/** uiHint 去重：只有变化才发 IPC */
let lastUiHint: boolean | null = null;

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

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 滑轨 mint 填充：把当前值换算成 --fill 百分比（奶油凹槽 + mint 填充的 CSS 契约） */
function paintRange(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  const v = Number(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct)).toFixed(2)}%`);
}

/* ─────────────────────────── uiHint 协同 ───────────────────────────
 * 恢复扇形 / 周报查看态是「主进程看不见的本地活动 UI」：
 * 打开时 uiHint(true) 让主进程保持 uiWin 可见，关闭时 uiHint(false) 交还决定权。
 * 其余显隐由主进程按 state 决定，渲染层不管窗口 show/hide。 */

function syncUiHint(): void {
  const active = recoveryPop.classList.contains('show') || weeklyViewOpen;
  if (active === lastUiHint) return;
  lastUiHint = active;
  try { window.pet.uiHint(active); } catch { /* noop */ }
}

/* ─────────────────────────── 命中区上报（click-through 核心） ─────────────────────────── */

type HotRect = { x: number; y: number; w: number; h: number };

/**
 * 收集当前可交互元素的窗口内包围盒。
 * 主进程按 50ms 轮询光标判断是否命中，命中才关闭鼠标穿透。
 *
 * 注意：这里是唯一的命中来源，不要再往主进程发状态式 hitTest，
 * 两套机制并存会导致 ignore 状态打架、原生层高频切换而崩溃。
 * （猫本体命中区由 catWin 自行上报，与本窗口无关。）
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
    // 精力恢复扇形菜单：chip 挂在 #recovery-pop 内，收起动画期间立即回收命中区
    if ((el.id === 'recovery-pop' || el.closest?.('#recovery-pop')) && !recoveryPop.classList.contains('show')) return true;
    // 周报弹窗：同理（17:30 弹出 / showWeekly 查看，确认后收起）
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

  // 常驻交互容器（猫不在此窗口：无 pet-wrap / petBodyInWindow，也无 dock）。
  for (const sel of ['#panel', '#report-modal', '#slide-card', '#duration-card', '#adjust-card', '#energy-hud'] as const) push(document.querySelector(sel));
  // 精力恢复扇形菜单：#recovery-pop 是 inset:0 全屏**穿透容器**，绝不能整块上报
  // （否则整窗永久不可穿透）。只上报实际可见的 chip（含中央收起钮；弹出动画期间
  // opacity<0.05 会被 hittable 过滤；显隐由 recoveryPop.show 类控制，见 explicitHidden）。
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
 * 为什么不放在 setupHitTest 闭包里：面板/卡片收起时必须**同步立即**回收热区。
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
  // 窗口尺寸变化：扇形菜单圆心跟随窗口底部中心
  window.addEventListener('resize', () => { syncRingCenter(); reportHotRects(); });

  // 指针移动也会改变布局可见性（hover 位移 / 悬停显隐）。mousemove 不节流会 IPC 风暴，
  // 这里只做「变化检测」：光标与交互区的归属翻转时排两次上报（进入立即 + 过渡结束后），
  // 保证显/隐两个方向都不会残留过期命中区。
  let lastOverInteractive: boolean | null = null;
  window.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overInteractive = !!el?.closest('[data-interactive]');
    if (overInteractive !== lastOverInteractive) {
      lastOverInteractive = overInteractive;
      scheduleHotReport();
      window.setTimeout(reportHotRects, 450); // hover 过渡结束后复核一次
    }
  }, { passive: true });

  reportHotRects(); // 首个渲染帧即可交互
}

/* ─────────────────────────── HUD 精力条 ───────────────────────────
 * 10 个格子（每格 1 分，ENERGY_MAX=10）：满格全亮，当前格按小数比例填充（半格支持）。
 * 触碰精力条时样式不变（无 hover 形变）；previewing/live 态由 CSS 作用于 .cell i。
 * 猫不在此窗口 → HUD 是窗口内底部常驻的一条奶油 pill（.show 由 boot 加满，
 * 窗口自身的 show/hide 由主进程决定，渲染层不做悬停显隐）。 */

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

/** 本地即时反馈：数字 + 格子 + 档位（全部不落库） */
function renderHud(v: number): void {
  hudNum.textContent = v.toFixed(1);
  renderHudCells(v);
  hudTier.textContent = tierFor(v).label;
}

/** HUD 恢复显示真实精力（预览/草稿从未落库，energy 一直是真值） */
function restoreHudFromState(): void {
  if (!state) return;
  hudSlider.value = String(state.energy);
  hudRestEnergy = state.energy;
  renderHud(state.energy);
}

/* ─────────────────────────── 滑动确认卡 ───────────────────────────
 * 新模型（绝对精力语义）：
 *  - 滑块滑的是「事件后的真实精力值」（min–max，step 0.5）
 *  - predicted（事件默认消耗/恢复）只作参考展示与默认落点
 *  - manual-adjust 卡为纯预览：确认/关闭都不落库，精力保持原值（关闭即回弹）
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
  paintRange(sSlider);
  sMin.textContent = sSlider.min;
  sMid.textContent = String((s.min + s.max) / 2);
  sMax.textContent = sSlider.max;
  positionBaseMark(s);
  sNote.value = '';
  updateSlideVisual(Number(sSlider.value));
  slideCard.classList.add('show');
  // 卡片出现时面板与恢复扇形收起；窗口模式同步回 pet，避免强制交互态残留
  panel.classList.remove('open');
  recoveryPop.classList.remove('show');
  syncUiHint(); // 恢复扇形若被收起 → uiHint(false)
  void window.pet.setMode('pet');
  // 同步上报：slide-card 命中区立即生效（不等节流空窗）
  reportHotRects();
}

/** 基准刻度：在滑轨上标记「事件前的真实精力」位置，一眼看出滑了多少 */
function positionBaseMark(s: PendingSlide): void {
  const range = Math.max(0.001, s.max - s.min);
  const pct = (clampSlider(s.baseEnergy) - s.min) / range;
  const trackPad = 12; // 滑块拇指半径，轨道实际行程 = 100% - 2*thumb
  sBaseMark.style.left = `calc(${trackPad}px + ${pct} * (100% - ${trackPad * 2}px))`;
}

function clampSlider(v: number): number {
  if (!slide) return 0;
  return Math.min(slide.max, Math.max(slide.min, Math.round(v * 2) / 2));
}

function updateSlideVisual(target: number): void {
  if (!slide) return;
  const delta = Math.round((target - slide.baseEnergy) * 2) / 2;
  // 大数字 = 目标真实精力；旁边小字 = 相对事件前的变化（Δ = target − baseEnergy）
  sValue.textContent = target.toFixed(1);
  sValue.className = 's-value ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
  sDelta.textContent = delta === 0 ? 'Δ 0' : `Δ ${fmtDelta(delta)}`;
  sDelta.className = 's-delta ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
  // 猫不在此窗口：HUD 就是预览面（本地即时反馈，不落库）
  slidePreviewActive = true;
  renderHud(target);
  // 事件默认消耗的精确预览走 IPC（80ms 节流，限制频率）
  if (previewDebounce) clearTimeout(previewDebounce);
  previewDebounce = setTimeout(() => {
    void window.pet.slidePreview(target).then((pv) => {
      if (pv && slidePreviewActive) renderHud(pv.energy);
    });
  }, 80);
}

function hideSlide(): void {
  slideCard.classList.remove('show');
  const wasManual = slide?.kind === 'manual-adjust';
  slide = null;
  slidePreviewActive = false;
  if (previewDebounce) { clearTimeout(previewDebounce); previewDebounce = null; }
  // 预览结束 → HUD 回到真实精力（调节窗口开启时由窗口逻辑接管，不复位）
  if (!adjustWin) restoreHudFromState();
  // 兜底：确保窗口模式回到 pet（panel 的宽限期会让整窗短暂挡点击）
  if (!panel.classList.contains('open')) void window.pet.setMode('pet');
  if (wasManual && state) toast(`还是 ${state.energy.toFixed(1)} 分，没变～`);
  // 同步回收 slide-card 命中区（关闭动画期间 computed opacity 仍 >0.05，
  // 必须按 class 立即从热区剔除，否则那块区域继续吃鼠标）
  reportHotRects();
}

function setupSlide(): void {
  sSlider.addEventListener('input', () => {
    paintRange(sSlider);
    updateSlideVisual(Number(sSlider.value));
  });
  sConfirm.addEventListener('click', async () => {
    if (!slide) return;
    const target = Number(sSlider.value);
    const note = sNote.value.trim() || undefined;
    const ev = await window.pet.slideConfirm(target, note);
    if (ev) {
      const delta = ev.actual_delta ?? 0;
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

/* ─────────────────────────── HUD 进度条调节（平时预览 / 事件后生效） ───────────────────────────
 * 双模式滑块：
 *
 * 1) 无调节窗口（平时）：自由滑动 → 只驱动本地预览（数字/格子/档位），
 *    **不写任何精力值**；松手（change）→ 回弹到滑动前的真实精力。
 *    adjustDraft IPC 在无窗口时主进程返回 null，是第二重防线（即使
 *    渲染层状态错乱也不会写入）。
 *
 * 2) 有调节窗口（完成事件后）：滑动 = adjustDraft(target)，写入主进程草稿；
 *    7 秒静置内可反复微调（拖动重置倒计时，主进程另有 60s 硬上限）；
 *    到点自动切确认弹窗相位（倒计时角标由本层按镜像 expiresAt 自渲染）。
 */

function setupHudSlider(): void {
  const clamp01 = (v: number): number => Math.min(ENERGY_MAX, Math.max(0, Math.round(v * 2) / 2));

  hudSlider.addEventListener('pointerdown', () => {
    if (adjustWin) return; // 窗口模式不回弹，起点就是草稿
    hudPreviewing = true;
    hudRestEnergy = state?.energy ?? 0;
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
    if (state) renderHud(state.energy);
  });
}

/* ─────────────────────────── 调节窗口（7s 微调 → 确认弹窗） ─────────────────────────── */

function stopCountdown(): void {
  if (adjustCountdown) { clearInterval(adjustCountdown); adjustCountdown = null; }
}

/** 倒计时角标：始终读**最新镜像**的 expiresAt（拖动微调后主进程重置窗口，回执刷新镜像） */
function renderAdjustCountdown(): void {
  if (!adjustWin) return;
  const remain = Math.max(0, Math.ceil((adjustWin.expiresAt - Date.now()) / 1000));
  hudAdjustCount.textContent = String(remain);
  if (remain <= 0) stopCountdown(); // confirming 相位由状态推送驱动
}

/** 进入窗口：显示倒计时角标 + HUD 滑块切换为「可写」模式 */
function enterAdjusting(w: AdjustWindow): void {
  stopCountdown();
  adjustCard.classList.remove('show');
  hudAdjustBadge.hidden = false;
  hudBarTrack.classList.add('live');
  renderAdjustCountdown();
  adjustCountdown = setInterval(renderAdjustCountdown, 250);
  hudSlider.value = String(w.draftEnergy);
  renderHud(w.draftEnergy);
  hud.classList.add('show'); // 调节窗期间 HUD 出现（草稿滑条+角标）；exitAdjust 收起
  toast(`完成了「${w.label}」～ 7 秒内可微调精力`, 3200);
  // HUD 变为可交互（进度条现在写入草稿），同步纳入热区
  reportHotRects();
}

/** 到点：切确认弹窗（显示当前草稿 vs 事件默认精力值） */
function enterConfirming(w: AdjustWindow): void {
  stopCountdown();
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live');
  aSub.textContent = `${w.icon} ${w.label}`;
  aCurrent.textContent = w.draftEnergy.toFixed(1);
  aDefault.textContent = w.defaultEnergy.toFixed(1);
  setAdjustDelta(Math.round((w.draftEnergy - w.baseEnergy) * 2) / 2, w.actualMinutes);
  aSlider.value = String(w.draftEnergy);
  paintRange(aSlider);
  positionDefaultMark(w);
  adjustCard.classList.add('show');
  // 弹窗出现：命中区同步生效（不等节流空窗，用户到点即点）
  reportHotRects();
}

function setAdjustDelta(delta: number, actualMinutes: number | null): void {
  aDelta.textContent = `Δ ${delta === 0 ? '0' : fmtDelta(delta)} · 用时 ${actualMinutes !== null ? `${actualMinutes} 分钟` : '—'}`;
  aDelta.className = 'a-delta ' + (delta > 0.1 ? 'pos' : delta < -0.1 ? 'neg' : 'zero');
}

/** 「事件默认精力值」在滑轨上的刻度位置（墨线虚线 mark） */
function positionDefaultMark(w: AdjustWindow): void {
  const pct = Math.min(1, Math.max(0, w.defaultEnergy / ENERGY_MAX));
  const trackPad = 12;
  aDefaultMark.style.left = `calc(${trackPad}px + ${pct} * (100% - ${trackPad * 2}px))`;
}

function exitAdjust(): void {
  stopCountdown();
  adjustWin = null;
  adjustCard.classList.remove('show');
  hudAdjustBadge.hidden = true;
  hudBarTrack.classList.remove('live', 'previewing');
  hudPreviewing = false;
  // HUD 恢复显示真实精力（草稿从未落库，energy 一直是真值；滑动预览中则不打断）
  if (state && !slidePreviewActive) restoreHudFromState();
  // 调节窗结束：HUD 收起（精力值常驻展示位在桌宠下方的悬浮胶囊）
  hud.classList.remove('show');
  // 弹窗关闭：同步回收命中区
  reportHotRects();
}

function setupAdjustCard(): void {
  // 弹窗内滑块：仍写草稿（confirming 相位 adjustDraft 依然允许微调）
  aSlider.addEventListener('input', () => {
    const v = Math.min(ENERGY_MAX, Math.max(0, Math.round(Number(aSlider.value) * 2) / 2));
    paintRange(aSlider);
    aCurrent.textContent = v.toFixed(1);
    if (adjustWin) {
      setAdjustDelta(Math.round((v - adjustWin.baseEnergy) * 2) / 2, adjustWin.actualMinutes);
      void window.pet.adjustDraft(v).then((w) => {
        if (w) { adjustWin = w; renderAdjustCountdown(); }
      });
    }
  });
  aConfirm.addEventListener('click', async () => {
    const note = aNote.value.trim() || undefined;
    const ev = await window.pet.adjustCommit(note);
    aNote.value = '';
    if (ev) {
      const delta = ev.actual_delta ?? 0;
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
    // Enter 提交（窗口级 Enter 对 textarea 让位到这里，避免双触发）
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aConfirm.click(); }
  });
}

/* ─────────────────────────── 全局按键（Enter 提交 / Esc 放弃·收起） ─────────────────────────── */

function setupKeys(): void {
  window.addEventListener('keydown', (e) => {
    // Esc 收起恢复扇形（炉石式菜单的标配退出键）
    if (e.key === 'Escape' && recoveryPop.classList.contains('show')) { closeRecoveryPop(); return; }
    // 调节确认弹窗：Enter 提交 / Esc 放弃（焦点在按钮上时不抢原生激活，避免双触发）
    if (!adjustCard.classList.contains('show')) return;
    const onButton = !!(e.target as HTMLElement | null)?.closest('button');
    if (e.key === 'Enter' && !e.shiftKey && !onButton) {
      if (e.target !== aNote) { e.preventDefault(); aConfirm.click(); } // 备注框内由 aNote 自己的处理器提交
    } else if (e.key === 'Escape') {
      aCancel.click();
    }
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

/* ─────────────────────────── 精力恢复扇形菜单（径向 chips） ─────────────────────────── */

/** 环圆心 = 窗口底部中心（猫不在本窗口，chips 围绕 HUD 上方展开） */
function syncRingCenter(): void {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight - 120;
  recoveryPop.style.setProperty('--cx', `${Math.round(cx)}px`);
  recoveryPop.style.setProperty('--cy', `${Math.round(cy)}px`);
}

function openRecoveryPop(): void {
  syncRingCenter();
  recoveryPop.classList.add('show');
  // 与面板互斥：扇形菜单打开时收起面板，窗口模式回 pet（chip 自身在热区里）
  panel.classList.remove('open');
  void window.pet.setMode('pet');
  // 主进程看不见这个本地 UI → uiHint(true) 保持窗口可见
  syncUiHint();
  // 同步上报：chip 弹出动画 .3s，动画结束后复核一次最终位置的热区
  reportHotRects();
  window.setTimeout(reportHotRects, 340);
}

function closeRecoveryPop(): void {
  recoveryPop.classList.remove('show');
  versionSlot.innerHTML = '';
  // 本地活动 UI 关闭 → uiHint(false) 交还窗口显隐决定权
  syncUiHint();
  // 同步回收命中区（收起动画期间 chip opacity 仍 >0，必须按 class 立即剔除）
  reportHotRects();
}

function setupRecovery(): void {
  rpClose.addEventListener('click', closeRecoveryPop);
}

/* ─────────────────────────── 恢复项渲染（径向扇形菜单） ───────────────────────────
 * chips 沿**上半环扇形**均匀分布（扇区 150°，围绕窗口底部中心）。
 * 角度约定：0° = 正上方（CSS translateY(-R) 方向），向两侧展开。
 * --i 为弹出顺序：从中间向两侧（0,1,1,2,2,3…），像扑克牌甩出。
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
    chip.title = `${item.name} · 约 ${item.minutes} 分钟`;
    // 精力清单只要文字：不带图标、不带默认值徽标（用户裁决 2026-10-26）
    chip.innerHTML = `<span class="nm">${escapeHtml(item.name)}</span>`;
    chip.addEventListener('click', () => {
      // 选中即按默认值恢复精力：收起菜单，直接进入事件后调节窗口（7s 微调 → 确认弹窗）
      closeRecoveryPop();
      void window.pet.recoveryStartAdjust(item.id).then(w => {
        if (!w) toast('已有调节进行中，请先处理');
      });
    });
    // 长按（500ms）查看默认值版本历史
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

/* ─────────────────────────── 任务面板 ─────────────────────────── */

function openPanel(): void {
  panel.classList.add('open');
  closeRecoveryPop();
  void window.pet.setMode('panel');
  // 展开：同步排一次上报（面板 opacity 过渡中，200ms 节流路径随后补齐完整命中区；
  // panel 模式的宽限期保证过渡期间可交互）
  scheduleHotReport();
  window.setTimeout(reportHotRects, 320); // .28s 过渡结束后复核
}

function closePanel(): void {
  panel.classList.remove('open');
  void window.pet.setMode('pet');
  // 收起：**同步立即**回收面板命中区。不等 200ms 节流 —— 否则光标停在旧面板区时，
  // 主进程轮询仍命中过期 rect，窗口保持可交互，表现为「面板关了那块还挡鼠标」
  reportHotRects();
}

function setupPanel(): void {
  $('panel-close').addEventListener('click', closePanel);
  $('panel-quit').addEventListener('click', () => { void window.pet.quit(); });
  // HUD 天气图标：点击静默刷新（仅更新 HUD 天气图标，不弹文字气泡/toast）
  hudWeather.addEventListener('click', () => { void window.pet.weatherRefresh(); });

  // 任务添加：标题 + 预估消耗（0–5）+ 预估分钟
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
    // 面板展示「任务名称 + 预估/实际时长」（流程联动的信息基础）
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
      doneBtn.className = 'btn sm';
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

/* ─────────────────────────── 周报弹窗 ───────────────────────────
 * 两个入口，同一套奶油纸感样式：
 *  1) state.reportModal（主进程 17:30 调度）：周五 requireAck 只给「已确认」；
 *     关闭（任一按钮）→ reportConfirm（state.reportModal 非空才触发）。
 *  2) onUiCmd showWeekly（右键菜单/托盘「本周报告」）：主动 weeklyReport()，
 *     查看态无 ack、aiSuggestions/decisions 为空数组；关闭不触发 reportConfirm，
 *     且开/关要 uiHint(true/false)（主进程看不见的本地活动 UI）。
 */

/** 渲染载荷：state 推送的 WeeklyReportPayload，或 showWeekly 组装的查看态视图 */
interface ReportView {
  report: WeeklyReport;
  aiSuggestions: WeeklyReportPayload['aiSuggestions'];
  decisions: WeeklyReportPayload['decisions'];
  requireAck: boolean;
  dateStr: string;
}

function renderReport(p: ReportView): void {
  const r = p.report;

  rmRange.textContent = `${fmtDate(r.weekStart)} – ${fmtDate(r.weekEnd - 1)} · 共 ${r.totalEvents} 条留痕`;

  // 主清单：墨线勾选条目（数据全部来自事件流 fold，非拍脑袋）
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

  // AI 推荐默认值：同一恢复项重复 3 次后由记忆产出的校准建议。
  // **每项推荐旁必须带证据计数**（因果链可见才能建立信任，预测错一次信任就崩）：
  // 给出「近 14 天你用了 4 次，3 次你调低了」，用户能自己核对那 4 次记忆。
  // 结构上名称行与证据行成对相邻（拆开渲染会读起来对不上号）。
  if (p.aiSuggestions.length) {
    rmAiSec.style.display = '';
    rmAi.innerHTML = p.aiSuggestions.map(a => {
      const ev = a.evidence;
      // 证据计数的结构化展示：总数 + 主导方向 + 吻合数，与 message 叙事互为印证
      const dominant = ev.adjustedDown > ev.adjustedUp ? '调低' : ev.adjustedUp > ev.adjustedDown ? '调高' : '调整';
      const dominantCount = Math.max(ev.adjustedDown, ev.adjustedUp);
      const counts = `近 ${ev.windowDays} 天用了 ${ev.total} 次 · ${dominantCount} 次${dominant}`
        + (ev.matched > 0 ? ` · ${ev.matched} 次吻合` : '');
      return `<li><span class="tick" aria-hidden="true"></span><span>${escapeHtml(a.itemName)}</span><b class="val">建议 ${fmtDelta(a.suggestedDelta)}</b></li>`
        + `<li class="ev-row">${escapeHtml(counts)}</li>`
        + `<li class="msg-row">${escapeHtml(a.message)}</li>`;
    }).join('');
  } else {
    rmAiSec.style.display = 'none';
  }

  // 历史决策留痕：近 7 天已确认的默认值变更（含来源）
  if (p.decisions.length) {
    rmDecSec.style.display = '';
    rmDec.innerHTML = p.decisions.map(d =>
      `<li><span class="tick" aria-hidden="true"></span><span class="src">${escapeHtml(d.source === 'ai' ? 'AI' : d.source === 'system' ? '系统' : '你')}</span>`
      + `<span>${escapeHtml(d.itemName)} → ${d.delta}</span>`
      + `<b class="val at">${fmtDate(d.createdAt)}</b></li>`,
    ).join('');
  } else {
    rmDecSec.style.display = 'none';
  }

  rmNote.innerHTML = r.narrative.map(n => escapeHtml(n)).join('<br>');
}

/** 收起弹窗（两种态通吃）：查看态还要交还 uiHint */
function hideReportModal(): void {
  shownReportDate = null;
  weeklyViewOpen = false;
  reportModal.classList.remove('show');
  syncUiHint();
  reportHotRects();
}

/** state.reportModal 驱动的显隐（payload 为 null 时收起；主动查看态不被误收） */
function applyReportModal(p: WeeklyReportPayload | null): void {
  if (!p) {
    if (shownReportDate !== null) {
      shownReportDate = null;
      if (!weeklyViewOpen) {
        reportModal.classList.remove('show');
        reportHotRects();
      }
    }
    return;
  }
  if (shownReportDate === p.dateStr && !weeklyViewOpen && reportModal.classList.contains('show')) return; // 已在显示同一份
  // 状态弹窗接管「主动查看态」：关闭从此走 reportConfirm
  weeklyViewOpen = false;
  shownReportDate = p.dateStr;
  renderReport(p);
  // 周五 requireAck：隐藏随手关闭按钮，必须点「已确认」
  rmAck.style.display = '';
  rmClose.style.display = p.requireAck ? 'none' : '';
  reportModal.classList.add('show');
  syncUiHint();
  reportHotRects();
}

/** onUiCmd showWeekly：主动拉取周报，以查看态展示（无 ack；关闭不 reportConfirm） */
async function showWeekly(): Promise<void> {
  // 已有状态驱动的弹窗在队列里 → 直接呈现它（带 ack 语义，不重复拉取）
  if (state?.reportModal) { applyReportModal(state.reportModal); return; }
  const r = await window.pet.weeklyReport();
  if (!r) { toast('还没有可用的周报数据'); return; }
  shownReportDate = null;
  weeklyViewOpen = true;
  // dateStr 用 manual- 前缀：避免与 17:30 定时弹窗的 YYYY-MM-DD 去重键相撞
  renderReport({ report: r, aiSuggestions: [], decisions: [], requireAck: false, dateStr: `manual-${Date.now()}` });
  rmAck.style.display = 'none';  // 查看态：无确认按钮
  rmClose.style.display = '';
  reportModal.classList.add('show');
  syncUiHint(); // uiHint(true)：主进程看不见查看态，保持窗口可见
  reportHotRects();
}

function setupReportModal(): void {
  const closeIt = (): void => {
    // 查看态关闭：只收起 + uiHint(false)，绝不触发 reportConfirm
    if (weeklyViewOpen) { hideReportModal(); return; }
    // state.reportModal 非空：关闭（含周五「已确认」与非周五随手关）都走 reportConfirm
    void window.pet.reportConfirm().then(() => {
      // 主进程确认后 state 推送会驱动收起；这里也同步收，避免空窗
      shownReportDate = null;
      reportModal.classList.remove('show');
      reportHotRects();
    });
  };
  rmAck.addEventListener('click', closeIt);
  rmClose.addEventListener('click', closeIt);
}

/* ─────────────────────────── AI 推荐卡（堆叠，三态处置） ─────────────────────────── */

function renderRecommendations(recs: InsightRecommendation[]): void {
  // 新增的推荐才建卡；已移除的删卡
  const currentIds = new Set(recs.map(r => r.id));
  for (const id of [...shownRecIds]) {
    if (!currentIds.has(id)) {
      const el = recStack.querySelector(`[data-rec="${id}"]`);
      if (el) {
        el.classList.add('leaving');
        reportHotRects(); // 退场动画期间命中区**立即**回收（.leaving 被 explicitHidden 剔除）
        setTimeout(() => el.remove(), 300);
      }
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
      <div class="r-sugg">建议默认值 <b>${fmtDelta(rec.suggestedDelta)}</b></div>
      <div class="r-edit" hidden>
        <input type="number" min="-2" max="5" step="0.5" value="${rec.suggestedDelta}" aria-label="你期望的默认值" />
        <button class="btn sm" data-act="modify-ok">好</button>
        <span class="r-edit-hint">可填 -2 ~ 5</span>
      </div>
      <div class="r-actions">
        <button class="btn ghost" data-act="rejected">拒绝</button>
        <button class="btn ghost" data-act="modified">改一改</button>
        <button class="btn" data-act="accepted">采纳</button>
      </div>
    `;
    const edit = card.querySelector<HTMLElement>('.r-edit')!;
    const editInput = card.querySelector<HTMLInputElement>('.r-edit input')!;
    const editOk = card.querySelector<HTMLButtonElement>('[data-act="modify-ok"]')!;
    const resolve = (act: 'accepted' | 'modified' | 'rejected', delta: number): void => {
      void window.pet.recommendationResolve(rec.id, act, delta).then(ok => {
        if (ok) {
          toast(act === 'accepted' ? '已校准默认值' : act === 'modified' ? '已按你的值校准' : '好的，先不动');
        }
      });
    };
    card.querySelectorAll<HTMLButtonElement>('.r-actions .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act as 'accepted' | 'modified' | 'rejected';
        if (act === 'modified') {
          // 改一改：弹内联数字输入，确认后才 resolve
          edit.hidden = !edit.hidden;
          if (!edit.hidden) editInput.focus();
          return;
        }
        resolve(act, rec.suggestedDelta);
      });
    });
    const submitModified = (): void => {
      const v = Math.max(-2, Math.min(5, Number(editInput.value) || 0));
      resolve('modified', v);
    };
    editOk.addEventListener('click', submitModified);
    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitModified(); }
    });
    recStack.appendChild(card);
    // 最多同时展示 2 张，其余等待
    while (recStack.children.length > 2) recStack.firstElementChild?.remove();
  }
}

/* ─────────────────────────── 主状态渲染 ─────────────────────────── */

/** 低精力提醒的 UI 阈值（跨过 3 分下行时 toast） */
const LOW_ENERGY_TOAST_AT = 3;

function applyState(s: AppState): void {
  const prev = state;
  state = s;

  // HUD（调节窗口期间显示草稿值、滑动卡预览期间显示预览值，均不被真值覆盖）
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
  // 面板副标题：情绪×天气一句话（与旧 panelSub 等价）
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

  renderRecoveries(s.recoveries);
  renderTasks();
  renderRecommendations(s.recommendations);

  // 周报弹窗（主进程 17:30 调度驱动；确认后 state 推 null 收起）
  applyReportModal(s.reportModal);

  // 低精力提示（跨过阈值下行时）：仅 toast
  if (prev && prev.energy >= LOW_ENERGY_TOAST_AT && s.energy < LOW_ENERGY_TOAST_AT) {
    toast(`电量低于 ${LOW_ENERGY_TOAST_AT} 分了，要不要休息一下？`, 3200);
  }
}

/* ─────────────────────────── 启动 ─────────────────────────── */

function boot(): void {
  initHudCells();
  // HUD 不再常驻：精力值已移到桌宠下方的悬浮胶囊（catWin）。
  // uiWin 的 HUD 仅在事件后调节窗期间出现（草稿滑条 + 倒计时角标）。
  syncRingCenter();
  paintRange(sSlider);
  paintRange(aSlider);

  setupHitTest();
  setupSlide();
  setupHudSlider();
  setupAdjustCard();
  setupDurationCard();
  setupPanel();
  setupRecovery();
  setupReportModal();
  setupKeys();

  window.pet.onState((s) => applyState(s));
  window.pet.onUiCmd((cmd: UiCmd) => {
    switch (cmd.type) {
      case 'openPanel': openPanel(); break;
      case 'openRecovery': openRecoveryPop(); break;
      case 'showWeekly': void showWeekly(); break;
    }
  });
  void window.pet.getState().then(s => { if (s) applyState(s); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export {};
