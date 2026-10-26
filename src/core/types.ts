/**
 * 领域类型定义 —— 全局唯一契约。
 * 所有模块共享，禁止在此处放置行为逻辑。
 */

/* ─────────────────────────── 精力 ─────────────────────────── */

/** 精力值范围 0–10（浮点，两位精度） */
export const ENERGY_MIN = 0;
export const ENERGY_MAX = 10;

/* ─────────────────────────── 天气 ─────────────────────────── */

/** 归一化天气语义（WeatherSensor 输出，屏蔽上游 API 差异） */
export type WeatherCondition = 'sunny' | 'cloudy' | 'rain' | 'thunderstorm';

export interface WeatherState {
  condition: WeatherCondition;
  /** 摄氏度 */
  tempC: number;
  /** 数据来源，用于降级标注 */
  source: 'live' | 'cache' | 'fallback';
  /** 获取时间戳（ms） */
  at: number;
}

export const FALLBACK_WEATHER: WeatherState = {
  condition: 'cloudy',
  tempC: 20,
  source: 'fallback',
  at: 0,
};

/* ─────────────────────────── 情绪 ─────────────────────────── */

/** 10 档 base 情绪（由精力值映射） */
export type BaseEmotion =
  | 'blissful'   // 9.5–10
  | 'radiant'    // 8.5–9.4
  | 'cheerful'   // 7.5–8.4
  | 'content'    // 6.5–7.4
  | 'calm'       // 5.5–6.4
  | 'steady'     // 4.5–5.4
  | 'weary'      // 3.5–4.4
  | 'drained'    // 2.5–3.4
  | 'exhausted'  // 1.5–2.4
  | 'burnt';     // 0–1.4

/** 天气 overlay 精灵（独立图层，不进状态机） */
export type WeatherOverlay =
  | 'none'
  | 'sunbeam'    // 晴：头顶小太阳 + 光斑
  | 'cloud-puff' // 阴：头顶云朵
  | 'rain-drop'  // 雨：头顶乌云 + 雨丝
  | 'storm-bolt';// 雷阵雨：乌云 + 闪电

/** pulse 层情绪反应（<6 分激活） */
export type PulseReaction =
  | 'none'
  | 'anxious'      // 连续拒绝恢复
  | 'guilty'       // 任务超时未完成
  | 'numb'         // 长时间无事件
  | 'restless'     // 高频小幅调整
  | 'grateful'     // 刚完成恢复且效果超预期
  | 'determined';  // 刚完成恢复且达标

export interface EmotionState {
  energy: number;
  base: BaseEmotion;
  overlay: WeatherOverlay;
  pulse: PulseReaction;
  /** 天气×精力复合修正后的最终表情标签，供渲染层查精灵图 */
  composite: string;
  /** 供 UI 展示的一句话状态 */
  headline: string;
  /** pulse 是否激活 */
  pulseActive: boolean;
}

/* ─────────────────────────── 任务 ─────────────────────────── */

export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: string;
  title: string;
  /** 预估精力消耗（正数表示扣减） */
  estCost: number;
  /** 预估时长（分钟）。旧事件流缺该字段时归一化为 0 */
  estMinutes: number;
  status: TaskStatus;
  createdAt: number;
  /** 计划完成截止（ms），用于超时判定 */
  dueAt: number | null;
  /** 用户确认的实际时长（分钟）；完成后写入，未完成为 null */
  actualMinutes: number | null;
}

/**
 * 任务流程第一步的返回载荷：面板展示「任务名称 + 预估时长」，
 * 等用户确认实际时长后，才允许进入精力调节流程（第二步）。
 */
export interface TaskDurationRequest {
  taskId: string;
  title: string;
  /** 预估时长（分钟），0 表示创建时未设定 */
  estMinutes: number;
  estCost: number;
  createdAt: number;
}

/* ─────────────────────────── 恢复项 ─────────────────────────── */

export interface RecoveryItem {
  id: string;
  name: string;
  icon: string;
  /** 默认预估恢复值（会被版本历史覆盖） */
  defaultDelta: number;
  /** 当前生效的预估值（来自版本历史最新一条） */
  currentDelta: number;
  /** 建议时长（分钟），用于「3 分钟滑动确认」默认窗口 */
  minutes: number;
}

export interface RecoveryVersion {
  id: number;
  itemId: string;
  delta: number;
  /** 调整理由 */
  reason: string;
  createdAt: number;
  /** 决策来源：system|user|ai（周报展示历史决策用） */
  source: string;
}

/* ─────────────────────────── 洞察 ─────────────────────────── */

/**
 * 推荐卡片的证据计数 —— 因果链可见性。
 *
 * 设计意图：AI 推荐默认值时，必须把「凭什么」摊开给用户看。
 * 只给一个「预估 1.5 → 实际 0.8」的统计结论，用户无法验证，预测错一次信任就崩；
 * 给出「近 14 天你用了 4 次，3 次你把效果调低了」，用户能自己回溯那 4 次记忆，
 * 因果链可见才能建立信任。
 */
export interface RecommendationEvidence {
  /** 窗口内该恢复项被确认的总次数（「午睡本周 4 次」） */
  total: number;
  /** 用户把实际效果调到低于预估的次数（「3 次你调低了」） */
  adjustedDown: number;
  /** 用户把实际效果调到高于预估的次数 */
  adjustedUp: number;
  /** 实际与预估吻合的次数 */
  matched: number;
  /** 证据收集窗口（天），供 UI 表述「近 N 天」 */
  windowDays: number;
}

export interface InsightRecommendation {
  id: string;
  itemId: string;
  itemName: string;
  predicted: number;
  /** 实际均值 */
  actual: number;
  /** 偏差样本数 */
  samples: number;
  /** 建议文案（含证据计数的因果叙事） */
  message: string;
  suggestedDelta: number;
  createdAt: number;
  /** 证据计数（周报每项推荐旁展示） */
  evidence: RecommendationEvidence;
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
  /** 每日收尾精力（用于折线） */
  daily: { date: string; closeEnergy: number }[];
  /** 最耗精力的时段 */
  peakDrainHour: number | null;
  /** 最有效的恢复项 */
  bestRecovery: { name: string; avgDelta: number } | null;
  narrative: string[];
}

/**
 * 周报弹窗载荷（需求 5）：每天 17:30 弹一次（周五需确认）。
 * 铅笔手绘清单 = 周报主体 + AI 推荐默认值 + 历史决策留痕。
 */
export interface WeeklyReportPayload {
  report: WeeklyReport;
  /**
   * AI 记忆推荐：同一恢复项重复 3 次后产出的默认值校准建议（未处置）。
   * evidence 是因果链的原始数据，message 是它的自然语言表述 —— 两者都给，
   * 让 UI 既能直接把叙事印在纸上，也能把计数做成独立的结构化标记。
   */
  aiSuggestions: {
    itemId: string; itemName: string; suggestedDelta: number; message: string;
    evidence: RecommendationEvidence;
  }[];
  /** 近 7 天已确认的默认值变更（新→旧），source 标注决策来源 */
  decisions: { itemId: string; itemName: string; delta: number; reason: string; source: string; createdAt: number }[];
  /** 周五重点确认：弹窗不可随手关闭，必须点「已确认」 */
  requireAck: boolean;
  /** 本次弹窗对应的日期（YYYY-MM-DD，审计用） */
  dateStr: string;
}

/* ─────────────────────────── 窗口 ─────────────────────────── */

export type WindowMode = 'pet' | 'panel';

/**
 * 精力调节窗口 —— 「完成一个事件后」才存在的临时可写状态。
 *
 * 生命周期：
 *   open(事件确认) → adjusting（7s 内可反复微调，每次微调重置计时）
 *                  → confirming（计时到点，等用户在弹窗里确认）
 *                  → 写入事件流 / 丢弃
 *
 * 与之相对：没有窗口时，进度条拖动是纯预览，松手回弹，永不落库。
 */
export type AdjustPhase = 'adjusting' | 'confirming';

export interface AdjustWindow {
  /** 触发本次调节的事件类型 */
  kind: 'task-complete' | 'recovery';
  refId: string;
  /** 事件名称（任务标题 / 恢复项名） */
  label: string;
  icon: string;
  /** 事件前的真实精力 */
  baseEnergy: number;
  /** 该事件的默认精力变化量（predicted） */
  predicted: number;
  /** 该事件的默认精力值 = clamp(baseEnergy + predicted) */
  defaultEnergy: number;
  /** 当前草稿精力（用户调节后的值，未落库） */
  draftEnergy: number;
  /** 用户确认的实际时长（分钟）；恢复项取其固定时长 */
  actualMinutes: number | null;
  phase: AdjustPhase;
  /** adjusting 阶段的剩余毫秒；confirming 阶段为 0 */
  remainingMs: number;
  openedAt: number;
  expiresAt: number;
}

export interface AppState {
  energy: number;
  emotion: EmotionState;
  weather: WeatherState;
  tasks: Task[];
  recoveries: RecoveryItem[];
  /** 是否展示晨间基线滑动（开机后首次） */
  morningBaselinePending: boolean;
  /** 待确认的滑动卡片（晨间基线） */
  pendingSlide: PendingSlide | null;
  /** 事件后的精力调节窗口（null = 进度条只读预览） */
  adjustWindow: AdjustWindow | null;
  /** AI 推荐卡片队列 */
  recommendations: InsightRecommendation[];
  /** 周报弹窗（每天 17:30 弹一次；周五 requireAck 需确认；null = 不显示） */
  reportModal: WeeklyReportPayload | null;
  mode: WindowMode;
  lastUpdated: number;
}

export type SlideKind = 'task-complete' | 'recovery' | 'morning-baseline' | 'manual-adjust';

export interface PendingSlide {
  kind: SlideKind;
  /** 关联对象 id（taskId / recoveryId / 'baseline' / 'manual'） */
  refId: string;
  title: string;
  subtitle: string;
  /**
   * 事件默认变化量 —— 仅作参考展示与滑块默认位置来源。
   * 滑块默认位置 = clamp(baseEnergy + predicted, min, max)。
   */
  predicted: number;
  /** 滑块范围（绝对精力值，通常 0–ENERGY_MAX） */
  min: number;
  max: number;
  /** 允许的最大绝对值（= ENERGY_MAX，保留字段） */
  absMax: number;
  /**
   * 基准精力：卡片弹出时的真实精力值（事件前）。
   * 确认时 actual_delta = 用户滑到的目标精力 - baseEnergy，
   * 即「以用户当前真实精力为准，事件消耗只是参考」。
   */
  baseEnergy: number;
  createdAt: number;
}

/* ─────────────────────────── 奶油猫壳层（v2.0 融合） ─────────────────────────── */

/**
 * 猫窗口布局（主进程 → 渲染层）。
 * 猫窗口随 FSM 行走：渲染层拥有窗口位置 px/py（屏幕坐标），
 * 布局只给工作区范围与窗口尺寸。
 */
export interface CatLayout {
  /** 主屏工作区 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 猫窗口尺寸 */
  winW: number;
  winH: number;
  /** 猫站地面时的窗口 y（工作区底边 - winH） */
  groundY: number;
}

/** ledge（窗口顶边）：id 对渲染层不透明（数字窗口 id 或 'screen-top'） */
export interface CatLedge {
  id: number | string;
  x: number;
  y: number;
  w: number;
  h: number;
  pid: number;
}

/** 主进程 → 猫窗口的命令（cat:cmd 通道） */
export type CatCmd =
  | { type: 'layout'; layout: CatLayout }
  | { type: 'keystatus'; ok: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'sleep-now' }
  | { type: 'skins-updated' }
  | { type: 'ledges'; ledges: CatLedge[] }
  | { type: 'ledge-gone'; id: number | string }
  /** 猫回地面（托盘/右键菜单「回到地面」；顶边趴着时 UI 卡片也需要） */
  | { type: 'go-ground' }
  /** UI 卡片窗口出现/收起：hold=true 时猫停止自主散步（安静陪伴），收起后恢复 */
  | { type: 'ui-hold'; active: boolean }
  /** 播放自定义姿势（右键菜单「摆个姿势」/ --selftest-pose）；def 已由主进程校验 */
  | { type: 'play-pose'; pose: CustomPoseDef };

/* ─────────────────────────── 自定义姿势（姿势插件） ─────────────────────────── */

/**
 * 姿势参数覆盖 —— CatPose 可覆盖字段的安全子集（渲染层时钟字段不可覆盖）。
 * 数值字段在姿势进/出包络内从当前值插值到目标值；枚举/布尔字段过半程切换。
 * 数值范围由 main/pose-defs.ts sanitizePose 统一钳制。
 */
export interface PoseOverrides {
  /** 横向缩放（0.3–3） */
  sx?: number;
  /** 纵向缩放（0.3–3） */
  sy?: number;
  /** 整体旋转 rad（±1.5） */
  rot?: number;
  eyes?: 'open' | 'blink' | 'happy' | 'closed' | 'wide';
  mouth?: 'w' | 'o' | 'line';
  /** 左前爪抬起 0–1 */
  pawL?: number;
  /** 右前爪抬起 0–1 */
  pawR?: number;
  /** 走路小腿循环 */
  legsOn?: boolean;
  /** 四肢张开 0–1 */
  splay?: number;
  /** 尾巴摆幅倍率（0–4，1=常态） */
  tailAmp?: number;
  /** 歪头 rad（±1） */
  headTilt?: number;
  /** 尾巴环抱（面包猫） */
  tailWrap?: boolean;
  /** 左耳姿态 0–1（0=竖直，0.55=飞机耳） */
  earL?: number;
  /** 右耳姿态 0–1 */
  earR?: number;
  /** 睡觉 z 气泡标志 */
  zzz?: boolean;
  /** 脸红 */
  blush?: boolean;
}

/** 姿势二级动画（代码驱动的正弦扰动，幅度随包络淡入淡出） */
export interface PoseAnim {
  /** 摇摆幅度 rad（0–0.35） */
  swayAmp?: number;
  /** 摇摆频率 Hz（0.1–8） */
  swayFreq?: number;
  /** 弹跳幅度：sy 比例（0–0.35，体积近似守恒联动 sx） */
  bounceAmp?: number;
  /** 弹跳频率 Hz（0.1–8） */
  bounceFreq?: number;
}

/**
 * 一条自定义姿势定义（poses/*.json，主进程 pose-defs.ts 校验钳制后经
 * cat:cmd play-pose 下发）。播放 = FSM 进入 'pose' 状态 duration 秒后回 idle；
 * 拖拽/甩出随时可打断。触发只走右键菜单与调试把手——不接任何手势
 * （红线 R10：手势→动作映射与摸头计数互扰，见 docs/pose-plugins.md）。
 */
export interface CustomPoseDef {
  /** 唯一 id（slug，重名去重保留先加载者） */
  id: string;
  /** 菜单显示名（≤20 字符） */
  name: string;
  /** 播放时长 s（0.5–30，默认 2） */
  duration: number;
  /** 气泡文案（≤80 字符；缺省不说话） */
  text?: string;
  /** 皮肤表情插播名（expressions 里没有则静默跳过） */
  expression?: string;
  /** 皮肤状态帧源（states 名，默认 idle；如 'sleep' 复用睡觉帧+皮肤侧 zzz） */
  useState?: string;
  pose?: PoseOverrides;
  anim?: PoseAnim;
}

/** 猫心情推送（cat:mood 通道）——领域 AppState 的猫侧投影 */
export interface CatMoodPayload {
  energy: number;
  emotion: EmotionState;
  weather: WeatherState;
}

/** 领域事件 → 猫的反应（cat:react 通道）；reaction 见 mood.ts 映射表 */
export interface CatReactPayload {
  reaction: string;
  /** 可选气泡文案（缺省由渲染层按 reaction+心情抽取） */
  text?: string;
}

/** 主进程 → UI 窗口的命令（ui:cmd 通道） */
export type UiCmd =
  | { type: 'openPanel' }
  | { type: 'openRecovery' }
  | { type: 'showWeekly' };
