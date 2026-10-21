/**
 * InsightEngine —— 洞察引擎（只读事件流，离线批处理）。
 *
 * 职责：
 *  - weeklyReport()：周报（均值/极值/日曲线/最耗时段/最有效恢复项 + 叙事文案）
 *  - detectRecommendations()：同一恢复项 ≥3 次 actual ≠ predicted（偏差显著）时，
 *    产出 AI 推荐卡片（建议校准 delta），支持接受/修改/拒绝
 *  - 主循环不依赖本模块 —— 仅在空闲/定时/用户打开面板时批处理
 *
 * 原则：只读。唯一的写操作是把推荐卡片登记到 recommendations 表（防重复弹出），
 * 以及用户对推荐的处置（接受→更新恢复项版本历史，由 Coordinator 调 RecoveryDeck 完成）。
 */

import type { DecisionLog } from '../storage/sqlite.js';
import { dayRangeMs, localDateStr } from '../storage/sqlite.js';
import type { DomainEvent } from '../core/events.js';
import { tempId, round2 } from '../core/events.js';
import type { InsightRecommendation, WeeklyReport } from '../core/types.js';
import { foldWithTrace, INITIAL_ENERGY } from '../ledger/fold.js';

/** 偏差判定阈值：|actual - predicted| >= 0.5 视为一次「不匹配」 */
export const DEVIATION_THRESHOLD = 0.5;
/** 触发推荐所需的最少不匹配次数 */
export const DEVIATION_SAMPLES_REQUIRED = 3;

export interface InsightOptions {
  log: DecisionLog;
  now?: () => number;
}

export class InsightEngine {
  private readonly log: DecisionLog;
  private readonly now: () => number;

  constructor(opts: InsightOptions) {
    this.log = opts.log;
    this.now = opts.now ?? (() => Date.now());
  }

  /* ─────────────────────────── 周报 ─────────────────────────── */

  /**
   * 生成周报（默认最近 7 天）。离线批处理：一次扫描事件流，纯计算。
   */
  weeklyReport(endDate = new Date(this.now())): WeeklyReport {
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1); // exclusive
    const start = new Date(end);
    start.setDate(start.getDate() - 7);

    const weekStart = start.getTime();
    const weekEnd = end.getTime();
    const events = this.log.queryRange(weekStart, weekEnd);

    // 开盘精力 = 周起点前的 fold
    const prior = this.log.queryRange(0, weekStart).filter(isEnergyAffecting);
    let cursor = foldWithTrace(prior, INITIAL_ENERGY).energy;

    const daily: { date: string; closeEnergy: number }[] = [];
    const energySamples: number[] = [];
    let tasksCompleted = 0;
    let recoveriesTaken = 0;
    const hourDrain = new Map<number, number>();
    const byItem = new Map<string, { name: string; gains: number[] }>();

    // 按天分组重放
    for (let d = new Date(start); d.getTime() < weekEnd; d.setDate(d.getDate() + 1)) {
      const ds = localDateStr(d);
      const [dStart, dEnd] = dayRangeMs(ds);
      const dayEvents = events.filter(e => e.at >= dStart && e.at < dEnd);
      const { energy, trace } = foldWithTrace(dayEvents, cursor);

      const dayEnergies = [cursor, ...trace.map(t => t.energy)];
      energySamples.push(...dayEnergies);

      for (const ev of dayEvents) {
        if (ev.payload.kind === 'task.completed') {
          tasksCompleted++;
          const delta = ev.actual_delta ?? 0;
          if (delta < 0) {
            const h = new Date(ev.at).getHours();
            hourDrain.set(h, (hourDrain.get(h) ?? 0) + Math.abs(delta));
          }
        }
        if (ev.payload.kind === 'recovery.taken') {
          recoveriesTaken++;
          const gain = ev.actual_delta ?? 0;
          const cur = byItem.get(ev.payload.itemId) ?? { name: ev.payload.itemName, gains: [] };
          cur.gains.push(gain);
          byItem.set(ev.payload.itemId, cur);
        }
      }

      daily.push({ date: ds, closeEnergy: energy });
      cursor = energy;
    }

    const avgEnergy = energySamples.length
      ? round2(energySamples.reduce((s, v) => s + v, 0) / energySamples.length)
      : INITIAL_ENERGY;
    const minEnergy = energySamples.length ? Math.min(...energySamples) : INITIAL_ENERGY;
    const maxEnergy = energySamples.length ? Math.max(...energySamples) : INITIAL_ENERGY;

    let peakDrainHour: number | null = null;
    let peakDrain = 0;
    for (const [h, v] of hourDrain) {
      if (v > peakDrain) { peakDrain = v; peakDrainHour = h; }
    }

    let bestRecovery: { name: string; avgDelta: number } | null = null;
    let bestAvg = -Infinity;
    for (const { name, gains } of byItem.values()) {
      if (!gains.length) continue;
      const avg = gains.reduce((s, v) => s + v, 0) / gains.length;
      if (avg > bestAvg) { bestAvg = avg; bestRecovery = { name, avgDelta: round2(avg) }; }
    }

    const narrative = buildNarrative({
      avgEnergy, minEnergy, maxEnergy, tasksCompleted, recoveriesTaken,
      peakDrainHour, bestRecovery, daily,
    });

    return {
      weekStart, weekEnd,
      avgEnergy, minEnergy: round2(minEnergy), maxEnergy: round2(maxEnergy),
      totalEvents: events.length,
      tasksCompleted, recoveriesTaken,
      daily, peakDrainHour, bestRecovery,
      narrative,
    };
  }

  /* ─────────────────────────── AI 推荐 ─────────────────────────── */

  /**
   * 扫描 recovery.taken 事件：同一恢复项 ≥3 次 |actual-predicted| ≥ 阈值 →
   * 生成推荐卡片（登记到 DB，防重复）。返回新产出的推荐。
   */
  detectRecommendations(): InsightRecommendation[] {
    const taken = this.log.byType('recovery.taken', 2000);
    // 按恢复项聚合偏差样本
    const byItem = new Map<string, { name: string; predicted: number[]; actual: number[]; mismatch: number }>();
    for (const ev of taken) {
      if (ev.payload.kind !== 'recovery.taken') continue;
      const pred = ev.predicted_delta ?? 0;
      const act = ev.actual_delta ?? pred;
      const cur = byItem.get(ev.payload.itemId) ?? { name: ev.payload.itemName, predicted: [], actual: [], mismatch: 0 };
      cur.predicted.push(pred);
      cur.actual.push(act);
      if (Math.abs(act - pred) >= DEVIATION_THRESHOLD) cur.mismatch++;
      byItem.set(ev.payload.itemId, cur);
    }

    const produced: InsightRecommendation[] = [];
    for (const [itemId, agg] of byItem) {
      if (agg.mismatch < DEVIATION_SAMPLES_REQUIRED) continue;
      if (this.log.hasPendingRecommendationFor(itemId)) continue; // 已有未处置推荐，跳过

      const actualAvg = agg.actual.reduce((s, v) => s + v, 0) / agg.actual.length;
      const predictedAvg = agg.predicted.reduce((s, v) => s + v, 0) / agg.predicted.length;
      const suggestedDelta = round2(actualAvg);
      const direction = actualAvg > predictedAvg ? '比预期更能恢复' : '比预期效果差';

      const rec: InsightRecommendation = {
        id: tempId('rec'),
        itemId,
        itemName: agg.name,
        predicted: round2(predictedAvg),
        actual: round2(actualAvg),
        samples: agg.mismatch,
        message: `「${agg.name}」最近 ${agg.mismatch} 次的实际效果${direction}（预估 ${round2(predictedAvg)} → 实际均值 ${round2(actualAvg)}）。要把默认恢复值校准为 ${suggestedDelta} 吗？`,
        suggestedDelta,
        createdAt: this.now(),
      };
      this.log.insertRecommendation({
        id: rec.id, itemId: rec.itemId, itemName: rec.itemName,
        predicted: rec.predicted, actual: rec.actual, samples: rec.samples,
        message: rec.message, suggestedDelta: rec.suggestedDelta,
      });
      produced.push(rec);
    }
    return produced;
  }

  /** 待处置推荐（从 DB 读，渲染用） */
  pendingRecommendations(): InsightRecommendation[] {
    return this.log.pendingRecommendations().map(r => ({
      id: r.id, itemId: r.item_id, itemName: r.item_name,
      predicted: r.predicted, actual: r.actual, samples: r.samples,
      message: r.message, suggestedDelta: r.suggested_delta, createdAt: r.created_at,
    }));
  }

  /** 处置推荐：accepted → 更新默认值；modified → 用新值更新；rejected → 仅记录 */
  resolveRecommendation(recId: string, action: 'accepted' | 'modified' | 'rejected', modifiedDelta?: number): { itemId: string; newDelta: number | null } | null {
    const rows = this.log.pendingRecommendations();
    const row = rows.find(r => r.id === recId);
    if (!row) return null;
    this.log.resolveRecommendation(recId, action);
    if (action === 'accepted') return { itemId: row.item_id, newDelta: row.suggested_delta };
    if (action === 'modified' && typeof modifiedDelta === 'number') return { itemId: row.item_id, newDelta: round2(modifiedDelta) };
    return { itemId: row.item_id, newDelta: null };
  }
}

function isEnergyAffecting(ev: DomainEvent): boolean {
  return ev.type === 'energy.set' || ev.type === 'energy.delta'
    || ev.type === 'task.completed' || ev.type === 'task.dropped'
    || ev.type === 'recovery.taken';
}

/** 叙事文案生成（模板化，离线；未来可替换为 LLM 批处理） */
function buildNarrative(r: {
  avgEnergy: number; minEnergy: number; maxEnergy: number;
  tasksCompleted: number; recoveriesTaken: number;
  peakDrainHour: number | null; bestRecovery: { name: string; avgDelta: number } | null;
  daily: { date: string; closeEnergy: number }[];
}): string[] {
  const out: string[] = [];
  out.push(`本周平均精力 ${r.avgEnergy} 分，波动区间 ${r.minEnergy}–${r.maxEnergy}。`);
  if (r.tasksCompleted > 0) out.push(`完成了 ${r.tasksCompleted} 个任务，进行了 ${r.recoveriesTaken} 次恢复。`);
  else out.push(`本周没有记录任务完成，${r.recoveriesTaken} 次恢复。`);
  if (r.peakDrainHour !== null) out.push(`精力流失最集中的时段是 ${r.peakDrainHour}:00 前后，可以考虑提前安排恢复。`);
  if (r.bestRecovery) out.push(`最有效的恢复方式是「${r.bestRecovery.name}」，平均回升 ${r.bestRecovery.avgDelta} 分。`);
  // 趋势：对比前半周与后半周收尾均值
  if (r.daily.length >= 4) {
    const half = Math.floor(r.daily.length / 2);
    const first = r.daily.slice(0, half);
    const second = r.daily.slice(half);
    const avg = (arr: { closeEnergy: number }[]) => arr.reduce((s, d) => s + d.closeEnergy, 0) / Math.max(1, arr.length);
    const diff = round2(avg(second) - avg(first));
    if (diff >= 0.5) out.push(`整体呈上升趋势，后半周收尾精力比前半周高 ${diff} 分。`);
    else if (diff <= -0.5) out.push(`后半周收尾精力比前半周低 ${Math.abs(diff)} 分，注意别透支。`);
    else out.push('前后半周精力基本持平。');
  }
  return out;
}
