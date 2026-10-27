/**
 * 精力外化（vitality）单测 —— 「宠物的精力变化绑定宠物外化变化」。
 *
 * 链路：energy → computeMoodParams.vitality → FSM 平滑（approachVitality）
 *       → computePose 姿态量（vitalityPoseMods）→ 皮肤忠实呈现 p.sx/sy/rot。
 *
 * 契约：
 *  1. 参数映射端点与单调性：低精力「走不动/没精力/很快睡」，高精力「轻快/坐不住」；
 *  2. vitalityPoseMods v=1 锚定旧基线（满精力/NEUTRAL 皮肤零改变），外化只朝低落方向
 *     下沉 + 步态弹跳略超基线（高涨）；
 *  3. vit 指数平滑：精力一变（消耗/恢复落库、调节预览拖动）姿态连续过渡，绝不跳变
 *     ——「每次消耗与恢复都记在它身上」= 肉眼可见地低落下去 / 高涨起来；
 *  4. FSM 集成：低活力 → pose 瘫软下沉（sy 压缩）+ 垂头（rot 随 face 变号）+ 耳耷拉
 *     + 尾巴无力；高活力 → 基线挺拔。
 *
 * CatFsm 只依赖 performance.now 与纯函数 mood（同 pose-fsm.test.ts），可在 node 直接实例化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CatFsm, approachVitality, vitalityPoseMods, VITALITY_TAU,
} from '../src/renderer/cat/cat-fsm.js';
import {
  computeMoodParams, withPreviewEnergy, NEUTRAL_MOOD, type MoodParams, type MoodInput,
} from '../src/renderer/cat/mood.js';
import type { CatMoodPayload } from '../src/core/types.js';

/* ─────────────────────────── 桩环境（同 pose-fsm 模式） ─────────────────────────── */

function makeFsm(params: () => MoodParams) {
  const fsm = new CatFsm({
    moveWindow: () => {},
    setDragActive: () => {},
    bubble: () => {},
    playExpr: () => true,
    moodParams: params,
    petLines: () => ['喵'],
  });
  fsm.initLayout({ x: 0, y: 0, w: 1440, h: 900, winW: 360, winH: 424, groundY: 900 - 424 });
  return fsm;
}

function makeMood(energy: number): MoodInput {
  const base: CatMoodPayload = {
    energy,
    weather: { condition: 'sunny', tempC: 22, source: 'live', at: 0 },
    emotion: {
      energy, base: 'calm', overlay: 'none', pulse: 'none',
      composite: 'calm', headline: '', pulseActive: false,
    },
  };
  return base;
}

/** 固定步长推进 n 帧（t = n*dt，确定性：避开抖耳窗/状态切换） */
function step(fsm: CatFsm, n: number, dt = 0.1): void {
  for (let i = 0; i < n; i++) fsm.update(dt);
}

/* ─────────────────────────── 1. 参数映射：走不动 ↔ 高涨 ─────────────────────────── */

test('computeMoodParams: vitality = energy/10（精力→外化的单一输入）', () => {
  assert.equal(computeMoodParams(makeMood(0)).vitality, 0);
  assert.equal(computeMoodParams(makeMood(5)).vitality, 0.5);
  assert.equal(computeMoodParams(makeMood(10)).vitality, 1);
  assert.equal(computeMoodParams(makeMood(99)).vitality, 1); // 越界钳制
  assert.equal(NEUTRAL_MOOD.vitality, 1); // 领域未就绪 = 中性挺拔，皮肤零改变
});

test('computeMoodParams: 低精力「走不动/没精力/很快睡」，高精力「轻快/坐不住」', () => {
  const lo = computeMoodParams(makeMood(0));
  const hi = computeMoodParams(makeMood(10));
  assert.equal(lo.walkSpeed, 16); // 拖步（旧 28）
  assert.equal(hi.walkSpeed, 48); // 轻快（旧 46）
  assert.equal(lo.sleepIdleMs, 9_000); // 没精力：9s 就睡过去（旧 12s）
  assert.equal(hi.sleepIdleMs, 45_000);
  assert.ok(lo.activity < 0.2, '低精力基本不动');
  assert.ok(hi.activity > 1.2, '高精力坐不住');
});

test('computeMoodParams: 全量程逐点单调（0→10 步长 0.5，跨档无跳变方向反转）', () => {
  let prev = computeMoodParams(makeMood(0));
  for (let e = 0.5; e <= 10; e += 0.5) {
    const cur = computeMoodParams(makeMood(e));
    assert.ok(cur.walkSpeed >= prev.walkSpeed, `walkSpeed 非单调 @${e}`);
    assert.ok(cur.activity >= prev.activity, `activity 非单调 @${e}`);
    assert.ok(cur.sleepIdleMs >= prev.sleepIdleMs, `sleepIdleMs 非单调 @${e}`);
    assert.ok(cur.vitality > prev.vitality, `vitality 非单调 @${e}`);
    prev = cur;
  }
});

test('调节预览也外化：withPreviewEnergy(0.5) → vitality 0.05（拖动滑条猫即低落）', () => {
  const eff = withPreviewEnergy(makeMood(9.5), 0.5);
  assert.ok(Math.abs(computeMoodParams(eff).vitality - 0.05) < 1e-9);
});

/* ─────────────────────────── 2. 姿态量纯函数 ─────────────────────────── */

test('vitalityPoseMods: v=1 锚定旧基线（syScale/tailScale=1、droop/earDroop=0）', () => {
  const m = vitalityPoseMods(1);
  assert.equal(m.syScale, 1);
  assert.equal(m.tailScale, 1);
  assert.equal(m.droopRot, 0);
  assert.equal(m.earDroop, 0);
  assert.ok(m.bounce >= 0.02, '高涨步态弹跳不低于旧固定值 0.02');
});

test('vitalityPoseMods: v=0 低落端（瘫软下沉 10% + 垂头 + 耳耷拉 + 尾巴无力 + 拖步）', () => {
  const m = vitalityPoseMods(0);
  assert.ok(Math.abs(m.syScale - 0.9) < 1e-9);
  assert.ok(Math.abs(m.droopRot - 0.09) < 1e-9);
  assert.ok(Math.abs(m.earDroop - 0.18) < 1e-9);
  assert.ok(Math.abs(m.tailScale - 0.45) < 1e-9);
  assert.ok(m.bounce < 0.01, '拖步无弹跳');
});

test('vitalityPoseMods: 各分量随 v 单调 + 越界钳制', () => {
  let prev = vitalityPoseMods(0);
  for (let v = 0.1; v <= 1.0; v += 0.1) {
    const cur = vitalityPoseMods(v);
    assert.ok(cur.syScale > prev.syScale);
    assert.ok(cur.tailScale > prev.tailScale);
    assert.ok(cur.bounce > prev.bounce);
    assert.ok(cur.droopRot < prev.droopRot);
    assert.ok(cur.earDroop < prev.earDroop);
    prev = cur;
  }
  assert.deepEqual(vitalityPoseMods(-1), vitalityPoseMods(0));
  assert.deepEqual(vitalityPoseMods(2), vitalityPoseMods(1));
});

/* ─────────────────────────── 3. 平滑：消耗/恢复「记在身上」的过渡 ─────────────────────────── */

test('approachVitality: 一个时间常数走到 ~63%，绝不过冲，帧率无关', () => {
  const after1Tau = approachVitality(1, 0, VITALITY_TAU);
  assert.ok(Math.abs(after1Tau - (1 - 0.6321)) < 0.002, `1τ 后应剩 ~36.8%，实际 ${after1Tau}`);
  // 帧率无关：1×dt 与 2×(dt/2) 结果一致
  const a = approachVitality(0.5, 1, 0.2);
  const b = approachVitality(approachVitality(0.5, 1, 0.1), 1, 0.1);
  assert.ok(Math.abs(a - b) < 1e-9);
  // 不过冲
  assert.ok(approachVitality(0, 1, 10) <= 1);
  assert.ok(approachVitality(1, 0, 10) >= 0);
  // 目标钳制
  assert.equal(approachVitality(0.5, 99, 60), 1);
});

test('FSM: 消耗落库（vitality 0.95→0.05）→ vit 连续低落下去；恢复 → 高涨回来', () => {
  let p = { ...NEUTRAL_MOOD, vitality: 0.95 };
  const fsm = makeFsm(() => p);
  step(fsm, 30, 0.05); // 1.5s：vit 已贴 0.95
  assert.ok(fsm.vitality() > 0.9, `起点应贴满精力，实际 ${fsm.vitality()}`);
  p = { ...p, vitality: 0.05 }; // 一笔大消耗落库
  step(fsm, 10, 0.05); // 0.5s ≈ 1τ：过渡中途，既没瞬变也没到位
  const mid = fsm.vitality();
  assert.ok(mid < 0.7 && mid > 0.15, `0.5s 应在过渡中段，实际 ${mid}`);
  step(fsm, 120, 0.05); // 再 6s ≈ 11τ：到位
  assert.ok(fsm.vitality() < 0.06, `应收敛到低精力，实际 ${fsm.vitality()}`);
  p = { ...p, vitality: 0.95 }; // 恢复项落库
  step(fsm, 120, 0.05);
  assert.ok(fsm.vitality() > 0.94, `应收敛回高涨，实际 ${fsm.vitality()}`);
});

/* ─────────────────────────── 4. FSM 集成：pose 外化 ─────────────────────────── */

test('FSM computePose: 低活力 → 瘫软下沉（sy 压缩）+ 尾巴无力；高活力 → 基线挺拔', () => {
  const lo = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 0 }));
  const hi = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 1 }));
  // 2.4s（≈4.4τ）：vit 收敛到 ~1.3%，且 stT < 初始 nextWalkIn 下限 2.5s → 确定性 idle
  step(lo, 24, 0.1);
  step(hi, 24, 0.1);
  assert.ok(lo.vitality() < 0.015 && hi.vitality() > 0.999);
  assert.equal(lo.st, 'idle');
  assert.equal(hi.st, 'idle');
  // 同一确定性时刻比较（呼吸相位一致）：低活力 sy 压缩 ~7%
  hi.t = lo.t;
  hi.stT = lo.stT;
  const plo = lo.computePose();
  const phi = hi.computePose();
  assert.ok(plo.sy < phi.sy * 0.95, `低活力应瘫软下沉：sy ${plo.sy} vs ${phi.sy}`);
  assert.ok(plo.tailAmp < phi.tailAmp * 0.5, `低活力尾巴应无力：${plo.tailAmp} vs ${phi.tailAmp}`);
});

test('FSM computePose: 低活力垂头（rot 随 face 变号 = 永远向前耷拉），满精力归零', () => {
  const lo = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 0 }));
  step(lo, 60, 0.1);
  lo.dir = 1;
  const rRight = lo.computePose().rot;
  lo.dir = -1;
  const rLeft = lo.computePose().rot;
  assert.ok(rRight > 0.08, `面朝右应向前(顺时针)耷拉：${rRight}`);
  assert.ok(rLeft < -0.08, `面朝左应镜像耷拉：${rLeft}`);
  const hi = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 1 }));
  step(hi, 60, 0.1);
  assert.ok(Math.abs(hi.computePose().rot) < 1e-9, '满精力 idle 不垂头');
});

test('FSM computePose: 低活力耳朵耷拉基线（v=1 保持 0/抖耳不受扰）', () => {
  const lo = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 0 }));
  step(lo, 24, 0.1); // t=2.4：vit 收敛；2.4%4.7>0.16 且 2.4%6.1>0.14 → 避开抖耳窗
  const p = lo.computePose();
  assert.ok(p.earL >= 0.17 && p.earR >= 0.17, `低精力耳应耷拉：L=${p.earL} R=${p.earR}`);
  const hi = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 1 }));
  step(hi, 24, 0.1);
  const q = hi.computePose();
  assert.equal(q.earL, 0);
  assert.equal(q.earR, 0);
});

test('FSM: 睡姿不再被压扁（sy≈1 仅呼吸微动，低/高精力一致）', () => {
  const lo = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 0 }));
  step(lo, 60, 0.1);
  lo.sleepNow();
  const p = lo.computePose();
  const hi = makeFsm(() => ({ ...NEUTRAL_MOOD, vitality: 1 }));
  step(hi, 60, 0.1);
  hi.sleepNow();
  const q = hi.computePose();
  assert.ok(Math.abs(p.sy - q.sy) < 1e-9, `睡姿 sy 应与 vitality 无关：lo=${p.sy} hi=${q.sy}`);
  assert.ok(Math.abs(q.sy - 1) < 0.05, `睡姿不再整体压扁（sy≈1，仅呼吸微动）：${q.sy}`);
  assert.equal(p.zzz, true);
});
