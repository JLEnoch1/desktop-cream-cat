/**
 * DecisionLog —— SQLite 事件流存储（append-only）。
 *
 * 使用 Electron 内置 node:sqlite（零原生依赖，完全离线）。
 * schema 预留 predicted_delta / actual_delta，为未来学习铺路。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DomainEvent, EventDraft, EventPayload, EventType } from '../core/events.js';
import { ENERGY_AFFECTING, round2 } from '../core/events.js';
import { foldDraft, foldEvents, INITIAL_ENERGY } from '../ledger/fold.js';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 核心：append-only 事件流（唯一事实源）
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL,
  at              INTEGER NOT NULL,           -- ms 时间戳
  source          TEXT    NOT NULL,           -- user|system|ai|weather|task
  predicted_delta REAL,                       -- 预估变化量（学习用）
  actual_delta    REAL,                       -- 实际变化量（学习用）
  energy_after    REAL,                       -- 事件后精力快照（冗余，审计用）
  payload         TEXT    NOT NULL            -- JSON 结构化负载
);

CREATE INDEX IF NOT EXISTS idx_events_at   ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
-- 偏差分析高频查询：按类型+时间扫描 recovery/task 的 predicted vs actual
CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);

-- 每日收尾快照（session.ended 冗余落表，加速周报）
CREATE TABLE IF NOT EXISTS daily_snapshots (
  date        TEXT PRIMARY KEY,               -- YYYY-MM-DD（本地时区）
  close_energy REAL NOT NULL,
  events_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- 恢复项默认值版本历史
CREATE TABLE IF NOT EXISTS recovery_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT    NOT NULL,
  delta      REAL    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_recver_item ON recovery_versions(item_id, created_at DESC);

-- AI 推荐卡片（含处置状态，避免重复弹出）
CREATE TABLE IF NOT EXISTS recommendations (
  id             TEXT PRIMARY KEY,
  item_id        TEXT    NOT NULL,
  item_name      TEXT    NOT NULL,
  predicted      REAL    NOT NULL,
  actual         REAL    NOT NULL,
  samples        INTEGER NOT NULL,
  message        TEXT    NOT NULL,
  suggested_delta REAL   NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',  -- pending|accepted|modified|rejected
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rec_status ON recommendations(status, created_at DESC);
`;

export interface DecisionLogOptions {
  /** 数据库文件绝对路径 */
  dbPath: string;
}

/**
 * DecisionLog：事件流持久化 + fold 状态维护。
 * 所有写操作走 append()，读操作走 todayEvents()/allEvents()/since()。
 */
export class DecisionLog {
  readonly db: DatabaseSync;
  private readonly dbPath: string;
  /** 内存中维护的当前精力（由 fold 得出，避免每次全量重算） */
  private energyCache: number;

  constructor(opts: DecisionLogOptions) {
    this.dbPath = opts.dbPath;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    this.energyCache = 0;
    this.rebuildEnergy();
  }

  /**
   * 前向兼容迁移：老库的 recovery_versions 无 source 列（周报需区分
   * 「AI 推荐采纳」vs「用户手动调整」的变更来源）。幂等，失败静默（列已存在）。
   */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(recovery_versions)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'source')) {
      try { this.db.exec("ALTER TABLE recovery_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'user'"); } catch { /* already added */ }
    }
  }

  /* ─────────────────────────── 写入 ─────────────────────────── */

  /**
   * 追加一条事件（唯一写入口）。
   * 在事务内计算 energy_after，保证事件流与精力快照一致。
   */
  append(draft: EventDraft): DomainEvent {
    const at = draft.at ?? Date.now();
    const affects = ENERGY_AFFECTING.has(draft.type);
    const before = this.energyCache;
    const after = affects ? foldDraft(before, draft) : before;

    const stmt = this.db.prepare(
      `INSERT INTO events (type, at, source, predicted_delta, actual_delta, energy_after, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const payloadJson = JSON.stringify(draft.payload);
    const info = stmt.run(
      draft.type,
      at,
      draft.source,
      draft.predicted_delta,
      draft.actual_delta,
      affects ? after : null,
      payloadJson,
    );
    const id = Number(info.lastInsertRowid);
    this.energyCache = after;

    // session.ended 同步落每日快照
    if (draft.type === 'session.ended' && draft.payload.kind === 'session.ended') {
      this.upsertDailySnapshot(new Date(at), draft.payload.closeEnergy);
    }
    return {
      id,
      type: draft.type,
      at,
      source: draft.source,
      predicted_delta: draft.predicted_delta,
      actual_delta: draft.actual_delta,
      energy_after: affects ? after : null,
      payload: draft.payload,
    };
  }

  /** 批量追加（事务） */
  appendMany(drafts: EventDraft[]): DomainEvent[] {
    const out: DomainEvent[] = [];
    this.db.exec('BEGIN');
    try {
      for (const d of drafts) out.push(this.append(d));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  /* ─────────────────────────── 读取 ─────────────────────────── */

  /** 当前精力（fold 结果） */
  currentEnergy(): number {
    return this.energyCache;
  }

  /** meta 键值读（IP 定位缓存、周报弹窗防重复等跨重启小状态） */
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** meta 键值写（UPSERT） */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** 指定日期的事件（本地时区，YYYY-MM-DD） */
  todayEvents(dateStr = localDateStr(new Date())): DomainEvent[] {
    const [start, end] = dayRangeMs(dateStr);
    return this.queryRange(start, end);
  }

  /** 全部事件（调试/导出用） */
  allEvents(): DomainEvent[] {
    return this.queryRange(0, Number.MAX_SAFE_INTEGER);
  }

  /** 增量事件（id > sinceId），用于渲染进程增量同步 */
  since(sinceId: number): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC').all(sinceId) as unknown as Row[];
    return rows.map(rowToEvent);
  }

  /** 按类型查询（InsightEngine 偏差分析用） */
  byType(type: EventType, limit = 1000): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?').all(type, limit) as unknown as Row[];
    return rows.reverse().map(rowToEvent);
  }

  /** 最大事件 id（增量同步游标） */
  lastEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS m FROM events').get() as unknown as { m: number | null };
    return row?.m ?? 0;
  }

  /** 时间范围内的事件 */
  queryRange(startMs: number, endMs: number): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE at >= ? AND at < ? ORDER BY id ASC').all(startMs, endMs) as unknown as Row[];
    return rows.map(rowToEvent);
  }

  /* ─────────────────────────── 恢复项版本历史 ─────────────────────────── */

  addRecoveryVersion(itemId: string, delta: number, reason: string, source: string = 'user'): void {
    this.db.prepare('INSERT INTO recovery_versions (item_id, delta, reason, created_at, source) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, round2(delta), reason, Date.now(), source);
  }

  recoveryVersions(itemId: string, limit = 20): RecoveryVersionRow[] {
    // 同毫秒时间戳时用 id DESC 打破平局，否则顺序不确定会返回错的「最新版本」
    return this.db.prepare('SELECT * FROM recovery_versions WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(itemId, limit) as unknown as RecoveryVersionRow[];
  }

  /**
   * 近期「默认值变更决策」历史（周报用，新→旧）：只取非初始版本，
   * 即用户/AI 实际做过的调整决策。source 标注决策来源。
   */
  recentRecoveryDecisions(sinceMs: number, limit = 30): RecoveryVersionRow[] {
    return this.db.prepare(
      "SELECT * FROM recovery_versions WHERE created_at >= ? AND reason != '初始默认值' ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(sinceMs, limit) as unknown as RecoveryVersionRow[];
  }

  /** 每个恢复项的最新版本 delta */
  latestRecoveryDeltas(): Map<string, number> {
    const rows = this.db.prepare(
      `SELECT item_id, delta FROM recovery_versions rv
       WHERE created_at = (SELECT MAX(created_at) FROM recovery_versions WHERE item_id = rv.item_id)`,
    ).all() as unknown as { item_id: string; delta: number }[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.item_id, r.delta);
    return m;
  }

  /* ─────────────────────────── 推荐卡片 ─────────────────────────── */

  insertRecommendation(rec: {
    id: string; itemId: string; itemName: string; predicted: number; actual: number;
    samples: number; message: string; suggestedDelta: number;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO recommendations
       (id, item_id, item_name, predicted, actual, samples, message, suggested_delta, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(rec.id, rec.itemId, rec.itemName, rec.predicted, rec.actual, rec.samples, rec.message, rec.suggestedDelta, Date.now());
  }

  resolveRecommendation(id: string, status: 'accepted' | 'modified' | 'rejected'): void {
    this.db.prepare(`UPDATE recommendations SET status = ?, resolved_at = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  pendingRecommendations(): RecommendationRow[] {
    return this.db.prepare(`SELECT * FROM recommendations WHERE status = 'pending' ORDER BY created_at ASC`).all() as unknown as RecommendationRow[];
  }

  /** 某恢复项是否已有未处置推荐（防重复弹出） */
  hasPendingRecommendationFor(itemId: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM recommendations WHERE item_id = ? AND status = 'pending'`).get(itemId) as unknown as { c: number };
    return (row?.c ?? 0) > 0;
  }

  /* ─────────────────────────── 每日快照 ─────────────────────────── */

  upsertDailySnapshot(date: Date, closeEnergy: number): void {
    const ds = localDateStr(date);
    const count = this.todayEvents(ds).length;
    this.db.prepare(
      `INSERT INTO daily_snapshots (date, close_energy, events_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET close_energy = excluded.close_energy,
         events_count = excluded.events_count, updated_at = excluded.updated_at`,
    ).run(ds, round2(closeEnergy), count, Date.now());
  }

  dailySnapshots(fromDate: string, toDate: string): DailySnapshotRow[] {
    return this.db.prepare('SELECT * FROM daily_snapshots WHERE date >= ? AND date <= ? ORDER BY date ASC')
      .all(fromDate, toDate) as unknown as DailySnapshotRow[];
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  /** 启动时全量重放事件流，重建精力（事实源校验） */
  private rebuildEnergy(): void {
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE type IN ('energy.set','energy.delta','task.completed','task.dropped','recovery.taken') ORDER BY id ASC`,
    ).all() as unknown as Row[];
    const events = rows.map(rowToEvent);
    this.energyCache = foldEvents(events, INITIAL_ENERGY);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

/* ─────────────────────────── 行类型与工具 ─────────────────────────── */

interface Row {
  id: number; type: string; at: number; source: string;
  predicted_delta: number | null; actual_delta: number | null;
  energy_after: number | null; payload: string;
}

export interface RecoveryVersionRow { id: number; item_id: string; delta: number; reason: string; created_at: number; source: string }
export interface DailySnapshotRow { date: string; close_energy: number; events_count: number; updated_at: number }
export interface RecommendationRow {
  id: string; item_id: string; item_name: string; predicted: number; actual: number;
  samples: number; message: string; suggested_delta: number; status: string;
  created_at: number; resolved_at: number | null;
}

function rowToEvent(r: Row): DomainEvent {
  let payload: EventPayload;
  try {
    payload = JSON.parse(r.payload) as EventPayload;
  } catch {
    payload = { kind: 'note.added', text: '[corrupted payload]' };
  }
  return {
    id: r.id,
    type: r.type as EventType,
    at: r.at,
    source: r.source as DomainEvent['source'],
    predicted_delta: r.predicted_delta,
    actual_delta: r.actual_delta,
    energy_after: r.energy_after,
    payload,
  };
}

/** 本地时区 YYYY-MM-DD */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 某本地日期的 [start, end) 毫秒区间 */
export function dayRangeMs(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return [start, end];
}
