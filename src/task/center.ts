/**
 * TaskCenter —— 任务管理。
 *
 * 职责：
 *  - 任务的创建/完成/放弃，全部以事件形式落入 DecisionLog
 *  - complete(taskId) 不直接扣精力，而是触发「3 分钟滑动确认」卡片，
 *    由用户滑动决定 actual_delta，confirm 时才写入 task.completed 事件
 *
 * 任务状态由事件流 fold 得出（open → done/dropped），不单独存表。
 */

import type { DecisionLog } from '../storage/sqlite.js';
import type { DomainEvent, EventDraft } from '../core/events.js';
import { taskCompletedDraft, taskCreatedDraft, taskDroppedDraft, tempId, TASK_COMPLETE_PREDICTED } from '../core/events.js';
import type { PendingSlide, Task } from '../core/types.js';
import { ENERGY_MAX } from '../core/types.js';
import { round2 } from '../core/events.js';

/**
 * 事件参考范围（量程 0–10）保留常量供兼容引用。
 * 任务完成的 predicted 已固定为 +4（TASK_COMPLETE_PREDICTED，需求 3：完成 = 回血），
 * 用户仍可在调节窗口覆盖全量程 —— 「用户当下的真实精力」才是事实。
 */
export const TASK_SLIDE_MIN = -5;
export const TASK_SLIDE_MAX = 2;
export const TASK_ABS_MAX = 5;

export class TaskCenter {
  constructor(private readonly log: DecisionLog) {}

  /**
   * 从事件流重建任务列表（fold）。
   *
   * 兼容旧数据：早期 task.created 的 payload 里没有 estMinutes，
   * 归一化为 0（UI 显示「未设定」），不能让它变成 undefined 参与运算。
   */
  list(): Task[] {
    const map = new Map<string, Task>();
    for (const ev of this.log.allEvents()) {
      const p = ev.payload;
      if (p.kind === 'task.created') {
        const raw = p.task as Partial<Task>;
        map.set(p.task.id, {
          ...p.task,
          estMinutes: typeof raw.estMinutes === 'number' && Number.isFinite(raw.estMinutes) ? raw.estMinutes : 0,
          actualMinutes: typeof raw.actualMinutes === 'number' ? raw.actualMinutes : null,
        });
      } else if (p.kind === 'task.completed') {
        const t = map.get(p.taskId);
        if (t) {
          t.status = 'done';
          t.actualMinutes = typeof p.actualMinutes === 'number' && Number.isFinite(p.actualMinutes)
            ? p.actualMinutes
            : null;
        }
      } else if (p.kind === 'task.dropped') {
        const t = map.get(p.taskId);
        if (t) { t.status = 'dropped'; }
      }
    }
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 未完成任务 */
  open(): Task[] {
    return this.list().filter(t => t.status === 'open');
  }

  get(taskId: string): Task | undefined {
    return this.list().find(t => t.id === taskId);
  }

  /** 创建任务（写事件） */
  create(title: string, estCost: number, dueAt: number | null = null, estMinutes = 0): Task {
    const task: Task = {
      id: tempId('task'),
      title: title.trim() || '未命名任务',
      estCost: Math.max(0, round2(estCost)),
      estMinutes: Math.max(0, round2(estMinutes)),
      status: 'open',
      createdAt: Date.now(),
      dueAt,
      actualMinutes: null,
    };
    this.log.append(taskCreatedDraft(task));
    return task;
  }

  /**
   * 完成任务 —— 不直接写 task.completed，而是打开事件后调节窗口。
   * 新模型：滑块滑的是「事件后的真实精力」（绝对值 0–ENERGY_MAX），
   * predicted 固定 +4（完成事件默认恢复，需求 3），confirm 时 actual = 目标 - baseEnergy。
   */
  requestComplete(taskId: string, baseEnergy: number): PendingSlide | null {
    const task = this.get(taskId);
    if (!task || task.status !== 'open') return null;
    return {
      kind: 'task-complete',
      refId: task.id,
      title: '完成任务',
      subtitle: task.title,
      predicted: TASK_COMPLETE_PREDICTED,
      min: 0,
      max: ENERGY_MAX,
      absMax: ENERGY_MAX,
      baseEnergy: round2(baseEnergy),
      createdAt: Date.now(),
    };
  }

  /**
   * 滑动确认后写入 task.completed。
   * @param actualMinutes 用户确认的实际时长（分钟），null 表示未记录
   */
  confirmComplete(taskId: string, actualDelta: number, note?: string, actualMinutes?: number | null): DomainEvent | null {
    const task = this.get(taskId);
    if (!task || task.status !== 'open') return null;
    const mins = typeof actualMinutes === 'number' && Number.isFinite(actualMinutes)
      ? Math.max(0, round2(actualMinutes))
      : null;
    const draft: EventDraft = taskCompletedDraft(task, round2(actualDelta), note, mins);
    return this.log.append(draft);
  }

  /** 放弃任务（不扣精力，仅标记状态） */
  drop(taskId: string, note?: string): DomainEvent | null {
    const task = this.get(taskId);
    if (!task || task.status !== 'open') return null;
    return this.log.append(taskDroppedDraft(task, note));
  }

  /** 超时未完成任务数（pulse「guilty」信号用） */
  overdueCount(now = Date.now()): number {
    return this.open().filter(t => t.dueAt !== null && t.dueAt < now).length;
  }
}
