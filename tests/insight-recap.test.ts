/**
 * dailyRecap 单测 —— 每日复盘清单（用户裁定 2026-10-27：每日 17:30 弹窗 = 今日复盘，非周手账）。
 *
 * 契约：
 *  1. 明细 = 当日 task.completed + recovery.taken（时间正序），Δ = actual_delta；
 *  2. 汇总 = 任务回血合计 / 恢复合计 / 计数；开盘 = 当日 0 点前全量 fold，收盘 = 当日 fold；
 *  3. 手动调整（energy.delta）影响开盘/收盘与净变化，但不进明细行；
 *  4. 日界：昨日事件绝不混入今日清单；
 *  5. 语义：任务完成 = 成就感回血（正值，TASK_COMPLETE_PREDICTED），不是消耗。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionLog } from '../src/storage/sqlite.js';
import { InsightEngine } from '../src/insight/engine.js';
import { INITIAL_ENERGY } from '../src/ledger/fold.js';
import type { EventDraft } from '../src/core/events.js';

/* ─────────────────────────── 工具 ─────────────────────────── */

type DraftType = EventDraft['type'];
type Payload = EventDraft['payload'];

function draft(type: DraftType, actual: number | null, payload: Payload, at: number): EventDraft {
  return { type, source: 'user', predicted_delta: null, actual_delta: actual, payload, at };
}

/** 固定时钟：2026-10-27 18:00 本地（17:30 弹窗时刻之后） */
const TODAY = new Date(2026, 9, 27, 18, 0, 0);
const at = (h: number, m: number, day = 27): number => new Date(2026, 9, day, h, m, 0).getTime();

function tmpLog(): { log: DecisionLog; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-recap-'));
  return { log: new DecisionLog({ dbPath: join(dir, 'test.db') }), dir };
}

/** 铺一天的账：昨日 energy.set→1；今日 2 任务 + 1 恢复 + 1 手动消耗 */
function seed(log: DecisionLog): void {
  // 昨日：精力直接设到 1（今日开盘 = 1）
  log.append(draft('energy.set', 1 - INITIAL_ENERGY,
    { kind: 'energy.set', before: INITIAL_ENERGY, target: 1 }, at(15, 0, 26)));
  // 今日
  log.append(draft('task.completed', 4,
    { kind: 'task.completed', taskId: 't1', title: '写周报', estCost: 3, actualMinutes: null }, at(9, 30)));
  log.append(draft('recovery.taken', 2.5,
    { kind: 'recovery.taken', itemId: 'r1', itemName: '午睡', minutes: 20 }, at(12, 10)));
  log.append(draft('task.completed', 3,
    { kind: 'task.completed', taskId: 't2', title: '修 bug', estCost: 2, actualMinutes: null }, at(14, 0)));
  // 手动调整：进开盘/收盘折线，不进明细
  log.append(draft('energy.delta', -1,
    { kind: 'energy.delta', delta: -1, note: '临时消耗' }, at(15, 0)));
}

/* ─────────────────────────── 用例 ─────────────────────────── */

test('dailyRecap: 今日明细/汇总/开盘收盘 全部来自事件流 fold', () => {
  const { log, dir } = tmpLog();
  try {
    seed(log);
    const insight = new InsightEngine({ log, now: () => TODAY.getTime() });
    const r = insight.dailyRecap();

    assert.equal(r.date, '2026-10-27');
    assert.equal(r.tasksCompleted, 2);
    assert.equal(r.recoveriesTaken, 1);
    assert.equal(r.taskGain, 7);        // 4 + 3（正值 = 成就感回血语义）
    assert.equal(r.recoverGain, 2.5);
    assert.equal(r.openEnergy, 1);      // 昨日 energy.set → 1
    // fold 逐步钳制 0–10：1 +4→5 +2.5→7.5 +3→10.5钳到10 -1→9（收盘是折叠语义，非增量求和）
    assert.equal(r.closeEnergy, 9);
    assert.equal(r.netChange, 8);

    // 明细：时间正序，任务+恢复，不含手动调整
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map(i => i.name), ['写周报', '午睡', '修 bug']);
    assert.deepEqual(r.items.map(i => i.kind), ['task', 'recovery', 'task']);
    assert.deepEqual(r.items.map(i => i.delta), [4, 2.5, 3]);
    assert.equal(r.items[0]!.at, at(9, 30));
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dailyRecap: 日界隔离——查昨日只含昨日，开盘回到 INITIAL', () => {
  const { log, dir } = tmpLog();
  try {
    seed(log);
    const insight = new InsightEngine({ log, now: () => TODAY.getTime() });
    const y = insight.dailyRecap(new Date(2026, 9, 26, 12, 0));

    assert.equal(y.date, '2026-10-26');
    assert.equal(y.items.length, 0);        // 昨日无任务/恢复
    assert.equal(y.tasksCompleted, 0);
    assert.equal(y.openEnergy, INITIAL_ENERGY); // 昨日 0 点前无事件
    assert.equal(y.closeEnergy, 1);         // 昨日 energy.set → 1
    assert.equal(y.netChange, 1 - INITIAL_ENERGY);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dailyRecap: 空账本 → 全零清单（开盘=收盘=INITIAL，不抛错）', () => {
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => TODAY.getTime() });
    const r = insight.dailyRecap();
    assert.equal(r.items.length, 0);
    assert.equal(r.openEnergy, INITIAL_ENERGY);
    assert.equal(r.closeEnergy, INITIAL_ENERGY);
    assert.equal(r.netChange, 0);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
