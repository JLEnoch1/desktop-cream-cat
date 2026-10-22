# `src/core/events.ts` — 事件契约与工厂

> 模块存根（原 STRUCTURE_MAP §3.2）· 层级 **L0** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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

export const EVENT_TYPES: readonly EventType[];              // ⚠️ 已定义但全项目无消费者，见 [问题清单](known-issues.md)
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
export function noteDraft(text: string): EventDraft;                          // ⚠️ 无调用方，见 [问题清单](known-issues.md)

export function recShownDraft(recId: string, itemId: string): EventDraft;      // 以下四个 source='ai'
export function recAcceptedDraft(recId: string, itemId: string, newDelta: number): EventDraft;
export function recModifiedDraft(recId: string, itemId: string, newDelta: number): EventDraft;
export function recRejectedDraft(recId: string, itemId: string): EventDraft;

export function round2(n: number): number;   // ⟨四舍五入到两位小数；全项目精度统一出口⟩
```
