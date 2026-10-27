/**
 * Coordinator 集成测试 —— 模块协调 / 滑动状态机 / 推荐处置闭环。
 * 不依赖 Electron，直接在 node 下跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Coordinator, ADJUST_WINDOW_MS, ADJUST_WINDOW_HARD_MAX_MS } from '../src/main/coordinator.js';
import { recoveryTakenDraft } from '../src/core/events.js';
import type { RecoveryItem, WeatherCondition } from '../src/core/types.js';
import type { BusPayloads } from '../src/core/bus.js';

function makeCoordinator(): { c: Coordinator; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-coord-'));
  const c = new Coordinator({
    userDataPath: dir,
    // 注入假天气，保证离线确定性
    weatherFetcher: async () => ({ condition: 'sunny', tempC: 22 }),
  });
  return { c, dir };
}

test('coordinator: 启动种子 + 晨间基线滑动 + confirm 写入 energy.set', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    // 恢复项已种子
    assert.equal(c.deck.list().length, 6);
    // 晨间基线卡弹出（无昨日快照 → 起点 INITIAL_ENERGY=7）
    const st0 = c.buildState();
    assert.equal(st0.pendingSlide?.kind, 'morning-baseline');
    assert.equal(st0.pendingSlide?.baseEnergy, 7);
    assert.equal(st0.pendingSlide?.min, 0);
    assert.equal(st0.pendingSlide?.max, 10);

    // 预览（绝对目标值）：不写库
    const pv = c.previewSlide(9);
    assert.equal(pv.energy, 9);
    assert.equal(c.ledger.current(), 7); // 未确认前不变

    // 确认：滑到 9 → energy.set(9)，actual_delta = 9 - 7 = 2
    const ev = c.confirmSlide(9, '睡得不错');
    assert.ok(ev);
    assert.equal(ev!.type, 'energy.set');
    assert.equal(ev!.actual_delta, 2);
    assert.equal(c.ledger.current(), 9);
    assert.equal(c.buildState().pendingSlide, null);
    assert.equal(c.buildState().morningBaselinePending, false);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 同一时刻仅一张滑动卡；取消后不再强制基线', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    assert.ok(c.buildState().pendingSlide);
    // 已有卡时再请求晨间卡 → null
    assert.equal(c.requestSlide('morning-baseline', 'baseline'), null);
    // 取消
    c.cancelSlide();
    assert.equal(c.buildState().pendingSlide, null);
    // 取消基线后不再自动弹
    const before = c.buildState();
    assert.equal(before.pendingSlide, null);
    // 恢复项不再走 slide，改走调节窗口（当前精力 7）
    const w = c.recoveryStartAdjust('rec_nap');
    assert.equal(w!.kind, 'recovery');
    assert.equal(w!.refId, 'rec_nap');
    assert.equal(w!.baseEnergy, 7);
    // 草稿起点 = 事件默认精力值 = clamp(7 + 1.5) = 8.5
    assert.equal(w!.draftEnergy, 8.5);
    assert.equal(w!.phase, 'adjusting');
    // 窗口内微调：草稿推到 9（不改则确认时 delta 就是默认的 1.5）
    assert.equal(c.adjustDraft(9)!.draftEnergy, 9);
    // commit 写 recovery.taken：确认 9 → actual = 9 - 7 = 2，predicted=currentDelta(1.5)
    const ev = c.commitAdjust();
    assert.equal(ev!.type, 'recovery.taken');
    assert.equal(ev!.predicted_delta, 1.5);
    assert.equal(ev!.actual_delta, 2);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: requestSlide 不再受理 task-complete/recovery（写入点唯一）', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    c.createTask('写设计文档', 2.5);
    const t = c.tasks.open()[0]!;
    // 旧路径必须返回 null，否则会与 commitAdjust 形成两个写入点
    assert.equal(c.requestSlide('task-complete', t.id), null);
    assert.equal(c.requestSlide('recovery', 'rec_nap'), null);
    // 晨间基线与临时预览仍走 slide
    assert.ok(c.requestSlide('manual-adjust', 'manual'));
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 任务完成流程 = 先确认实际时长，再调精力，确认后落库', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide(); // 关掉晨间卡
    c.createTask('写设计文档', 2.5, null, 45);
    const tasks = c.tasks.open();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.estMinutes, 45);

    // 第一步：取名称与预估时长（不打开窗口、不落库）
    const req = c.taskDurationRequest(tasks[0]!.id)!;
    assert.equal(req.title, '写设计文档');
    assert.equal(req.estMinutes, 45);
    assert.equal(c.buildState().adjustWindow, null);
    assert.equal(c.ledger.current(), 7);

    // 第二步：用户确认实际时长 62 分钟 → 打开 7s 调节窗口
    const w = c.taskCompleteWithDuration(tasks[0]!.id, 62)!;
    assert.equal(w.kind, 'task-complete');
    assert.equal(w.label, '写设计文档');
    assert.equal(w.actualMinutes, 62);
    assert.equal(w.predicted, 4);           // 需求 3：完成事件默认恢复 +4
    assert.equal(w.baseEnergy, 7);         // 事件前真实精力
    assert.equal(w.phase, 'adjusting');
    assert.equal(w.remainingMs, 7000);
    // 草稿起点 = 事件默认精力值 = clamp(7 + 4) = 10
    assert.equal(w.draftEnergy, 10);
    assert.equal(w.defaultEnergy, 10);

    // 事件此刻尚未落库：任务仍是 open，精力未变
    assert.equal(c.tasks.open().length, 1);
    assert.equal(c.ledger.current(), 7);

    // 窗口内微调（只改草稿）
    const w2 = c.adjustDraft(5.5)!;
    assert.equal(w2.draftEnergy, 5.5);
    assert.equal(c.ledger.current(), 7); // 仍未落库

    // 确认 → 写 task.completed，actual = 5.5 - 7 = -1.5
    const ev = c.commitAdjust('比预想顺利');
    assert.equal(ev!.type, 'task.completed');
    assert.equal(ev!.predicted_delta, 4);
    assert.equal(ev!.actual_delta, -1.5);
    assert.equal((ev!.payload as { actualMinutes?: number | null }).actualMinutes, 62);
    assert.equal(c.tasks.open().length, 0);
    assert.equal(c.tasks.get(tasks[0]!.id)!.actualMinutes, 62);
    // 精力 = 用户确认的真实值
    assert.equal(c.ledger.current(), 5.5);
    // 窗口关闭
    assert.equal(c.buildState().adjustWindow, null);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 取消调节 → 草稿丢弃，任务保持 open，精力不变', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    // 先取基线，再建任务：eventsBefore 不能把 task.created 算进去
    const eventsBefore = c.log.allEvents().length;
    c.createTask('整理资料', 2);
    const id = c.tasks.open()[0]!.id;

    c.taskCompleteWithDuration(id, 30);
    c.adjustDraft(9);
    c.cancelAdjust();

    assert.equal(c.ledger.current(), 7);                       // 未变
    assert.equal(c.tasks.open().length, 1);                    // 仍可再次完成
    assert.equal(c.log.allEvents().length, eventsBefore + 1);  // 只多了 task.created
    assert.equal(c.buildState().adjustWindow, null);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 无调节窗口时，进度条预览不落库（adjustDraft 返回 null）', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    const before = c.ledger.current();
    const eventsBefore = c.log.allEvents().length;
    // 平时（无事件）拖动进度条：主进程拒绝，精力纹丝不动
    assert.equal(c.adjustDraft(2), null);
    assert.equal(c.adjustDraft(9), null);
    assert.equal(c.ledger.current(), before);
    assert.equal(c.log.allEvents().length, eventsBefore);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 窗口同一时刻只有一个（重复请求返回 null）', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    c.createTask('任务A', 1);
    c.createTask('任务B', 1);
    const [a, b] = c.tasks.open();
    assert.ok(c.taskCompleteWithDuration(a!.id, 10));
    // 已有窗口 → 拒绝第二个，避免两张草稿互相覆盖
    assert.equal(c.taskCompleteWithDuration(b!.id, 10), null);
    assert.equal(c.recoveryStartAdjust('rec_nap'), null);
    assert.equal(c.buildState().adjustWindow!.refId, a!.id);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 临时调节（manual-adjust）纯预览，不落库', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    const before = c.ledger.current(); // 7
    const eventsBefore = c.log.allEvents().length;

    const slide = c.requestSlide('manual-adjust', 'manual');
    assert.equal(slide!.kind, 'manual-adjust');
    assert.equal(slide!.baseEnergy, before);

    // 预览任意值都不写库
    c.previewSlide(2);
    assert.equal(c.ledger.current(), before);

    // 「确认」临时调节 = 关闭卡片，精力不变、事件流不变
    const ev = c.confirmSlide(2);
    assert.equal(ev, null);
    assert.equal(c.ledger.current(), before);
    assert.equal(c.log.allEvents().length, eventsBefore);
    assert.equal(c.buildState().pendingSlide, null);

    // 取消同样不落库
    c.requestSlide('manual-adjust', 'manual');
    c.cancelSlide();
    assert.equal(c.ledger.current(), before);
    assert.equal(c.log.allEvents().length, eventsBefore);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 推荐闭环 accept → 恢复项默认值更新 + 版本历史', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    // 造 3 次偏差：rec_nap predicted=1.5, actual=4
    const item = c.deck.get('rec_nap')!;
    for (let i = 0; i < 3; i++) c.log.append(recoveryTakenDraft({ ...item } as RecoveryItem, 4));
    // 批处理产出推荐
    const produced = c['insight'].detectRecommendations();
    assert.equal(produced.length, 1);
    const recId = produced[0]!.id;
    // 手动触发协调层的处置（runInsightBatch 为定时器触发，这里直接调处置路径）
    assert.equal(c.buildState().recommendations.length, 1);
    const ok = c.resolveRecommendation(recId, 'accepted');
    assert.ok(ok);
    // 恢复项默认值已校准为建议值（≈4）
    const after = c.deck.get('rec_nap')!;
    assert.ok(Math.abs(after.currentDelta - produced[0]!.suggestedDelta) < 1e-9);
    // 版本历史多了一条（AI 来源）
    const versions = c.deck.versions('rec_nap');
    assert.ok(versions.length >= 2);
    assert.equal(versions[0]!.reason, '采纳 AI 推荐校准');
    // 推荐已处置，不再 pending
    assert.equal(c.buildState().recommendations.length, 0);
    // 事件流记录了 accepted
    assert.equal(c.log.byType('recommendation.accepted').length, 1);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 情绪合成随精力变化（三层 + 天气显示门槛）', async () => {
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    // 初始精力 7，注入晴天：7 < 8 → 不挂太阳
    const hi = c.buildState().emotion;
    assert.equal(hi.overlay, 'none');
    // 拉到 9 分（好状态）+ 晴 → 显示太阳
    c.ledger.setEnergy(9);
    const sunny = c.buildState().emotion;
    assert.equal(sunny.overlay, 'sunbeam');
    // 门槛已废除（Q1）：9 分也激活（旧行为下 9 >= 3 是 false）
    assert.equal(sunny.pulseActive, true);
    // 拉低精力 → 依旧激活（激活状态不再随精力翻转）
    c.ledger.setEnergy(2);
    const lo = c.buildState().emotion;
    assert.equal(lo.pulseActive, true);
    assert.notEqual(lo.base, sunny.base);
    assert.equal(lo.energy, 2);
    // 精力 2 + 晴 → 低精力区只显示不良天气，晴不显示
    assert.equal(lo.overlay, 'none');
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 重启后 fold 一致（事件流为唯一事实源）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-coord-'));
  try {
    const c1 = new Coordinator({ userDataPath: dir, weatherFetcher: async () => ({ condition: 'rain', tempC: 18 }) });
    await c1.start();
    c1.cancelSlide();
    c1.ledger.adjust(-3);
    const e1 = c1.ledger.current();
    c1.stop();

    const c2 = new Coordinator({ userDataPath: dir, weatherFetcher: async () => ({ condition: 'rain', tempC: 18 }) });
    await c2.start();
    assert.equal(c2.ledger.current(), e1);
    c2.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────── 调节窗口计时（需求 3：拖动重置 7s + 60s 硬上限）───────────────────
 * 用 node:test 的 mock.timers 冻结 Date 与 setTimeout，做确定性验证，
 * 避免真实等待 7s/60s。只 mock setTimeout+Date：天气/洞察是 setInterval（10min/30min），
 * 不在测试窗口内触发，c.stop() 会清掉。 */

test('coordinator: adjusting 相位拖动微调 → 重置 7s 静置倒计时', async (t) => {
  const T = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T });
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    c.createTask('写文档', 2, null, 45);
    const id = c.tasks.open()[0]!.id;

    const w = c.taskCompleteWithDuration(id, 50)!;
    assert.equal(w.phase, 'adjusting');
    assert.equal(w.remainingMs, ADJUST_WINDOW_MS); // 7000

    // 推进 4s：剩余 3s，仍在 adjusting
    t.mock.timers.tick(4000);
    assert.equal(c.buildState().adjustWindow!.phase, 'adjusting');
    assert.equal(c.buildState().adjustWindow!.remainingMs, ADJUST_WINDOW_MS - 4000);

    // 拖动微调 → expiresAt 重置为 now+7s（需求 3：拖动过程中不计入静置时间）
    const w2 = c.adjustDraft(9)!;
    assert.equal(w2.draftEnergy, 9);
    assert.equal(w2.remainingMs, ADJUST_WINDOW_MS); // 回到满 7s
    assert.equal(w2.phase, 'adjusting');

    // 再推进 6s（累计 10s < 重置后的 11s 截止）→ 仍未到点
    t.mock.timers.tick(6000);
    assert.equal(c.buildState().adjustWindow!.phase, 'adjusting');
    assert.equal(c.buildState().adjustWindow!.remainingMs, 1000);

    // 越过重置后的截止（11s）→ 切 confirming
    t.mock.timers.tick(1500);
    assert.equal(c.buildState().adjustWindow!.phase, 'confirming');

    // 确认落库：actual = 9 - 7 = 2
    const ev = c.commitAdjust('状态不错');
    assert.equal(ev!.type, 'task.completed');
    assert.equal(ev!.actual_delta, 2);
    assert.equal(c.ledger.current(), 9);
    assert.equal(c.buildState().adjustWindow, null);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('coordinator: 拖动重置受 60s 硬上限封顶，到点强制 confirming', async (t) => {
  const T = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T });
  const { c, dir } = makeCoordinator();
  try {
    await c.start();
    c.cancelSlide();
    c.createTask('长任务', 2, null, 45);
    const id = c.tasks.open()[0]!.id;
    c.taskCompleteWithDuration(id, 50); // hardDeadline = T + 60000

    // 每 5s 拖动一次续命（5s < 7s，相位保持 adjusting），推进到 55s
    for (let i = 0; i < 11; i++) {
      t.mock.timers.tick(5000);
      const w = c.adjustDraft(8)!;
      assert.equal(w.phase, 'adjusting');
    }
    // now = T + 55000：最后一次拖动时 min(55+7, 60) = 60 → 已被硬上限封顶
    // 再推进 3s → 剩余 = 60 - 58 = 2s（若未封顶应为 7 - 3 = 4s）
    t.mock.timers.tick(3000);
    assert.equal(c.buildState().adjustWindow!.phase, 'adjusting');
    assert.equal(c.buildState().adjustWindow!.remainingMs, ADJUST_WINDOW_HARD_MAX_MS - 58000); // 2000

    // 此刻拖动：expiresAt = min(58+7=65s, 60s) = 60s → 剩余仍是 2s（不给满 7s）
    const w = c.adjustDraft(8)!;
    assert.equal(w.remainingMs, ADJUST_WINDOW_HARD_MAX_MS - 58000); // 2000，而非 7000
    assert.equal(w.phase, 'adjusting');

    // 推进 2s 到硬上限 → 强制 confirming（拖动无法无限续命）
    t.mock.timers.tick(2000);
    assert.equal(c.buildState().adjustWindow!.phase, 'confirming');
    assert.equal(c.buildState().adjustWindow!.remainingMs, 0);

    // 硬上限后仍可确认落库
    const ev = c.commitAdjust('拖到上限');
    assert.equal(ev!.actual_delta, 1); // 8 - 7
    assert.equal(c.ledger.current(), 8);
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────── 周报调度（需求 5：17:30 弹窗 / 周五确认 / 防重复）───────────────────
 * 固定时间戳（本地时区 Asia/Shanghai）：
 *  周三 2026-10-21 09:00 → 未到 17:30
 *  周三 2026-10-21 17:31 → 已到期
 *  周五 2026-10-23 17:29 / 17:31 → 到期且 requireAck */
const WED_AM = 1792544400000;   // 2026-10-21 09:00
const WED_PM = 1792575060000;   // 2026-10-21 17:31
const FRI_AM = 1792747740000;   // 2026-10-23 17:29
const FRI_PM = 1792747860000;   // 2026-10-23 17:31

function makeCoordinatorAt(nowMs: number): { c: Coordinator; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-report-'));
  const c = new Coordinator({
    userDataPath: dir,
    weatherFetcher: async () => ({ condition: 'sunny', tempC: 22 }),
  });
  // 冻结 now：start() 内 checkReportDue 与 meta 日期判定都走它
  const origNow = Date.now;
  Date.now = () => nowMs;
  (c as unknown as { __restoreNow?: () => void }).__restoreNow = () => { Date.now = origNow; };
  return { c, dir };
}

test('coordinator: 周报 17:30 前不弹，到点弹且当天只弹一次', async () => {
  // 上午启动：不弹
  const a = makeCoordinatorAt(WED_AM);
  try {
    await a.c.start();
    a.c.cancelSlide();
    assert.equal(a.c.buildState().reportModal, null);
  } finally { (a.c as never as { __restoreNow?: () => void }).__restoreNow?.(); a.c.stop(); rmSync(a.dir, { recursive: true, force: true }); }

  // 17:31 启动：补弹（requireAck=false，周三）
  const b = makeCoordinatorAt(WED_PM);
  try {
    await b.c.start();
    b.c.cancelSlide();
    const m = b.c.buildState().reportModal;
    assert.ok(m);
    assert.equal(m!.requireAck, false);
    assert.equal(m!.dateStr, '2026-10-21');
    // 再次检查不重复弹（meta 已记录）
    b.c['checkReportDue']();
    assert.ok(b.c.buildState().reportModal); // 仍是同一份（confirmReport 前不消失）
    // 确认 → 收起；再触发也不弹（同日已弹过）
    b.c.confirmReport();
    assert.equal(b.c.buildState().reportModal, null);
    b.c['checkReportDue']();
    assert.equal(b.c.buildState().reportModal, null);
  } finally { (b.c as never as { __restoreNow?: () => void }).__restoreNow?.(); b.c.stop(); rmSync(b.dir, { recursive: true, force: true }); }
});

test('coordinator: 周五 17:30 弹窗 requireAck=true，且未确认前不重复弹', async () => {
  // 17:29 启动：未到点
  const a = makeCoordinatorAt(FRI_AM);
  try {
    await a.c.start();
    a.c.cancelSlide();
    assert.equal(a.c.buildState().reportModal, null);
  } finally { (a.c as never as { __restoreNow?: () => void }).__restoreNow?.(); a.c.stop(); rmSync(a.dir, { recursive: true, force: true }); }

  // 17:31 启动：弹且需确认
  const b = makeCoordinatorAt(FRI_PM);
  try {
    await b.c.start();
    b.c.cancelSlide();
    const m = b.c.buildState().reportModal;
    assert.ok(m);
    assert.equal(m!.requireAck, true); // 周五重点确认
    // 未确认期间重复检查不产生第二份
    b.c['checkReportDue']();
    assert.equal(b.c.buildState().reportModal!.dateStr, m!.dateStr);
  } finally { (b.c as never as { __restoreNow?: () => void }).__restoreNow?.(); b.c.stop(); rmSync(b.dir, { recursive: true, force: true }); }
});

test('coordinator: 周报载荷含 AI 推荐与已确认变更留痕', async () => {
  // 上午启动（不弹、meta 未写），补数据后手动切到 17:31 触发一次带内容的弹窗
  const b = makeCoordinatorAt(WED_AM);
  try {
    await b.c.start();
    b.c.cancelSlide();
    assert.equal(b.c.buildState().reportModal, null);
    // 造 3 次偏差产出推荐（pending 状态 → 进 aiSuggestions）
    const item = b.c.deck.get('rec_nap')!;
    for (let i = 0; i < 3; i++) b.c.log.append(recoveryTakenDraft({ ...item } as RecoveryItem, 4));
    b.c['insight'].detectRecommendations();
    // 造一条已确认变更（user 来源）
    b.c.deck.updateDelta('rec_tea', 2, '手动调整', 'user');
    // 切到 17:31 触发
    Date.now = () => WED_PM;
    b.c['checkReportDue']();
    const m = b.c.buildState().reportModal;
    assert.ok(m);
    assert.equal(m!.dateStr, '2026-10-21');
    assert.ok(m!.aiSuggestions.length >= 1);
    assert.equal(m!.aiSuggestions[0]!.itemId, 'rec_nap');
    const dec = m!.decisions.find(d => d.itemId === 'rec_tea');
    assert.ok(dec);
    assert.equal(dec!.source, 'user');
    assert.equal(dec!.delta, 2);
  } finally { (b.c as never as { __restoreNow?: () => void }).__restoreNow?.(); b.c.stop(); rmSync(b.dir, { recursive: true, force: true }); }
});

/* ─────────────────── 实时天气 → 心情广播（refreshWeather 唯一入口）───────────────────
 * 守护用户需求的天气层绑定：
 *  - 天气变了（condition 翻转）→ changed=true → 壳层才让猫吐槽；
 *  - 头顶挂件跟随**实时**天气：雨（精力<8）= rain-drop 落小雨，晴+精力≥8 = sunbeam 出太阳；
 *  - 例行刷新天气没变 → changed=false（不打扰）；精力变化不算天气变化。 */

test('coordinator: refreshWeather 广播 changed 标志，头顶挂件随实时天气更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-coord-'));
  let condition: WeatherCondition = 'rain';
  const c = new Coordinator({
    userDataPath: dir,
    weatherFetcher: async () => ({ condition, tempC: 18 }),
  });
  try {
    const seen: BusPayloads['weather:changed'][] = [];
    c.bus.on('weather:changed', (p) => { seen.push(p); });
    await c.start();
    // start 的首刷是异步的（fetcher 立即解决）：等一拍让它落地
    await new Promise((r) => setTimeout(r, 10));
    c.cancelSlide();

    // 首刷：无缓存 → 兜底「阴」，live 拉到「雨」= 语义翻转
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { source: 'live', changed: true, condition: 'rain', previous: 'cloudy' });
    // 实时天气已绑定：sensor 拿到 live 雨
    assert.equal(c.weather.current().condition, 'rain');
    assert.equal(c.weather.current().source, 'live');
    // 精力默认 7（<8）+ 雨 → 头顶落小雨
    assert.equal(c.buildState().emotion.overlay, 'rain-drop');

    // 天气转晴：changed=true；精力 7 + 晴 → 低精力区不挂太阳（R4 红线）
    condition = 'sunny';
    const w2 = await c.refreshWeather();
    assert.equal(w2.condition, 'sunny');
    assert.deepEqual(seen[1], { source: 'live', changed: true, condition: 'sunny', previous: 'rain' });
    assert.equal(c.buildState().emotion.overlay, 'none');

    // 例行刷新、天气没变 → changed=false（壳层静默同步，不让猫吐槽）
    await c.refreshWeather();
    assert.equal(seen[2]!.changed, false);
    assert.equal(seen[2]!.condition, 'sunny');

    // 精力拉到 9（≥8）+ 晴 = 状态好天也好 → 头顶出太阳
    c.ledger.setEnergy(9);
    await c.refreshWeather();
    assert.equal(seen[3]!.changed, false); // 精力变化不算天气变化
    assert.equal(c.buildState().emotion.overlay, 'sunbeam');

    // 好状态下变天（雨）→ 挂件归 none（≥8 只显示好天气），但 changed=true 仍会广播
    condition = 'rain';
    await c.refreshWeather();
    assert.equal(seen[4]!.changed, true);
    assert.deepEqual(seen[4], { source: 'live', changed: true, condition: 'rain', previous: 'sunny' });
    assert.equal(c.buildState().emotion.overlay, 'none');
    // 精力掉回 <8 + 雨 → 小雨重新落下（归因外化）
    c.ledger.setEnergy(5);
    assert.equal(c.buildState().emotion.overlay, 'rain-drop');
  } finally { c.stop(); rmSync(dir, { recursive: true, force: true }); }
});
