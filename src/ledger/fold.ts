/**
 * fold —— 精力值的纯函数折叠。
 *
 * 核心不变式：精力值 = fold(events)。
 * 单独成模块是为了让 storage 与 ledger 共享同一份折叠逻辑，且不产生循环依赖。
 */

import type { DomainEvent, EventDraft, EventPayload, EventType } from '../core/events.js';
import { ENERGY_AFFECTING, round2 } from '../core/events.js';
import { ENERGY_MAX, ENERGY_MIN } from '../core/types.js';

/** 初始精力（新用户默认中位偏上，量程 0–10） */
export const INITIAL_ENERGY = 7;

export function clampEnergy(v: number): number {
  if (Number.isNaN(v)) return INITIAL_ENERGY;
  return Math.min(ENERGY_MAX, Math.max(ENERGY_MIN, round2(v)));
}

/**
 * 折叠的原子操作：给定事件前精力 + 事件关键字段，返回事件后精力。
 * storage 写入路径与 ledger 重放路径都调用它，保证「单一折叠语义」。
 */
export function nextEnergy(
  before: number,
  type: EventType,
  actualDelta: number | null,
  payload: EventPayload,
): number {
  if (!ENERGY_AFFECTING.has(type)) return before;
  switch (payload.kind) {
    case 'energy.set':
      return clampEnergy(payload.target);
    case 'energy.delta':
      return clampEnergy(before + (actualDelta ?? payload.delta));
    case 'task.completed':
      return clampEnergy(before + (actualDelta ?? 0));
    case 'task.dropped':
      return before; // 放弃任务不直接扣精力（预估时未扣，故不重复）
    case 'recovery.taken':
      return clampEnergy(before + (actualDelta ?? 0));
    default:
      return before;
  }
}

/** 单事件折叠（DomainEvent 形式，重放路径用） */
export function foldEvent(before: number, ev: DomainEvent): number {
  return nextEnergy(before, ev.type, ev.actual_delta, ev.payload);
}

/** 单草稿折叠（EventDraft 形式，写入路径用） */
export function foldDraft(before: number, draft: EventDraft): number {
  return nextEnergy(before, draft.type, draft.actual_delta, draft.payload);
}

/** 全量折叠：从初始值重放事件流 */
export function foldEvents(evs: DomainEvent[], initial = INITIAL_ENERGY): number {
  let e = initial;
  for (const ev of evs) e = foldEvent(e, ev);
  return clampEnergy(e);
}

/** 折叠并返回每一步快照（InsightEngine 画日内曲线用） */
export function foldWithTrace(evs: DomainEvent[], initial = INITIAL_ENERGY): { energy: number; trace: { id: number; at: number; energy: number }[] } {
  let e = initial;
  const trace: { id: number; at: number; energy: number }[] = [];
  for (const ev of evs) {
    const next = foldEvent(e, ev);
    if (next !== e) trace.push({ id: ev.id, at: ev.at, energy: next });
    e = next;
  }
  return { energy: clampEnergy(e), trace };
}

export { ENERGY_MIN, ENERGY_MAX };
