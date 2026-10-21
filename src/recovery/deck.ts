/**
 * RecoveryDeck —— 恢复项卡片组。
 *
 * 职责：
 *  - 维护恢复项清单（午睡/冥想/下午茶/发呆/打球/健身）
 *  - 每个恢复项的「当前预估 delta」来自版本历史最新一条（可被 AI 推荐更新）
 *  - take(itemId) 触发滑动确认；confirm 时写 recovery.taken，
 *    事件同时记录 predicted_delta（卡片默认值）与 actual_delta（用户确认值），
 *    为 InsightEngine 的偏差学习提供数据
 */

import type { DecisionLog } from '../storage/sqlite.js';
import type { DomainEvent, EventDraft } from '../core/events.js';
import { recoveryItemUpdatedDraft, recoveryTakenDraft } from '../core/events.js';
import type { PendingSlide, RecoveryItem, RecoveryVersion } from '../core/types.js';
import { ENERGY_MAX } from '../core/types.js';
import { round2 } from '../core/events.js';

/**
 * 事件参考范围（量程 0–10）：恢复最多 -2（恢复也可能不适）～ +5。
 * 仅用于约束 predicted（参考值）—— 用户滑动可覆盖全量程，
 * 因为「用户当下的真实精力」才是事实，事件效果只是参考。
 */
export const RECOVERY_SLIDE_MIN = -2;
export const RECOVERY_SLIDE_MAX = 5;
export const RECOVERY_ABS_MAX = 5;

function clampRange(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, round2(v)));
}

/** 默认恢复项（首次启动种子；量程 0–10）—— 6 个常见精力恢复方式 */
export const DEFAULT_ITEMS: Omit<RecoveryItem, 'currentDelta'>[] = [
  { id: 'rec_nap',      name: '午睡',   icon: '😴', defaultDelta: 1.5, minutes: 20 },
  { id: 'rec_meditate', name: '冥想',   icon: '🧘', defaultDelta: 1.2, minutes: 10 },
  { id: 'rec_tea',      name: '下午茶', icon: '🍵', defaultDelta: 1.0, minutes: 15 },
  { id: 'rec_zoneout',  name: '发呆',   icon: '😶', defaultDelta: 0.6, minutes: 5 },
  { id: 'rec_ball',     name: '打球',   icon: '🏀', defaultDelta: 2.0, minutes: 30 },
  { id: 'rec_gym',      name: '健身',   icon: '💪', defaultDelta: 2.5, minutes: 45 },
];

export class RecoveryDeck {
  constructor(private readonly log: DecisionLog) {}

  /** 恢复项列表（currentDelta 取版本历史最新值，无版本则用 defaultDelta） */
  list(): RecoveryItem[] {
    const latest = this.log.latestRecoveryDeltas();
    return DEFAULT_ITEMS.map(d => ({
      ...d,
      currentDelta: latest.has(d.id) ? latest.get(d.id)! : d.defaultDelta,
    }));
  }

  get(itemId: string): RecoveryItem | undefined {
    return this.list().find(i => i.id === itemId);
  }

  /** 首次启动：为每个默认项写入初始版本（保证版本历史完整可追溯） */
  seedIfEmpty(): void {
    const existing = new Set<string>();
    for (const ev of this.log.allEvents()) {
      if (ev.payload.kind === 'recovery.item.updated') existing.add(ev.payload.item.id);
    }
    const drafts: EventDraft[] = [];
    for (const d of DEFAULT_ITEMS) {
      if (existing.has(d.id)) continue;
      const item: RecoveryItem = { ...d, currentDelta: d.defaultDelta };
      drafts.push(recoveryItemUpdatedDraft(item, 0, d.defaultDelta, '初始默认值', 'system'));
      this.log.addRecoveryVersion(d.id, d.defaultDelta, '初始默认值', 'system');
    }
    if (drafts.length) this.log.appendMany(drafts);
  }

  /** 版本历史（新→旧） */
  versions(itemId: string, limit = 20): RecoveryVersion[] {
    return this.log.recoveryVersions(itemId, limit).map(r => ({
      id: r.id,
      itemId: r.item_id,
      delta: r.delta,
      reason: r.reason,
      createdAt: r.created_at,
      source: r.source,
    }));
  }

  /** 更新恢复项默认值（新版本入历史） */
  updateDelta(itemId: string, newDelta: number, reason: string, source: EventDraft['source'] = 'user'): RecoveryItem | null {
    const item = this.get(itemId);
    if (!item) return null;
    const delta = round2(newDelta);
    if (delta === item.currentDelta) return item;
    const updated: RecoveryItem = { ...item, currentDelta: delta };
    this.log.append(recoveryItemUpdatedDraft(updated, item.currentDelta, delta, reason, source));
    this.log.addRecoveryVersion(itemId, delta, reason, source);
    return updated;
  }

  /**
   * 执行恢复 —— 返回滑动确认卡片。
   * 新模型：滑块滑的是「恢复后的真实精力」（绝对值 0–ENERGY_MAX），
   * predicted(currentDelta) 只作默认位置参考；confirm 时 actual = 目标 - baseEnergy，
   * predicted_delta 仍记录卡片默认值，为 InsightEngine 的偏差学习提供数据。
   */
  requestTake(itemId: string, baseEnergy: number): PendingSlide | null {
    const item = this.get(itemId);
    if (!item) return null;
    return {
      kind: 'recovery',
      refId: item.id,
      title: '恢复一下',
      subtitle: `${item.icon} ${item.name} · 约 ${item.minutes} 分钟`,
      predicted: clampRange(item.currentDelta, RECOVERY_SLIDE_MIN, RECOVERY_SLIDE_MAX),
      min: 0,
      max: ENERGY_MAX,
      absMax: ENERGY_MAX,
      baseEnergy: round2(baseEnergy),
      createdAt: Date.now(),
    };
  }

  /** 滑动确认：写 recovery.taken，predicted=卡片默认值，actual=用户确认值 */
  confirmTake(itemId: string, actualDelta: number, note?: string): DomainEvent | null {
    const item = this.get(itemId);
    if (!item) return null;
    return this.log.append(recoveryTakenDraft(item, round2(actualDelta), note));
  }
}
