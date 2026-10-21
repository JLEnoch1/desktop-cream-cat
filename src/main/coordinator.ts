/**
 * Coordinator —— 主进程模块协调器。
 *
 * 职责：
 *  - 组装 DecisionLog / EnergyLedger / TaskCenter / RecoveryDeck / WeatherSensor / InsightEngine / EmotionEngine
 *  - 维护 PendingSlide 状态机（同一时刻最多一张滑动卡）
 *  - 计算 AppState（fold 事件流 → 情绪 → 推送渲染进程）
 *  - 晨间基线：开机后若无今日 energy.set，默认展示「昨日收尾精力」的滑动卡
 *  - 天气定时刷新 + AI 推荐批处理（主循环不依赖）
 */

import { join } from 'node:path';
import { DecisionLog, localDateStr } from '../storage/sqlite.js';
import { EventBus } from '../core/bus.js';
import { EnergyLedger } from '../ledger/energy.js';
import { TaskCenter } from '../task/center.js';
import { RecoveryDeck } from '../recovery/deck.js';
import { WeatherSensor } from '../weather/sensor.js';
import type { WeatherFetcher } from '../weather/sensor.js';
import { resolveGeo } from '../weather/geo.js';
import { InsightEngine } from '../insight/engine.js';
import { resolve as resolveEmotion, describe as describeEmotion } from '../emotion/engine.js';
import type { EmotionState } from '../core/types.js';
import { ENERGY_MAX } from '../core/types.js';
import { INITIAL_ENERGY } from '../ledger/fold.js';
import {
  recAcceptedDraft, recModifiedDraft, recRejectedDraft, recShownDraft,
  sessionEndedDraft, sessionStartedDraft, round2,
} from '../core/events.js';
import type { DomainEvent } from '../core/events.js';
import type { AppState, PendingSlide, WindowMode, WeeklyReport, WeeklyReportPayload, AdjustWindow, TaskDurationRequest } from '../core/types.js';

/** 天气刷新间隔（30 分钟） */
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
/** AI 推荐批处理间隔（10 分钟，离线本地计算） */
const INSIGHT_BATCH_MS = 10 * 60 * 1000;
/**
 * 事件完成后的精力调节窗口静置倒计时（ms）。
 *
 * 停止操作后 7 秒到点转 confirming。**拖动会重置倒计时**
 * （需求 3：拖动过程中不计入静置时间），但受 ADJUST_WINDOW_HARD_MAX_MS
 * 硬上限约束，防止持续拖动让窗口永不关闭。
 */
export const ADJUST_WINDOW_MS = 7000;
/** 调节窗口总时长硬上限（ms）：从打开起算，超时强制 confirming */
export const ADJUST_WINDOW_HARD_MAX_MS = 60000;
/** 周报弹窗检查间隔（ms）：60s 轮询一次是否到达 17:30 */
export const REPORT_CHECK_MS = 60 * 1000;
/** 每日周报触发时刻：17:30（本地时区） */
export const REPORT_TRIGGER_HOUR = 17;
export const REPORT_TRIGGER_MINUTE = 30;
/** meta 键：最近一次周报弹窗日期（YYYY-MM-DD，防同日重复弹） */
export const REPORT_LAST_DATE_META = 'last_report_date';

export interface CoordinatorOptions {
  userDataPath: string;
  /** 注入天气抓取器（测试/自定义数据源） */
  weatherFetcher?: WeatherFetcher;
  lat?: number;
  lon?: number;
}

export class Coordinator {
  readonly bus = new EventBus();
  readonly log: DecisionLog;
  readonly ledger: EnergyLedger;
  readonly tasks: TaskCenter;
  readonly deck: RecoveryDeck;
  readonly weather: WeatherSensor;
  readonly insight: InsightEngine;

  private pendingSlide: PendingSlide | null = null;
  /** 事件后的精力调节窗口（null = 进度条只读预览） */
  private adjustWindow: AdjustWindow | null = null;
  private adjustTimer: ReturnType<typeof setTimeout> | null = null;
  /** 调节窗口硬上限截止时刻（openedAt + 60s），拖动重置倒计时也不得越过 */
  private adjustHardDeadline = 0;
  /** 启动延迟 3s 的首次洞察批处理定时器（stop 时必须清掉，否则向已关闭的 db 发查询） */
  private insightStartupTimer: ReturnType<typeof setTimeout> | null = null;
  /** 启动延迟 1.5s 的 IP 定位定时器（stop 时清掉，避免退出后写已关闭的 db） */
  private geoTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否启用启动期 IP 定位（测试模式/显式坐标时关闭） */
  private readonly geoEnabled: boolean;
  /** 周报弹窗载荷（null = 不显示；每天 17:30 生成，确认后清空） */
  private reportModal: WeeklyReportPayload | null = null;
  private mode: WindowMode = 'pet';
  private morningDone = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastPushedJson = '';

  constructor(opts: CoordinatorOptions) {
    const dbPath = join(opts.userDataPath, 'energy-pet.db');
    this.log = new DecisionLog({ dbPath });
    this.ledger = new EnergyLedger(this.log);
    this.tasks = new TaskCenter(this.log);
    this.deck = new RecoveryDeck(this.log);
    this.weather = new WeatherSensor({
      log: this.log,
      ...(opts.lat !== undefined ? { lat: opts.lat } : {}),
      ...(opts.lon !== undefined ? { lon: opts.lon } : {}),
      ...(opts.weatherFetcher ? { fetcher: opts.weatherFetcher } : {}),
    });
    this.insight = new InsightEngine({ log: this.log });
    // 测试模式：注入 fetcher 或显式坐标 → 跳过 IP 定位，保证离线确定性
    this.geoEnabled = opts.weatherFetcher === undefined && opts.lat === undefined && opts.lon === undefined;
  }

  /* ─────────────────────────── 生命周期 ─────────────────────────── */

  async start(): Promise<void> {
    // 种子恢复项版本历史
    this.deck.seedIfEmpty();
    // 开机事件
    this.log.append(sessionStartedDraft());
    // 首次天气刷新（不阻塞启动）
    this.weather.refresh().then(() => this.bus.emit('weather:changed', { source: this.weather.current().source })).catch(() => {});
    // 定时任务
    this.timers.push(setInterval(() => {
      this.weather.refresh().then(() => this.bus.emit('weather:changed', { source: this.weather.current().source })).catch(() => {});
    }, WEATHER_REFRESH_MS));
    this.timers.push(setInterval(() => this.runInsightBatch(), INSIGHT_BATCH_MS));
    // 周报调度（需求 5）：每 60s 检查是否到达 17:30；无随时查看入口，仅弹窗一条路
    this.timers.push(setInterval(() => this.checkReportDue(), REPORT_CHECK_MS));
    // 晨间基线（同步触发；渲染层自行用 RAF 延迟显示，让宠物先出现）
    this.maybeMorningBaseline();
    // 周报补弹：启动时已过 17:30 且今天没弹过 → 立即补弹（错过的不丢）
    this.checkReportDue();
    // 启动即产出一次推荐检测（本地批处理，很快）
    this.insightStartupTimer = setTimeout(() => { this.insightStartupTimer = null; this.runInsightBatch(); }, 3000);
    // IP 定位（需求 4）：缓存未过期时构造期已应用坐标；否则异步定位后热更新并重拉天气。
    // 延迟 1.5s 避开启动网络争抢；定位失败不影响任何功能（传感器继续用兜底坐标）。
    if (this.geoEnabled) {
      this.geoTimer = setTimeout(() => {
        this.geoTimer = null;
        resolveGeo(this.log)
          .then(async (p) => {
            // 省市一并传入：QQ 天气（默认主源）按省+市查询实时观测
            this.weather.setLocation(p.lat, p.lon, p.city, p.province);
            this.bus.emit('geo:changed', p);
            await this.weather.refresh();
            this.bus.emit('weather:changed', { source: this.weather.current().source });
          })
          .catch(() => {});
      }, 1500);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // 调节窗口的 setTimeout 不属于 timers 数组，必须单独清掉，
    // 否则退出后仍会触发一次 expireAdjustWindow → 向已关闭的 bus 发事件
    this.clearAdjustTimer();
    this.adjustWindow = null;
    // 启动延迟洞察定时器同理：不清会在 db 关闭后触发一次查询（database is not open）
    if (this.insightStartupTimer) { clearTimeout(this.insightStartupTimer); this.insightStartupTimer = null; }
    // IP 定位定时器同理
    if (this.geoTimer) { clearTimeout(this.geoTimer); this.geoTimer = null; }
    // 收尾事件：记录当日收尾精力
    try {
      const e = this.ledger.current();
      this.log.append(sessionEndedDraft(e));
      this.log.upsertDailySnapshot(new Date(), e);
    } catch { /* db already closed */ }
    this.bus.clear();
    this.log.close();
  }

  /* ─────────────────────────── 状态计算 ─────────────────────────── */

  /** 组装 AppState（渲染进程唯一数据入口） */
  buildState(): AppState {
    const energy = this.ledger.current();
    const weather = this.weather.current();
    const events = this.ledger.todayEvents();
    const emotion = resolveEmotion({ energy, weather, events });
    return {
      energy,
      emotion,
      weather,
      tasks: this.tasks.list(),
      recoveries: this.deck.list(),
      morningBaselinePending: !this.morningDone && this.pendingSlide?.kind === 'morning-baseline',
      pendingSlide: this.pendingSlide,
      adjustWindow: this.buildAdjustWindow(),
      recommendations: this.insight.pendingRecommendations(),
      reportModal: this.reportModal,
      mode: this.mode,
      lastUpdated: Date.now(),
    };
  }

  /**
   * 对外的调节窗口视图。
   * remainingMs 每次组装时重算，保证推送出去的倒计时不是过期值。
   */
  private buildAdjustWindow(): AdjustWindow | null {
    const w = this.adjustWindow;
    if (!w) return null;
    const remaining = w.phase === 'confirming' ? 0 : Math.max(0, w.expiresAt - Date.now());
    return { ...w, remainingMs: remaining };
  }

  /** 状态变化推送（去重：JSON 相同则跳过） */
  pushState(send: (channel: string, payload: unknown) => void): void {
    const state = this.buildState();
    const json = JSON.stringify({ ...state, lastUpdated: 0 });
    if (json === this.lastPushedJson) return;
    this.lastPushedJson = json;
    send('state:update', state);
  }

  /** 情绪一句话摘要（气泡用） */
  emotionSummary(): string {
    const s = this.buildState();
    return describeEmotion(s.emotion, s.weather);
  }

  /* ─────────────────────────── 滑动确认状态机 ─────────────────────────── */

  /**
   * 请求弹出滑动卡。已有卡片时排队失败返回 null。
   *
   * 职责收窄：本状态机现在只负责 **morning-baseline（晨间基线）** 与
   * **manual-adjust（临时预览）** 两类。
   *
   * 任务完成 / 恢复项已迁移到「事件后调节窗口」（见 openAdjustWindow），
   * 不再走这里 —— 目的是让 `task.completed` / `recovery.taken` 只有
   * commitAdjust() 一个写入点，避免两条路径各自算 delta 而分叉。
   * 对这两种 kind 直接返回 null，调用方应改用 taskDurationRequest /
   * recoveryStartAdjust。
   */
  requestSlide(kind: PendingSlide['kind'], _refId: string): PendingSlide | null {
    if (kind === 'task-complete' || kind === 'recovery') return null;
    if (this.pendingSlide) return null;
    let slide: PendingSlide | null = null;
    if (kind === 'morning-baseline') slide = this.buildMorningSlide();
    else if (kind === 'manual-adjust') slide = this.buildManualSlide();
    if (!slide) return null;
    this.pendingSlide = slide;
    this.bus.emit('slide:requested', { kind: slide.kind, refId: slide.refId });
    return slide;
  }

  /**
   * 滑动预览 —— 不落库。
   * target 为「目标绝对精力值」（新模型：滑块直接滑真实精力，事件默认值仅作参考）。
   * manual-adjust 卡片全程只走这里，确认/取消都不写事件流。
   */
  previewSlide(target: number): { energy: number; emotion: EmotionState } {
    const projected = clamp(target);
    const weather = this.weather.current();
    const events = this.ledger.todayEvents();
    const emotion = resolveEmotion({ energy: projected, weather, events });
    return { energy: round2(projected), emotion };
  }

  /**
   * 确认滑动 —— 晨间基线的唯一写入口。
   * target 为用户确认的「当前真实精力值」（绝对值）。
   * actual_delta = target - baseEnergy。
   * manual-adjust 是临时预览，确认不落库（结束时恢复原状态）。
   *
   * task-complete / recovery 已不走这里（见 requestSlide 的职责说明），
   * 它们的写入点唯一：commitAdjust()。
   */
  confirmSlide(target: number, _note?: string): DomainEvent | null {
    const slide = this.pendingSlide;
    if (!slide) return null;

    // 临时调节：不写任何事件，直接关卡（精力保持原值）
    if (slide.kind === 'manual-adjust') {
      this.pendingSlide = null;
      this.bus.emit('slide:cancelled', { kind: slide.kind, refId: slide.refId });
      this.bus.emit('state:dirty');
      return null;
    }

    const goal = clamp(target);
    // delta = 真实精力 - 事件前精力（goal 已钳制在 0–ENERGY_MAX，delta 天然有界）
    const d = round2(goal - slide.baseEnergy);
    let ev: DomainEvent | null = null;

    if (slide.kind === 'morning-baseline') {
      // 晨间基线：直接设定今日初始精力
      ev = this.ledger.setEnergy(clamp(slide.baseEnergy + d), '晨间基线');
      this.morningDone = true;
    }
    this.pendingSlide = null;
    if (ev) {
      this.bus.emit('event:appended', { id: ev.id, type: ev.type });
      this.bus.emit('energy:changed', { energy: this.ledger.current(), previous: this.ledger.current() - (ev.actual_delta ?? 0) });
      this.bus.emit('slide:confirmed', { kind: slide.kind, refId: slide.refId, delta: d });
    }
    this.bus.emit('state:dirty');
    return ev;
  }

  cancelSlide(): void {
    const slide = this.pendingSlide;
    if (!slide) return;
    this.pendingSlide = null;
    // 晨间基线取消也算完成（不强制）
    if (slide.kind === 'morning-baseline') this.morningDone = true;
    this.bus.emit('slide:cancelled', { kind: slide.kind, refId: slide.refId });
    this.bus.emit('state:dirty');
  }

  /* ─────────────────────────── 事件后的精力调节窗口 ─────────────────────────── */

  /**
   * 打开调节窗口（唯一入口）。
   *
   * 关键语义：**事件本体此刻尚未落库**。窗口只持有一份「草稿精力」，
   * 要等用户在确认弹窗里点「确认」才由 commitAdjust() 写入事件流。
   * 中途取消 → 草稿丢弃，任务保持 open / 恢复项不计次。
   *
   * slide 参数复用 TaskCenter.requestComplete / RecoveryDeck.requestTake 的产物，
   * 以便 predicted / baseEnergy / 参考范围只有一处定义。
   */
  private openAdjustWindow(
    slide: PendingSlide,
    opts: { label: string; icon: string; actualMinutes: number | null },
  ): AdjustWindow | null {
    if (this.adjustWindow) return null; // 同一时刻只允许一个窗口
    const now = Date.now();
    const defaultEnergy = clamp(slide.baseEnergy + slide.predicted);
    this.adjustHardDeadline = now + ADJUST_WINDOW_HARD_MAX_MS;
    this.adjustWindow = {
      kind: slide.kind === 'task-complete' ? 'task-complete' : 'recovery',
      refId: slide.refId,
      label: opts.label,
      icon: opts.icon,
      baseEnergy: slide.baseEnergy,
      predicted: slide.predicted,
      defaultEnergy,
      // 草稿起点 = 事件默认精力值，用户可在此基础上左右微调
      draftEnergy: defaultEnergy,
      actualMinutes: opts.actualMinutes,
      phase: 'adjusting',
      remainingMs: ADJUST_WINDOW_MS,
      openedAt: now,
      expiresAt: now + ADJUST_WINDOW_MS,
    };
    this.armAdjustTimer();
    this.bus.emit('adjust:opened', { kind: this.adjustWindow.kind, refId: this.adjustWindow.refId });
    this.bus.emit('state:dirty');
    return this.buildAdjustWindow();
  }

  /** 重排静置倒计时：7s，但不得越过 60s 硬上限 */
  private armAdjustTimer(): void {
    this.clearAdjustTimer();
    const delay = Math.max(0, Math.min(ADJUST_WINDOW_MS, this.adjustHardDeadline - Date.now()));
    this.adjustTimer = setTimeout(() => {
      this.adjustTimer = null;
      this.expireAdjustWindow();
    }, delay);
  }

  private clearAdjustTimer(): void {
    if (this.adjustTimer) { clearTimeout(this.adjustTimer); this.adjustTimer = null; }
  }

  /**
   * 到点：adjusting → confirming。
   *
   * 只切相位，**既不自动落库也不自动丢弃** —— 必须等用户在弹窗里表态。
   * 这是「窗口结束弹出确认弹窗」的落点，也是防止草稿被静默写库的关键。
   */
  private expireAdjustWindow(): void {
    const w = this.adjustWindow;
    if (!w || w.phase !== 'adjusting') return;
    w.phase = 'confirming';
    w.remainingMs = 0;
    this.bus.emit('adjust:confirming', { refId: w.refId });
    this.bus.emit('state:dirty');
  }

  /**
   * 窗口内微调（adjusting / confirming 皆可）：只改草稿，不落库。
   * adjusting 相位下拖动 = 用户仍在操作 → **重置 7s 静置倒计时**
   * （需求 3：拖动过程中不计入静置时间），但受 60s 硬上限封顶。
   */
  adjustDraft(target: number): AdjustWindow | null {
    const w = this.adjustWindow;
    if (!w) return null;
    w.draftEnergy = clamp(target);
    if (w.phase === 'adjusting') {
      w.expiresAt = Math.min(Date.now() + ADJUST_WINDOW_MS, this.adjustHardDeadline);
      this.armAdjustTimer();
    }
    this.bus.emit('adjust:changed', { draft: w.draftEnergy });
    this.bus.emit('state:dirty');
    return this.buildAdjustWindow();
  }

  /** 确认弹窗 → 落库（事件后精力调节的唯一写入点） */
  commitAdjust(note?: string): DomainEvent | null {
    const w = this.adjustWindow;
    if (!w) return null;
    const delta = round2(w.draftEnergy - w.baseEnergy);
    const ev = w.kind === 'task-complete'
      ? this.tasks.confirmComplete(w.refId, delta, note, w.actualMinutes)
      : this.deck.confirmTake(w.refId, delta, note);
    this.closeAdjustWindow();
    if (ev) {
      this.bus.emit('event:appended', { id: ev.id, type: ev.type });
      this.bus.emit('energy:changed', { energy: this.ledger.current(), previous: w.baseEnergy });
      this.bus.emit('adjust:committed', { refId: w.refId, delta, energy: this.ledger.current() });
    }
    this.bus.emit('state:dirty');
    return ev;
  }

  /** 放弃调节：草稿丢弃，事件不落库 */
  cancelAdjust(): void {
    const w = this.adjustWindow;
    if (!w) return;
    this.closeAdjustWindow();
    this.bus.emit('adjust:cancelled', { refId: w.refId });
    this.bus.emit('state:dirty');
  }

  private closeAdjustWindow(): void {
    this.clearAdjustTimer();
    this.adjustWindow = null;
  }

  /* ─────────────────────────── 事件触发入口 ─────────────────────────── */

  /**
   * 任务流程第一步：取任务名称与预估时长，供面板展示「实际时长」确认表单。
   * 不打开调节窗口、不落库。
   */
  taskDurationRequest(taskId: string): TaskDurationRequest | null {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'open') return null;
    return {
      taskId: t.id,
      title: t.title,
      estMinutes: t.estMinutes,
      estCost: t.estCost,
      createdAt: t.createdAt,
    };
  }

  /**
   * 任务流程第二步：用户确认实际时长后，才打开精力调节窗口。
   * 顺序不可颠倒 —— 「先确认时长，再调精力」是流程要求。
   */
  taskCompleteWithDuration(taskId: string, actualMinutes: number): AdjustWindow | null {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'open') return null;
    const slide = this.tasks.requestComplete(taskId, this.ledger.current());
    if (!slide) return null;
    const mins = Number.isFinite(actualMinutes) ? Math.max(0, round2(actualMinutes)) : null;
    return this.openAdjustWindow(slide, { label: t.title, icon: '✅', actualMinutes: mins });
  }

  /** 恢复项：时长固定，直接打开调节窗口 */
  recoveryStartAdjust(itemId: string): AdjustWindow | null {
    const item = this.deck.get(itemId);
    if (!item) return null;
    const slide = this.deck.requestTake(itemId, this.ledger.current());
    if (!slide) return null;
    return this.openAdjustWindow(slide, {
      label: item.name,
      icon: item.icon,
      actualMinutes: item.minutes,
    });
  }

  /* ─────────────────────────── 晨间基线 ─────────────────────────── */

  /** 今日是否已设过基线（有 energy.set 事件即视为已设） */
  private hasTodayBaseline(): boolean {
    return this.ledger.todayEvents().some(e => e.type === 'energy.set' && e.payload.kind === 'energy.set' && e.payload.reason === '晨间基线');
  }

  /** 基线滑动起点：昨日收尾精力（无则 INITIAL_ENERGY） */
  private morningBaselineStart(): number {
    return this.ledger.yesterdayCloseEnergy() ?? INITIAL_ENERGY;
  }

  private buildMorningSlide(): PendingSlide {
    const start = this.morningBaselineStart();
    return {
      kind: 'morning-baseline',
      refId: 'baseline',
      title: '早安，今天感觉如何？',
      subtitle: `昨天收尾在 ${start} 分。滑动设定今日初始精力`,
      predicted: 0,
      min: 0,
      max: ENERGY_MAX,
      absMax: ENERGY_MAX,
      baseEnergy: start,
      createdAt: Date.now(),
    };
  }

  /**
   * 临时调节卡 —— 纯预览，不落库。
   * 用户可随时拖动查看宠物在不同精力下的状态，确认/关闭后精力保持原值。
   * 真正生效的调节只有「事件完成后的滑动确认」一条路。
   */
  private buildManualSlide(): PendingSlide {
    const base = this.ledger.current();
    return {
      kind: 'manual-adjust',
      refId: 'manual',
      title: '临时调节 · 仅预览',
      subtitle: `当前精力 ${base} 分。拖动看看状态，关闭后自动恢复`,
      predicted: 0,
      min: 0,
      max: ENERGY_MAX,
      absMax: ENERGY_MAX,
      baseEnergy: base,
      createdAt: Date.now(),
    };
  }

  private maybeMorningBaseline(): void {
    if (this.morningDone || this.hasTodayBaseline()) { this.morningDone = true; return; }
    if (this.pendingSlide) return;
    this.requestSlide('morning-baseline', 'baseline');
  }

  /* ─────────────────────────── 任务 / 恢复 快捷入口 ─────────────────────────── */

  createTask(title: string, estCost: number, dueAt: number | null = null, estMinutes = 0): void {
    this.tasks.create(title, estCost, dueAt, estMinutes);
    this.bus.emit('task:changed');
    this.bus.emit('state:dirty');
  }

  dropTask(taskId: string): void {
    this.tasks.drop(taskId);
    this.bus.emit('task:changed');
    this.bus.emit('state:dirty');
  }

  /* ─────────────────────────── AI 推荐 ─────────────────────────── */

  private runInsightBatch(): void {
    try {
      const produced = this.insight.detectRecommendations();
      for (const rec of produced) {
        this.log.append(recShownDraft(rec.id, rec.itemId));
        this.bus.emit('recommendation:new', { id: rec.id, itemId: rec.itemId });
      }
      if (produced.length) this.bus.emit('state:dirty');
    } catch (err) {
      console.error('[insight] batch failed:', err);
    }
  }

  /** 处置推荐：accepted/modified → 更新恢复项默认值（写版本历史） */
  resolveRecommendation(recId: string, action: 'accepted' | 'modified' | 'rejected', modifiedDelta?: number): boolean {
    const result = this.insight.resolveRecommendation(recId, action, modifiedDelta);
    if (!result) return false;
    if (action === 'accepted') {
      this.log.append(recAcceptedDraft(recId, result.itemId, result.newDelta ?? 0));
      if (result.newDelta !== null) this.deck.updateDelta(result.itemId, result.newDelta, '采纳 AI 推荐校准', 'ai');
    } else if (action === 'modified') {
      this.log.append(recModifiedDraft(recId, result.itemId, modifiedDelta ?? 0));
      if (result.newDelta !== null) this.deck.updateDelta(result.itemId, result.newDelta, '用户修改后采纳', 'user');
    } else {
      this.log.append(recRejectedDraft(recId, result.itemId));
    }
    this.bus.emit('recovery:changed');
    this.bus.emit('state:dirty');
    return true;
  }

  /* ─────────────────────────── 周报 ─────────────────────────── */

  weeklyReport(): WeeklyReport {
    return this.insight.weeklyReport();
  }

  /**
   * 周报到期检查（需求 5）：本地时区 17:30 后、且今日未弹过 → 弹窗。
   * - 每天只弹一次：meta last_report_date 记录已弹日期
   * - 错过补弹：启动时已过 17:30 也会命中（checkReportDue 在 start() 同步调用一次）
   * - 周五 requireAck：重点确认，弹窗必须点「已确认」才收
   */
  private checkReportDue(): void {
    if (this.reportModal) return; // 已有未确认弹窗（周五场景），不重复弹
    // 用 Date.now() 构造（而非裸 new Date()）：测试可冻结时钟做确定性断言
    const now = new Date(Date.now());
    const hhmm = now.getHours() * 60 + now.getMinutes();
    if (hhmm < REPORT_TRIGGER_HOUR * 60 + REPORT_TRIGGER_MINUTE) return; // 未到 17:30
    const dateStr = localDateStr(now);
    if (this.log.getMeta(REPORT_LAST_DATE_META) === dateStr) return; // 今日已弹过

    const report = this.insight.weeklyReport(now);
    const aiSuggestions = this.insight.pendingRecommendations().map(r => ({
      itemId: r.itemId,
      itemName: r.itemName,
      suggestedDelta: r.suggestedDelta,
      message: r.message,
    }));
    const weekStartMs = report.weekStart;
    const itemNames = new Map(this.deck.list().map(i => [i.id, i.name] as const));
    const decisions = this.log.recentRecoveryDecisions(weekStartMs).map(v => ({
      itemId: v.item_id,
      itemName: itemNames.get(v.item_id) ?? v.item_id,
      delta: v.delta,
      reason: v.reason,
      source: v.source,
      createdAt: v.created_at,
    }));
    this.reportModal = {
      report,
      aiSuggestions,
      decisions,
      requireAck: now.getDay() === 5, // 周五重点确认
      dateStr,
    };
    this.log.setMeta(REPORT_LAST_DATE_META, dateStr);
    this.bus.emit('state:dirty');
  }

  /** 周报弹窗确认/关闭（周五 requireAck 时渲染层只给确认按钮，非周五可随手关） */
  confirmReport(): void {
    if (!this.reportModal) return;
    this.reportModal = null;
    this.bus.emit('state:dirty');
  }

  /* ─────────────────────────── 窗口模式 ─────────────────────────── */

  setMode(mode: WindowMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.bus.emit('mode:changed', { mode });
    this.bus.emit('state:dirty');
  }

  getMode(): WindowMode {
    return this.mode;
  }
}

/* ─────────────────────────── 工具 ─────────────────────────── */

function clamp(v: number): number {
  return Math.min(ENERGY_MAX, Math.max(0, round2(v)));
}

export { WEATHER_REFRESH_MS, INSIGHT_BATCH_MS };
