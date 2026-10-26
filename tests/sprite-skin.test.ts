/**
 * sprite-skin 单测 —— 移植自 desktop-pet test/sprite-skin.test.js（M2）。
 *
 * 源测试用全局 Image/ctx 桩驱动 window.createSpriteSkin；本版改为模块化调用：
 *  - FakeImage 经 opts.ImageCtor 注入（设 src 后微任务触发 onload，尺寸可配）
 *  - ctx 用最小 CanvasRenderingContext2D 记录桩（drawn 记 drawImage 图像 tag，
 *    calls 记各方法调用次数），经 as unknown as CanvasRenderingContext2D 收窄
 *
 * 覆盖源测试全部用例：帧时钟/fps 取帧、表情插播、once+hold 回落、未知表情
 * 返回 false、切状态清零帧时钟 + 边界交叉溶解层序、步态引擎（起步相位归零/
 * 步内交叉溶解双层/换帧点连续/速度同步钳制/状态边界相位重置）、N 帧循环
 * （着地帧 bob≈0、过渡帧峰值）、小步扫描换帧无跳变；
 * 另补：表情重入从头播、expressionNames、状态回退链、缺 idle 拒绝；
 * 融合扩展：setOverlay 天气挂件、setPulse 脉冲光晕。
 *
 * node:test 顶层 test 按注册顺序串行执行，多个 skin 共享同一 ctx/drawn 桩
 * （与源测试的全局桩语义一致）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpriteSkin } from '../src/renderer/cat/sprite-skin.js';
import type { DrawInfo, SkinAssetsV2, SkinPose, SpriteSkin } from '../src/renderer/cat/sprite-skin.js';

/* ─────────────────────────── 桩环境 ─────────────────────────── */

/** Image 桩：设 src 后异步（微任务）触发 onload；naturalWidth/Height 可配（默认 200×140） */
class FakeImage {
  /** 可配尺寸：加载任何 url 都用这组默认值 */
  static natW = 200;
  static natH = 140;
  /** 记录 src，供 drawImage 断言帧序 */
  tag = '';
  naturalWidth = FakeImage.natW;
  naturalHeight = FakeImage.natH;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(v: string) {
    this.tag = v;
    queueMicrotask(() => {
      this.onload?.();
    });
  }
}
const ImageCtor = FakeImage as unknown as new () => HTMLImageElement;

/** ctx 记录桩：drawn = drawImage 的图像 tag 序列；calls = 各方法调用计数 */
const drawn: string[] = [];
const calls: Record<string, number> = {};
function bump(name: string): void {
  calls[name] = (calls[name] ?? 0) + 1;
}
const gradientStub = { addColorStop(): void {} };
const ctxRaw = {
  canvas: {},
  globalAlpha: 1,
  fillStyle: '' as unknown,
  strokeStyle: '' as unknown,
  lineWidth: 1,
  font: '',
  lineJoin: '',
  lineCap: '',
  save(): void { bump('save'); },
  restore(): void { bump('restore'); },
  translate(): void { bump('translate'); },
  rotate(): void { bump('rotate'); },
  scale(): void { bump('scale'); },
  drawImage(img: unknown): void {
    bump('drawImage');
    drawn.push((img as FakeImage).tag);
  },
  beginPath(): void { bump('beginPath'); },
  closePath(): void { bump('closePath'); },
  moveTo(): void { bump('moveTo'); },
  lineTo(): void { bump('lineTo'); },
  bezierCurveTo(): void { bump('bezierCurveTo'); },
  ellipse(): void { bump('ellipse'); },
  arc(): void { bump('arc'); },
  fill(): void { bump('fill'); },
  stroke(): void { bump('stroke'); },
  fillText(): void { bump('fillText'); },
  createRadialGradient(): typeof gradientStub {
    bump('createRadialGradient');
    return gradientStub;
  },
};
const ctx = ctxRaw as unknown as CanvasRenderingContext2D;

/** 计数快照 / 差值：验证「一次 draw 期间某方法被调用了几次」 */
function snapshot(): Record<string, number> {
  return { ...calls };
}
function diff(before: Record<string, number>, name: string): number {
  return (calls[name] ?? 0) - (before[name] ?? 0);
}

/* ─────────────────────── 素材（与源测试一致） ─────────────────────── */

const assets1: SkinAssetsV2 = {
  states: {
    idle: { frames: ['idle'] },
    walk: { frames: ['w1', 'w2'], fps: 2 },
  },
  expressions: {
    happy: { frames: ['h1'], fps: 10, once: true, hold: 0.1 },
  },
};
const assets2: SkinAssetsV2 = {
  states: {
    idle: { frames: ['i'] },
    walk: {
      frames: ['w1', 'w2'],
      anim: { interval: [0.2, 0.2], refSpeed: 46, crossfade: 0.5, entryT: 0.05, stateXfade: 0.1 },
    },
  },
  expressions: {},
};
// N 帧循环（4 帧：着地 c / 过渡 p 交替，AI 补帧后的形态）
const assets3: SkinAssetsV2 = {
  states: {
    idle: { frames: ['i3'] },
    walk: {
      frames: ['c0', 'p1', 'c2', 'p3'],
      anim: { interval: [0.2, 0.2], refSpeed: 46, bobAmp: 4, entryT: 0.01, crossfade: 0, stateXfade: 0 },
    },
  },
  expressions: {},
};

const pose: SkinPose = { face: 1, rot: 0 };
const info = (state: string, dt: number): DrawInfo => ({ state, dt, stateT: 0, squashT: 0, air: 0 });
const winfo = (dt: number, speed?: number): DrawInfo => ({
  state: 'walk', dt, stateT: 0, squashT: 0, air: 0, speed: speed ?? 0,
});

const skinOpts = { ctx, cx: 180, ground: 374, fps: 8, ImageCtor } as const;
const skin: SpriteSkin = await createSpriteSkin(assets1, skinOpts);
const skin2: SpriteSkin = await createSpriteSkin(assets2, skinOpts);
const skin3: SpriteSkin = await createSpriteSkin(assets3, skinOpts);

/* ─────────── 帧时钟 / 表情队列（skin1，与源测试共享时钟 tNow） ─────────── */

let tNow = 0;

test('sprite-skin: 1) walk 2 帧 @2fps：0.25s 步进 → 帧序 w1 w2 w2 w1', () => {
  drawn.length = 0;
  for (let i = 0; i < 4; i++) {
    tNow += 0.25;
    skin.draw(pose, tNow, info('walk', 0.25));
  }
  // 时钟 0.25/0.5/0.75/1.0 × 2fps → 帧 0/1/1/0
  assert.deepEqual(drawn, ['w1', 'w2', 'w2', 'w1']);
});

test('sprite-skin: 2) 表情插播：play 后下一帧画 h1（覆盖状态帧）', () => {
  assert.equal(skin.playExpression('happy'), true);
  drawn.length = 0;
  tNow += 0.05;
  skin.draw(pose, tNow, info('walk', 0.05));
  assert.equal(drawn[0], 'h1');
});

test('sprite-skin: 3) once(0.1s)+hold(0.1s) 播完后回落状态帧', () => {
  drawn.length = 0;
  for (let i = 0; i < 5; i++) {
    tNow += 0.06;
    skin.draw(pose, tNow, info('walk', 0.06));
  }
  assert.ok(
    drawn.slice(-2).every((d) => d === 'w1' || d === 'w2'),
    `应回落到 walk 帧: ${drawn}`,
  );
});

test('sprite-skin: 4) 未知表情静默返回 false', () => {
  assert.equal(skin.playExpression('nope'), false);
});

test('sprite-skin: 4b) 同名表情重入从头播（时钟归零，once+hold 重新计时）', () => {
  // 先播 0.15s（逼近 once+hold=0.2s 边界）再重入：若时钟未归零，
  // 再播 0.1s 时累计 0.25s 早已回落 walk 帧；归零则 0.1s 处仍是 h1
  assert.equal(skin.playExpression('happy'), true);
  tNow += 0.15;
  skin.draw(pose, tNow, info('walk', 0.15));
  assert.equal(skin.playExpression('happy'), true); // 重入
  drawn.length = 0;
  tNow += 0.1;
  skin.draw(pose, tNow, info('walk', 0.1));
  assert.equal(drawn[drawn.length - 1], 'h1', '重入后应从头播（未到 once+hold）');
  // 重播完 once+hold 后仍正常回落
  tNow += 0.15;
  skin.draw(pose, tNow, info('walk', 0.15));
  const last = drawn[drawn.length - 1];
  assert.ok(last === 'w1' || last === 'w2', `重播结束后应回落 walk 帧: ${drawn}`);
});

test('sprite-skin: 4c) expressionNames 列出已加载表情', () => {
  assert.deepEqual(skin.expressionNames(), ['happy']);
});

test('sprite-skin: 5) 切状态清零帧时钟 + 边界交叉溶解层序 [上一状态帧淡出, w1]', () => {
  for (let i = 0; i < 3; i++) {
    tNow += 0.25;
    skin.draw(pose, tNow, info('idle', 0.25));
  }
  drawn.length = 0;
  tNow += 0.01;
  skin.draw(pose, tNow, info('walk', 0.01));
  assert.equal(drawn[0], 'idle'); // 边界溶解：上一状态最后一帧淡出
  assert.equal(drawn[drawn.length - 1], 'w1'); // 当前帧相位归零
});

/* ─────────── 步态引擎（skin2：anim 配置，两帧走姿） ─────────── */

let t2 = 0;
const step = (dt: number, speed?: number): string[] => {
  t2 += dt;
  drawn.length = 0;
  skin2.draw(pose, t2, winfo(dt, speed));
  return drawn.slice();
};

test('sprite-skin: 6) 起步：相位归零、渐入包络使首帧 bob=0、步时长=interval', () => {
  const batch = step(0.01);
  assert.deepEqual(batch, ['w1']);
  const g = skin2.gaitInfo();
  assert.ok(g, 'walk 后应有步态快照');
  assert.equal(Math.abs(g.bob), 0);
  assert.equal(g.stepDur, 0.2);
});

test('sprite-skin: 7) 步内交叉溶解：phi>0.75 后同帧画两层（w1+w2）', () => {
  let sawXfade = false;
  for (let i = 0; i < 18; i++) {
    if (step(0.01).length === 2) sawXfade = true;
  }
  assert.ok(sawXfade, '应出现步内交叉溶解双层绘制');
});

test('sprite-skin: 8) 换帧点连续：发生 wrap 的那帧 bob 远小于步中值', () => {
  let wrapped = false;
  let g = skin2.gaitInfo();
  for (let i = 0; i < 5 && !wrapped; i++) {
    step(0.01);
    g = skin2.gaitInfo();
    if (g?.idx === 1) wrapped = true;
  }
  assert.ok(wrapped, '应发生换帧');
  assert.ok(g, '应有步态快照');
  assert.ok(Math.abs(g.bob) < 1.0, `换帧点 bob 应接近 0: ${g.bob}`);
});

test('sprite-skin: 9) 速度同步：speed=92（2×ref）→ k 钳制 0.6 → stepDur=0.12', () => {
  for (let i = 0; i < 22; i++) step(0.01, 92);
  const g = skin2.gaitInfo();
  assert.ok(g);
  assert.ok(Math.abs(g.stepDur - 0.12) < 1e-9, `速度同步 stepDur: ${g.stepDur}`);
});

test('sprite-skin: 10) 状态边界：walk→idle 回落单帧；再回 walk 相位重置（idx=0）', () => {
  t2 += 0.01;
  drawn.length = 0;
  skin2.draw(pose, t2, info('idle', 0.01));
  assert.equal(drawn[drawn.length - 1], 'i');
  t2 += 0.01;
  drawn.length = 0;
  skin2.draw(pose, t2, winfo(0.01));
  const g = skin2.gaitInfo();
  assert.ok(g);
  assert.equal(g.idx, 0);
  assert.ok(g.phi < 0.2);
});

/* ─────────── N 帧循环（skin3：4 帧着地/过渡交替） ─────────── */

let t3 = 0;
const step3 = (dt: number): string[] => {
  t3 += dt;
  drawn.length = 0;
  skin3.draw(pose, t3, { state: 'walk', dt, stateT: 0, squashT: 0, air: 0, speed: 0 });
  return drawn.slice();
};

test('sprite-skin: 11) 4 帧循环帧序 c0→p1→c2→p3；着地帧 bob≈0、过渡帧峰值', () => {
  // dt=stepDur=0.2 → 每步 phi 恰好 wrap 归零，采样点正落在换帧点上
  let d = step3(0.2); // 起步 gaitReset(idx=0) 后 advance → 画 p1；首帧 env=0（渐入）
  assert.deepEqual(d, ['p1']);
  let g = skin3.gaitInfo();
  assert.ok(g);
  assert.equal(g.n, 4);
  assert.equal(Math.abs(g.bob), 0); // env=0 → 幅度未渐入

  d = step3(0.2); // idx=2（着地帧）：ph=π → lift≈0 → bob≈0
  assert.deepEqual(d, ['c2']);
  g = skin3.gaitInfo();
  assert.ok(g);
  assert.ok(Math.abs(g.bob) < 1e-6, `着地帧 bob 应≈0: ${g.bob}`);

  d = step3(0.2); // idx=3（过渡帧）：ph=3π/2 → lift=1 → bob=-bobAmp
  assert.deepEqual(d, ['p3']);
  g = skin3.gaitInfo();
  assert.ok(g);
  assert.ok(Math.abs(g.bob + 4) < 1e-6, `过渡帧 bob 应为峰值: ${g.bob}`);

  d = step3(0.2); // idx 回绕到 0（着地帧）
  assert.deepEqual(d, ['c0']);
  g = skin3.gaitInfo();
  assert.ok(g);
  assert.equal(g.idx, 0);
  assert.ok(Math.abs(g.bob) < 1e-6);
});

test('sprite-skin: 12) 换帧点变换量连续：小步扫描多个 wrap，|Δbob| 不超斜率上界', () => {
  const g0 = skin3.gaitInfo();
  assert.ok(g0);
  let prevBob: number | null = null;
  let prevIdx = g0.idx;
  let maxJump = 0;
  let wraps = 0;
  for (let i = 0; i < 40; i++) {
    step3(0.015); // Δph=0.075·π/2 → |Δbob| ≤ 4·sin(0.1178) ≈ 0.47
    const gi = skin3.gaitInfo();
    assert.ok(gi);
    if (prevBob !== null) maxJump = Math.max(maxJump, Math.abs(gi.bob - prevBob));
    if (gi.idx !== prevIdx) wraps++;
    prevBob = gi.bob;
    prevIdx = gi.idx;
  }
  assert.ok(wraps >= 2, `应跨越多个换帧点: ${wraps}`);
  assert.ok(maxJump < 0.6, `相邻采样 bob 增量应在斜率上界内（换帧无跳变）: ${maxJump}`);
});

/* ─────────── 补充：状态回退链 / 缺 idle ─────────── */

test('sprite-skin: 13) 状态回退链：缺失的状态与未知状态全部回落 idle 帧', async () => {
  const assets4: SkinAssetsV2 = { states: { idle: { frames: ['only'] } } };
  const skin4 = await createSpriteSkin(assets4, skinOpts);
  for (const s of ['walk', 'tap', 'sleep', 'drag', 'pet', 'thrown', 'groom', 'no-such-state']) {
    drawn.length = 0;
    tNow += 0.016;
    skin4.draw(pose, tNow, info(s, 0.016));
    assert.ok(drawn.length >= 1, `${s} 应有本体绘制`);
    assert.equal(drawn[drawn.length - 1], 'only', `${s} 应回退 idle 帧`);
  }
});

test('sprite-skin: 14) 缺 idle 素材 → createSpriteSkin 拒绝', async () => {
  await assert.rejects(
    () => createSpriteSkin({ states: { walk: { frames: ['w'] } } }, skinOpts),
    /idle/,
  );
});

/* ─────────── 融合扩展：天气挂件 / 脉冲光晕 ─────────── */

test('sprite-skin: 15) setOverlay：五种天气 draw 均不抛错；rain-drop 有雨丝绘制调用', () => {
  const stepOnce = (): void => {
    tNow += 0.016;
    skin.draw(pose, tNow, info('idle', 0.016));
  };

  skin.setOverlay('none');
  let b = snapshot();
  assert.doesNotThrow(stepOnce);
  // none：本体/阴影只用 drawImage/ellipse/fill，不应出现挂件笔触
  assert.equal(diff(b, 'stroke'), 0);
  assert.equal(diff(b, 'arc'), 0);
  assert.equal(diff(b, 'createRadialGradient'), 0);

  skin.setOverlay('rain-drop');
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.ok(diff(b, 'stroke') >= 5, 'rain-drop 应有云描边 + 4 条雨丝');
  assert.ok(diff(b, 'arc') >= 3, 'rain-drop 云应由 3 段圆弧组成');
  assert.ok(diff(b, 'drawImage') >= 1, '本体仍应正常绘制');

  skin.setOverlay('sunbeam');
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.equal(diff(b, 'createRadialGradient'), 1, 'sunbeam 太阳核心为径向渐变');
  assert.ok(diff(b, 'stroke') >= 9, '8 道光芒 + 核心描边');
  assert.ok(diff(b, 'arc') >= 1, '太阳核心圆');

  skin.setOverlay('cloud-puff');
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.ok(diff(b, 'stroke') >= 1, '云朵描边');
  assert.ok(diff(b, 'arc') >= 3, '云朵 3 段圆弧');

  skin.setOverlay('storm-bolt');
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.ok(diff(b, 'stroke') >= 4, '云描边 + 3 条雨丝（闪电随时间闪现）');

  skin.setOverlay('none'); // 还原，避免影响后续用例
  b = snapshot();
  stepOnce();
  assert.equal(diff(b, 'stroke'), 0);
});

test('sprite-skin: 16) setPulse：grateful×1 → draw 调 createRadialGradient；none×0 → 不调', () => {
  const stepOnce = (): void => {
    tNow += 0.016;
    skin.draw(pose, tNow, info('idle', 0.016));
  };
  skin.setOverlay('none'); // 排除 sunbeam 渐变的干扰

  skin.setPulse('grateful', 1);
  let b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.equal(diff(b, 'createRadialGradient'), 1, '光晕应画一次径向渐变');
  assert.ok(diff(b, 'ellipse') >= 2, '光晕椭圆 + 接地阴影');

  skin.setPulse('none', 0);
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.equal(diff(b, 'createRadialGradient'), 0, 'none×0 不应画光晕');

  // 强度契约：0 强度即使反应非 none 也不画；越界强度钳制到 1 仍画
  skin.setPulse('grateful', 0);
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.equal(diff(b, 'createRadialGradient'), 0);

  skin.setPulse('determined', 5); // 钳制到 1
  b = snapshot();
  assert.doesNotThrow(stepOnce);
  assert.equal(diff(b, 'createRadialGradient'), 1);

  skin.setPulse('none', 0); // 还原
});
