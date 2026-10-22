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
import type { EvidenceCounts } from '../storage/sqlite.js';
import { dayRangeMs, localDateStr } from '../storage/sqlite.js';
import type { DomainEvent } from '../core/events.js';
import { tempId, round2 } from '../core/events.js';
import type { InsightRecommendation, WeeklyReport } from '../core/types.js';
import { foldWithTrace, INITIAL_ENERGY } from '../ledger/fold.js';

/** 偏差判定阈值：|actual - predicted| >= 0.5 视为一次「不匹配」 */
export const DEVIATION_THRESHOLD = 0.5;
/** 触发推荐所需的最少不匹配次数 */
export const DEVIATION_SAMPLES_REQUIRED = 3;
/**
 * 证据收集窗口（天）。
 *
 * 为什么要有窗口：旧实现用 byType('recovery.taken', 2000) 全量扫描，
 * 「最近 3 次」可能横跨半年的陈旧数据——用户半年前的习惯不该驱动今天的推荐。
 * 14 天兼顾「够新」与「够样本」（7 天对低频恢复项容易永远凑不满 3 次）。
 */
export const RECOMMEND_WINDOW_DAYS = 14;

export interface InsightOptions {
  log: DecisionLog;
  now?: () => number;
}

/** 单个恢复项在窗口内的聚合中间态 */
interface ItemAggregate {
  name: string;
  /** 有效证据（处置水位线之后 + 窗口之内）的预估值 */
  predicted: number[];
  /** 有效证据的实际值 */
  actual: number[];
  /** 处置水位线（ms）；null = 该项从未被处置过 */
  resolvedAt: number | null;
  /**
   * 证据计数（窗口内全量，**不受水位线影响**）。
   * 这是刻意的：水位线决定「该不该再建议」，证据计数描述「你做过什么」。
   * 两者混为一谈会导致处置后 total 归零，用户反而看不出自己用过几次。
   */
  evidence: EvidenceCounts;
}

function newItemAggregate(name: string, resolvedAt: number | null): ItemAggregate {
  return {
    name,
    predicted: [],
    actual: [],
    resolvedAt,
    evidence: { total: 0, down: 0, up: 0, matched: 0 },
  };
}

/**
 * 证据叙事文案 —— 因果链可见性。
 *
 * 对比：
 *   旧：「午睡最近 3 次的实际效果比预期效果差（预估 1.5 → 实际均值 0.8）」
 *   新：「午睡：近 14 天你用了 4 次，其中 3 次你把效果调低了（预估 1.5 → 你给的均值 0.8）」
 *
 * 差别不在措辞而在**可验证性**：旧文案给的是系统算出来的结论，用户无法回溯；
 * 新文案把「你做了 4 次、3 次调低」这些用户自己经历过的事实摆出来，
 * 用户可以自己核对记忆。预测错一次信任就崩，所以推荐必须自带证据。
 *
 * 语气红线：只陈述用户的动作（「你调低了」），绝不评价（「你总是低估」）。
 * 调低/调高都是中性事实，不含「你做错了」的暗示。
 */
function buildEvidenceMessage(
  name: string,
  evidence: { total: number; down: number; up: number; matched: number },
  predictedAvg: number,
  suggestedDelta: number,
): string {
  const { total, down, up } = evidence;
  // 主导方向：哪个方向的调整次数多，就用哪个方向的叙事
  const dominant = down > up ? '调低' : up > down ? '调高' : '调整';
  const dominantCount = Math.max(down, up);
  const windowLabel = `近 ${RECOMMEND_WINDOW_DAYS} 天`;

  const head = `${name}：${windowLabel}你用了 ${total} 次，其中 ${dominantCount} 次你把效果${dominant}了`;
  const body = `（卡片预估 ${predictedAvg} → 你给的均值 ${suggestedDelta}）`;
  const ask = `要把默认值改成 ${suggestedDelta} 吗？`;
  return `${head}${body}。${ask}`;
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
   * 扫描 recovery.taken 事件 → 生成推荐卡片（登记到 DB，防重复）。
   *
   * 三道闸门，缺一不可：
   *
   * 1. **时间窗**（RECOMMEND_WINDOW_DAYS）：只统计近 14 天的确认记录。
   *    旧实现全量扫描，「最近 3 次」可能横跨半年陈旧数据。
   *
   * 2. **处置水位线**（lastResolvedAt）：用户处置过的恢复项，该时刻之前的
   *    所有证据一律作废，只有**处置之后新发生**的偏差才能重新触发。
   *    三种处置（接受/修改/拒绝）都设水位线，因为历史事件的 predicted_delta
   *    永不变，默认值一改旧证据就统计失效。这是设计红线「拒绝零痕迹」的技术落点
   *    ——否则拒绝后每 10 分钟批处理都会用同一批数据原样重弹（实测复现连续 5 轮）。
   *
   * 3. **pending 去重**：已有未处置卡片时不重复产出。
   *
   * 证据计数（total/down/up/matched）随卡片落库，供周报展示因果链：
   * 「近 14 天你用了 4 次，3 次把效果调低了」比「预估 1.5 → 实际 0.8」可信得多。
   */
  detectRecommendations(): InsightRecommendation[] {
    const now = this.now();
    const windowStart = now - RECOMMEND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    // queryRange 是半开区间 [start, end)，上界必须 > now 才能纳入「此刻」的事件
    // （同毫秒写入的确认记录 at === now，传 now 会被静默漏掉）
    const taken = this.log.queryRange(windowStart, now + 1).filter(ev => ev.type === 'recovery.taken');

    // 按恢复项聚合：证据计数 + 偏差样本
    const byItem = new Map<string, ItemAggregate>();
    for (const ev of taken) {
      if (ev.payload.kind !== 'recovery.taken') continue;
      const itemId = ev.payload.itemId;
      // resolvedAt 水位线：懒加载一次（同 item 多条事件复用）
      const cur = byItem.get(itemId)
        ?? newItemAggregate(ev.payload.itemName, this.log.lastResolvedAt(itemId));

      const pred = ev.predicted_delta ?? 0;
      const act = ev.actual_delta ?? pred;
      const diff = round2(act - pred);

      cur.evidence.total++;
      if (Math.abs(diff) >= DEVIATION_THRESHOLD) {
        // 方向分组：调低 = 实际效果不如预估，调高 = 比预估更能恢复
        if (diff < 0) cur.evidence.down++;
        else cur.evidence.up++;
        // 处置水位线之后的样本才计入「有效证据」。
        // resolvedAt === null 表示该项从未被处置，全部样本有效。
        if (cur.resolvedAt === null || ev.at > cur.resolvedAt) {
          cur.predicted.push(pred);
          cur.actual.push(act);
        }
      } else {
        cur.evidence.matched++;
      }
      byItem.set(itemId, cur);
    }

    const produced: InsightRecommendation[] = [];
    for (const [itemId, agg] of byItem) {
      const mismatch = agg.predicted.length;
      if (mismatch < DEVIATION_SAMPLES_REQUIRED) continue;
      if (this.log.hasPendingRecommendationFor(itemId)) continue; // 已有未处置推荐，跳过

      const actualAvg = agg.actual.reduce((s, v) => s + v, 0) / mismatch;
      const predictedAvg = agg.predicted.reduce((s, v) => s + v, 0) / mismatch;
      const suggestedDelta = round2(actualAvg);

      const rec: InsightRecommendation = {
        id: tempId('rec'),
        itemId,
        itemName: agg.name,
        predicted: round2(predictedAvg),
        actual: round2(actualAvg),
        samples: mismatch,
        message: buildEvidenceMessage(agg.name, agg.evidence, round2(predictedAvg), suggestedDelta),
        suggestedDelta,
        createdAt: now,
        // 存储层列名（down/up）→ 领域类型（adjustedDown/adjustedUp）显式映射
        evidence: {
          total: agg.evidence.total,
          adjustedDown: agg.evidence.down,
          adjustedUp: agg.evidence.up,
          matched: agg.evidence.matched,
          windowDays: RECOMMEND_WINDOW_DAYS,
        },
      };
      this.log.insertRecommendation({
        id: rec.id, itemId: rec.itemId, itemName: rec.itemName,
        predicted: rec.predicted, actual: rec.actual, samples: rec.samples,
        message: rec.message, suggestedDelta: rec.suggestedDelta,
        evidence: agg.evidence,
      });
      produced.push(rec);
    }
    return produced;
  }

  /**
   * 待处置推荐（从 DB 读，渲染用）。
   * 证据计数一并带出 —— 周报每条推荐旁要展示「近 14 天用了 N 次，M 次调低」。
   */
  pendingRecommendations(): InsightRecommendation[] {
    return this.log.pendingRecommendations().map(r => ({
      id: r.id, itemId: r.item_id, itemName: r.item_name,
      predicted: r.predicted, actual: r.actual, samples: r.samples,
      message: r.message, suggestedDelta: r.suggested_delta, createdAt: r.created_at,
      evidence: {
        total: r.total_uses,
        adjustedDown: r.adjusted_down,
        adjustedUp: r.adjusted_up,
        matched: r.matched,
        windowDays: RECOMMEND_WINDOW_DAYS,
      },
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
