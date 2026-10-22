# `src/recovery/deck.ts` — 恢复项卡片组

> 模块存根（原 STRUCTURE_MAP §3.10）· 层级 **L2** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
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
