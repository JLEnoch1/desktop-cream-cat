/**
 * EnergyLedger —— 精力账本。
 *
 * 职责：
 *  - current()：当前精力（由 fold 维护，O(1) 读取）
 *  - append(draft)：写入事件流并更新精力
 *  - todayEvents()：今日事件（供 UI 展示历史）
 *
 * 不变式：精力值 = fold(events)，本类不维护独立状态，只代理 DecisionLog。
 */

import type { DecisionLog } from '../storage/sqlite.js';
import { dayRangeMs, localDateStr } from '../storage/sqlite.js';
import type { DomainEvent, EventDraft } from '../core/events.js';
import { ENERGY_AFFECTING, energyDeltaDraft, energySetDraft, round2 } from '../core/events.js';
import { clampEnergy, foldEvents, foldWithTrace, INITIAL_ENERGY } from './fold.js';

export interface LedgerSnapshot {
  energy: number;
  /** 今日事件数 */
  todayCount: number;
  /** 今日精力变化总量（收尾 - 开盘） */
  todayDelta: number;
  /** 今日最高 / 最低 */
  todayHigh: number;
  todayLow: number;
  /** 距上次精力变化事件的毫秒数（pulse「长时间无事件」判定用） */
  msSinceLastChange: number;
}

export class EnergyLedger {
  constructor(private readonly log: DecisionLog) {}

  /** 当前精力（fold 结果，O(1)） */
  current(): number {
    return this.log.currentEnergy();
  }

  /** 追加事件，返回落库后的完整事件 */
  append(draft: EventDraft): DomainEvent {
    return this.log.append(draft);
  }

  /** 批量追加（事务） */
  appendMany(drafts: EventDraft[]): DomainEvent[] {
    return this.log.appendMany(drafts);
  }

  /** 今日事件（本地时区） */
  todayEvents(dateStr = localDateStr(new Date())): DomainEvent[] {
    return this.log.todayEvents(dateStr);
  }

  /** 今日精力快照（供 UI 展示） */
  todaySnapshot(dateStr = localDateStr(new Date())): LedgerSnapshot {
    const events = this.todayEvents(dateStr);
    const open = this.startOfDayEnergy(dateStr);
    const { energy, trace } = foldWithTrace(events, open);
    let high = open;
    let low = open;
    for (const t of trace) {
      high = Math.max(high, t.energy);
      low = Math.min(low, t.energy);
    }
    const lastChange = trace.length ? trace[trace.length - 1]! : null;
    return {
      energy,
      todayCount: events.length,
      todayDelta: round2(energy - open),
      todayHigh: high,
      todayLow: low,
      msSinceLastChange: lastChange ? Date.now() - lastChange.at : Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * 某日开盘精力 = 该日之前所有事件 fold 的结果。
   * 优先用 daily_snapshots 前一日快照加速，否则全量重放。
   */
  startOfDayEnergy(dateStr: string): number {
    const prev = this.previousSnapshot(dateStr);
    if (prev !== null) return prev;
    const [startMs] = dayRangeMs(dateStr);
    const prior = this.log.queryRange(0, startMs).filter(e => ENERGY_AFFECTING.has(e.type));
    return foldEvents(prior, INITIAL_ENERGY);
  }

  /** 前一日收尾精力（daily_snapshots），无则 null */
  private previousSnapshot(dateStr: string): number | null {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    const prevStr = localDateStr(d);
    const rows = this.log.dailySnapshots(prevStr, prevStr);
    return rows.length ? clampEnergy(rows[0]!.close_energy) : null;
  }

  /** 昨日收尾精力（晨间基线默认值：开机后展示昨日收尾表情） */
  yesterdayCloseEnergy(): number | null {
    return this.previousSnapshot(localDateStr(new Date()));
  }

  /** 手动校准（晨间基线 / 用户调整） */
  setEnergy(target: number, reason?: string): DomainEvent {
    const before = this.current();
    return this.append(energySetDraft(clampEnergy(target), before, reason));
  }

  /** 通用增减（滑动确认写入） */
  adjust(delta: number, opts: { note?: string; refType?: string; refId?: string; source?: EventDraft['source'] } = {}): DomainEvent {
    return this.append(energyDeltaDraft(delta, opts));
  }

  /** 增量同步游标 */
  lastEventId(): number {
    return this.log.lastEventId();
  }

  /** 自某 id 以来的新事件 */
  since(id: number): DomainEvent[] {
    return this.log.since(id);
  }
}

export { INITIAL_ENERGY };
