# `src/task/center.ts` — 任务管理

> 模块存根（原 STRUCTURE_MAP §3.9）· 层级 **L2** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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
