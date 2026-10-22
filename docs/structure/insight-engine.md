# `src/insight/engine.ts` — 洞察引擎

> 模块存根（原 STRUCTURE_MAP §3.12）· 层级 **L2** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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
