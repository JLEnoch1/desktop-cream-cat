# `src/ledger/fold.ts` — 精力折叠纯函数

> 模块存根（原 STRUCTURE_MAP §3.5）· 层级 **L1** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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
