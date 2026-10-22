# `src/core/types.ts` — 领域类型唯一契约

> 模块存根（原 STRUCTURE_MAP §3.1）· 层级 **L0** · 测试：—（类型契约，经 core.test 间接覆盖）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/** 职责边界：全局共享类型与常量。禁止放置任何行为逻辑。 */

export const ENERGY_MIN = 0;                 // 精力量程下界
export const ENERGY_MAX = 10;                // 精力量程上界

/** 归一化天气语义，屏蔽上游 API 差异 */
export type WeatherCondition = 'sunny' | 'cloudy' | 'rain' | 'thunderstorm';

export interface WeatherState {
  condition: WeatherCondition;
  tempC: number;                             // 摄氏度
  source: 'live' | 'cache' | 'fallback';     // 数据来源，用于降级标注
  at: number;                                // 获取时间戳 ms
}

export const FALLBACK_WEATHER: WeatherState; // 降级兜底：cloudy / 20°C / at:0

/** 10 档 base 情绪，由精力值映射 */
export type BaseEmotion =
  | 'blissful' | 'radiant' | 'cheerful' | 'content' | 'calm'
  | 'steady' | 'weary' | 'drained' | 'exhausted' | 'burnt';

/** 天气 overlay 精灵，独立图层不进状态机 */
export type WeatherOverlay =
  | 'none' | 'sunbeam' | 'cloud-puff' | 'rain-drop' | 'storm-bolt';

/** pulse 层情绪反应，低精力时激活 */
export type PulseReaction =
  | 'none' | 'anxious' | 'guilty' | 'numb'
  | 'restless' | 'grateful' | 'determined';

export interface EmotionState {
  energy: number;
  base: BaseEmotion;
  overlay: WeatherOverlay;
  pulse: PulseReaction;
  composite: string;      // 天气×精力复合后的最终表情标签，供渲染层查精灵
  headline: string;       // UI 展示的一句话状态
  pulseActive: boolean;   // pulse 是否激活
}

export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: string;
  title: string;
  estCost: number;            // 预估精力消耗，正数表示扣减
  status: TaskStatus;
  createdAt: number;
  dueAt: number | null;       // 计划截止 ms，用于超时判定
}

export interface RecoveryItem {
  id: string;
  name: string;
  icon: string;
  defaultDelta: number;       // 默认预估恢复值，会被版本历史覆盖
  currentDelta: number;       // 当前生效预估值，来自版本历史最新一条
  minutes: number;            // 建议时长（分钟）
}

export interface RecoveryVersion {
  id: number;
  itemId: string;
  delta: number;
  reason: string;             // 调整理由
  createdAt: number;
}

/** 🆕 证据计数（预测-校准回路的因果链原始数据，DESIGN.md §7.1） */
export interface RecommendationEvidence {
  total: number;         // 窗口内该恢复项被确认的总次数（「午睡本周 4 次」）
  adjustedDown: number;  // 用户把实际效果调到**低于**预估的次数（「3 次你调低了」）
  adjustedUp: number;    // 用户把实际效果调到高于预估的次数
  matched: number;       // 实际与预估吻合的次数
  windowDays: number;    // 证据收集窗口（天），供 UI 表述「近 N 天」
  // 🔴 R15：证据计数按窗口**全量**统计，**不受处置水位线影响**。
  //    R14：水位线 lastResolvedAt() 只影响"何时再推荐"，不是永久封禁。
}

export interface InsightRecommendation {
  id: string; itemId: string; itemName: string;
  predicted: number;           // 预估均值
  actual: number;              // 实际均值
  samples: number;             // 偏差样本数
  message: string;             // 建议文案（含证据计数的因果叙事）
                               // 🔴 R13：只陈述用户动作，绝不评价
  suggestedDelta: number;      // 建议校准值
  createdAt: number;
  evidence: RecommendationEvidence;   // 🆕 周报每项推荐旁展示（首版存根漏此字段）
}

export interface WeeklyReport {
  weekStart: number;
  weekEnd: number;
  avgEnergy: number;
  minEnergy: number;
  maxEnergy: number;
  totalEvents: number;
  tasksCompleted: number;
  recoveriesTaken: number;
  daily: { date: string; closeEnergy: number }[];  // 每日收尾精力，用于折线
  peakDrainHour: number | null;                    // 最耗精力时段（小时）
  bestRecovery: { name: string; avgDelta: number } | null;
  narrative: string[];                             // 叙事文案段落
}

/** 🆕 周报**弹窗载荷**（区别于上面的 WeeklyReport 纯数据）——Coordinator.checkReportDue() 组装 */
export interface WeeklyReportPayload {
  report: WeeklyReport;
  /** AI 记忆推荐：同一恢复项重复 3 次后产出的默认值校准建议（未处置）。
   *  evidence = 因果链原始数据，message = 其自然语言表述 —— **两者都给**，
   *  让 UI 既能把叙事印在纸上，也能把计数做成独立的结构化标记。 */
  aiSuggestions: {
    itemId: string; itemName: string; suggestedDelta: number; message: string;
    evidence: RecommendationEvidence;
  }[];
  /** 近 7 天已确认的默认值变更（新→旧），source 标注决策来源（'ai' | 'user'） */
  decisions: { itemId: string; itemName: string; delta: number; reason: string; source: string; createdAt: number }[];
  /** 周五重点确认：弹窗不可随手关闭，必须点「已确认」 */
  requireAck: boolean;
  /** 本次弹窗对应的日期（YYYY-MM-DD，审计用） */
  dateStr: string;
  // ⏳ **M3/T6 将新增** `presentation: 'note' | 'scroll'`（由 now.getDay()===5 决定），
  //    并要求 requireAck 与 presentation==='scroll' 绑定。**当前无此字段**
  //    ⇒ 周一至周四仍走模态卷轴，与 DESIGN.md §6.2 的裁决不符（已知缺口，R12）。
}

export type WindowMode = 'pet' | 'panel';

/** 渲染进程唯一数据入口，由 Coordinator.buildState() 组装 */
export interface AppState {
  energy: number;
  emotion: EmotionState;
  weather: WeatherState;
  tasks: Task[];
  recoveries: RecoveryItem[];
  morningBaselinePending: boolean;   // 是否展示晨间基线滑动（开机后首次）
  pendingSlide: PendingSlide | null; // 待确认的滑动卡片（②晨间基线 / 临时预览）
  adjustWindow: AdjustWindow | null; // 🆕 事件后调节窗口（①）。**null = 进度条只读预览**（R8）
  recommendations: InsightRecommendation[];  // AI 推荐卡片队列
  reportModal: WeeklyReportPayload | null;   // 🆕 周报弹窗（每天 17:30 弹一次；
                                             //    周五 requireAck；null = 不显示）
  mode: WindowMode;
  lastUpdated: number;
}

export type SlideKind = 'task-complete' | 'recovery' | 'morning-baseline' | 'manual-adjust';

/** 滑动确认卡。语义关键：滑块滑的是「事件后的绝对精力值」，非增量 */
export interface PendingSlide {
  kind: SlideKind;
  refId: string;       // taskId / recoveryId / 'baseline' / 'manual'
  title: string;
  subtitle: string;
  predicted: number;   // 事件默认变化量，仅作参考展示与滑块默认位来源
  min: number;         // 滑块范围下界（绝对精力值）
  max: number;         // 滑块范围上界
  absMax: number;      // 允许的最大绝对值 = ENERGY_MAX（保留字段）
  baseEnergy: number;  // 卡片弹出时的真实精力（事件前）；actual = target - baseEnergy
  createdAt: number;
}
```
