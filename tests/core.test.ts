/**
 * 核心域测试 —— fold / 情绪规则表 / pulse / 推荐偏差 / 天气降级。
 * 运行：npm test（esbuild 编译后 node --test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionLog, localDateStr } from '../src/storage/sqlite.js';
import { EnergyLedger } from '../src/ledger/energy.js';
import { foldEvents, INITIAL_ENERGY, clampEnergy } from '../src/ledger/fold.js';
import {
  energyDeltaDraft, energySetDraft, recoveryTakenDraft, taskCompletedDraft,
  recRejectedDraft, recAcceptedDraft,
} from '../src/core/events.js';
import {
  resolve, tierFor, extractPulseSignals, resolvePulse, PULSE_RULES,
  COMPOSITE_TABLE, MODIFIER_LABEL, energyBand,
  resolveWeatherOverlay, WEATHER_DISPLAY_ENERGY_MIN, describe,
} from '../src/emotion/engine.js';
import { TaskCenter } from '../src/task/center.js';
import { RecoveryDeck, DEFAULT_ITEMS } from '../src/recovery/deck.js';
import { InsightEngine, DEVIATION_SAMPLES_REQUIRED, RECOMMEND_WINDOW_DAYS } from '../src/insight/engine.js';
import { WeatherSensor, wmoToCondition } from '../src/weather/sensor.js';
import type { RecoveryItem, WeatherState } from '../src/core/types.js';
import { FALLBACK_WEATHER } from '../src/core/types.js';
import type { DomainEvent } from '../src/core/events.js';

function tmpLog(): { log: DecisionLog; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-test-'));
  return { log: new DecisionLog({ dbPath: join(dir, 'test.db') }), dir };
}

const mkItem = (id: string, delta: number): RecoveryItem => ({
  id, name: id, icon: 'x', defaultDelta: delta, currentDelta: delta, minutes: 3,
});

const sunnyWeather = (): WeatherState => ({ condition: 'sunny', tempC: 25, source: 'live', at: Date.now() });

/* ─────────────────────────── fold ─────────────────────────── */

test('fold: energy.set 覆盖，energy.delta 累加，钳制 0–10', () => {
  const { log, dir } = tmpLog();
  try {
    const ledger = new EnergyLedger(log);
    // 空库 fold → INITIAL_ENERGY
    assert.equal(ledger.current(), INITIAL_ENERGY);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }

  // 纯 fold 函数验证
  const events = [
    fakeEvent('energy.set', null, 5, { kind: 'energy.set', before: 0, target: 5 }),
    fakeEvent('energy.delta', 3, 3, { kind: 'energy.delta', delta: 3 }),
    fakeEvent('energy.delta', -2, -2, { kind: 'energy.delta', delta: -2 }),
  ];
  assert.equal(foldEvents(events, 0), 6);

  // 钳制
  assert.equal(clampEnergy(99), 10);
  assert.equal(clampEnergy(-99), 0);
  assert.equal(clampEnergy(Number.NaN), INITIAL_ENERGY);
});

test('fold: 非精力事件不影响结果', () => {
  const events = [
    fakeEvent('energy.set', null, 10, { kind: 'energy.set', before: 0, target: 10 }),
    fakeEvent('weather.observed', null, null, { kind: 'weather.observed', weather: sunnyWeather() }),
    fakeEvent('note.added', null, null, { kind: 'note.added', text: 'hi' }),
  ];
  assert.equal(foldEvents(events, 0), 10);
});

/* ─────────────────────────── DecisionLog / Ledger ─────────────────────────── */

test('DecisionLog: append 维护 energy_after，重启后 fold 一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-test-'));
  const dbPath = join(dir, 'a.db');
  try {
    const log1 = new DecisionLog({ dbPath });
    const l1 = new EnergyLedger(log1);
    l1.setEnergy(6);
    l1.adjust(-3);
    assert.equal(l1.current(), 3);
    const events = log1.allEvents();
    assert.equal(events[events.length - 1]!.energy_after, 3);
    log1.close();

    // 重开数据库 → 重放 → 相同精力
    const log2 = new DecisionLog({ dbPath });
    assert.equal(log2.currentEnergy(), 3);
    log2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ledger: todaySnapshot 统计开盘/最高/最低', () => {
  const { log, dir } = tmpLog();
  try {
    const ledger = new EnergyLedger(log);
    ledger.setEnergy(5);
    ledger.adjust(4);
    ledger.adjust(-6);
    const snap = ledger.todaySnapshot();
    assert.equal(snap.energy, 3);
    assert.equal(snap.todayHigh, 9);
    assert.equal(snap.todayLow, 3);
    assert.equal(snap.todayCount, 3);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────── 情绪：base 10 档 ─────────────────────────── */

test('emotion: 10 档 base 映射边界（量程 0–10）', () => {
  assert.equal(tierFor(10).emotion, 'blissful');
  assert.equal(tierFor(9.5).emotion, 'blissful');
  assert.equal(tierFor(9.4).emotion, 'radiant');
  assert.equal(tierFor(7.5).emotion, 'cheerful');
  assert.equal(tierFor(5.5).emotion, 'calm');
  assert.equal(tierFor(4.5).emotion, 'steady');
  assert.equal(tierFor(3.5).emotion, 'weary');
  assert.equal(tierFor(2.5).emotion, 'drained');
  assert.equal(tierFor(1.5).emotion, 'exhausted');
  assert.equal(tierFor(0).emotion, 'burnt');
});

test('emotion: resolve 输出完整 EmotionState', () => {
  const st = resolve({ energy: 7, weather: sunnyWeather(), events: [] });
  assert.equal(st.base, 'content');
  // 精力 7 < 8（显示门槛）→ 晴也不挂太阳
  assert.equal(st.overlay, 'none');
  // 门槛已废除（Q1）：全档激活，高精力同样参与 pulse 判定
  assert.equal(st.pulseActive, true);
  // 空事件流下 msSinceLastChange = MAX_SAFE_INTEGER ≥ 90min ⇒ 命中兜底的 numb
  assert.equal(st.pulse, 'numb');
  assert.ok(st.composite.includes('content'));
  assert.ok(st.headline.length > 0);
});

/* ─────────────────────────── 天气显示门槛（问题 4 的唯一判定入口） ─────────────────────────── */

test('weather: 显示门槛 8 分集中定义，禁止各处复制', () => {
  assert.equal(WEATHER_DISPLAY_ENERGY_MIN, 8);
});

test('weather: 精力 >=8 且晴 → 只显示太阳', () => {
  assert.equal(resolveWeatherOverlay(8, 'sunny'), 'sunbeam');
  assert.equal(resolveWeatherOverlay(10, 'sunny'), 'sunbeam');
});

test('weather: 精力 >=8 但多云/阴/雨/雷 → 不显示任何天气元素', () => {
  assert.equal(resolveWeatherOverlay(9, 'cloudy'), 'none');
  assert.equal(resolveWeatherOverlay(9, 'rain'), 'none');
  assert.equal(resolveWeatherOverlay(9, 'thunderstorm'), 'none');
  assert.equal(resolveWeatherOverlay(8, 'cloudy'), 'none');
});

test('weather: 精力 <8 → 仅显示不良天气（雨/雷），晴与多云都不显示', () => {
  assert.equal(resolveWeatherOverlay(7.9, 'rain'), 'rain-drop');
  assert.equal(resolveWeatherOverlay(0, 'thunderstorm'), 'storm-bolt');
  assert.equal(resolveWeatherOverlay(7.9, 'sunny'), 'none');
  assert.equal(resolveWeatherOverlay(3, 'cloudy'), 'none');
});

test('weather: resolve 与门槛函数同源（overlay 不各算一套）', () => {
  for (const energy of [0, 3, 7, 7.9, 8, 9, 10]) {
    for (const condition of ['sunny', 'cloudy', 'rain', 'thunderstorm'] as const) {
      const st = resolve({ energy, weather: { condition, tempC: 20, source: 'live', at: 0 }, events: [] });
      assert.equal(st.overlay, resolveWeatherOverlay(energy, condition), `energy=${energy} ${condition}`);
    }
  }
});

test('weather: 精力低时 composite 仍体现天气语义（与 overlay 解耦）', () => {
  // 精力 2、雨天：头顶不挂太阳（overlay 走门槛），但「雪上加霜」语义仍要在 composite 里
  const st = resolve({ energy: 2, weather: { condition: 'rain', tempC: 18, source: 'live', at: 0 }, events: [] });
  assert.equal(st.overlay, 'rain-drop'); // 雨属不良天气，低精力区允许显示
  assert.ok(st.composite.includes('soaked'));
});

/* ─────────────────────────── 天气 × 精力复合规则表 ─────────────────────────── */

test('emotion: 复合规则表 4×3 全覆盖', () => {
  const bands = ['high', 'mid', 'low'] as const;
  const conditions = ['sunny', 'cloudy', 'rain', 'thunderstorm'] as const;
  for (const c of conditions) {
    for (const b of bands) {
      assert.ok(typeof COMPOSITE_TABLE[c][b] === 'string', `${c}×${b} 缺失`);
    }
  }
  // 抽查语义
  assert.equal(COMPOSITE_TABLE.rain.high, 'cozy');
  assert.equal(COMPOSITE_TABLE.rain.low, 'soaked');
  assert.equal(COMPOSITE_TABLE.thunderstorm.low, 'startled');
  assert.equal(COMPOSITE_TABLE.sunny.high, 'lifted');
  assert.equal(energyBand(6.5), 'high');
  assert.equal(energyBand(3), 'mid');
  assert.equal(energyBand(2.9), 'low');
});

/**
 * thunderstorm × high 必须是 neutral —— 不得再出现「反差兴奋」类修饰。
 *
 * 守护两条：① charged 已从词汇表删除；② overlay 层与 composite 层不打架
 * （精力 7 + 雷阵雨：头顶挂 storm-bolt，叙事层绝不能同时说「被点燃」）。
 */
test('emotion: 雷阵雨+高精力 无正向修饰（charged 已废除，两层不打架）', () => {
  assert.equal(COMPOSITE_TABLE.thunderstorm.high, 'neutral');
  assert.ok(!('charged' in MODIFIER_LABEL), 'charged 不得留在叙事词汇表里');
  assert.ok(!('charged' in COMPOSITE_TABLE.thunderstorm));

  // 档位错配放大器：energyBand.high 门槛 6.5 < overlay 门槛 8
  // ⇒ 精力 7 时头顶有 storm-bolt，叙事层必须沉默
  const storm: WeatherState = { condition: 'thunderstorm', tempC: 16, source: 'live', at: 0 };
  const s7 = resolve({ energy: 7, weather: storm, events: [] });
  assert.equal(s7.overlay, 'storm-bolt');
  assert.equal(energyBand(7), 'high');
  // 无天气修饰后缀（thunderstorm×high = neutral）。门槛废除后全档激活，
  // 空事件流会追加 pulse 段（numb），故用 startsWith 守「base 之后没有修饰」
  // 而不是全等 'content' —— 本条要守的是天气层沉默，不是 pulse 层。
  assert.ok(s7.composite.startsWith('content'), s7.composite);
  assert.ok(!s7.composite.includes('charged'), 'charged 不得复活');
  assert.equal(describe(s7, storm), '满足 · 雷阵雨'); // 无「反而被点燃」

  // 精力 9（>=8）时 overlay 归 none，叙事层同样沉默
  const s9 = resolve({ energy: 9, weather: storm, events: [] });
  assert.equal(s9.overlay, 'none');
  assert.ok(s9.composite.startsWith('radiant'), s9.composite);
  assert.ok(!s9.composite.includes('charged'), 'charged 不得复活');

  // 低精力侧的 startled 保留（外部归因，不指向自我价值）
  const s2 = resolve({ energy: 2, weather: storm, events: [] });
  assert.equal(s2.overlay, 'storm-bolt');
  assert.ok(s2.composite.startsWith('exhausted__startled'));
});

test('emotion: 同精力不同天气 → composite 不同', () => {
  const rain = resolve({ energy: 2, weather: { condition: 'rain', tempC: 18, source: 'live', at: 0 }, events: [] });
  const sunny = resolve({ energy: 2, weather: sunnyWeather(), events: [] });
  // 精力 2 < 3 → pulse 激活，空事件流命中 numb；天气修饰仍不同
  assert.ok(rain.composite.startsWith('exhausted__soaked'));
  assert.ok(sunny.composite.startsWith('exhausted__heavy'));
  assert.notEqual(rain.composite, sunny.composite);
});

/* ─────────────────────────── pulse ─────────────────────────── */

/**
 * Q1 裁决：激活门槛已废除，全档激活。
 *
 * 旧行为「精力 <3 才激活」被明确否决 —— 门槛是旧设计遗产，留着它等于给
 * 全幅区间装个只许全幅通过的闸门。现在脉冲的「轻重」由
 * pulse-contract.intensity() 按精力调制（高精力压缩、低精力全幅），
 * 而「有没有反应」不再看精力。
 */
test('pulse: 门槛已废除，全档激活', () => {
  const hi = resolve({ energy: 10, weather: sunnyWeather(), events: [] });
  assert.equal(hi.pulseActive, true, '精力 10 也必须激活');
  const lo = resolve({ energy: 0, weather: sunnyWeather(), events: [] });
  assert.equal(lo.pulseActive, true, '精力 0 必须激活');
  // 旧门槛两侧（3 / 2.9）现在同侧：激活状态不再随精力翻转
  assert.equal(
    resolve({ energy: 3, weather: sunnyWeather(), events: [] }).pulseActive,
    resolve({ energy: 2.9, weather: sunnyWeather(), events: [] }).pulseActive,
  );
  // 全量程扫描：任何精力下都激活
  for (let e = 0; e <= 10; e += 0.5) {
    assert.equal(resolve({ energy: e, weather: sunnyWeather(), events: [] }).pulseActive, true, `energy=${e}`);
  }
});

test('pulse: 6 条规则各有判定，连续拒绝 → anxious', () => {
  assert.equal(PULSE_RULES.length, 6);
  const now = Date.now();
  const events = [
    fakeEvent('recommendation.rejected', null, null, { kind: 'recommendation.rejected', recommendationId: 'r1', itemId: 'rec_nap' }, now - 5000),
    fakeEvent('recommendation.rejected', null, null, { kind: 'recommendation.rejected', recommendationId: 'r2', itemId: 'rec_nap' }, now - 3000),
  ];
  const sig = extractPulseSignals(events, now);
  assert.equal(sig.rejectedStreak, 2);
  const r = resolvePulse(sig, true);
  assert.equal(r.reaction, 'anxious');
  // 未激活时无反应
  assert.equal(resolvePulse(sig, false).reaction, 'none');
});

test('pulse: 恢复超预期 → grateful；达标 → determined', () => {
  const now = Date.now();
  const good = [fakeEvent('recovery.taken', 2, 4, { kind: 'recovery.taken', itemId: 'a', itemName: 'a', minutes: 3 }, now - 1000)];
  const okEv = [fakeEvent('recovery.taken', 2, 2.5, { kind: 'recovery.taken', itemId: 'a', itemName: 'a', minutes: 3 }, now - 1000)];
  assert.equal(resolvePulse(extractPulseSignals(good, now), true).reaction, 'grateful');
  assert.equal(resolvePulse(extractPulseSignals(okEv, now), true).reaction, 'determined');
});

test('pulse: 超时任务 → guilty', () => {
  const now = Date.now();
  const events = [
    fakeEvent('task.created', null, null, {
      kind: 'task.created',
      task: { id: 't1', title: 'x', estCost: 2, estMinutes: 30, status: 'open', createdAt: now - 10000, dueAt: now - 5000, actualMinutes: null },
    }, now - 9000),
  ];
  const sig = extractPulseSignals(events, now);
  assert.equal(sig.overdueTasks, 1);
  assert.equal(resolvePulse(sig, true).reaction, 'guilty');
});

test('pulse: 长时间无事件 → numb；高频小幅 → restless', () => {
  const now = Date.now();
  const old = [fakeEvent('energy.delta', -1, -1, { kind: 'energy.delta', delta: -1 }, now - 100 * 60 * 1000)];
  assert.equal(resolvePulse(extractPulseSignals(old, now), true).reaction, 'numb');

  const many: DomainEvent[] = [];
  for (let i = 0; i < 5; i++) {
    many.push(fakeEvent('energy.delta', 0.5, 0.5, { kind: 'energy.delta', delta: 0.5 }, now - (60 - i * 10) * 1000));
  }
  const sig = extractPulseSignals(many, now);
  assert.equal(sig.recentAdjustCount, 5);
  assert.equal(resolvePulse(sig, true).reaction, 'restless');
});

/* ─────────────────────────── TaskCenter ─────────────────────────── */

test('task: complete 不直接落事件，滑动确认后才写 task.completed', () => {
  const { log, dir } = tmpLog();
  try {
    const tc = new TaskCenter(log);
    const t = tc.create('写周报', 2);
    assert.equal(tc.open().length, 1);
    assert.equal(log.byType('task.completed').length, 0);

    // 弹出时基准精力 7，滑块范围为绝对值 0–10
    const slide = tc.requestComplete(t.id, 7)!;
    assert.equal(slide.kind, 'task-complete');
    assert.equal(slide.predicted, 4);         // 需求 3：完成事件默认恢复 +4
    assert.equal(slide.baseEnergy, 7);
    assert.equal(slide.min, 0);
    assert.equal(slide.max, 10);

    // 确认：用户滑到 5.5（= 事件后真实精力），actual_delta = 5.5 - 7 = -1.5
    const ev = tc.confirmComplete(t.id, -1.5, '比预期轻松')!;
    assert.equal(ev.predicted_delta, 4);
    assert.equal(ev.actual_delta, -1.5);
    assert.equal(tc.open().length, 0);
    assert.equal(tc.list().find(x => x.id === t.id)!.status, 'done');
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────── RecoveryDeck ─────────────────────────── */

test('recovery: seed 写入版本历史；updateDelta 产生新版本', () => {
  const { log, dir } = tmpLog();
  try {
    const deck = new RecoveryDeck(log);
    deck.seedIfEmpty();
    deck.seedIfEmpty(); // 幂等
    assert.equal(deck.list().length, DEFAULT_ITEMS.length);
    const nap = deck.get('rec_nap')!;
    assert.equal(nap.currentDelta, 1.5); // 量程 0–10 的默认值
    assert.equal(deck.versions('rec_nap').length, 1);

    deck.updateDelta('rec_nap', 2.5, '实测更恢复');
    assert.equal(deck.get('rec_nap')!.currentDelta, 2.5);
    assert.equal(deck.versions('rec_nap').length, 2);
    assert.equal(deck.versions('rec_nap')[0]!.reason, '实测更恢复');

    // take → confirm 记录 predicted/actual（基准精力 5）
    const slide = deck.requestTake('rec_nap', 5)!;
    assert.equal(slide.predicted, 2.5); // 参考值 = currentDelta
    assert.equal(slide.baseEnergy, 5);
    assert.equal(slide.min, 0);
    assert.equal(slide.max, 10);
    // 用户滑到 7.5 → actual = 7.5 - 5 = 2.5
    const ev = deck.confirmTake('rec_nap', 2.5)!;
    assert.equal(ev.predicted_delta, 2.5);
    assert.equal(ev.actual_delta, 2.5);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────── InsightEngine ─────────────────────────── */

test('insight: 同恢复项 ≥3 次偏差 → 产出推荐；<3 次不产出', () => {
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log });
    const item = mkItem('rec_walk', 2);
    // 2 次偏差 → 不触发
    log.append(recoveryTakenDraft(item, 4));
    log.append(recoveryTakenDraft(item, 4.5));
    assert.equal(insight.detectRecommendations().length, 0);
    // 第 3 次 → 触发
    log.append(recoveryTakenDraft(item, 5));
    const recs = insight.detectRecommendations();
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.itemId, 'rec_walk');
    assert.ok(recs[0]!.samples >= DEVIATION_SAMPLES_REQUIRED);
    assert.ok(recs[0]!.suggestedDelta > 2); // 实际均值高于预估

    // 不重复产出（已有 pending）
    assert.equal(insight.detectRecommendations().length, 0);
    assert.equal(insight.pendingRecommendations().length, 1);

    // 处置
    const ok = insight.resolveRecommendation(recs[0]!.id, 'accepted');
    assert.ok(ok);
    assert.equal(ok!.newDelta, recs[0]!.suggestedDelta);
    assert.equal(insight.pendingRecommendations().length, 0);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ── 推荐水位线：处置后旧证据作废（红线「拒绝零痕迹零情绪反馈」的技术落点） ── */

/**
 * 为什么必须冻结时钟：
 * resolveRecommendation 用 Date.now() 写 resolved_at，事件用 Date.now() 写 at。
 * 真实时钟下测试跑得快，两者可能同毫秒，导致「旧证据是否早于水位线」的断言不确定。
 * 冻结后：旧事件 at === resolved_at（严格不大于 → 作废），tick 之后的新事件 at > 水位线（有效）。
 */
const DAY = 24 * 60 * 60 * 1000;

test('insight: 拒绝后不再用同一批数据重弹（水位线）', (t) => {
  const T = Date.parse('2026-10-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => Date.now() });
    const item = mkItem('rec_walk', 2);

    // 3 次调高偏差 → 触发推荐
    for (let i = 0; i < 3; i++) log.append(recoveryTakenDraft(item, 4.5));
    const recs = insight.detectRecommendations();
    assert.equal(recs.length, 1);

    // 用户拒绝
    insight.resolveRecommendation(recs[0]!.id, 'rejected');
    assert.equal(insight.pendingRecommendations().length, 0);

    // 模拟之后 5 轮（每 10 分钟）批处理：同一批历史数据不得重弹
    for (let round = 0; round < 5; round++) {
      t.mock.timers.tick(10 * 60 * 1000);
      assert.equal(insight.detectRecommendations().length, 0, `第 ${round + 1} 轮不应重弹`);
    }
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 接受后不再重弹（旧 predicted_delta 不可变，默认值一改旧证据即失效）', (t) => {
  const T = Date.parse('2026-10-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => Date.now() });
    const deck = new RecoveryDeck(log);
    deck.seedIfEmpty();
    const nap = deck.get('rec_nap')!;

    // 4 次午睡，实际只恢复 0.8（预估 1.5）→ 4 次调低
    for (let i = 0; i < 4; i++) log.append(recoveryTakenDraft(nap, 0.8));
    const recs = insight.detectRecommendations();
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.suggestedDelta, 0.8);

    // 接受 → coordinator 会同步更新默认值
    insight.resolveRecommendation(recs[0]!.id, 'accepted');
    deck.updateDelta('rec_nap', 0.8, '采纳 AI 推荐校准', 'ai');
    assert.equal(deck.get('rec_nap')!.currentDelta, 0.8);

    // 之后 3 轮批处理不得重弹（否则会出现「建议改成 0.8」而当前已是 0.8 的同义反复）
    for (let round = 0; round < 3; round++) {
      t.mock.timers.tick(10 * 60 * 1000);
      const again = insight.detectRecommendations();
      assert.equal(again.length, 0, `第 ${round + 1} 轮不应重弹`);
    }
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 水位线只切时间不永久封禁 —— 处置后新偏差可重新建议', (t) => {
  const T = Date.parse('2026-10-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => Date.now() });
    const item = mkItem('rec_walk', 2);

    for (let i = 0; i < 3; i++) log.append(recoveryTakenDraft(item, 4.5));
    const recs = insight.detectRecommendations();
    insight.resolveRecommendation(recs[0]!.id, 'rejected');

    // 拒绝后立刻检测：旧证据已作废，2 次不足
    t.mock.timers.tick(1000);
    log.append(recoveryTakenDraft(item, 4.5));
    log.append(recoveryTakenDraft(item, 4.5));
    assert.equal(insight.detectRecommendations().length, 0, '水位线后仅 2 次，不足 3');

    // 第 3 次新偏差 → 可重新建议（用户习惯会变，系统必须能重新学习）
    t.mock.timers.tick(1000);
    log.append(recoveryTakenDraft(item, 4.5));
    const again = insight.detectRecommendations();
    assert.equal(again.length, 1, '水位线后满 3 次应重新建议');
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 14 天窗口外的陈旧样本不计入', (t) => {
  const T = Date.parse('2026-10-15T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => Date.now() });
    const item = mkItem('rec_walk', 2);

    // 3 次偏差，但发生在 20 天前（窗口外）
    const stale = T - 20 * DAY;
    for (let i = 0; i < 3; i++) log.append({ ...recoveryTakenDraft(item, 4.5), at: stale });
    assert.equal(insight.detectRecommendations().length, 0, '窗口外样本不应触发');

    // 补 3 次窗口内的偏差 → 触发
    for (let i = 0; i < 3; i++) log.append(recoveryTakenDraft(item, 4.5));
    assert.equal(insight.detectRecommendations().length, 1);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 证据计数按方向分组，message 含可回溯的因果叙事', () => {
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log });
    const item = mkItem('rec_nap', 1.5);

    // 4 次午睡：3 次调低（0.8）、1 次吻合（1.5）
    log.append(recoveryTakenDraft(item, 0.8));
    log.append(recoveryTakenDraft(item, 0.8));
    log.append(recoveryTakenDraft(item, 0.8));
    log.append(recoveryTakenDraft(item, 1.5));

    const recs = insight.detectRecommendations();
    assert.equal(recs.length, 1);
    const ev = recs[0]!.evidence;
    assert.equal(ev.total, 4, '总次数含吻合的那次');
    assert.equal(ev.adjustedDown, 3);
    assert.equal(ev.adjustedUp, 0);
    assert.equal(ev.matched, 1);
    assert.equal(ev.windowDays, RECOMMEND_WINDOW_DAYS);

    // 因果叙事：用户能自己回溯那 4 次经历，而不是只看到一个统计结论
    const msg = recs[0]!.message;
    assert.ok(msg.includes('4 次'), '应含总次数');
    assert.ok(msg.includes('3 次你把效果调低了'), '应含方向分组的证据计数');
    assert.ok(!msg.includes('你总是'), '语气红线：不得含评价性措辞');

    // pendingRecommendations 从 DB 回读时证据计数不能丢（周报渲染依赖）
    const pending = insight.pendingRecommendations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.evidence.total, 4);
    assert.equal(pending[0]!.evidence.adjustedDown, 3);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 证据计数不受水位线影响（total 描述「你做过什么」，水位线决定「该不该建议」）', (t) => {
  const T = Date.parse('2026-10-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const { log, dir } = tmpLog();
  try {
    const insight = new InsightEngine({ log, now: () => Date.now() });
    const item = mkItem('rec_walk', 2);

    for (let i = 0; i < 3; i++) log.append(recoveryTakenDraft(item, 4.5));
    const recs = insight.detectRecommendations();
    assert.equal(recs[0]!.evidence.total, 3);

    insight.resolveRecommendation(recs[0]!.id, 'rejected');

    // 拒绝后再来 3 次：total 应为 6（历史行为不该被拒绝抹掉），
    // 而有效证据只有拒绝后的 3 条 → 恰好够重新触发
    t.mock.timers.tick(60 * 1000);
    for (let i = 0; i < 3; i++) log.append(recoveryTakenDraft(item, 4.5));
    const again = insight.detectRecommendations();
    assert.equal(again.length, 1);
    assert.equal(again[0]!.evidence.total, 6, '总次数含拒绝前的历史');
    assert.equal(again[0]!.samples, 3, '有效证据只算水位线之后');
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('insight: 周报计算均值/极值/叙事', () => {
  const { log, dir } = tmpLog();
  try {
    log.append(energySetDraft(5, 0, '晨间基线'));
    log.append(energyDeltaDraft(3));
    log.append(energyDeltaDraft(-5));
    const insight = new InsightEngine({ log });
    const r = insight.weeklyReport();
    assert.equal(r.avgEnergy > 0, true);
    assert.equal(r.maxEnergy, 8);
    assert.equal(r.minEnergy, 3);
    assert.equal(r.daily.length, 7);
    assert.ok(r.narrative.length >= 2);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────── WeatherSensor ─────────────────────────── */

test('weather: WMO 码归一化', () => {
  assert.equal(wmoToCondition(0), 'sunny');
  assert.equal(wmoToCondition(2), 'sunny');
  assert.equal(wmoToCondition(3), 'cloudy');
  assert.equal(wmoToCondition(45), 'cloudy');
  assert.equal(wmoToCondition(61), 'rain');
  assert.equal(wmoToCondition(80), 'rain');
  assert.equal(wmoToCondition(71), 'rain'); // 雪按雨处理（v1 四语义）
  assert.equal(wmoToCondition(95), 'thunderstorm');
  assert.equal(wmoToCondition(99), 'thunderstorm');
});

test('weather: live 成功 → 入事件流；失败 → 降级链', async () => {
  const { log, dir } = tmpLog();
  try {
    // 成功路径
    const okSensor = new WeatherSensor({
      log,
      fetcher: async () => ({ condition: 'rain', tempC: 22.5 }),
    });
    const w = await okSensor.refresh();
    assert.equal(w.source, 'live');
    assert.equal(w.condition, 'rain');
    assert.equal(w.tempC, 22.5);
    assert.equal(log.byType('weather.observed').length, 1);
    assert.equal(okSensor.current().source, 'live');

    // 失败路径 → 使用事件流缓存（source: cache）
    const badSensor = new WeatherSensor({
      log,
      fetcher: async () => { throw new Error('offline'); },
    });
    const w2 = await badSensor.refresh();
    assert.equal(w2.source, 'cache');
    assert.equal(w2.condition, 'rain');

    // 无缓存失败 → fallback
    const { log: log2, dir: dir2 } = tmpLog();
    const s3 = new WeatherSensor({ log: log2, fetcher: async () => { throw new Error('x'); } });
    const w3 = await s3.refresh();
    assert.equal(w3.source, 'fallback');
    assert.equal(w3.condition, FALLBACK_WEATHER.condition);
    log2.close(); rmSync(dir2, { recursive: true, force: true });
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────── 事件流完整性 ─────────────────────────── */

test('events: 事件流只增不改，id 递增', () => {
  const { log, dir } = tmpLog();
  try {
    const e1 = log.append(energySetDraft(10, 0));
    const e2 = log.append(energyDeltaDraft(1));
    const e3 = log.append(energyDeltaDraft(-2));
    assert.ok(e1.id < e2.id && e2.id < e3.id);
    assert.equal(log.allEvents().length, 3);
    assert.equal(log.lastEventId(), e3.id);
    // since 增量
    assert.equal(log.since(e1.id).length, 2);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('events: predicted/actual 字段持久化（学习铺路）', () => {
  const { log, dir } = tmpLog();
  try {
    const item = mkItem('rec_music', 1.5);
    log.append(recoveryTakenDraft(item, 3));
    const ev = log.byType('recovery.taken')[0]!;
    assert.equal(ev.predicted_delta, 1.5);
    assert.equal(ev.actual_delta, 3);
    // 重启后仍在
    log.close();
    const log2 = new DecisionLog({ dbPath: join(dir, 'test.db') });
    const ev2 = log2.byType('recovery.taken')[0]!;
    assert.equal(ev2.predicted_delta, 1.5);
    assert.equal(ev2.actual_delta, 3);
    log2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('localDateStr 格式', () => {
  assert.match(localDateStr(new Date(2026, 9, 20)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDateStr(new Date(2026, 0, 5)), '2026-01-05');
});

/* ─────────────────────────── 工具 ─────────────────────────── */

let fakeSeq = 0;
function fakeEvent(type: DomainEvent['type'], predicted: number | null, actual: number | null, payload: DomainEvent['payload'], at = Date.now()): DomainEvent {
  fakeSeq += 1;
  return { id: fakeSeq, type, at, source: 'user', predicted_delta: predicted, actual_delta: actual, energy_after: null, payload };
}

// 推荐相关事件工厂也过一遍（确保 drafts 构造正确）
test('events: 推荐处置 drafts 构造', () => {
  const a = recAcceptedDraft('r1', 'item1', 3);
  assert.equal(a.type, 'recommendation.accepted');
  assert.equal(a.source, 'ai');
  const r = recRejectedDraft('r2', 'item2');
  assert.equal(r.type, 'recommendation.rejected');
});

test('task.completed draft: predicted 固定 +4，actualMinutes 透传', () => {
  const t = { id: 't1', title: 'x', estCost: 3, estMinutes: 45, status: 'open' as const, createdAt: 0, dueAt: null, actualMinutes: null };
  const d = taskCompletedDraft(t, -2, 'note');
  assert.equal(d.predicted_delta, 4);       // 需求 3：完成事件默认恢复 +4（与 actualDelta 无关）
  assert.equal(d.actual_delta, -2);
  // 未传时长 → payload 里为 null（不能是 undefined，否则 JSON 落库后字段丢失）
  assert.equal((d.payload as { actualMinutes?: number | null }).actualMinutes, null);
  // 传入时长 → 原样落 payload
  const d2 = taskCompletedDraft(t, -2, 'note', 62.5);
  assert.equal((d2.payload as { actualMinutes?: number | null }).actualMinutes, 62.5);
});
