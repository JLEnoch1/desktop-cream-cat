/**
 * pose-fsm 单测 —— CatFsm 自定义姿势状态（'pose'）与 applyCustomPose 纯函数。
 *
 * 覆盖：包络形状（0→1→0）、数值插值/枚举过半程切换、anim 正弦扰动、
 * playPose 行为（气泡/表情插播/paused 拒绝/睡眠中唤醒摆姿势）、
 * 定时回 idle、拖拽打断即弃覆盖、poseSkinState 帧源映射、play-pose 命令通道。
 *
 * CatFsm 只依赖 performance.now 与纯函数 mood，可在 node 直接实例化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CatFsm, applyCustomPose, poseEnv, type CatPose } from '../src/renderer/cat/cat-fsm.js';
import { NEUTRAL_MOOD } from '../src/renderer/cat/mood.js';
import { createSpriteSkin } from '../src/renderer/cat/sprite-skin.js';
import type { CustomPoseDef } from '../src/core/types.js';

/* ─────────────────────────── 桩环境 ─────────────────────────── */

function makeFsm() {
  const bubbles: { text: string; ms?: number }[] = [];
  const exprs: string[] = [];
  const moves: [number, number][] = [];
  const fsm = new CatFsm({
    moveWindow: (x, y) => moves.push([x, y]),
    setDragActive: () => {},
    bubble: (text, ms) => bubbles.push({ text, ms }),
    playExpr: (n) => { exprs.push(n); return true; },
    moodParams: () => NEUTRAL_MOOD,
    petLines: () => ['喵'],
  });
  fsm.initLayout({ x: 0, y: 0, w: 1440, h: 900, winW: 360, winH: 424, groundY: 900 - 424 });
  return { fsm, bubbles, exprs, moves };
}

const basePose = (): CatPose => ({
  face: 1, sx: 1, sy: 1, rot: 0,
  eyes: 'open', mouth: 'w',
  pawL: 0, pawR: 0,
  legsOn: false, legPh: 0, splay: 0,
  tailPh: 0, tailAmp: 1,
  headTilt: 0, tailWrap: false,
  earL: 0, earR: 0,
  zzz: false, zzzPh: 0, blush: false,
});

const def = (over: Partial<CustomPoseDef> = {}): CustomPoseDef => ({
  id: 'test-pose', name: '测试', duration: 2, ...over,
});

/* ─────────────────────────── 纯函数：包络与覆盖 ─────────────────────────── */

test('poseEnv: 起点 0 → 中段 1 → 终点 0', () => {
  assert.equal(poseEnv(0, 3), 0);
  assert.equal(poseEnv(1.5, 3), 1);
  assert.equal(poseEnv(3, 3), 0);
  assert.ok(poseEnv(0.11, 3) > 0 && poseEnv(0.11, 3) < 1); // 淡入坡上
  assert.equal(poseEnv(99, 3), 0); // 超时不复活
});

test('applyCustomPose: env=1 数值到位、枚举生效；env=0 原样不动', () => {
  const d = def({ pose: { sx: 1.2, sy: 0.8, rot: 0.3, pawR: 1, tailAmp: 2.5, eyes: 'closed', mouth: 'o', blush: true, tailWrap: true } });

  const p0 = basePose();
  applyCustomPose(p0, d, 0, 0);
  assert.equal(p0.sx, 1);
  assert.equal(p0.eyes, 'open'); // env<0.5 不切枚举
  assert.equal(p0.blush, false);

  const p1 = basePose();
  applyCustomPose(p1, d, 1, 0);
  assert.ok(Math.abs(p1.sx - 1.2) < 1e-9);
  assert.ok(Math.abs(p1.sy - 0.8) < 1e-9);
  assert.ok(Math.abs(p1.rot - 0.3) < 1e-9);
  assert.ok(Math.abs(p1.pawR - 1) < 1e-9);
  assert.ok(Math.abs(p1.tailAmp - 2.5) < 1e-9);
  assert.equal(p1.eyes, 'closed');
  assert.equal(p1.mouth, 'o');
  assert.equal(p1.blush, true);
  assert.equal(p1.tailWrap, true);

  // 半程插值：env=0.5 → sx 在 1 与 1.2 正中
  const ph = basePose();
  applyCustomPose(ph, d, 0.5, 0);
  assert.ok(Math.abs(ph.sx - 1.1) < 1e-9);
  assert.equal(ph.eyes, 'closed'); // env≥0.5 已切换
});

test('applyCustomPose: anim 正弦扰动随 env 缩放；bounce 联动 sx 体积守恒', () => {
  const sway = def({ anim: { swayAmp: 0.1, swayFreq: 1 } });
  const p = basePose();
  applyCustomPose(p, sway, 1, 0.25); // sin(0.25·2π)=1 → rot=+0.1
  assert.ok(Math.abs(p.rot - 0.1) < 1e-9);
  const p2 = basePose();
  applyCustomPose(p2, sway, 0.5, 0.25);
  assert.ok(Math.abs(p2.rot - 0.05) < 1e-9); // 幅度 × env

  const bounce = def({ anim: { bounceAmp: 0.1, bounceFreq: 1 } });
  const p3 = basePose();
  applyCustomPose(p3, bounce, 1, 0.25); // sin=1 → sy×1.1, sx×(1-0.06)
  assert.ok(Math.abs(p3.sy - 1.1) < 1e-9);
  assert.ok(Math.abs(p3.sx - 0.94) < 1e-9);
});

/* ─────────────────────────── FSM：pose 状态生命周期 ─────────────────────────── */

test('playPose: 进入 pose 态；气泡与表情插播按 def 触发', () => {
  const { fsm, bubbles, exprs } = makeFsm();
  const ok = fsm.playPose(def({ text: '喵呜~', expression: 'happy', duration: 3 }));
  assert.equal(ok, true);
  assert.equal(fsm.st, 'pose');
  assert.deepEqual(bubbles, [{ text: '喵呜~', ms: 2700 }]); // clamp(3*900,1200,4200)
  assert.deepEqual(exprs, ['happy']);
  // 无 text/expression 的 def 不触发
  const { fsm: f2, bubbles: b2, exprs: e2 } = makeFsm();
  f2.playPose(def());
  assert.equal(b2.length, 0);
  assert.equal(e2.length, 0);
});

test('playPose: paused 拒绝；睡眠中触发会醒来摆姿势', () => {
  const { fsm } = makeFsm();
  fsm.paused = true;
  assert.equal(fsm.playPose(def()), false);
  assert.equal(fsm.st, 'idle');
  fsm.paused = false;

  fsm.set('sleep');
  assert.equal(fsm.playPose(def()), true);
  assert.equal(fsm.st, 'pose'); // 明确意图 → 起床摆
});

test('update: duration 到点自动回 idle；pose 期间不自主散步', () => {
  const { fsm } = makeFsm();
  fsm.playPose(def({ duration: 1 }));
  for (let i = 0; i < 12; i++) fsm.update(0.1); // 1.2s > 1s
  assert.equal(fsm.st, 'idle');
});

test('computePose: pose 态应用覆盖；拖拽打断后立即弃覆盖', () => {
  const { fsm } = makeFsm();
  fsm.playPose(def({ duration: 3, pose: { sx: 1.3, eyes: 'happy' }, anim: { swayAmp: 0.08, swayFreq: 2 } }));
  for (let i = 0; i < 10; i++) fsm.update(0.1); // stT=1s → env=1
  const p = fsm.computePose();
  assert.ok(Math.abs(p.sx - 1.3) < 0.02, `sx 应≈1.3（含 bounce/sway 无 sx 干扰），实际 ${p.sx}`);
  assert.equal(p.eyes, 'happy');

  // 拖拽打断：set('drag') 清 poseDef → 覆盖不再生效
  fsm.set('drag');
  const pd = fsm.computePose();
  assert.equal(pd.sx, 1);
  assert.notEqual(pd.eyes, 'happy');
  assert.equal(fsm.poseSkinState, null);
});

test('poseSkinState: useState 帧源映射（缺省 idle）', () => {
  const { fsm } = makeFsm();
  fsm.playPose(def({ useState: 'sleep', duration: 2 }));
  assert.equal(fsm.poseSkinState, 'sleep');
  fsm.playPose(def({ duration: 2 }));
  assert.equal(fsm.poseSkinState, 'idle');
  fsm.set('idle');
  assert.equal(fsm.poseSkinState, null);
});

test('applyCmd: play-pose 命令通道（与右键菜单同链路）', () => {
  const { fsm } = makeFsm();
  fsm.applyCmd({ type: 'play-pose', pose: def({ id: 'via-cmd', text: '来喽' }) });
  assert.equal(fsm.st, 'pose');
  assert.equal(fsm.poseSkinState, 'idle');
});

test('pose 态 legsOn 覆盖时 legPh 原地推进（踏腿感）', () => {
  const { fsm } = makeFsm();
  fsm.playPose(def({ duration: 5, pose: { legsOn: true } }));
  const ph0 = fsm.legPh;
  fsm.update(0.1);
  assert.ok(fsm.legPh > ph0);
  const p = fsm.computePose();
  assert.equal(p.legsOn, false); // env<0.5 起步阶段布尔未切换（0.1s 处）
  for (let i = 0; i < 5; i++) fsm.update(0.1); // stT=0.6 → env=1
  assert.equal(fsm.computePose().legsOn, true);
});

/* ─────────────────── 渲染链路守护：sprite-skin 缩放单源 ─────────────────── */

/** Image 桩：设 src 后微任务触发 onload（sprite-skin loadFrames 可 await） */
class FakeImage {
  naturalWidth = 200;
  naturalHeight = 140;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private v = '';
  get src(): string { return this.v; }
  set src(s: string) { this.v = s; queueMicrotask(() => this.onload?.()); }
}

/** ctx 记录桩：只关心 scale() 参数序列（本体缩放 = face*sx, sy） */
const scales: [number, number][] = [];
const ctxStub = {
  canvas: {},
  globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
  save() {}, restore() {}, translate() {}, rotate() {},
  scale(x: number, y: number): void { scales.push([x, y]); },
  drawImage() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
  ellipse() {}, arc() {}, quadraticCurveTo() {}, bezierCurveTo() {},
  fill() {}, stroke() {}, fillRect() {}, fillText() {},
  measureText: () => ({ width: 10 }),
} as unknown as CanvasRenderingContext2D;

test('sprite-skin: CatPose.sx/sy 单一来源直通本体缩放（姿势缩放渲染守护）', async () => {
  const skin = await createSpriteSkin(
    { states: { idle: { frames: ['idle.png'] } } },
    {
      ctx: ctxStub, cx: 180, ground: 374, fps: 8, targetHeight: 250,
      ImageCtor: FakeImage as unknown as new () => HTMLImageElement,
    },
  );

  // 姿势覆盖后的 sx/sy 必须原样进 drawBody 的 ctx.scale
  skin.draw({ face: 1, rot: 0, sx: 1.35, sy: 0.75 }, 1.0, { state: 'idle', stateT: 0, dt: 0.016 });
  assert.ok(
    scales.some(([x, y]) => Math.abs(x - 1.35) < 1e-9 && Math.abs(y - 0.75) < 1e-9),
    `本体缩放应含 (1.35, 0.75)，实际 ${JSON.stringify(scales)}`,
  );

  // 不传 sx/sy（既有调用方形态）→ 1:1，行为与修复前一致
  scales.length = 0;
  skin.draw({ face: 1, rot: 0 }, 1.016, { state: 'idle', stateT: 0, dt: 0.016 });
  assert.ok(scales.some(([x, y]) => x === 1 && y === 1), `缺省应 1:1，实际 ${JSON.stringify(scales)}`);
});
