# 5. 一致性问题清单（源码实测，未修改任何文件）

> 专题文档（原 STRUCTURE_MAP §5 全文迁入，保留 §5.1/5.2/5.3 编号）· v1.3 已按当前源码逐条重测
> ⚠️ 多会话并行改动，行号会失效，引用前重测 · [返回地图入口](../../STRUCTURE_MAP.md)


以下是抽取过程中发现的**文档/注释与实现不一致**及**已定义但未接线**的公开 API。
全部仅记录，未改动任何代码。

四类的划分：
- **§5.1 注释与实现矛盾** — 源码注释/历史文档说的与代码做的不一致（🔴 会误导实现者）
- **§5.2 无调用方的公开 API** — TS 层死代码，多为测试可达性或未来扩展预留
- **§5.3 有意的重复定义** — 看着像缺陷、实为进程隔离等设计取舍，**勿"修复"**
- **§5.4 孤立死代码 / 已废弃通道** — 🆕 渲染层与协议层的重构残留（孤立 CSS、deprecated IPC、
  不受类型检查的内联表）。⚠️ 与 §5.2 的关键区别：§5.2 调不到（无调用方），§5.4② **调得到但静默无操作**（更危险）

> 🔄 **v1.3 已按当前源码逐条重测**（行号全部刷新）。旧版清单有 **3 处已失效**：
> ① `applyOverlay()` 现在**有调用方**（`app.ts:1175`），不再是死代码；
> ② `EventBus.once()` **根本不存在**（bus.ts 只有 `constructor`/`clear`/`listenerCount` 三个非 emit/on 方法）——
>    旧清单把 `main/index.ts` 的 3 处 `.once()` 误归给 EventBus，实为 Electron `win`/`webContents` 的方法；
> ③ `clampRange()` 现在**只剩 `recovery/deck.ts:28` 一份**，`task/center.ts` 的那份已不存在 ⇒ 不再是重复定义。

## 5.1 注释与实现矛盾

| 位置 | 注释/文档称 | 实际实现 | 影响 |
|---|---|---|---|
| `src/emotion/engine.ts:6` | 文件头「pulse：精力 **< 6** 时激活」 | `PULSE_THRESHOLD = 3`（:58），`resolve()` 用 `energy < 3` | **注释仍未修**（v1.3 复核：原文尚在）。同文件与 `tests/core.test.ts` 均确认为 3 |
| `src/core/types.ts:57` | `PulseReaction` 上方「pulse 层情绪反应（**<6 分**激活）」 | 同上，实际阈值 3 | **注释错误，仍未修** |
| `overview.md`（工作区根） | 「测试 **30/30** 全绿」、「pulse（**<6** 激活）」 | 实测 **106/106**；阈值 3 | **历史文档，已严重过期**。不作待办来源，也不反映当前状态 |
| `src/renderer/pet.ts:238` 附近 `injure()` 注释 | 「未来若要接线，触发源必须是**领域事件**（如连续拒绝恢复建议）」 | 2026-10-22 **用户裁决推翻此预留**：不接线 + 领域层除名（DESIGN.md §5.4）。📌 **DESIGN.md 红线 R10/R11 措辞已于 v1.4 修订**（用户 11:49 批准）：R11 现写「跌倒态…**永不**由任何用户行为序列触发（手势、连点、拖动、拒绝计数均不可）」，"仅可由领域事件触发"的悬空许可已从契约中消除 | 🔴 **仅剩这行源码注释未跟进**：它仍邀请实现者去做已被原则性否决的事（影子计数器 = 暗中监视 / RSD 流失引信）。T0 与 v1.4 均只改 .md，**源码注释待 T12 实现时随 `injure()` 改名一并清除** |
| `src/main/index.ts` `buildTrayIcon()` | 裁决文档提及托盘应为「64px 猫」 | 实测 size=**16** 的暖黄**纯色圆点**，不是猫 | ⚠️ Q11：裁决的"64px"不对应任何实际尺寸（身体直径 104–116px）。T13 需澄清基准 |

> 注：`PULSE_THRESHOLD = 3` 与 `energyBand()` 的 low 档（<3）是对齐的，实现自洽；错的只是注释。
> 🔴 该常量是红线（DESIGN.md §4.3 / TASKS.md Q1），**勿自行调整**。

## 5.2 已定义但无调用方的公开 API（v1.3 逐条重测）

| API | 定义位置 | 状态 |
|---|---|---|
| `bus`（全局单例） | `core/bus.ts:117` | **未被任何文件 import**。`Coordinator` 自建 `new EventBus()`，`main/index.ts` 经 `coordinator.bus` 访问 |
| `EventBus.emitDebounced()` | `core/bus.ts:95` | 无调用方。注释称「合并高频 emit」，但实际节流由 `app.ts` 的 200ms 上报节流（`scheduleHotReport()`）与 `pushState` 的 JSON 去重承担 |
| `EventBus.listenerCount()` | `core/bus.ts:111` | 无调用方 |
| ~~`EventBus.once()`~~ | — | ❌ **不存在**（v1.3 更正，见本节开头） |
| `EVENT_TYPES` | `core/events.ts:32` | 仅定义处出现，无消费者。`EventType` 联合才是实际约束来源 |
| `noteDraft()` / `note.added` | `core/events.ts:194` | 工厂无调用方。事件类型在 `EventPayload` 与 `rowToEvent` 的损坏降级路径中被使用 |
| `EnergyLedger.since()` | `ledger/energy.ts:119` | 主链路无调用方；仅测试直接测 `DecisionLog.since()` |
| `EnergyLedger.adjust()` | `ledger/energy.ts:109` | 生产链路无调用方（写入走 `tasks.confirmComplete`/`deck.confirmTake`/`setEnergy`）；仅测试使用 |
| `EnergyLedger.todaySnapshot()` / `LedgerSnapshot` | `ledger/energy.ts:55` | 生产链路无调用方；仅测试使用。⚠️ 但 `daily_snapshots` **表**由 `stop()` 的 `upsertDailySnapshot` 写入、被 `morningBaselineStart()` 读取（R17 跨天连续的关键）——**方法无调用方 ≠ 表无用途** |
| `TaskCenter.overdueCount()` | `task/center.ts:133` | **无调用方**。pulse 的 `guilty` 信号由 `extractPulseSignals()` 自行从事件流计算 `overdueTasks`，未经此方法 |
| `PetRenderer.clearPreview()` | `renderer/pet.ts:222` | 无调用方。`app.ts:hideSlide()` 改用 `applyEmotion(state.emotion)` 恢复 |
| ~~`PetRenderer.applyOverlay()`~~ | `renderer/pet.ts:226` | ✅ **已有调用方**：`app.ts:1175` `pet.applyOverlay(s.emotion.overlay)`（v1.3 更正） |
| `PetRenderer.injure()` | `renderer/pet.ts:262` | 🔴 **无调用方，且已裁决永久除名**（不是"未来扩展预留"）。见 §5.1 末行与 DESIGN.md §5.4 / TASKS.md T12 |
| `TASK_ABS_MAX` / `RECOVERY_ABS_MAX` | `task/center.ts:26`、`recovery/deck.ts:26` | 均 = 5，无调用方。实际 `PendingSlide.absMax` 直接取 `ENERGY_MAX` |
| `resolveTailPose()` / `resolveEarPose()` | `renderer/pet.ts:101`、`:124` | ✅ **不是死代码**：被 `drawTail()`/`render()` 调用，且由 `tests/pose.test.ts` 直测（导出是为了可测性） |

> 这些多为测试可达性或未来扩展预留。列出是为了避免后续对话误以为它们在主链路上。
> ⚠️ **例外**：`injure()` 已裁决删除，不要把它当"预留 API"接线。

## 5.3 有意的重复定义（非缺陷，勿"修复"）

- `HotRect` 在 `core/hittest.ts:11`（`export interface`）与 `renderer/app.ts:191`（`type` 字面量）**各定义一份**。
  渲染层未 import 主进程模块，属**进程隔离的有意设计**；`preload` 的 `hitRects()` 也用内联结构类型。
- `clamp(v)` 在 `main/coordinator.ts:649` 独立定义，与 `ledger/fold.ts:15` 的 `clampEnergy()` 逻辑相近，
  但下界写死 `0` 而非 `ENERGY_MIN`。
- `isEnergyAffecting()`（`insight/engine.ts:331`）与 `core/events.ts:43` 的 `ENERGY_AFFECTING` 集合
  **重复表达同一规则**——一处是函数，一处是 Set。
  🔴 **潜在维护风险点**：新增精力相关事件类型时**两处都必须改**，否则周报统计漏项。
- ❌ ~~`clampRange(v, lo, hi)` 在 `task/center.ts:28` 与 `recovery/deck.ts:28` 各一份~~
  **v1.3 更正**：现在**只剩 `recovery/deck.ts:28` 一份**（`task/center.ts` 已无此函数），
  不再是重复定义。

## 5.4 孤立死代码 / 已废弃通道（🆕 v1.3 新增，逐条 grep 实测）

与 §5.2 的区别：§5.2 是「导出符号无调用方」（TS 层，多为测试可达性预留）；
本节是**渲染层与协议层的残留物**——重构后旧实现的躯壳还在，容易被误当成活代码去改。

**① 孤立 CSS 规则**（`styles.css` 有规则，`index.html` 的 `class=` 与 `app.ts` 均 0 命中）

| CSS 选择器 | 规则行 | 被谁取代 | 备注 |
|---|---|---|---|
| `.panel-tabs`（含 `button` / `button.active` / `button:not(.active):hover`） | `styles.css:242/247/259/263` | **无取代——tab 系统已整体拆除** | `.panel-tabs` 容器在 index.html **0 命中**；app.ts 无任何 `data-tab`/`data-page` 处理逻辑 |
| `.tab-page.active` | `styles.css:275` | 同上 | 只剩 `index.html:116` 一个**孤立包装 div**（`class="tab-page active" data-page="tasks"`）：无兄弟页、无切换逻辑 ⇒ `active` 恒真，该规则等价于无条件 `display:block` |
| `.rec-grid` | `styles.css:283` | 径向表情菜单 `#recovery-pop` + `.rp-ring` | `id="rec-grid"` 与 `class="rec-grid"` 在 index.html **均 0 命中**（旧存根曾把它列为有效 id，见 §3.17 已剔除注记） |
| `.rec-card`（含 `:hover`/`:active`/`.ico`/`.nm`/`.dt`） | `styles.css:288–307` | `.rp-chip`（`styles.css` 内 10 条规则，活的） | ⚠️ 子选择器 `.ico`/`.nm`/`.dt` 的**类名被 rp-chip 复用**，故不能按类名整体删——只能删 `.rec-card` 前缀的那几条 |
| `.rec-card .hist` | `styles.css:307` | 版本历史弹层 `.version-pop` / `.vrow` | `.hist` 类名在全仓 0 命中 |
| `.report-nums`（含 `.cell`/`b`/`span`） | `styles.css:403–425` | 周报模态 `rm-*` 前缀系列 | 旧存根曾把 `report-nums`/`report-spark`/`report-narrative` 当有效 id 列出 |
| `.spark`（含 `.col`/`i`/`em`） | `styles.css:426–446` | `rm-list` 的 `.tick` + `.val` 手绘条目 | 精力走势图已被文字清单取代（`applyReportModal()` 只写 rmRange/rmList/rmAi/rmDec/rmNote） |

**② 已废弃的 IPC 通道**（调用后静默无操作——最危险的一类，因为不报错）

| 位置 | 内容 | 为何危险 |
|---|---|---|
| `preload/index.ts:83-85` | `recoveryTake(itemId)` 标注 `@deprecated`「已迁至 `recoveryStartAdjust`（事件后调节窗口）；保留仅为兼容旧调用，**主进程恒返回 null**」 | 🔴 调它不报错不抛异常，只是**什么都不发生**；返回的 null 还会被上层误读为「已有调节进行中」并 toast 出错误提示。旧存根正是照它写的 `renderRecoveries` 描述（已更正）。新代码一律用 `recoveryStartAdjust()` |
| `main/index.ts:354` | `ipcMain.on('win:hitTest', () => { /* deprecated: 见 win:hotRects */ })` — 空实现 | 命中来源必须唯一（不变式 10）。**保留空 handler 是刻意的**：防止两套机制打架。⚠️ 勿"顺手补实现" |

**③ `drawPulseAura` 的内联配色表不受类型检查**

`pet.ts:874` 的 `colors` 声明为 `Record<string, string>`（而非 `Record<PulseReaction, string>`），
新增 pulse 类型时漏配色会**静默落到默认灰紫** `rgba(160,160,200,0.4)`——TS 不报错、106 个测试也不覆盖。
建议改法：换成 `Record<PulseReaction, string>` 让编译器兜住（属 T4 范围，见 §6 修改指引）。

**④ 未被引用但仍在渲染的 id**（非死代码，勿删）

机械化差集实测：`index.html` 72 个 id，`app.ts` 的 `$()`/`$<T>()` 强引用 **69 个**，
**0 个缺失**（不存在启动即抛 `missing #id` 的风险）。差集 3 个：

| id | CSS 选择器 | app.ts | 判定 |
|---|---|---|---|
| `dock` | **6 处** | 仅注释提及 | ✅ 活（CSS 定位/布局容器） |
| `stage` | **2 处** | 仅注释提及 | ✅ 活（`pointer-events:none` 舞台层，见 app.ts:234 注释） |
| `panel-title` | **0 处** | **0 命中** | 🟡 `index.html:109` 的 `<h1>精力控制台</h1>`。会渲染但**无样式规则、无 JS 引用**（继承父级样式）。不是死代码，只是未样式化；删除前须确认视觉无回退 |

> 🟡 **清理门槛**：以上**只登记不删**（T0 不改 src）。②的两条是**有意保留的兼容层**，
> 删除需评估外部调用方与旧 IPC 契约；①③④ 属低风险清理（仅动 `styles.css`/`pet.ts` 类型标注），
> 建议并入 T4（③）/ T13（①的 tab 与 rec-* 系列）顺带整理，或单开一条低优先级技术债任务。
> ⚠️ 删 `.rec-card` 系列时注意 `.ico`/`.nm`/`.dt` 被 `.rp-chip` 复用（见①表末行）。
