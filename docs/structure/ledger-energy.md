# `src/ledger/energy.ts` — 精力账本

> 模块存根（原 STRUCTURE_MAP §3.7）· 层级 **L2** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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
