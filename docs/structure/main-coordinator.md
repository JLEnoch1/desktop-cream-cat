# `src/main/coordinator.ts` — 模块协调器（653 行）

> 模块存根（原 STRUCTURE_MAP §3.13）· 层级 **L3** · 测试：tests/coordinator.test.ts（16 例）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：装配全部领域模块 + 维护**两套并存的状态机** + 计算 AppState + 周报定时触发。
 * 是「领域层」与「Electron 层」之间唯一的接缝：main/index.ts 只认 Coordinator。
 *
 * 🔴 **两套状态机不可混淆**（首版存根只记了滑动卡那套，v1.3 补全）：
 *   ① 事件后调节窗口（AdjustWindow）：task-complete / recovery，7s 静置倒计时
 *   ② 滑动卡（PendingSlide）：morning-baseline / manual-adjust
 *   requestSlide() 对 kind ∈ {task-complete, recovery} **直接返回 null** —— 刻意迁走，
 *   目的是让这两类事件只有 commitAdjust() 一个写入点（否则两条路径各算 delta 会分叉）。
 */

const WEATHER_REFRESH_MS = 30 * 60 * 1000;   // 天气刷新间隔（模块内私有，非 export）
const INSIGHT_BATCH_MS = 10 * 60 * 1000;     // AI 推荐批处理间隔（同上）

export const ADJUST_WINDOW_MS = 7000;              // 🔴 R8/R9：事件后调节窗口静置倒计时
export const ADJUST_WINDOW_HARD_MAX_MS = 60000;    // 🔴 硬上限，拖动重置也封顶
export const REPORT_CHECK_MS = 60 * 1000;          // 周报轮询间隔（60s）
export const REPORT_TRIGGER_HOUR = 17;             // 触发时刻：17:30
export const REPORT_TRIGGER_MINUTE = 30;
export const REPORT_LAST_DATE_META = 'last_report_date';  // 防重复弹的 meta key

export interface CoordinatorOptions {
  userDataPath: string;
  weatherFetcher?: WeatherFetcher;   // 注入天气抓取器（测试/自定义数据源）
  lat?: number;
  lon?: number;
}

export class Coordinator {
  readonly bus: EventBus;              // 自建实例（非 core/bus 的全局单例）
  readonly log: DecisionLog;
  readonly ledger: EnergyLedger;
  readonly tasks: TaskCenter;
  readonly deck: RecoveryDeck;
  readonly weather: WeatherSensor;
  readonly insight: InsightEngine;

  constructor(opts: CoordinatorOptions);
    // ⟨dbPath = join(userDataPath, 'energy-pet.db')；按序装配 7 个模块；
    //   lat/lon 仅在显式提供时透传（避免 exactOptionalPropertyTypes 冲突）；
    //   **geoEnabled = weatherFetcher===undefined && lat===undefined && lon===undefined**
    //   （三者任一被显式注入就关掉 IP 定位——测试注入 fetcher 时不应真去联网定位）⟩

  /* ── 生命周期 ── */
  start(): Promise<void>;
    // ⟨seedIfEmpty → append(sessionStarted) → weather.refresh()(不阻塞)
    //   → **3 个 setInterval 全部 push 进 `timers`**（天气 WEATHER_REFRESH_MS /
    //     洞察 INSIGHT_BATCH_MS / 周报 REPORT_CHECK_MS）
    //   → maybeMorningBaseline() → insightStartupTimer = setTimeout(3000)
    //   → geoEnabled 时 geoTimer = setTimeout(IP 定位 → weather.setLocation + emit geo:changed)⟩
  stop(): void;
    // ⟨for (timers) clearInterval → append(sessionEnded) + upsertDailySnapshot
    //   → **单独 clearTimeout(insightStartupTimer / geoTimer)** → bus.clear() → log.close()⟩
    // 🔴 **不变式（已踩坑，现已守住）**：`timers` 数组**只装 setInterval**；
    //    所有 setTimeout 字段（insightStartupTimer / geoTimer / adjustTimer）必须**单独 clearTimeout**，
    //    否则 db 关闭后定时器仍触发查询，报 "database is not open"。
    //    ⇒ **新增任何 setTimeout 都要同步在 stop()（或对应关闭路径）补清理**。
    //    adjustTimer 由 clearAdjustTimer() / closeAdjustWindow() 负责。

  /* ── 状态计算 ── */
  buildState(): AppState;
    // ⟨渲染进程唯一数据入口。energy=ledger.current()，weather=weather.current()，
    //   emotion=resolve({energy, weather, events: ledger.todayEvents()})；
    //   morningBaselinePending = !morningDone && pendingSlide?.kind==='morning-baseline'⟩
  pushState(send: (channel: string, payload: unknown) => void): void;
    // ⟨去重推送：JSON 比对（lastUpdated 归零后比）相同则跳过，否则 send('state:update', state)⟩
  emotionSummary(): string;
    // ⟨describe(buildState().emotion, weather)。⚠️ 用途已变：**不再是气泡文案**（R1 气泡已删），
    //   现仅供**系统托盘 tooltip**（悬停才可见）。🔴 R6：渲染层禁止读它查精灵⟩

  /* ── ① 事件后调节窗口（7s）—— task-complete / recovery 的唯一路径 ── */
  taskDurationRequest(taskId: string): TaskDurationRequest | null;
    // ⟨先问实际用时，再进调节窗口（任务完成流程第一步）⟩
  taskCompleteWithDuration(taskId: string, actualMinutes: number): AdjustWindow | null;
    // ⟨记实际时长并 openAdjustWindow('task-complete', ...)⟩
  recoveryStartAdjust(itemId: string): AdjustWindow | null;
    // ⟨恢复项进入调节窗口 openAdjustWindow('recovery', ...)⟩
  adjustDraft(target: number): AdjustWindow | null;
    // 🔴 R8：无窗口时返回 **null**（窗口外的任何拖动都只是预览，永不落库、永不弹"是否保存"）。
    //   有窗口：w.draftEnergy = clamp(target)；**adjusting 相位下拖动 = 重置 7s 倒计时**
    //   expiresAt = min(now + ADJUST_WINDOW_MS, adjustHardDeadline) 并重 armAdjustTimer()；
    //   emit adjust:changed + state:dirty
  commitAdjust(note?: string): DomainEvent | null;
    // 🔴 **唯一写入点**。delta = round2(draftEnergy - baseEnergy)；
    //   task-complete → tasks.confirmComplete(refId, delta, note, actualMinutes)
    //   recovery      → deck.confirmTake(refId, delta, note)
    //   然后 closeAdjustWindow() + emit event:appended / energy:changed / adjust:committed
  cancelAdjust(): void;   // ⟨草稿丢弃，事件不落库，任务保持 open，精力不变⟩
  private openAdjustWindow(kind, refId, baseEnergy, ...): AdjustWindow | null;
  private buildAdjustWindow(): AdjustWindow | null;
  private armAdjustTimer(): void; private clearAdjustTimer(): void;
  private expireAdjustWindow(): void;
    // 🔴 R9：到点**只切相位** adjusting → confirming，**既不自动落库也不自动丢弃**。
    //   草稿被静默写库是最坏结果（用户没意识到自己"确认"了什么），
    //   被静默丢弃是次坏结果（用户的调节白费）。必须等用户表态。
  private adjustWindow: AdjustWindow | null;
  private adjustTimer: ReturnType<typeof setTimeout> | null;
  private adjustHardDeadline = 0;      // 60s 硬上限的绝对时刻

  /* ── ② 滑动卡状态机（同一时刻最多一张卡）—— morning-baseline / manual-adjust ── */
  requestSlide(kind: PendingSlide['kind'], refId: string): PendingSlide | null;
    // 🔴 **职责已收窄**：kind ∈ {task-complete, recovery} → **直接 null**（调用方应改用
    //   taskDurationRequest / recoveryStartAdjust）；已有卡 → null；
    //   morning-baseline → buildMorningSlide()；manual-adjust → buildManualSlide()；
    //   成功则 emit('slide:requested')
  previewSlide(target: number): { energy: number; emotion: EmotionState };
    // ⟨不落库。target 为目标绝对精力值；返回投影精力与对应情绪。
    //   manual-adjust 卡全程只走这里⟩
  confirmSlide(target: number, note?: string): DomainEvent | null;
    // ⟨**manual-adjust 确认也不落库**（直接关卡返回 null，精力保持原值）；
    //   morning-baseline：d = round2(clamp(target) - slide.baseEnergy)
    //     → ledger.setEnergy(clamp(baseEnergy + d), '晨间基线')，置 morningDone=true；
    //   成功后 emit event:appended / energy:changed / slide:confirmed，末尾必 emit state:dirty⟩
  cancelSlide(): void;
    // ⟨关卡；morning-baseline 取消也算完成（morningDone=true，**不强制**）；
    //   emit slide:cancelled + state:dirty⟩
  private pendingSlide: PendingSlide | null;

  /* ── 周报（17:30 触发链路）── */
  weeklyReport(): WeeklyReport;   // ⟨委托 insight.weeklyReport()，滚动 7 天窗口⟩
  private checkReportDue(): void;
    // ⟨REPORT_CHECK_MS 轮询：到 17:30 且 meta[REPORT_LAST_DATE_META] !== 今日
    //   → 组装 WeeklyReportPayload 存入 reportModal + emit report:due。
    //   requireAck = (now.getDay() === 5)（**仅周五**，R12）。
    //   含启动补弹：补弹也走本方法，故形态跟随当天星期。
    //   ⚠️ M3/T6 将加 presentation:'note'|'scroll' 分级（周一至周四改非模态角落便签）；
    //      当前周一至周四**仍走模态卷轴**，与 DESIGN.md §6.2 的裁决不符 —— 已知缺口⟩
  confirmReport(): void;   // ⟨用户点"已确认" → 清 reportModal + 写 meta[last_report_date]⟩
  private reportModal: WeeklyReportPayload | null;

  /* ── 任务快捷入口 ── */
  createTask(title: string, estCost: number, dueAt?: number | null, estMinutes = 0): void;
  dropTask(taskId: string): void;

  /* ── AI 推荐 ── */
  resolveRecommendation(
    recId: string,
    action: 'accepted' | 'modified' | 'rejected',
    modifiedDelta?: number,
  ): boolean;
    // ⟨委托 insight.resolveRecommendation；失败返回 false；
    //   accepted → recAcceptedDraft + deck.updateDelta(..., '采纳 AI 推荐校准', 'ai')
    //   modified → recModifiedDraft + deck.updateDelta(..., '用户修改后采纳', 'user')
    //   rejected → recRejectedDraft；末尾 emit recovery:changed + state:dirty
    //   🔴 R14：**三种处置都设水位线** lastResolvedAt（不是永久封禁，仅影响下次推荐时机）；
    //      R15：证据计数按窗口全量，**不受水位线影响**⟩

  /* ── 窗口模式 ── */
  setMode(mode: WindowMode): void;   // ⟨同值直接 return；否则 emit mode:changed + state:dirty⟩
  getMode(): WindowMode;

  /* ── 私有 ── */
  private mode: WindowMode;                       // 初值 'pet'
  private morningDone: boolean;
  private timers: ReturnType<typeof setInterval>[];   // ⚠️ **只装 setInterval**，见 stop() 的坑
  private lastPushedJson: string;
  private insightStartupTimer / geoTimer: ReturnType<typeof setTimeout> | null;
  private readonly geoEnabled: boolean;           // 未显式给 lat/lon 时才启用 IP 定位
  private hasTodayBaseline(): boolean;            // ⟨今日是否已有 reason==='晨间基线' 的 energy.set⟩
  private morningBaselineStart(): number;
    // 🔴 R17：= **yesterdayCloseEnergy()**（读 `daily_snapshots` 表）?? INITIAL_ENERGY。
    //   **不是** session.ended 事件，更不是 0 —— 精力跨天连续，禁止午夜归零。
  private buildMorningSlide(): PendingSlide;
    // ⟨文案在 :492 附近：`昨天收尾在 ${start} 分。滑动设定今日初始精力`（T9 将强化因果呈现）⟩
  private buildManualSlide(): PendingSlide;       // ⟨纯预览卡，确认/关闭都不落库⟩
  private maybeMorningBaseline(): void;           // ⟨!hasTodayBaseline() && !morningDone → requestSlide⟩
  private runInsightBatch(): void;                // ⟨detectRecommendations → recShownDraft + emit⟩
}

// 内部：clamp(v: number): number   // Math.min(ENERGY_MAX, Math.max(0, round2(v)))
```
