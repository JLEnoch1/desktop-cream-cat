# 桌面精力宠物 · 全局结构地图

> 用途：供后续对话复用的结构索引。命名、路径、类型签名均从源码逐一抽取，未作改写。
> 抽取时间：2026-10-21 · 覆盖 commit：工作区当前状态

## 0. 覆盖范围与取舍

**全量覆盖，无省略。** `src/` 下 17 个 TypeScript 文件共 4087 行已全部读取并抽取接口，
包括体量最大的 `renderer/pet.ts`（704 行）与 `renderer/app.ts`（681 行）。
因此不存在「优先主链路、省略次要模块」的取舍——所有模块均在清单内。

唯一未展开的是**方法体内部实现**（Canvas 绘制细节、SQL 语句、DOM 事件绑定逻辑），
这是存根清单的定义要求，不属于取舍省略。

| 项目 | 数量 |
|---|---|
| TypeScript 源文件 | 17 |
| 源码总行数 | 4087 |
| 测试文件 | 3（`tests/*.test.ts`） |
| 测试用例 | **40**（core 24 + hittest 9 + coordinator 7） |
| 构建脚本 | 2（`scripts/build.mjs`、`scripts/build-tests.mjs`） |

> ⚠️ 与根目录 `overview.md` 的差异：该文档称「测试 30/30 全绿」，实测源码中 `test(` 计数为 **40**。
> 详见 §5 一致性问题清单。

---

## 1. 目录树

```
energy-pet/
├── package.json                  # [配置] npm 脚本入口；main 指向 dist/main/index.js
├── tsconfig.json                 # [配置] strict 模式；ES2022 + Bundler 解析；paths 别名 @/* → src/*
├── smoke.sh                      # [入口·脚本] 沙箱/兼容环境启动，自动 unset ELECTRON_RUN_AS_NODE
├── start.sh                      # [入口·脚本] 常规启动封装
├── selfcheck.png                 # [产物] --selfcheck 模式的窗口截图（UI 渲染验证）
│
├── scripts/
│   ├── build.mjs                 # [入口·构建] esbuild 三路打包 main(cjs)/preload(cjs)/renderer(iife)
│   └── build-tests.mjs           # [入口·构建] tests/*.test.ts → dist-tests/*.mjs（external: electron, node:sqlite）
│
├── src/
│   ├── core/                     # ── 契约层：零依赖根，所有模块向下依赖它 ──
│   │   ├── types.ts              # [核心] 领域类型唯一契约（198 行）；仅类型+常量，禁止行为逻辑
│   │   ├── events.ts             # [核心] append-only 事件契约 + 15 个事件草稿工厂（197 行）
│   │   ├── bus.ts                # [核心] EventBus 轻量发布订阅，模块间解耦（105 行）
│   │   └── hittest.ts            # [核心] click-through 命中区几何判定，纯函数（64 行）
│   │
│   ├── storage/
│   │   └── sqlite.ts             # [核心] DecisionLog：node:sqlite 事件流持久化，唯一写入口（340 行）
│   │
│   ├── ledger/
│   │   ├── fold.ts               # [核心] 精力折叠纯函数：energy = fold(events)（76 行）
│   │   └── energy.ts             # [核心] EnergyLedger 精力账本，代理 DecisionLog（124 行）
│   │
│   ├── emotion/
│   │   └── engine.ts             # [核心] EmotionEngine 三层情绪合成，纯函数无 IO（300 行）
│   │
│   ├── task/
│   │   └── center.ts             # [核心] TaskCenter 任务管理，状态由事件流 fold 得出（119 行）
│   │
│   ├── recovery/
│   │   └── deck.ts               # [核心] RecoveryDeck 恢复项卡片组 + 默认值版本历史（126 行）
│   │
│   ├── weather/
│   │   └── sensor.ts             # [核心] WeatherSensor Open-Meteo + 双层缓存 + 三级降级（136 行）
│   │
│   ├── insight/
│   │   └── engine.ts             # [核心] InsightEngine 只读事件流，周报 + 偏差推荐（238 行）
│   │
│   ├── main/                     # ── Electron 主进程 ──
│   │   ├── coordinator.ts        # [核心] Coordinator 模块组装 + AppState 计算 + 滑动状态机（359 行）
│   │   └── index.ts              # [入口] 主进程入口：窗口/IPC/托盘/命中轮询/崩溃自愈（631 行）
│   │
│   ├── preload/
│   │   └── index.ts              # [入口] contextBridge 白名单桥接，暴露 window.pet（89 行）
│   │
│   └── renderer/                 # ── Electron 渲染进程 ──
│       ├── index.html            # [入口] 单页结构，45 个 id 挂载点
│       ├── styles.css            # [样式] 透明窗口 + 面板/卡片样式
│       ├── app.ts                # [核心] 渲染主控：状态 diff、滑动卡、面板、命中区上报（681 行）
│       └── pet.ts                # [核心] PetRenderer Canvas 三层图层合成 + RAF 动画（704 行）
│
├── tests/
│   ├── core.test.ts              # 24 用例：fold/DecisionLog/Ledger/emotion/pulse/task/recovery/insight
│   ├── hittest.test.ts           # 9 用例：pointInRects/fallbackHotRects/sanitizeRects 边界
│   └── coordinator.test.ts       # 7 用例：端到端闭环（滑动、推荐、重启 fold 一致性）
│
├── dist/                         # [构建产物] main/index.js · preload/index.js · renderer/*
└── dist-tests/                   # [构建产物] *.mjs + sourcemap，node --test 直接运行
```

---

## 2. 依赖方向

### 2.1 分层规则

```
        ┌──────────────────────────────────────────────────┐
  L4    │ main/index.ts        renderer/app.ts             │  进程入口
        │ (Electron API)       (DOM + window.pet)          │
        └────────┬─────────────────────────┬───────────────┘
                 │                         │
        ┌────────▼─────────┐      ┌────────▼─────────┐
  L3    │ main/coordinator │      │ renderer/pet.ts  │      装配 / 表现
        │ preload/index.ts │      │                  │
        └────────┬─────────┘      └────────┬─────────┘
                 │                         │
        ┌────────▼─────────────────────────▼───────────────┐
  L2    │ ledger/energy  task/center  recovery/deck        │      领域模块
        │ weather/sensor insight/engine emotion/engine     │      （互不依赖）
        └────────┬─────────────────────────┬───────────────┘
                 │                         │
        ┌────────▼─────────┐      ┌────────▼─────────┐
  L1    │ storage/sqlite   │      │ ledger/fold      │      状态与折叠
        └────────┬─────────┘      └────────┬─────────┘
                 │                         │
        ┌────────▼─────────────────────────▼───────────────┐
  L0    │ core/types  core/events  core/bus  core/hittest  │      契约层（零依赖根）
        └──────────────────────────────────────────────────┘
```

**关键约束**：
- L0 不 import 任何项目内模块（`events.ts` 仅 type-import `types.ts`）——真正的依赖根。
- L2 六个领域模块**横向零依赖**，全部只向下依赖 L0/L1，彼此通过 `Coordinator` 装配。
- `emotion/engine.ts` 是唯一跨进程复用的 L2 模块：主进程 `coordinator` 与渲染进程 `app.ts`/`pet.ts` 同时 import 它。
- `ledger/fold.ts` 被 `storage/sqlite.ts`（写路径）与 `ledger/energy.ts`（重放路径）共享，独立成模块正是为了**打破 storage↔ledger 循环依赖**。
- `core/hittest.ts` 几何纯函数供主进程调用，渲染进程 `app.ts` **自行重定义**了同名局部类型 `HotRect`（未 import），属有意的进程隔离。

### 2.2 精确 import 关系（源码实测）

| 源文件 | 依赖的项目内模块 |
|---|---|
| `core/types.ts` | —（零依赖） |
| `core/events.ts` | `core/types`（仅 type） |
| `core/bus.ts` | —（零依赖） |
| `core/hittest.ts` | —（零依赖） |
| `ledger/fold.ts` | `core/events`, `core/types` |
| `storage/sqlite.ts` | `core/events`, `ledger/fold` |
| `ledger/energy.ts` | `storage/sqlite`, `core/events`, `ledger/fold` |
| `emotion/engine.ts` | `core/events`, `core/types` |
| `task/center.ts` | `storage/sqlite`, `core/events`, `core/types` |
| `recovery/deck.ts` | `storage/sqlite`, `core/events`, `core/types` |
| `weather/sensor.ts` | `storage/sqlite`, `core/events`, `core/types` |
| `insight/engine.ts` | `storage/sqlite`, `core/events`, `core/types`, `ledger/fold` |
| `main/coordinator.ts` | `storage/sqlite`, `core/bus`, `core/events`, `core/types`, `ledger/energy`, `ledger/fold`, `task/center`, `recovery/deck`, `weather/sensor`, `insight/engine`, `emotion/engine` |
| `main/index.ts` | `main/coordinator`, `core/types`, `core/hittest` |
| `preload/index.ts` | `core/types`, `core/events`（全部仅 type） |
| `renderer/pet.ts` | `core/types`, `emotion/engine` |
| `renderer/app.ts` | `renderer/pet`, `emotion/engine`, `core/types`, `preload/index`（仅 type） |

### 2.3 运行时数据流转（四条主链路）

**① 启动链路**
```
app.whenReady()  →  new Coordinator({userDataPath})
                      ├→ new DecisionLog({dbPath: <userData>/energy-pet.db})
                      │     └→ exec(SCHEMA_SQL) + rebuildEnergy()  ← 全量重放校准 fold
                      ├→ new EnergyLedger(log) / TaskCenter(log) / RecoveryDeck(log)
                      ├→ new WeatherSensor({log})  ← 构造时 fromEventLog() 恢复缓存
                      └→ new InsightEngine({log})
                 →  registerIpc() → createWindow() → coordinator.start()
                      ├→ deck.seedIfEmpty()        （写 6 条初始版本历史）
                      ├→ log.append(sessionStartedDraft())
                      ├→ weather.refresh()         （不阻塞）
                      ├→ setInterval(weather, 30min) / setInterval(insight, 10min)
                      ├→ maybeMorningBaseline()    （弹晨间基线滑动卡）
                      └→ setTimeout(runInsightBatch, 3s)
```

**② 写链路（所有状态变更的唯一路径）**
```
用户操作 → window.pet.*(IPC invoke) → ipcMain.handle
        → Coordinator 方法 → 领域模块 → EventDraft 工厂（core/events）
        → DecisionLog.append(draft)                     ← 唯一写入口
              ├→ foldDraft(before, draft) 计算 energy_after
              ├→ INSERT INTO events (...)
              └→ energyCache = after
        → bus.emit('state:dirty' | 'energy:changed' | ...)
        → main/index.ts flushState() → coordinator.pushState(sendToRenderer)
              └→ JSON 去重后 webContents.send('state:update', AppState)
        → renderer/app.ts applyState(s) → pet.applyEmotion() + DOM 更新
```

**③ 滑动确认链路（predicted / actual 双记录的来源）**
```
requestSlide(kind, refId)
  ├→ kind='task-complete' → TaskCenter.requestComplete(id, ledger.current())
  ├→ kind='recovery'      → RecoveryDeck.requestTake(id, ledger.current())
  ├→ kind='morning-baseline' → buildMorningSlide()   baseEnergy = 昨日收尾 ?? INITIAL_ENERGY
  └→ kind='manual-adjust'    → buildManualSlide()    纯预览，不落库
       ↓ 返回 PendingSlide（同一时刻最多一张，已有卡返回 null）
渲染层 showSlide(s) → 滑块默认位 = clampSlider(baseEnergy + predicted)
  ├→ 拖动 input → updateSlideVisual(target)
  │     ├→ pet.setPreview(target)                    本地即时反馈
  │     └→ 80ms 节流 → slidePreview(target) IPC → previewSlide() 不落库
  └→ 确认 → slideConfirm(target, note) IPC
        → confirmSlide(target)：d = round2(clamp(target) - slide.baseEnergy)
             ├→ task-complete    → TaskCenter.confirmComplete(refId, d, note)
             ├→ recovery         → RecoveryDeck.confirmTake(refId, d, note)
             ├→ morning-baseline → ledger.setEnergy(..., '晨间基线')；morningDone = true
             └→ manual-adjust    → 直接关卡，不写任何事件
```

**④ 偏差学习链路（AI 推荐闭环）**
```
recovery.taken 事件同时记录 predicted_delta(卡片默认值) 与 actual_delta(用户确认值)
  ↓ 每 10min / 启动后 3s
InsightEngine.detectRecommendations()
  ├→ log.byType('recovery.taken', 2000)
  ├→ 按 itemId 聚合，统计 |actual-predicted| >= 0.5 的次数
  ├→ mismatch >= 3 且 !hasPendingRecommendationFor(itemId)
  └→ log.insertRecommendation(rec) → 返回新产出推荐
  ↓
Coordinator 写 recShownDraft + bus.emit('recommendation:new') → 渲染层建卡
  ↓ 用户点击
resolveRecommendation(recId, action, modifiedDelta?)
  ├→ accepted → recAcceptedDraft + deck.updateDelta(itemId, suggestedDelta, '采纳 AI 推荐校准', 'ai')
  ├→ modified → recModifiedDraft + deck.updateDelta(itemId, modifiedDelta, '用户修改后采纳', 'user')
  └→ rejected → recRejectedDraft（仅记录，不改默认值）
        ↓ updateDelta 双写：append(recoveryItemUpdatedDraft) + addRecoveryVersion()
```

---

## 3. 存根清单

> 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。
> `private` 成员仅在影响理解职责边界时列出名称，省略实现。

### 3.1 `src/core/types.ts` — 领域类型唯一契约

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

export interface InsightRecommendation {
  id: string;
  itemId: string;
  itemName: string;
  predicted: number;          // 预估均值
  actual: number;             // 实际均值
  samples: number;            // 偏差样本数
  message: string;            // 建议文案
  suggestedDelta: number;     // 建议校准值
  createdAt: number;
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

export type WindowMode = 'pet' | 'panel';

/** 渲染进程唯一数据入口，由 Coordinator.buildState() 组装 */
export interface AppState {
  energy: number;
  emotion: EmotionState;
  weather: WeatherState;
  tasks: Task[];
  recoveries: RecoveryItem[];
  morningBaselinePending: boolean;
  pendingSlide: PendingSlide | null;
  recommendations: InsightRecommendation[];
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

### 3.2 `src/core/events.ts` — 事件契约与工厂

```ts
/** 职责边界：append-only 事件流的类型定义 + 草稿构造。不含持久化、不含折叠。 */

export type EventSource = 'user' | 'system' | 'ai' | 'weather' | 'task';

export type EventType =
  | 'energy.set' | 'energy.delta'
  | 'task.created' | 'task.completed' | 'task.dropped'
  | 'recovery.taken' | 'recovery.item.updated'
  | 'weather.observed'
  | 'recommendation.shown' | 'recommendation.accepted'
  | 'recommendation.modified' | 'recommendation.rejected'
  | 'session.started' | 'session.ended' | 'note.added';

export const EVENT_TYPES: readonly EventType[];              // ⚠️ 已定义但全项目无消费者，见 §5
export const ENERGY_AFFECTING: ReadonlySet<EventType>;       // 参与精力 fold 的 5 种事件

/** 事件不可变；predicted/actual 双记录是偏差学习的数据基础 */
export interface DomainEvent {
  id: number;                          // 自增主键，保证事件流顺序
  type: EventType;
  at: number;                          // 发生时间戳 ms
  source: EventSource;
  predicted_delta: number | null;      // 系统/推荐认为的变化量
  actual_delta: number | null;         // 用户滑动确认后的真实变化量
  energy_after: number | null;         // 事件后精力快照，冗余存储便于审计
  payload: EventPayload;
}

/** 按 type 区分的负载联合 */
export type EventPayload =
  | { kind: 'energy.set'; before: number; target: number; reason?: string }
  | { kind: 'energy.delta'; delta: number; note?: string; refType?: string; refId?: string }
  | { kind: 'task.created'; task: Task }
  | { kind: 'task.completed'; taskId: string; title: string; estCost: number; note?: string }
  | { kind: 'task.dropped'; taskId: string; title: string; note?: string }
  | { kind: 'recovery.taken'; itemId: string; itemName: string; minutes: number; note?: string }
  | { kind: 'recovery.item.updated'; item: RecoveryItem; previousDelta: number; newDelta: number; reason: string }
  | { kind: 'weather.observed'; weather: WeatherState }
  | { kind: 'recommendation.shown'; recommendationId: string; itemId: string }
  | { kind: 'recommendation.accepted'; recommendationId: string; itemId: string; newDelta: number }
  | { kind: 'recommendation.modified'; recommendationId: string; itemId: string; newDelta: number }
  | { kind: 'recommendation.rejected'; recommendationId: string; itemId: string }
  | { kind: 'session.started'; at: number }
  | { kind: 'session.ended'; closeEnergy: number }
  | { kind: 'note.added'; text: string };

/** 写入用草稿；id/at/energy_after 由存储层填充 */
export type EventDraft = Omit<DomainEvent, 'id' | 'at' | 'energy_after'> & { at?: number };

// ── 工厂函数（全部返回 EventDraft，除 tempId/round2）──

export function tempId(prefix: string): string;
  // ⟨进程内唯一 id，用于推荐卡等临时对象；非事件主键⟩

export function energySetDraft(target: number, before: number, reason?: string): EventDraft;
  // ⟨actual_delta = round2(target - before)；source='user'⟩

export function energyDeltaDraft(
  delta: number,
  opts?: { note?: string; refType?: string; refId?: string; source?: EventSource },
): EventDraft;
  // ⟨通用增减；source 默认 'user'⟩

export function taskCreatedDraft(task: Task): EventDraft;                      // source='task'
export function taskCompletedDraft(task: Task, actualDelta: number, note?: string): EventDraft;
  // ⟨predicted = round2(-|task.estCost|)，actual = round2(actualDelta)⟩
export function taskDroppedDraft(task: Task, note?: string): EventDraft;       // 两个 delta 均 null

export function recoveryTakenDraft(item: RecoveryItem, actualDelta: number, note?: string): EventDraft;
  // ⟨predicted = round2(item.currentDelta)，actual = round2(actualDelta)⟩

export function recoveryItemUpdatedDraft(
  item: RecoveryItem, previousDelta: number, newDelta: number,
  reason: string, source?: EventSource,
): EventDraft;
  // ⟨source 默认 'user'；AI 校准时传 'ai'⟩

export function weatherObservedDraft(weather: WeatherState): EventDraft;       // source='weather'
export function sessionStartedDraft(): EventDraft;                            // source='system'
export function sessionEndedDraft(closeEnergy: number): EventDraft;           // source='system'
export function noteDraft(text: string): EventDraft;                          // ⚠️ 无调用方，见 §5

export function recShownDraft(recId: string, itemId: string): EventDraft;      // 以下四个 source='ai'
export function recAcceptedDraft(recId: string, itemId: string, newDelta: number): EventDraft;
export function recModifiedDraft(recId: string, itemId: string, newDelta: number): EventDraft;
export function recRejectedDraft(recId: string, itemId: string): EventDraft;

export function round2(n: number): number;   // ⟨四舍五入到两位小数；全项目精度统一出口⟩
```

### 3.3 `src/core/bus.ts` — 事件总线

```ts
/** 职责边界：主进程内模块解耦。不做持久化、不做重放（那是 DecisionLog 的事）。 */

export type BusEventName =
  | 'event:appended' | 'energy:changed' | 'weather:changed'
  | 'task:changed' | 'recovery:changed'
  | 'slide:requested' | 'slide:confirmed' | 'slide:cancelled'
  | 'recommendation:new' | 'mode:changed' | 'state:dirty';

export interface BusPayloads {
  'event:appended': { id: number; type: string };
  'energy:changed': { energy: number; previous: number };
  'weather:changed': { source: string };
  'task:changed': undefined;
  'recovery:changed': undefined;
  'slide:requested': { kind: string; refId: string };
  'slide:confirmed': { kind: string; refId: string; delta: number };
  'slide:cancelled': { kind: string; refId: string };
  'recommendation:new': { id: string; itemId: string };
  'mode:changed': { mode: string };
  'state:dirty': undefined;
}

export class EventBus {
  constructor(errorHandler?: (name: BusEventName, err: unknown) => void);
    // ⟨默认 handler 走 console.error；单 handler 抛错不影响其他订阅者⟩

  on<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): () => void;
    // ⟨返回退订函数⟩
  once<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): () => void;
    // ⟨只触发一次⟩ ⚠️ 无调用方，见 §5
  off<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): void;
  emit<K extends BusEventName>(name: K, payload?: BusPayloads[K]): void;
    // ⟨同步派发；迭代前复制 handler 集合，避免 on/off 造成迭代异常⟩
  emitDebounced<K extends BusEventName>(name: K, payload?: BusPayloads[K], ms?: number): void;
    // ⟨合并高频 emit，默认 60ms⟩ ⚠️ 无调用方，节流实际由 app.ts 的 200ms 上报节流承担
  clear(): void;                          // ⟨清空全部定时器与 handler⟩
  listenerCount(name: BusEventName): number;  // ⚠️ 无调用方，见 §5

  private handlers: Map<BusEventName, Set<Handler<any>>>;
  private errorHandler: (name: BusEventName, err: unknown) => void;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export const bus: EventBus;   // 全局单例 ⚠️ 实际未被 import，Coordinator 自建实例，见 §5
```

### 3.4 `src/core/hittest.ts` — 命中区判定

```ts
/**
 * 职责边界：click-through 几何判定的纯逻辑，无 Electron/DOM 依赖，双进程可共用。
 * 误判代价不对称：漏判 → 窗口永久穿透按钮全失效；误判 → 宠物挡住桌面。
 */

export interface HotRect { x: number; y: number; w: number; h: number }  // 窗口内 DIP 坐标

export function pointInRects(
  x: number, y: number,
  rects: readonly HotRect[],
  width: number, height: number,
): boolean;
// ⟨光标是否落在任一命中区内。x/y 为相对窗口左上角坐标；
//   非有限值或窗口外一律 false（覆盖多显示器负坐标场景）；矩形为闭区间⟩

export function fallbackHotRects(width: number, height: number): HotRect[];
// ⟨上报链路异常时的保守兜底：窗口底部中央 72%×55% 单矩形。
//   宁可让宠物区可点，也不整窗穿透⟩

export function sanitizeRects(input: unknown): HotRect[];
// ⟨过滤脏数据：非数组 → []；剔除 NaN/非数字字段、w<1 或 h<1 的矩形⟩
```

### 3.5 `src/ledger/fold.ts` — 精力折叠纯函数

```ts
/**
 * 职责边界：核心不变式「精力值 = fold(events)」的唯一实现。
 * 独立成模块以便 storage（写路径）与 ledger（重放路径）共享同一折叠语义且不产生循环依赖。
 */

export const INITIAL_ENERGY = 7;   // 新用户默认精力（量程 0–10）

export function clampEnergy(v: number): number;
// ⟨钳制到 [ENERGY_MIN, ENERGY_MAX] 并 round2；NaN → INITIAL_ENERGY⟩

export function nextEnergy(
  before: number, type: EventType,
  actualDelta: number | null, payload: EventPayload,
): number;
// ⟨折叠原子操作。非 ENERGY_AFFECTING 类型原样返回 before。
//   energy.set → clampEnergy(payload.target)（覆盖语义）
//   energy.delta → before + (actualDelta ?? payload.delta)
//   task.completed / recovery.taken → before + (actualDelta ?? 0)
//   task.dropped → before（放弃任务不扣精力，预估时未扣故不重复）⟩

export function foldEvent(before: number, ev: DomainEvent): number;   // 重放路径
export function foldDraft(before: number, draft: EventDraft): number; // 写入路径

export function foldEvents(evs: DomainEvent[], initial?: number): number;
// ⟨全量重放；initial 默认 INITIAL_ENERGY⟩

export function foldWithTrace(
  evs: DomainEvent[], initial?: number,
): { energy: number; trace: { id: number; at: number; energy: number }[] };
// ⟨折叠并返回每一步快照（仅收录 energy 实际变化的事件），供日内曲线/高低点统计⟩

export { ENERGY_MIN, ENERGY_MAX };   // 从 core/types 转出
```

### 3.6 `src/storage/sqlite.ts` — 事件流持久化

```ts
/**
 * 职责边界：append-only 事件流的唯一写入口 + fold 状态维护。
 * 基于 Electron 内置 node:sqlite（零原生依赖，完全离线）。
 * schema 版本 SCHEMA_VERSION = 1。
 */

export interface DecisionLogOptions { dbPath: string }   // 数据库文件绝对路径

export class DecisionLog {
  readonly db: DatabaseSync;                 // 公开以便测试直接查库
  constructor(opts: DecisionLogOptions);
    // ⟨自动建目录 → exec(SCHEMA_SQL) → 写 meta.schema_version → rebuildEnergy()⟩

  /* ── 写入 ── */
  append(draft: EventDraft): DomainEvent;
    // ⟨唯一写入口。at 缺省取 Date.now()；ENERGY_AFFECTING 类型才算 energy_after；
    //   返回落库后的完整事件；session.ended 额外触发 upsertDailySnapshot⟩
  appendMany(drafts: EventDraft[]): DomainEvent[];
    // ⟨BEGIN/COMMIT 事务包裹，异常 ROLLBACK 后抛出⟩

  /* ── 读取 ── */
  currentEnergy(): number;                                   // ⟨内存 energyCache，O(1)⟩
  todayEvents(dateStr?: string): DomainEvent[];              // ⟨本地时区当日，按 id 升序⟩
  allEvents(): DomainEvent[];                                // ⟨全量，调试/导出用⟩
  since(sinceId: number): DomainEvent[];                     // ⟨id > sinceId，增量同步用⟩
  byType(type: EventType, limit?: number): DomainEvent[];    // ⟨默认 1000；DESC 取后 reverse，故返回升序⟩
  lastEventId(): number;                                     // ⟨MAX(id)，无事件返回 0⟩
  queryRange(startMs: number, endMs: number): DomainEvent[]; // ⟨at ∈ [start, end)，id 升序⟩

  /* ── 恢复项版本历史 ── */
  addRecoveryVersion(itemId: string, delta: number, reason: string): void;
  recoveryVersions(itemId: string, limit?: number): RecoveryVersionRow[];
    // ⟨默认 20；ORDER BY created_at DESC, id DESC —— id 用于打破同毫秒平局⟩
  latestRecoveryDeltas(): Map<string, number>;   // ⟨每个恢复项的最新版本 delta⟩

  /* ── 推荐卡片 ── */
  insertRecommendation(rec: {
    id: string; itemId: string; itemName: string; predicted: number;
    actual: number; samples: number; message: string; suggestedDelta: number;
  }): void;                                            // ⟨INSERT OR IGNORE，status='pending'⟩
  resolveRecommendation(id: string, status: 'accepted' | 'modified' | 'rejected'): void;
  pendingRecommendations(): RecommendationRow[];       // ⟨status='pending'，created_at 升序⟩
  hasPendingRecommendationFor(itemId: string): boolean; // ⟨防重复弹出⟩

  /* ── 每日快照 ── */
  upsertDailySnapshot(date: Date, closeEnergy: number): void;  // ⟨ON CONFLICT(date) DO UPDATE⟩
  dailySnapshots(fromDate: string, toDate: string): DailySnapshotRow[];

  close(): void;   // ⟨幂等，已关闭不抛错⟩

  private dbPath: string;
  private energyCache: number;
  private rebuildEnergy(): void;   // ⟨启动全量重放 5 类精力事件，事实源校验⟩
}

/* ── 行类型（DB 原始形态，snake_case）── */
export interface RecoveryVersionRow { id: number; item_id: string; delta: number; reason: string; created_at: number }
export interface DailySnapshotRow { date: string; close_energy: number; events_count: number; updated_at: number }
export interface RecommendationRow {
  id: string; item_id: string; item_name: string; predicted: number; actual: number;
  samples: number; message: string; suggested_delta: number; status: string;
  created_at: number; resolved_at: number | null;
}

/* ── 时区工具（模块级导出，被 ledger/insight 共用）── */
export function localDateStr(d: Date): string;              // ⟨本地时区 YYYY-MM-DD⟩
export function dayRangeMs(dateStr: string): [number, number]; // ⟨该本地日期的 [start, end) ms 区间⟩

// 内部：interface Row（DB 行）与 rowToEvent(r: Row): DomainEvent
//   payload JSON 解析失败时降级为 { kind:'note.added', text:'[corrupted payload]' }
```

**数据表（5 张）**：`meta`(key,value) · `events`(唯一事实源) · `daily_snapshots`(date 主键) ·
`recovery_versions` · `recommendations`。索引：`idx_events_at`、`idx_events_type`、
`idx_events_type_at`（偏差分析高频查询）、`idx_recver_item`、`idx_rec_status`。
PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`。

### 3.7 `src/ledger/energy.ts` — 精力账本

```ts
/**
 * 职责边界：精力读写门面。不维护独立状态，只代理 DecisionLog + fold。
 * 不变式：精力值 = fold(events)。
 */

export interface LedgerSnapshot {
  energy: number;
  todayCount: number;          // 今日事件数
  todayDelta: number;          // 收尾 - 开盘
  todayHigh: number;
  todayLow: number;
  msSinceLastChange: number;   // 距上次精力变化事件 ms；无变化则 MAX_SAFE_INTEGER
}

export class EnergyLedger {
  constructor(log: DecisionLog);   // private readonly log

  current(): number;                             // ⟨委托 log.currentEnergy()，O(1)⟩
  append(draft: EventDraft): DomainEvent;        // ⟨委托 log.append⟩
  appendMany(drafts: EventDraft[]): DomainEvent[];
  todayEvents(dateStr?: string): DomainEvent[];
  todaySnapshot(dateStr?: string): LedgerSnapshot;
    // ⟨开盘 = startOfDayEnergy，再 foldWithTrace 求高低点⟩
  startOfDayEnergy(dateStr: string): number;
    // ⟨某日开盘精力 = 该日之前所有事件 fold 结果。
    //   优先用前一日 daily_snapshots 加速，否则全量重放⟩
  yesterdayCloseEnergy(): number | null;   // ⟨晨间基线默认值来源；无快照返回 null⟩
  setEnergy(target: number, reason?: string): DomainEvent;   // ⟨手动校准，走 energySetDraft⟩
  adjust(delta: number, opts?: {
    note?: string; refType?: string; refId?: string; source?: EventDraft['source'];
  }): DomainEvent;                                             // ⟨通用增减⟩
  lastEventId(): number;                 // ⟨增量同步游标⟩
  since(id: number): DomainEvent[];

  private previousSnapshot(dateStr: string): number | null;
}

export { INITIAL_ENERGY };   // 从 ledger/fold 转出
```

### 3.8 `src/emotion/engine.ts` — 三层情绪合成

```ts
/**
 * 职责边界：纯函数，无副作用无 IO。
 *   base    10 档精力状态表      → 主体表情
 *   weather 独立 overlay 精灵    → 锚定头顶，不参与表情状态机
 *   pulse   日志驱动的瞬时反应   → 精力 < PULSE_THRESHOLD 时激活
 */

/* ── base 层 ── */
export interface BaseTier {
  emotion: BaseEmotion;
  min: number;         // 区间下界（含），上界为下一档下界
  label: string;       // 中文档位名
  headline: string;    // 一句话状态
  breath: number;      // 呼吸周期 s
  bounce: number;      // 弹跳幅度 px
  blink: number;       // 眨眼间隔 s
  hue: number;         // 主色调
  sat: number;         // 饱和度
}

export const BASE_TIERS: readonly BaseTier[];
// ⟨10 档，从高到低排列；min 依次为 9.5/8.5/7.5/6.5/5.5/4.5/3.5/2.5/1.5/-1⟩

export const PULSE_THRESHOLD = 3;   // ⚠️ pulse 激活阈值 = 精力 < 3（非注释所称 6），见 §5

export function tierFor(energy: number): BaseTier;
// ⟨查表取第一个 energy >= min 的档；全不匹配返回末档 burnt⟩

/* ── weather 层 ── */
export const WEATHER_OVERLAY: Record<WeatherCondition, WeatherOverlay>;
// ⟨sunny→sunbeam, cloudy→cloud-puff, rain→rain-drop, thunderstorm→storm-bolt⟩
export const WEATHER_LABEL: Record<WeatherCondition, string>;   // 晴/阴/雨/雷阵雨

/* ── 天气 × 精力 复合规则 ── */
export type EnergyBand = 'high' | 'mid' | 'low';
export type CompositeModifier =
  | 'lifted' | 'neutral' | 'cozy' | 'heavy' | 'soaked' | 'startled' | 'charged';

export const COMPOSITE_TABLE: Record<WeatherCondition, Record<EnergyBand, CompositeModifier>>;
// ⟨4×3 全覆盖。语义：同样下雨，精力高是「惬意听雨(cozy)」，精力低是「雪上加霜(soaked)」⟩

export function energyBand(energy: number): EnergyBand;
// ⟨>=6.5 high；>=3 mid；否则 low。low 与 PULSE_THRESHOLD(3) 对齐⟩

export const MODIFIER_LABEL: Record<CompositeModifier, string>;

/* ── pulse 层：6 信号 → 6 反应 ── */
export interface PulseSignals {
  rejectedStreak: number;              // 连续拒绝恢复建议次数
  overdueTasks: number;                // 超时未完成任务数
  msSinceLastChange: number;           // 距上次精力变化事件 ms
  recentAdjustCount: number;           // 近 30min energy.delta 次数
  recentAdjustAvgAbs: number;          // 近 30min energy.delta 平均绝对值
  lastRecoveryDeviation: number | null; // 最近一次 recovery.taken 的 actual-predicted
}

export interface PulseRule {
  reaction: PulseReaction;
  priority: number;                    // 数字小先判定
  test: (s: PulseSignals) => boolean;
  headline: string;
}

export const PULSE_RULES: readonly PulseRule[];
// ⟨6 条，priority 1→6：
//   grateful(dev>=1) · determined(-1<dev<1) · anxious(rejectedStreak>=2)
//   guilty(overdue>=1) · restless(count>=4 且 avgAbs<=1.5) · numb(>=90min 无变化)⟩

export function extractPulseSignals(events: DomainEvent[], now?: number): PulseSignals;
// ⟨纯函数便于单测。WINDOW = 30min；rejectedStreak 从后往前扫，遇 accepted/modified 中断；
//   overdueTasks = created 且 dueAt<now 且无对应 completed/dropped⟩

export function resolvePulse(
  signals: PulseSignals, pulseActive: boolean,
): { reaction: PulseReaction; headline: string | null };
// ⟨pulseActive=false 直接返回 none；否则按 priority 首个命中生效（单一反应，不叠加）⟩

/* ── 合成入口 ── */
export interface ResolveInput {
  energy: number;
  weather: WeatherState;
  events: DomainEvent[];   // 今日或近段，按 id 升序
  now?: number;
}

export function resolve(input: ResolveInput): EmotionState;
// ⟨三层合成主入口。pulseActive = energy < PULSE_THRESHOLD；
//   headline 取 pulse headline，无则取 base tier headline⟩

export function buildComposite(
  base: BaseEmotion, modifier: CompositeModifier, pulse: PulseReaction,
): string;
// ⟨'__' 连接；modifier='neutral' 与 pulse='none' 均跳过。例：'drained__soaked__anxious'⟩

export function describe(state: EmotionState, weather: WeatherState): string;
// ⟨UI 摘要，格式「{档位label} · {天气label}，{修饰说明}」⟩
```

### 3.9 `src/task/center.ts` — 任务管理

```ts
/**
 * 职责边界：任务创建/完成/放弃，全部以事件形式落 DecisionLog。
 * 任务状态由事件流 fold 得出（open→done/dropped），不单独存表。
 * complete 不直接扣精力，而是返回滑动确认卡，confirm 时才写事件。
 */

export const TASK_SLIDE_MIN = -5;   // 事件参考范围：仅约束 predicted
export const TASK_SLIDE_MAX = 2;    // 用户滑动可覆盖全量程
export const TASK_ABS_MAX = 5;

export class TaskCenter {
  constructor(log: DecisionLog);   // private readonly log

  list(): Task[];
    // ⟨遍历 allEvents 重建：task.created 建条目，completed/dropped 改 status；按 createdAt 升序⟩
  open(): Task[];                                  // ⟨status==='open'⟩
  get(taskId: string): Task | undefined;
  create(title: string, estCost: number, dueAt?: number | null): Task;
    // ⟨id=tempId('task')；title 空则 '未命名任务'；estCost = max(0, round2)；写 task.created⟩
  requestComplete(taskId: string, baseEnergy: number): PendingSlide | null;
    // ⟨任务不存在或非 open → null。predicted = clampRange(-|estCost|, -5, 2)；
    //   min=0, max=ENERGY_MAX, baseEnergy=round2(baseEnergy)⟩
  confirmComplete(taskId: string, actualDelta: number, note?: string): DomainEvent | null;
    // ⟨校验后写 task.completed，actual_delta = 用户确认值⟩
  drop(taskId: string, note?: string): DomainEvent | null;   // ⟨不扣精力，仅标记状态⟩
  overdueCount(now?: number): number;   // ⟨open 且 dueAt<now 的数量；pulse 'guilty' 信号源⟩
}

// 内部：clampRange(v, lo, hi): number
```

### 3.10 `src/recovery/deck.ts` — 恢复项卡片组

```ts
/**
 * 职责边界：恢复项清单 + 默认值版本历史。
 * currentDelta 取版本历史最新一条（可被 AI 推荐更新）。
 * take 触发滑动确认，事件同时记 predicted（卡片默认值）与 actual（用户确认值），
 * 为 InsightEngine 偏差学习供数。
 */

export const RECOVERY_SLIDE_MIN = -2;   // 恢复也可能不适
export const RECOVERY_SLIDE_MAX = 5;
export const RECOVERY_ABS_MAX = 5;

export const DEFAULT_ITEMS: Omit<RecoveryItem, 'currentDelta'>[];
// ⟨6 个种子项：rec_water(💧 0.4/1min) · rec_stretch(🙆 0.6/3min) · rec_walk(🚶 1.0/10min)
//   rec_nap(😴 1.5/20min) · rec_music(🎵 0.8/4min) · rec_breath(🌬️ 0.5/2min)⟩

export class RecoveryDeck {
  constructor(log: DecisionLog);   // private readonly log

  list(): RecoveryItem[];
    // ⟨DEFAULT_ITEMS 叠加 latestRecoveryDeltas()；无版本则用 defaultDelta⟩
  get(itemId: string): RecoveryItem | undefined;
  seedIfEmpty(): void;
    // ⟨首次启动：为无 recovery.item.updated 事件的默认项写初始版本，
    //   双写 appendMany(drafts) + addRecoveryVersion()，保证历史完整可追溯⟩
  versions(itemId: string, limit?: number): RecoveryVersion[];
    // ⟨默认 20；DB Row → 领域类型（snake_case → camelCase）映射⟩
  updateDelta(
    itemId: string, newDelta: number, reason: string,
    source?: EventDraft['source'],
  ): RecoveryItem | null;
    // ⟨item 不存在 → null；delta 未变 → 原样返回不写事件；
    //   变更则双写：append(recoveryItemUpdatedDraft) + addRecoveryVersion⟩
  requestTake(itemId: string, baseEnergy: number): PendingSlide | null;
    // ⟨predicted = clampRange(currentDelta, -2, 5)；subtitle 含 icon/name/minutes⟩
  confirmTake(itemId: string, actualDelta: number, note?: string): DomainEvent | null;
    // ⟨写 recovery.taken，predicted=卡片默认值，actual=用户确认值⟩
}

// 内部：clampRange(v, lo, hi): number
```

### 3.11 `src/weather/sensor.ts` — 天气感知

```ts
/**
 * 职责边界：API 抓取 + 双层缓存 + 三级降级。完全离线可用——网络失败不抛错只降级。
 * 降级链：live → 内存缓存 → 事件流缓存 → FALLBACK_WEATHER
 * fetcher 可注入，便于单测与替换数据源。
 */

export const CACHE_TTL_MS = 30 * 60 * 1000;   // 缓存 TTL 30min
export const FETCH_TIMEOUT_MS = 6000;         // 请求超时

export interface WeatherFetcher {
  (lat: number, lon: number, signal: AbortSignal): Promise<{ condition: WeatherCondition; tempC: number }>;
}

export interface WeatherSensorOptions {
  log: DecisionLog;
  lat?: number;              // 默认 22.5431（深圳）
  lon?: number;              // 默认 114.0579
  fetcher?: WeatherFetcher;  // 默认 openMeteoFetcher
  ttlMs?: number;
  now?: () => number;        // 可注入时钟，便于测试
}

export function wmoToCondition(code: number): WeatherCondition;
// ⟨WMO 天气码 → 4 种语义的核心映射：
//   >=95 thunderstorm；51–67 或 80–82 rain；71–77/85–86（雪霰）按 rain；
//   45/48（雾）cloudy；>=3 cloudy；0–2 sunny⟩

export const openMeteoFetcher: WeatherFetcher;
// ⟨默认抓取器，请求 api.open-meteo.com/v1/forecast（current=temperature_2m,weather_code）；
//   非 2xx 或 payload 缺字段则抛错，由 doRefresh 捕获降级⟩

export class WeatherSensor {
  constructor(opts: WeatherSensorOptions);
    // ⟨构造时 fromEventLog() 恢复缓存，跨进程重启仍有效⟩

  current(): WeatherState;
    // ⟨永不抛错。TTL 内返回缓存(source 保持原值)；过期返回 {...cache, source:'cache'}；
    //   无缓存返回 FALLBACK_WEATHER⟩
  refresh(): Promise<WeatherState>;
    // ⟨inflight 去重：并发调用复用同一 Promise⟩

  private log / lat / lon / fetcher / ttlMs / now;
  private cache: WeatherState | null;
  private inflight: Promise<WeatherState> | null;
  private doRefresh(): Promise<WeatherState>;
    // ⟨AbortController 超时控制；成功 → source='live' 且 append(weatherObservedDraft)；
    //   失败 → 内存缓存 ?? 事件流缓存（source='cache'）?? FALLBACK_WEATHER⟩
  private fromEventLog(): WeatherState | null;
    // ⟨log.byType('weather.observed', 1) 取最近一条，source 改写为 'cache'⟩
}
```

### 3.12 `src/insight/engine.ts` — 洞察引擎

```ts
/**
 * 职责边界：只读事件流的离线批处理。主循环不依赖本模块。
 * 唯一写操作：把推荐卡登记到 recommendations 表（防重复弹出）。
 * 恢复项默认值的实际更新由 Coordinator 调 RecoveryDeck 完成，本模块不碰。
 */

export const DEVIATION_THRESHOLD = 0.5;         // |actual-predicted| >= 0.5 记一次不匹配
export const DEVIATION_SAMPLES_REQUIRED = 3;    // 触发推荐所需最少不匹配次数

export interface InsightOptions {
  log: DecisionLog;
  now?: () => number;   // 可注入时钟
}

export class InsightEngine {
  constructor(opts: InsightOptions);

  weeklyReport(endDate?: Date): WeeklyReport;
    // ⟨默认最近 7 天。一次扫描纯计算：
    //   周开盘 = 周起点前 ENERGY_AFFECTING 事件 fold；再按天分组 foldWithTrace 重放；
    //   聚合 avg/min/max（含每日开盘与每步 trace）、tasksCompleted、recoveriesTaken、
    //   peakDrainHour（仅统计 actual_delta<0 的 task.completed，按小时累加 |delta|）、
    //   bestRecovery（按 itemId 聚合 actual_delta 均值取最大）、narrative⟩

  detectRecommendations(): InsightRecommendation[];
    // ⟨扫 byType('recovery.taken', 2000) 按 itemId 聚合偏差；
    //   mismatch >= 3 且无 pending 推荐 → 生成卡片并 insertRecommendation；
    //   suggestedDelta = round2(actual 均值)；返回本次新产出的推荐⟩

  pendingRecommendations(): InsightRecommendation[];
    // ⟨DB Row → 领域类型映射，渲染用⟩

  resolveRecommendation(
    recId: string,
    action: 'accepted' | 'modified' | 'rejected',
    modifiedDelta?: number,
  ): { itemId: string; newDelta: number | null } | null;
    // ⟨找不到 pending 记录 → null。accepted → newDelta=suggested_delta；
    //   modified 且 modifiedDelta 为 number → newDelta=round2(modifiedDelta)；
    //   其余（含 rejected）→ newDelta=null，仅记录处置⟩

  private log: DecisionLog;
  private now: () => number;
}

// 内部：isEnergyAffecting(ev): boolean
//       buildNarrative(r): string[]  —— 模板化文案；含前后半周收尾均值趋势对比（阈值 ±0.5）
```

### 3.13 `src/main/coordinator.ts` — 模块协调器

```ts
/**
 * 职责边界：装配全部领域模块 + 维护 PendingSlide 状态机 + 计算 AppState。
 * 是「领域层」与「Electron 层」之间唯一的接缝：main/index.ts 只认 Coordinator。
 */

export const WEATHER_REFRESH_MS = 30 * 60 * 1000;   // 天气刷新间隔
export const INSIGHT_BATCH_MS = 10 * 60 * 1000;     // AI 推荐批处理间隔

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
    //   lat/lon/fetcher 仅在显式提供时透传（避免 exactOptionalPropertyTypes 冲突）⟩

  /* ── 生命周期 ── */
  start(): Promise<void>;
    // ⟨seedIfEmpty → append(sessionStarted) → weather.refresh()(不阻塞)
    //   → 两个 setInterval → maybeMorningBaseline() → setTimeout(insight, 3000)⟩
  stop(): void;
    // ⟨清定时器 → append(sessionEnded) + upsertDailySnapshot → bus.clear() → log.close()⟩

  /* ── 状态计算 ── */
  buildState(): AppState;
    // ⟨渲染进程唯一数据入口。energy=ledger.current()，weather=weather.current()，
    //   emotion=resolve({energy, weather, events: ledger.todayEvents()})；
    //   morningBaselinePending = !morningDone && pendingSlide?.kind==='morning-baseline'⟩
  pushState(send: (channel: string, payload: unknown) => void): void;
    // ⟨去重推送：JSON 比对（lastUpdated 归零后比）相同则跳过，否则 send('state:update', state)⟩
  emotionSummary(): string;   // ⟨describe(buildState().emotion, weather)，气泡用⟩

  /* ── 滑动确认状态机（同一时刻最多一张卡）── */
  requestSlide(kind: PendingSlide['kind'], refId: string): PendingSlide | null;
    // ⟨已有卡 → null。按 kind 分派到 tasks.requestComplete / deck.requestTake /
    //   buildMorningSlide / buildManualSlide；成功则 emit('slide:requested')⟩
  previewSlide(target: number): { energy: number; emotion: EmotionState };
    // ⟨不落库。target 为目标绝对精力值；返回投影精力与对应情绪⟩
  confirmSlide(target: number, note?: string): DomainEvent | null;
    // ⟨唯一写入口。manual-adjust 直接关卡返回 null；
    //   其余 d = round2(clamp(target) - slide.baseEnergy)，按 kind 分派写入；
    //   morning-baseline 额外置 morningDone=true；
    //   成功后 emit event:appended / energy:changed / slide:confirmed，末尾必 emit state:dirty⟩
  cancelSlide(): void;
    // ⟨关卡；morning-baseline 取消也算完成（不强制）；emit slide:cancelled + state:dirty⟩

  /* ── 任务快捷入口 ── */
  createTask(title: string, estCost: number, dueAt?: number | null): void;
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
    //   rejected → recRejectedDraft；末尾 emit recovery:changed + state:dirty⟩

  weeklyReport(): WeeklyReport;   // ⟨委托 insight.weeklyReport()⟩

  /* ── 窗口模式 ── */
  setMode(mode: WindowMode): void;   // ⟨同值直接 return；否则 emit mode:changed + state:dirty⟩
  getMode(): WindowMode;

  /* ── 私有 ── */
  private pendingSlide: PendingSlide | null;
  private mode: WindowMode;                       // 初值 'pet'
  private morningDone: boolean;
  private timers: ReturnType<typeof setInterval>[];
  private lastPushedJson: string;
  private hasTodayBaseline(): boolean;            // ⟨今日是否已有 reason==='晨间基线' 的 energy.set⟩
  private morningBaselineStart(): number;         // ⟨yesterdayCloseEnergy() ?? INITIAL_ENERGY⟩
  private buildMorningSlide(): PendingSlide;
  private buildManualSlide(): PendingSlide;       // ⟨纯预览卡，确认/关闭都不落库⟩
  private maybeMorningBaseline(): void;
  private runInsightBatch(): void;                // ⟨detectRecommendations → recShownDraft + emit⟩
}

// 内部：clamp(v: number): number   // Math.min(ENERGY_MAX, Math.max(0, round2(v)))
```

### 3.14 `src/main/index.ts` — 主进程入口

```ts
/**
 * 职责边界：Electron 主进程。窗口创建、IPC 注册、托盘、命中轮询、拖拽、崩溃可观测性与自愈。
 * 不含任何业务逻辑——全部委托 Coordinator。
 *
 * 窗口策略（v1 单宠物单进程）：透明/无边框/置顶(screen-saver)/skipTaskbar/不可调大小。
 * click-through 用「主进程 50ms 轮询光标 + 渲染进程上报 hotRect」而非 forward:true，
 * 因为 macOS 上 transparent + forward 高频切换会触发原生层 SIGABRT。
 */

// ── 模块级常量 ──
const WIN_WIDTH = 400;  const WIN_HEIGHT = 620;  const EDGE_MARGIN = 24;
const CRASH_LOG_MAX_BYTES = 256 * 1024;
const DRAG_STALE_MS = 8000;      // mouseup 丢失保护
const HIT_WARMUP_MS = 2500;      // 启动宽限，期间不告警空命中区
// ── 模块级状态 ──
let win / tray / coordinator / quitting / hotRects / ignoring / hitTimer
let dragOffset / dragLastAt / forcedInteractive / warnedEmptyRects / lastSignal
const APP_START_AT: number;

// ── 崩溃可观测性 ──
function logCrash(tag: string, detail: unknown): void;
// ⟨落盘 <userData>/crash.log；超 256KB 轮转为 .1（只留一份历史）；
//   写日志失败不影响主流程⟩

// ── 窗口 ──
function computeBounds(): Electron.Rectangle;
// ⟨屏幕右下角对齐，留 EDGE_MARGIN；小屏保护：h∈[320, workArea.h-16]，w∈[280, workArea.w-16]⟩
function createWindow(): void;
// ⟨BrowserWindow 配置要点：frame:false, transparent:true, alwaysOnTop('screen-saver'),
//   setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}), focusable:true（不可设 false，
//   否则 macOS 收不到鼠标事件）, acceptFirstMouse:true, showInactive() 不抢焦点；
//   webPreferences: contextIsolation:true, nodeIntegration:false, sandbox:false,
//   backgroundThrottling:false（保 60fps）；
//   初始 setIgnoreMouseEvents(true)；启动 startHitTestLoop()；
//   处理 --selftest-click / --selfcheck 两种自检模式⟩

// ── 状态推送 ──
function sendToRenderer(channel: string, payload: unknown): void;   // ⟨win 已销毁则静默跳过⟩
function flushState(): void;                                        // ⟨统一刷新入口⟩

// ── 命中测试 / click-through ──
function setIgnoreMouseEvents(ignore: boolean): void;   // ⟨同值跳过；异常走 logCrash⟩
function isCursorOverHotRect(): boolean;
// ⟨screen.getCursorScreenPoint() 减窗口原点转窗口内坐标；hotRects 为空则用兜底区⟩
function fallbackHotRects(width: number, height: number): HotRect[];
// ⟨包装 core/hittest 同名函数，附加「空命中区」告警（宽限期后仅告警一次）⟩
function startHitTestLoop(): void;
// ⟨50ms setInterval。优先级：拖拽中(强制可交互，含 DRAG_STALE_MS 超时复位)
//   → forcedInteractive(panel 模式) → 按命中判定⟩
function stopHitTestLoop(): void;

// ── 拖拽移动窗口 ──
function startDrag(screenX: number, screenY: number): void;
function moveDrag(screenX: number, screenY: number): void;
// ⟨限制在目标显示器工作区内，避免拖出屏幕找不回来⟩
function endDrag(): void;

// ── IPC 注册（通道名 → Coordinator 方法）──
function registerIpc(): void;
```

**IPC 通道全表**（`invoke` = 双向有返回，`on` = 单向）：

| 通道 | 类型 | 入参 | 返回 |
|---|---|---|---|
| `app:getState` | invoke | — | `AppState \| null` |
| `win:hotRects` | on | `HotRect[]` | — |
| `win:hitTest` | on | — | — （**deprecated 空实现**，避免与 hotRects 两套机制打架） |
| `renderer:error` | on | `{source, message, stack?}` | — |
| `win:dragStart` / `dragMove` | on | `{x, y}` | — |
| `win:dragEnd` | on | — | — |
| `win:setMode` | invoke | `WindowMode` | `WindowMode` |
| `slide:request` | invoke | `{kind, refId}` | `PendingSlide \| null` |
| `slide:preview` | invoke | `target: number` | `{energy, emotion} \| null` |
| `slide:confirm` | invoke | `{target, note?}` | `DomainEvent \| null` |
| `slide:cancel` | invoke | — | `true` |
| `task:create` | invoke | `{title, estCost, dueAt?}` | `true` |
| `task:drop` | invoke | `taskId: string` | `true` |
| `task:complete` | invoke | `taskId: string` | `PendingSlide \| null` |
| `recovery:take` | invoke | `itemId: string` | `PendingSlide \| null` |
| `recovery:updateDelta` | invoke | `{itemId, delta, reason}` | `RecoveryItem \| null` |
| `recovery:versions` | invoke | `itemId: string` | `RecoveryVersion[]` |
| `energy:set` | invoke | `target: number` | `number`（当前精力） |
| `weather:refresh` | invoke | — | `WeatherState \| null` |
| `recommendation:resolve` | invoke | `{id, action, delta?}` | `boolean` |
| `insight:weeklyReport` | invoke | — | `WeeklyReport \| null` |
| `emotion:summary` | invoke | — | `string` |
| `app:quit` / `app:reposition` | invoke | — | `true` |
| `state:update` | **主→渲染** | — | `AppState`（由 `pushState` 推送） |

```ts
// ── 窗口模式 ──
function applyModeToWindow(mode: WindowMode): void;
// ⟨panel → forcedInteractive=true + 关闭穿透 + focus()；
//   pet → forcedInteractive=false + 交回轮询控制⟩

// ── 托盘 ──
function buildTrayIcon(): Electron.NativeImage;
// ⟨程序化绘制 16×16 BGRA 圆点，无需外部资源；setTemplateImage(true) 跟随系统深浅色⟩
function createTray(): void;
// ⟨静态菜单只构建一次 —— macOS 上菜单显示中调 setContextMenu 会 SIGABRT；
//   动态信息（精力/情绪）改由 tooltip 承载，节流 800ms；
//   菜单项：打开/收起面板 · 刷新天气 · 回到默认位置 · 退出⟩

// ── 应用生命周期 ──
app.requestSingleInstanceLock();   // 拿不到锁 → logCrash + quit，避免多实例抢同一 DB
app.whenReady().then(async () => {
  // process.on('uncaughtException' | 'unhandledRejection') → logCrash 但不退出
  //   （宠物应用「静默死掉」比崩溃更糟）
  // new Coordinator → registerIpc → createWindow → await coordinator.start()
  // app.on('render-process-gone')：自动 reload；连续 >3 次判定为崩溃循环，停止 reload
  // setInterval 30s 清零崩溃计数
  // app.on('child-process-gone')：GPU/Utility 崩溃仅记录
  // coordinator.bus.on(10 个事件) → flushState()；mode:changed 额外 applyModeToWindow
  // createTray() → flushState()
});
process.on('SIGTERM'|'SIGINT'|'SIGHUP') → logCrash + quit;   // 终止信号审计
app.on('window-all-closed') → 仅 quitting 时真退出（macOS 点 Dock 不退出）;
app.on('before-quit') → logCrash(退出原因审计) + coordinator.stop();
app.on('activate') → win 为空则重建;
// 若 process.argv 含 --no-sandbox → app.disableHardwareAcceleration()
```

### 3.15 `src/preload/index.ts` — 安全桥接

```ts
/**
 * 职责边界：contextIsolation:true + nodeIntegration:false 下的白名单桥接。
 * 渲染进程无法直接触达 Node/Electron 能力；所有写操作经 IPC → Coordinator → DecisionLog。
 */

type Unsub = () => void;   // 状态推送订阅句柄

const api = {
  getState(): Promise<AppState | null>;
  reportError(info: { source: string; message: string; stack?: string }): void;  // send
  onState(cb: (state: AppState) => void): Unsub;      // ⟨订阅 'state:update'，返回退订函数⟩
  hitRects(rects: { x: number; y: number; w: number; h: number }[]): void;       // send
  dragStart(x: number, y: number): void;
  dragMove(x: number, y: number): void;
  dragEnd(): void;
  setMode(mode: WindowMode): Promise<WindowMode>;
  slideRequest(kind: PendingSlide['kind'], refId: string): Promise<PendingSlide | null>;
  slidePreview(target: number): Promise<{ energy: number; emotion: EmotionState } | null>;
  slideConfirm(target: number, note?: string): Promise<DomainEvent | null>;
  slideCancel(): Promise<boolean>;
  taskCreate(title: string, estCost: number, dueAt?: number | null): Promise<boolean>;
  taskDrop(taskId: string): Promise<boolean>;
  taskComplete(taskId: string): Promise<PendingSlide | null>;
  recoveryTake(itemId: string): Promise<PendingSlide | null>;
  recoveryUpdateDelta(itemId: string, delta: number, reason: string): Promise<RecoveryItem | null>;
  recoveryVersions(itemId: string): Promise<RecoveryVersion[]>;
  energySet(target: number): Promise<number>;
  weatherRefresh(): Promise<WeatherState | null>;
  recommendationResolve(
    id: string, action: 'accepted' | 'modified' | 'rejected', delta?: number,
  ): Promise<boolean>;
  weeklyReport(): Promise<WeeklyReport | null>;
  emotionSummary(): Promise<string>;
  quit(): Promise<boolean>;
  reposition(): Promise<boolean>;
};

export type PetApi = typeof api;   // 被 renderer/app.ts 用于 declare global Window.pet
contextBridge.exposeInMainWorld('pet', api);
```

### 3.16 `src/renderer/pet.ts` — Canvas 渲染器

```ts
/**
 * 职责边界：三层图层合成，与 EmotionEngine 三层一一对应。
 *   body 层    base 情绪驱动主体（体型/配色/眼睛/嘴/呼吸/弹跳/眨眼）
 *   weather 层 独立精灵锚定头顶，不参与表情状态机
 *   pulse 层   低精力瞬时反应特效（光环/符号）
 * RAF 驱动 60fps；所有状态变化经 lerp 平滑插值，表情切换不生硬。
 */

export interface PetRenderOptions {
  canvas: HTMLCanvasElement;
  dpr?: number;   // 默认 min(devicePixelRatio, 2)
}

interface RenderParams {   // 模块内私有：插值后的连续量
  energy: number; hue: number; sat: number;
  breath: number;    // 呼吸周期 s
  bounce: number;    // 弹跳幅度 px
  blink: number;     // 眨眼间隔 s
  eyeOpen: number;   // 0–1 眼睛开合
  mouthCurve: number; // -1 哭 … +1 大笑
  squish: number;    // 疲惫时身体压扁程度
  tremble: number;   // 颤抖强度
}

const EMOTION_PARAMS: Record<BaseEmotion, {
  mouthCurve: number; eyeOpen: number; squish: number; tremble: number;
}>;   // 10 档 base → 嘴型/眼开合/压扁/颤抖

const PULSE_PARAMS: Record<PulseReaction, Partial<{
  mouthCurve: number; tremble: number; eyeOpen: number;
}>>;  // pulse 反应对渲染参数的微调（覆盖 base 值）

export class PetRenderer {
  constructor(opts: PetRenderOptions);
    // ⟨取 2d context，失败抛 Error('PetRenderer: 2d context unavailable')；
    //   初始 target/current = buildParams(10, 'steady', 'none', false)；resize() 后立即 loop()⟩

  /* ── 对外 API ── */
  applyEmotion(state: EmotionState): void;
    // ⟨主路径：AppState 推送时调用，设置 target 与 overlay/pulse/pulseActive⟩
  setPreview(energy: number): void;
    // ⟨滑块预览：按投影精力实时驱动表情；pulseActive = energy < PULSE_THRESHOLD，
    //   未激活时 pulse 传 'none'⟩
  clearPreview(state: EmotionState): void;      // ⟨等价于 applyEmotion(state)⟩
  applyOverlay(overlay: WeatherOverlay): void;
  say(text: string, ms?: number): void;         // ⟨气泡，默认 3200ms 后自动消失⟩
  poke(): void;                                 // ⟨点击戳一下：挤压反馈 + 6 颗粒子⟩
  celebrate(): void;                            // ⟨庆祝：18 颗 hue=48 粒子⟩
  resize(): void;                               // ⟨按 CSS 尺寸 × dpr 重设画布像素⟩
  petBounds(): { x: number; y: number; w: number; h: number };
    // ⟨宠物主体实际可视包围盒（canvas CSS 坐标），含头顶天气精灵与影子。
    //   为何不用整个 canvas 盒子：canvas 占满 240×230 的 pet-wrap，本体只在底部中央一小块，
    //   直接上报会造成「画布比可点击范围大」的错位观感⟩
  destroy(): void;                              // ⟨cancelAnimationFrame⟩

  /* ── 私有 ── */
  private canvas / ctx / dpr / raf / startTime;
  private lastBlink / blinking / blinkProgress;
  private target: RenderParams;    // 目标参数（由情绪状态决定）
  private current: RenderParams;   // 当前参数（向 target 平滑插值）
  private overlay: WeatherOverlay; private pulse: PulseReaction; private pulseActive: boolean;
  private bubbleText: string | null; private bubbleUntil: number; private pokeTime: number;
  private particles: { x,y,vx,vy,life,maxLife,hue,size }[];
  private buildParams(energy, base, pulse, pulseActive): RenderParams;
    // ⟨BASE_TIERS 按 emotion 查档（未命中回退 tierFor(energy)）；
    //   eyeOpen/mouthCurve/tremble 取 PULSE_PARAMS ?? EMOTION_PARAMS（pulse 覆盖 base）⟩
  private loop: () => void;
    // ⟨RAF 回调。插值系数 k = 1 - exp(-dt*6)（帧率无关近似）；
    //   眨眼按 blink * (0.7 + random*0.6) 秒随机调度⟩
  private render(t: number, now: number): void;
    // ⟨绘制顺序：影子 → pulse 光环 → 身体(径向渐变+高光+双耳) → 脸(双眼+嘴+腮红)
    //   → 天气 overlay → 粒子 → 气泡。
    //   bodyR = min(52 + energy*0.6, H*0.32)（体型随画布高度自适应，小窗不裁切 overlay）⟩
  private drawEar(ctx, x, y, angle, p: RenderParams): void;
  private drawEyes(ctx, x, y, bodyR, p: RenderParams, now: number): void;
    // ⟨open<0.15 画闭眼弧线（开心向上弯/累时向下垂）；否则画睁眼+眼神光；
    //   eyeOpen<0.7 叠加上眼皮遮罩表现疲惫⟩
  private drawMouth(ctx, x, y, bodyR, p: RenderParams): void;
    // ⟨curve>0.65 画张嘴大笑+舌头；否则二次贝塞尔，curve 控制弯向⟩
  private drawPulseAura(x, y, bodyR, t): void;
    // ⟨6 种 pulse 各有专属光环颜色；anxious💧 / restless〰️ / grateful✨ 附加符号⟩
  private drawWeatherOverlay(x, y, t, _petHue: number): void;
    // ⟨4 种精灵：sunbeam(旋转光芒) / cloud-puff / rain-drop(循环雨丝) / storm-bolt(周期闪电)；
    //   锚定头顶右侧 x+44~46，各有独立浮动相位⟩
  private spawnParticles(n: number, hue: number): void;
  private updateParticles(ctx: CanvasRenderingContext2D): void;   // ⟨五角星形状，重力 120⟩
  private drawBubble(ctx, x, y, text: string, fade: number): void;
}

// 模块级工具（导出 lerp）
function lerp(a: number, b: number, t: number): number;
function roundRect(ctx, x, y, w, h, r: number): void;      // 私有
function wrapText(ctx, text: string, maxW: number): string[];  // 私有，逐字符折行
export { lerp };
```

### 3.17 `src/renderer/app.ts` — 渲染进程主控

```ts
/**
 * 职责边界：串联 PetRenderer / 滑动确认 / 面板 / 推荐卡 / hitTest。
 * 数据流：主进程 pushState(AppState) → 本模块 diff 渲染。
 * 写操作全部经 window.pet.* IPC → Coordinator → DecisionLog。
 * 模块无导出（export {}），以 IIFE 形式由 esbuild 打包。
 */

declare global {
  interface Window { pet: import('../preload/index.js').PetApi }
}

/* ── 错误黑匣子：window 'error' / 'unhandledrejection' → pet.reportError → 主进程 crash.log ── */

/* ── DOM 引用（$ 帮助函数：找不到元素直接抛 Error(`missing #${id}`)）──
   pet-wrap / pet-canvas / energy-hud / hud-num / hud-bar / hud-tier / hud-weather
   slide-card / s-title / s-sub / s-value / s-delta / s-predicted / s-predicted-row
   s-base-mark / s-slider / s-min / s-mid / s-max / s-note / s-confirm / s-cancel
   panel / panel-sub / rec-grid / version-slot / task-list / task-title / task-cost
   report-nums / report-spark / report-narrative / rec-stack / toast           */

/* ── 模块级状态 ── */
let pet: PetRenderer;
let state: AppState | null;
let slide: PendingSlide | null;
let previewDebounce: ReturnType<typeof setTimeout> | null;
let shownRecIds: Set<string>;        // 已建卡的推荐 id，用于增量建卡/删卡
let activeTab: string;               // 初值 'recovery'
let reportCache: WeeklyReport | null;
let hudVisible: boolean;

/* ── 工具 ── */
function toast(msg: string, ms?: number): void;   // 默认 2200ms
function fmtDelta(v: number): string;             // ⟨0.5 步长取整，正数加 '+' 前缀⟩
const WEATHER_ICON: Record<string, string>;       // sunny☀️ cloudy☁️ rain🌧️ thunderstorm⛈️
function escapeHtml(s: string): string;           // ⟨& < > " ' 五字符转义，防注入⟩

/* ── 命中区上报（click-through 渲染侧核心）── */
type HotRect = { x: number; y: number; w: number; h: number };   // 本地定义，未 import core/hittest
function collectHotRects(): HotRect[];
// ⟨唯一命中来源。收集顺序：宠物主体(petBounds 而非整个 canvas) → #dock/#panel/#slide-card
//   → #rec-stack 的实际子卡片（跳过空容器，避免整块区域不可穿透）；按 x,y,w,h 去重。
//   内部两个判定函数：
//     explicitHidden(el) —— slide-card 无 .show / panel 无 .open / 含 .leaving 视为隐藏
//       （关闭动画期 computed opacity 仍 >0，但命中区必须立刻回收，否则残留挡桌面）
//     hittable(el) —— display/visibility/opacity 查祖先链；pointer-events 只查元素自身
//       （子元素可用 auto 覆盖祖先 none，#stage 正是 none + [data-interactive]{auto}）⟩
function setupHitTest(): void;
// ⟨ResizeObserver + MutationObserver(class/style 属性过滤) → 200ms 节流上报；
//   setInterval 1500ms 兜底校对（CSS 过渡完成后尺寸可能有偏差）；
//   mousemove 只做「变化检测」：dock 悬停态翻转时排两次上报（进入立即 + 450ms 后复核）；
//   另一路 mousemove 控制 HUD 悬停显隐（elementFromPoint 判 #pet-wrap）；
//   调试钩子 window.__hotRects 供 --selfcheck 读取；
//   末尾立即 report() 保证首帧即可交互⟩

/* ── 宠物拖拽 ── */
function setupDrag(): void;
// ⟨pet-wrap mousedown(button 0) → dragStart；window mousemove → dragMove；
//   mouseup → dragEnd，且 moved=false 时视为点击：pet.poke() + emotionSummary 气泡⟩

/* ── 滑动确认卡 ── */
function showSlide(s: PendingSlide): void;
// ⟨manual-adjust 为纯预览：隐藏 confirm 按钮/备注框/事件默认行，取消文案改「关闭 · 恢复原状」；
//   morning-baseline：predicted 行改显 baseEnergy，标签改「昨日收尾」，卡片加 .morning；
//   滑块 min/max 来自 s，step=0.5，默认值 = clampSlider(baseEnergy + predicted)；
//   出现时收起面板并 setMode('pet')，避免 panel 强制交互态残留⟩
function positionBaseMark(s: PendingSlide): void;
// ⟨在滑轨标记「事件前真实精力」位置；trackPad=13（拇指半径），
//   left = calc(13px + pct * (100% - 26px))⟩
function clampSlider(v: number): number;      // ⟨钳制到 slide.[min,max] 并按 0.5 取整⟩
function updateSlideVisual(target: number): void;
// ⟨大数字显示目标精力，小字显示 Δ（0.5 步长）；pos/neg/zero 三态着色；
//   pet.setPreview(target) 本地即时反馈 + 80ms 节流走 slidePreview IPC⟩
function hideSlide(): void;
// ⟨移除 .show；恢复 state.emotion；面板未开则兜底 setMode('pet')；
//   manual 预览结束时气泡提示「还是 X 分，没变～」⟩
function setupSlide(): void;
// ⟨slider input → updateSlideVisual；confirm → slideConfirm(target, note) 后按 delta 正负
//   celebrate/气泡/toast；cancel → slideCancel；备注框 Enter 确认 / Escape 取消⟩

/* ── 面板 ── */
function setupPanel(): void;
// ⟨open: 加 .open + setMode('panel') + 隐藏 HUD + report 页则 loadReport；
//   close: 移除 .open + setMode('pet')；
//   tab 切换按 data-tab / data-page 联动 active 类；
//   任务添加：cost 钳制 [0,5]，Enter 亦可提交；
//   dock 四键：dock-adjust(manual-adjust 预览卡) · dock-weather(刷新+toast 来源) ·
//             dock-say(emotionSummary 气泡) · dock-quit⟩

/* ── 恢复项 / 任务 / 周报 / 推荐卡渲染 ── */
function renderRecoveries(items: RecoveryItem[]): void;
// ⟨每次全量重建 rec-grid；点击 → recoveryTake(item.id)；
//   长按 500ms → showVersions；mouseup/mouseleave 清除长按定时器⟩
function showVersions(item: RecoveryItem): Promise<void>;
// ⟨版本历史弹层，最多 8 条，6s 后自动移除⟩
function renderTasks(): void;
// ⟨open 按 createdAt 倒序 + 最近 6 条已完成；超时任务加 .overdue 与「超时」标签；
//   open 项附「完成」「放弃」按钮；空态提示文案⟩
function loadReport(): Promise<void>;      // ⟨weeklyReport() → reportCache → renderReport⟩
function renderReport(): void;
// ⟨6 个数据格 + 迷你柱状图（高度按 closeEnergy/max，max 取 max(ENERGY_MAX, ...)，下限 4%）
//   + 叙事段落⟩
function renderRecommendations(recs: InsightRecommendation[]): void;
// ⟨增量：消失的卡片加 .leaving 后 300ms 移除；新增才建卡（shownRecIds 去重）；
//   卡内 range 滑杆 min=-2 max=5 step=0.5 供「按此调整」；
//   三按钮 data-act=rejected/modified/accepted → recommendationResolve；
//   同屏最多 2 张，超出移除最旧；建卡时气泡「我发现了一个规律…」⟩

/* ── 主状态渲染 ── */
function applyState(s: AppState): void;
// ⟨① 无滑动卡时 pet.applyEmotion(s.emotion)（有卡则不打断预览）
//   ② HUD：数值/进度条宽度(energy/ENERGY_MAX)/档位 label/天气图标/面板副标题
//   ③ 滑动卡 diff：refId|kind|createdAt 任一变化才 showSlide（createdAt 参与比对，
//      保证同一恢复项连续两次卡片也能正确刷新）；卡片消失且本地有 slide → hideSlide
//   ④ renderRecoveries / renderTasks / renderRecommendations
//   ⑤ 首次推送且 morningBaselinePending → 问候气泡 5s
//   ⑥ 精力跨过 PULSE_THRESHOLD 向下 → 低电量提示气泡 4.2s⟩

/* ── 启动 ── */
function boot(): void;
// ⟨new PetRenderer({canvas: petCanvas}) → setupHitTest/setupDrag/setupSlide/setupPanel
//   → report-refresh 绑定 → onState 订阅 + getState 首拉 → resize 监听⟩
// document.readyState === 'loading' ? DOMContentLoaded 后 boot : 立即 boot

export {};
```

**渲染层依赖的 45 个 DOM id**（`index.html` 提供，`app.ts` 通过 `$()` 强引用，缺失即抛错）：
`stage` `pet-wrap` `pet-canvas` `energy-hud` `hud-num` `hud-bar` `hud-tier` `hud-weather` ·
`slide-card` `s-title` `s-sub` `s-value` `s-delta` `s-predicted-row` `s-predicted` `s-base-mark`
`s-slider` `s-min` `s-mid` `s-max` `s-note` `s-confirm` `s-cancel` ·
`panel` `panel-title` `panel-sub` `panel-close` `rec-grid` `version-slot` `task-list` `task-title`
`task-cost` `task-add-btn` `report-nums` `report-spark` `report-narrative` `report-refresh`
`rec-stack` `toast` · `dock` `dock-panel` `dock-adjust` `dock-weather` `dock-say` `dock-quit`

---

## 4. 关键设计不变式

修改代码前必须守住的约束，违反任一条都会破坏系统正确性：

| # | 不变式 | 保障位置 |
|---|---|---|
| 1 | **精力值 = fold(events)**，事件流是唯一事实源 | `ledger/fold.ts`；`DecisionLog.rebuildEnergy()` 启动全量重放校验 |
| 2 | **所有写入只走 `DecisionLog.append()`** | 领域模块均无直接 SQL；`append` 内计算 `energy_after` |
| 3 | **事件不可变**，只追加不修改 | schema 无 UPDATE 路径（`resolveRecommendation` 改的是 recommendations 表，非 events） |
| 4 | **折叠语义单一**：写路径与重放路径共用 `nextEnergy` | `foldDraft`（写）/ `foldEvent`（重放）都委托它 |
| 5 | **同一时刻最多一张滑动卡** | `Coordinator.requestSlide()` 首行 `if (this.pendingSlide) return null` |
| 6 | **`actual_delta` = target − baseEnergy**（绝对精力语义，非增量） | `confirmSlide()`；`predicted_delta` 仅作参考记录 |
| 7 | **`manual-adjust` 永不落库** | `confirmSlide()` 首分支直接关卡返回 null |
| 8 | **天气永不抛错**，只降级 | `WeatherSensor.current()` / `doRefresh()` catch 全兜底 |
| 9 | **命中区宁可偏大不可为空** | `fallbackHotRects()` 兜底 + `sanitizeRects()` 过滤脏数据 |
| 10 | **命中来源唯一**：只用 `win:hotRects` 轮询 | `win:hitTest` 保留为 deprecated 空实现，避免两套机制打架 |
| 11 | **精度统一两位小数** | 全部经 `core/events.round2()` |
| 12 | **情绪合成为纯函数** | `emotion/engine.ts` 无 IO、无状态，双进程可安全复用 |

---

## 5. 一致性问题清单（源码实测，未修改任何文件）

以下是抽取过程中发现的**文档/注释与实现不一致**及**已定义但未接线**的公开 API。
全部仅记录，未改动任何代码。

### 5.1 注释与实现矛盾

| 位置 | 注释/文档称 | 实际实现 | 影响 |
|---|---|---|---|
| `src/emotion/engine.ts:6` | 文件头「pulse：精力 **< 6** 时激活」 | `PULSE_THRESHOLD = 3`（:49），`resolve()` 用 `energy < 3`（:267） | **注释错误**。同文件 :80 与 `tests/core.test.ts:170` 均确认为 3 |
| `src/core/types.ts:57` | `PulseReaction` 上方「pulse 层情绪反应（**<6 分**激活）」 | 同上，实际阈值 3 | **注释错误** |
| `overview.md:10,24` | 「测试 **30/30** 全绿」、「pulse（**<6** 激活）」 | 实测 `test(` 计数 **40**（core 24 + hittest 9 + coordinator 7）；阈值 3 | **文档过期**，两处均需更新 |
| `overview.md:15` | 「`Coordinator` 事件总线 + 模块协调」 | Coordinator 确实持有 bus，但描述易误解为使用 `core/bus` 的全局单例（实际自建实例） | 表述可更精确 |

> 注：`PULSE_THRESHOLD = 3` 与 `energyBand()` 的 low 档（<3）是对齐的，实现自洽；错的只是注释。

### 5.2 已定义但无调用方的公开 API

| API | 定义位置 | 状态 |
|---|---|---|
| `bus`（全局单例） | `core/bus.ts:105` | **未被任何文件 import**。`Coordinator` 在 :46 自建 `new EventBus()`，`main/index.ts` 经 `coordinator.bus` 访问 |
| `EventBus.once()` | `core/bus.ts:58` | 无调用方（`main/index.ts` 的 3 处 `.once()` 是 Electron `win`/`webContents` 的方法，非本类） |
| `EventBus.emitDebounced()` | `core/bus.ts:83` | 无调用方。注释称「合并高频 emit」，但实际节流由 `app.ts` 的 200ms 上报节流与 `pushState` 的 JSON 去重承担 |
| `EventBus.listenerCount()` | `core/bus.ts:99` | 无调用方 |
| `EVENT_TYPES` | `core/events.ts:32` | 仅定义处出现，无消费者。`EventType` 联合才是实际约束来源 |
| `noteDraft()` / `note.added` | `core/events.ts:178` | 工厂无调用方。事件类型在 `EventPayload` 与 `rowToEvent` 的损坏降级路径中被使用 |
| `EnergyLedger.since()` | `ledger/energy.ts:120` | 主链路无调用方；仅 `tests/core.test.ts:392` 直接测 `DecisionLog.since()` |
| `TaskCenter.overdueCount()` | `task/center.ts:116` | **无调用方**。pulse 的 `guilty` 信号由 `extractPulseSignals()` 自行从事件流计算 `overdueTasks`，未经此方法 |
| `EnergyLedger.todaySnapshot()` / `LedgerSnapshot` | `ledger/energy.ts:55` | 生产链路无调用方；仅 `tests/core.test.ts:104` 使用。`Coordinator.buildState()` 不消费它 |
| `EnergyLedger.adjust()` | `ledger/energy.ts:109` | 生产链路无调用方（`confirmSlide` 走 `tasks.confirmComplete`/`deck.confirmTake`/`setEnergy`）；仅测试使用 |
| `PetRenderer.clearPreview()` / `applyOverlay()` | `renderer/pet.ts:124,128` | 无调用方。`app.ts:hideSlide()` 改用 `applyEmotion(state.emotion)` 恢复 |
| `TASK_ABS_MAX` / `RECOVERY_ABS_MAX` | `task/center.ts:26`、`recovery/deck.ts:26` | 无调用方。实际 `PendingSlide.absMax` 直接取 `ENERGY_MAX` |
| `core/bus.ts` 的 `'event:appended'` / `'energy:changed'` payload | `core/bus.ts:24-25` | emit 有调用（`coordinator.ts:213-214`），但 `main/index.ts` 对 `energy:changed` 只做 `flushState()`，未读 payload |

> 这些不是缺陷——多为测试可达性或未来扩展预留。列出是为了避免后续对话误以为它们在主链路上。

### 5.3 有意的重复定义（非缺陷，勿"修复"）

- `HotRect` 在 `core/hittest.ts:11` 与 `renderer/app.ts:112` **各定义一份**。
  渲染层未 import 主进程模块，属进程隔离的有意设计；`preload` 的 `hitRects()` 也用内联结构类型。
- `clampRange(v, lo, hi)` 在 `task/center.ts:28` 与 `recovery/deck.ts:28` **各定义一份**（模块私有，逻辑相同）。
- `clamp(v)` 在 `main/coordinator.ts:355` 独立定义，与 `ledger/fold.clampEnergy()` 逻辑相近但下界写死 0 而非 `ENERGY_MIN`。
- `isEnergyAffecting()`（`insight/engine.ts:207`）与 `core/events.ENERGY_AFFECTING` 集合**重复表达同一规则**——
  一处是 Set，一处是函数。若新增精力相关事件类型，两处都要改，属潜在维护风险点。

---

## 6. 修改指引（按任务类型定位）

| 想做的事 | 改哪里 | 注意事项 |
|---|---|---|
| 新增事件类型 | `core/events.ts`（`EventType` + `EventPayload` + 工厂）→ `ledger/fold.ts` `nextEnergy()` | 若影响精力，必须同时加入 `ENERGY_AFFECTING` **和** `insight/engine.ts` 的 `isEnergyAffecting()`（两处重复，见 §5.3） |
| 改精力计算规则 | `ledger/fold.ts` 的 `nextEnergy()` | 单点修改即可，写路径与重放路径自动同步（不变式 4） |
| 加情绪档位 | `emotion/engine.ts` 的 `BASE_TIERS` + `renderer/pet.ts` 的 `EMOTION_PARAMS` | 两个 Record 都按 `BaseEmotion` 索引，漏一处会 TS 报错 |
| 加 pulse 反应 | `core/types.ts` `PulseReaction` → `emotion/engine.ts` `PULSE_RULES` + `PULSE_PARAMS` → `pet.ts` `drawPulseAura` 配色表 | 规则按 priority 首个命中生效，不叠加 |
| 加恢复项 | `recovery/deck.ts` 的 `DEFAULT_ITEMS` | `seedIfEmpty()` 会自动为新项写初始版本历史 |
| 加 IPC 通道 | `main/index.ts` `registerIpc()` + `preload/index.ts` `api` | 两处签名需一致；`preload` 只暴露白名单 |
| 加面板 UI | `renderer/index.html`（id）→ `styles.css` → `app.ts` | 新增可交互元素须确保被 `collectHotRects()` 收集到，否则点击穿透（不变式 9） |
| 改窗口行为 | `main/index.ts` `createWindow()` / `applyModeToWindow()` | **勿设 `focusable:false`**，macOS 会同时失去鼠标事件接收能力 |
| 改托盘菜单 | `main/index.ts` `createTray()` | **勿动态重建菜单**，macOS 菜单显示中调 `setContextMenu` 会 SIGABRT |
| 改命中判定 | `core/hittest.ts`（几何）+ `renderer/app.ts` `collectHotRects()`（采集） | 几何纯函数有 9 个单测覆盖，改完跑 `npm test` |

**验证命令**：
```bash
cd energy-pet
npm run typecheck    # tsc --noEmit（strict + noUnusedLocals/Parameters）
npm test             # 40 个用例：build-tests → node --test dist-tests/*.mjs
npm start            # build + electron .
./smoke.sh           # 沙箱环境启动（自动 unset ELECTRON_RUN_AS_NODE）
```
> `noUnusedLocals`/`noUnusedParameters` 已开启，意味着 §5.2 列出的未使用**导出**不会报错
> （导出符号不受该规则约束），但新增未使用的局部变量会。
