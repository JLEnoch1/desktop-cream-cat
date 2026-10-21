/**
 * 事件契约 —— append-only 事件流的唯一事实源定义。
 *
 * 设计原则：
 *  1. 事件不可变，只追加不修改；精力值 = fold(events)
 *  2. predicted_delta / actual_delta 为未来学习预留（InsightEngine 比对偏差）
 *  3. 每个事件都带 source，便于追溯是用户手动、系统自动还是 AI 推荐产生
 */

import type { RecoveryItem, Task, WeatherState } from './types.js';

export type EventSource = 'user' | 'system' | 'ai' | 'weather' | 'task';

/** 事件类型联合 —— 新增类型必须同时在 EVENT_TYPES 与 reducer 中登记 */
export type EventType =
  | 'energy.set'            // 晨间基线 / 手动校准：直接设定精力值
  | 'energy.delta'          // 通用增减（滑动确认写入）
  | 'task.created'
  | 'task.completed'        // 触发滑动确认，actual_delta 由用户确认
  | 'task.dropped'
  | 'recovery.taken'        // 恢复项执行，predicted/actual 均记录
  | 'recovery.item.updated' // 恢复项默认值版本变更
  | 'weather.observed'      // 天气快照（不进精力 fold，仅供情绪 overlay）
  | 'recommendation.shown'
  | 'recommendation.accepted'
  | 'recommendation.modified'
  | 'recommendation.rejected'
  | 'session.started'       // 开机
  | 'session.ended'         // 收尾（记录当日收尾精力）
  | 'note.added';           // 纯备注，不影响精力

export const EVENT_TYPES: readonly EventType[] = [
  'energy.set', 'energy.delta',
  'task.created', 'task.completed', 'task.dropped',
  'recovery.taken', 'recovery.item.updated',
  'weather.observed',
  'recommendation.shown', 'recommendation.accepted',
  'recommendation.modified', 'recommendation.rejected',
  'session.started', 'session.ended', 'note.added',
] as const;

/** 哪些事件参与精力 fold（weather/note/recommendation 不参与） */
export const ENERGY_AFFECTING: ReadonlySet<EventType> = new Set<EventType>([
  'energy.set', 'energy.delta', 'task.completed', 'task.dropped', 'recovery.taken',
]);

export interface DomainEvent {
  /** 自增主键，事件流顺序保证 */
  id: number;
  type: EventType;
  /** 发生时间戳（ms） */
  at: number;
  source: EventSource;
  /**
   * 预估变化量 —— 系统/推荐/AI 认为会变化多少。
   * 对 task.completed 为任务 estCost 取负；对 recovery.taken 为恢复项 currentDelta。
   */
  predicted_delta: number | null;
  /**
   * 实际变化量 —— 用户滑动确认后写入的真实值。
   * energy.set 时为 (target - before)；其余为确认 delta。
   */
  actual_delta: number | null;
  /** 事件后精力快照（fold 结果，冗余存储便于快速读取与审计） */
  energy_after: number | null;
  /** 结构化负载 */
  payload: EventPayload;
}

/** 负载联合 —— 按 type 区分 */
export type EventPayload =
  | { kind: 'energy.set'; before: number; target: number; reason?: string }
  | { kind: 'energy.delta'; delta: number; note?: string; refType?: string; refId?: string }
  | { kind: 'task.created'; task: Task }
  | { kind: 'task.completed'; taskId: string; title: string; estCost: number; actualMinutes?: number | null; note?: string }
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

/** 写入用的事件草稿（id/at/energy_after 由存储层填充） */
export type EventDraft = Omit<DomainEvent, 'id' | 'at' | 'energy_after'> & {
  at?: number;
};

/* ─────────────────────────── 工厂函数 ─────────────────────────── */

let seq = 0;
/** 进程内唯一 id（用于推荐卡等临时对象，非事件主键） */
export function tempId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function energySetDraft(target: number, before: number, reason?: string): EventDraft {
  return {
    type: 'energy.set',
    source: 'user',
    predicted_delta: null,
    actual_delta: round2(target - before),
    payload: { kind: 'energy.set', before, target, reason },
  };
}

export function energyDeltaDraft(delta: number, opts: { note?: string; refType?: string; refId?: string; source?: EventSource } = {}): EventDraft {
  return {
    type: 'energy.delta',
    source: opts.source ?? 'user',
    predicted_delta: null,
    actual_delta: round2(delta),
    payload: { kind: 'energy.delta', delta: round2(delta), note: opts.note, refType: opts.refType, refId: opts.refId },
  };
}

export function taskCreatedDraft(task: Task): EventDraft {
  return { type: 'task.created', source: 'task', predicted_delta: null, actual_delta: null, payload: { kind: 'task.created', task } };
}

/**
 * @param actualMinutes 用户确认的实际时长（分钟）。可选，保持与旧调用签名兼容。
 */
/**
 * 任务完成的默认精力恢复（需求 3）：完成一个事件 = 成就感回血，固定 +4。
 * 旧的「-estCost 消耗」语义已反转；estCost 仅作面板参考信息保留。
 */
export const TASK_COMPLETE_PREDICTED = 4;

export function taskCompletedDraft(task: Task, actualDelta: number, note?: string, actualMinutes?: number | null): EventDraft {
  return {
    type: 'task.completed',
    source: 'user',
    predicted_delta: TASK_COMPLETE_PREDICTED,
    actual_delta: round2(actualDelta),
    payload: {
      kind: 'task.completed',
      taskId: task.id,
      title: task.title,
      estCost: task.estCost,
      actualMinutes: actualMinutes ?? null,
      note,
    },
  };
}

export function taskDroppedDraft(task: Task, note?: string): EventDraft {
  return {
    type: 'task.dropped',
    source: 'user',
    predicted_delta: null,
    actual_delta: null,
    payload: { kind: 'task.dropped', taskId: task.id, title: task.title, note },
  };
}

export function recoveryTakenDraft(item: RecoveryItem, actualDelta: number, note?: string): EventDraft {
  return {
    type: 'recovery.taken',
    source: 'user',
    predicted_delta: round2(item.currentDelta),
    actual_delta: round2(actualDelta),
    payload: { kind: 'recovery.taken', itemId: item.id, itemName: item.name, minutes: item.minutes, note },
  };
}

export function recoveryItemUpdatedDraft(item: RecoveryItem, previousDelta: number, newDelta: number, reason: string, source: EventSource = 'user'): EventDraft {
  return {
    type: 'recovery.item.updated',
    source,
    predicted_delta: null,
    actual_delta: null,
    payload: { kind: 'recovery.item.updated', item, previousDelta, newDelta, reason },
  };
}

export function weatherObservedDraft(weather: WeatherState): EventDraft {
  return { type: 'weather.observed', source: 'weather', predicted_delta: null, actual_delta: null, payload: { kind: 'weather.observed', weather } };
}

export function sessionStartedDraft(): EventDraft {
  return { type: 'session.started', source: 'system', predicted_delta: null, actual_delta: null, payload: { kind: 'session.started', at: Date.now() } };
}

export function sessionEndedDraft(closeEnergy: number): EventDraft {
  return { type: 'session.ended', source: 'system', predicted_delta: null, actual_delta: null, payload: { kind: 'session.ended', closeEnergy } };
}

export function noteDraft(text: string): EventDraft {
  return { type: 'note.added', source: 'user', predicted_delta: null, actual_delta: null, payload: { kind: 'note.added', text } };
}

export function recShownDraft(recId: string, itemId: string): EventDraft {
  return { type: 'recommendation.shown', source: 'ai', predicted_delta: null, actual_delta: null, payload: { kind: 'recommendation.shown', recommendationId: recId, itemId } };
}
export function recAcceptedDraft(recId: string, itemId: string, newDelta: number): EventDraft {
  return { type: 'recommendation.accepted', source: 'ai', predicted_delta: null, actual_delta: null, payload: { kind: 'recommendation.accepted', recommendationId: recId, itemId, newDelta } };
}
export function recModifiedDraft(recId: string, itemId: string, newDelta: number): EventDraft {
  return { type: 'recommendation.modified', source: 'ai', predicted_delta: null, actual_delta: null, payload: { kind: 'recommendation.modified', recommendationId: recId, itemId, newDelta } };
}
export function recRejectedDraft(recId: string, itemId: string): EventDraft {
  return { type: 'recommendation.rejected', source: 'ai', predicted_delta: null, actual_delta: null, payload: { kind: 'recommendation.rejected', recommendationId: recId, itemId } };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
