# `src/storage/sqlite.ts` — 事件流持久化

> 模块存根（原 STRUCTURE_MAP §3.6）· 层级 **L1** · 测试：tests/core.test.ts
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：append-only 事件流的唯一写入口 + fold 状态维护。
 * 基于 Electron 内置 node:sqlite（零原生依赖，完全离线）。
 * schema 版本 SCHEMA_VERSION = 1。
 */

export interface DecisionLogOptions { dbPath: string }   // 数据库文件绝对路径

export class DecisionLog {
  readonly db: DatabaseSync;                 // 公开以便测试直接查库
  constructor(opts: DecisionLogOptions);
    // ⟨自动建目录 → exec(SCHEMA_SQL) → 写 meta.schema_version → rebuildEnergy()⟩

  /* ── 写入 ── */
  append(draft: EventDraft): DomainEvent;
    // ⟨唯一写入口。at 缺省取 Date.now()；ENERGY_AFFECTING 类型才算 energy_after；
    //   返回落库后的完整事件；session.ended 额外触发 upsertDailySnapshot⟩
  appendMany(drafts: EventDraft[]): DomainEvent[];
    // ⟨BEGIN/COMMIT 事务包裹，异常 ROLLBACK 后抛出⟩

  /* ── 读取 ── */
  currentEnergy(): number;                                   // ⟨内存 energyCache，O(1)⟩
  todayEvents(dateStr?: string): DomainEvent[];              // ⟨本地时区当日，按 id 升序⟩
  allEvents(): DomainEvent[];                                // ⟨全量，调试/导出用⟩
  since(sinceId: number): DomainEvent[];                     // ⟨id > sinceId，增量同步用⟩
  byType(type: EventType, limit?: number): DomainEvent[];    // ⟨默认 1000；DESC 取后 reverse，故返回升序⟩
  lastEventId(): number;                                     // ⟨MAX(id)，无事件返回 0⟩
  queryRange(startMs: number, endMs: number): DomainEvent[]; // ⟨at ∈ [start, end)，id 升序⟩

  /* ── 恢复项版本历史 ── */
  addRecoveryVersion(itemId: string, delta: number, reason: string): void;
  recoveryVersions(itemId: string, limit?: number): RecoveryVersionRow[];
    // ⟨默认 20；ORDER BY created_at DESC, id DESC —— id 用于打破同毫秒平局⟩
  latestRecoveryDeltas(): Map<string, number>;   // ⟨每个恢复项的最新版本 delta⟩

  /* ── 推荐卡片 ── */
  insertRecommendation(rec: {
    id: string; itemId: string; itemName: string; predicted: number;
    actual: number; samples: number; message: string; suggestedDelta: number;
  }): void;                                            // ⟨INSERT OR IGNORE，status='pending'⟩
  resolveRecommendation(id: string, status: 'accepted' | 'modified' | 'rejected'): void;
  pendingRecommendations(): RecommendationRow[];       // ⟨status='pending'，created_at 升序⟩
  hasPendingRecommendationFor(itemId: string): boolean; // ⟨防重复弹出⟩

  /* ── 每日快照 ── */
  upsertDailySnapshot(date: Date, closeEnergy: number): void;  // ⟨ON CONFLICT(date) DO UPDATE⟩
  dailySnapshots(fromDate: string, toDate: string): DailySnapshotRow[];

  close(): void;   // ⟨幂等，已关闭不抛错⟩

  private dbPath: string;
  private energyCache: number;
  private rebuildEnergy(): void;   // ⟨启动全量重放 5 类精力事件，事实源校验⟩
}

/* ── 行类型（DB 原始形态，snake_case）── */
export interface RecoveryVersionRow { id: number; item_id: string; delta: number; reason: string; created_at: number }
export interface DailySnapshotRow { date: string; close_energy: number; events_count: number; updated_at: number }
export interface RecommendationRow {
  id: string; item_id: string; item_name: string; predicted: number; actual: number;
  samples: number; message: string; suggested_delta: number; status: string;
  created_at: number; resolved_at: number | null;
}

/* ── 时区工具（模块级导出，被 ledger/insight 共用）── */
export function localDateStr(d: Date): string;              // ⟨本地时区 YYYY-MM-DD⟩
export function dayRangeMs(dateStr: string): [number, number]; // ⟨该本地日期的 [start, end) ms 区间⟩

// 内部：interface Row（DB 行）与 rowToEvent(r: Row): DomainEvent
//   payload JSON 解析失败时降级为 { kind:'note.added', text:'[corrupted payload]' }
```

**数据表（5 张）**：`meta`(key,value) · `events`(唯一事实源) · `daily_snapshots`(date 主键) ·
`recovery_versions` · `recommendations`。索引：`idx_events_at`、`idx_events_type`、
`idx_events_type_at`（偏差分析高频查询）、`idx_recver_item`、`idx_rec_status`。
PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`。
