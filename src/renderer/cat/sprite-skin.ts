/**
 * 图像精灵皮肤 v2（移植自 desktop-pet renderer/sprite-skin.js，融合扩展版）。
 *
 * 状态多帧循环 + 表情打断短序列 + 代码二级动画（呼吸/颠簸/旋转/压扁/爱心）。
 * 与 cat-fsm 解耦：FSM 只产出 pose 与状态名，这里负责「画成猫」。
 *
 * 融合新增（energy-pet 嫁接点）：
 *  - setOverlay(WeatherOverlay)：头顶奶油线稿天气小挂件（晴/云/雨/雷）
 *  - setPulse(PulseReaction, intensity)：身后柔和脉冲光晕（强度走 pulse-contract）
 *
 * assets v2：{ states:{name:{frames,url[],fps?,anim?}}, expressions:{name:{frames,fps,once,hold}} }
 * 兼容 v1：{ idle, walk[], tap, sleep, drag, pet, thrown, groom }
 */

import type { WeatherOverlay, PulseReaction } from '../../core/types.js';

/* ─────────────────────────── 类型契约 ─────────────────────────── */

export interface SkinPose {
  /** 朝向：1 右 / -1 左 */
  face: number;
  /** 整体旋转（rad） */
  rot: number;
  sx?: number;
  sy?: number;
}

export interface DrawInfo {
  /** FSM 状态名（perch-walk 已由调用方映射成 'walk'） */
  state: string;
  stateT: number;
  dt: number;
  /** 落地压扁剩余时间（0.22 → 0） */
  squashT?: number;
  /** 离地高度归一化（0 地面 → 1 高空），驱动接地阴影 */
  air?: number;
  /** 当前移速 px/s（步态引擎速度同步用；应报速度包络后的真实步速 walkV） */
  speed?: number;
  /** 窗口整数步进的亚像素余量（画布层补偿平移，消除 0/1px 交替微跳） */
  subX?: number;
}

export interface GaitAnimConfig {
  interval: [number, number];
  refSpeed: number;
  bobAmp: number;
  swayAmp: number;
  swayPhase: number;
  squashAmp: number;
  crossfade: number;
  entryT: number;
  exitT?: number;
  stateXfade: number;
}

interface StateSpec {
  frames?: string[];
  fps?: number;
  anim?: Partial<GaitAnimConfig>;
}

interface ExpressionSpec {
  frames?: string[];
  fps?: number;
  once?: boolean;
  hold?: number;
}

export interface SkinAssetsV2 {
  states?: Record<string, StateSpec>;
  expressions?: Record<string, ExpressionSpec>;
  /* v1 兼容字段 */
  idle?: string | string[];
  walk?: string | string[];
  tap?: string | string[];
  sleep?: string | string[];
  drag?: string | string[];
  pet?: string | string[];
  thrown?: string | string[];
  groom?: string | string[];
}

export interface SpriteSkinOptions {
  ctx: CanvasRenderingContext2D;
  /** 猫水平中心（窗口坐标） */
  cx: number;
  /** 猫脚底 y（窗口坐标） */
  ground: number;
  fps?: number;
  targetHeight?: number;
  /** 测试注入：替代全局 Image */
  ImageCtor?: new () => HTMLImageElement;
}

export interface GaitSnapshot {
  phi: number;
  idx: number;
  n: number;
  stepDur: number;
  bob: number;
  sway: number;
  sy: number;
  env: number;
}

export interface SpriteSkin {
  draw(pose: SkinPose, t: number, info: DrawInfo): void;
  /** 表情插播：once 播完(+hold)自动回落；无该表情素材返回 false（静默跳过） */
  playExpression(name: string): boolean;
  /** 最近一帧步态观测（单测/devtools 调参） */
  gaitInfo(): GaitSnapshot | null;
  /** 天气挂件（emotion 引擎已算好门槛，这里只忠实呈现） */
  setOverlay(overlay: WeatherOverlay): void;
  /** 脉冲光晕：intensity 来自 pulse-contract.pulseIntensity() */
  setPulse(pulse: PulseReaction, intensity: number): void;
  /** 当前已加载的表情名集合（诊断） */
  expressionNames(): string[];
}

/* ─────────────────────────── 工具 ─────────────────────────── */

function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.65);
  ctx.bezierCurveTo(x - s * 0.95, y - s * 0.1, x - s * 0.5, y - s * 0.95, x, y - s * 0.3);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.95, x + s * 0.95, y - s * 0.1, x, y + s * 0.65);
  ctx.closePath();
}

function normalize(assets: SkinAssetsV2): { states: Record<string, StateSpec>; expressions: Record<string, ExpressionSpec> } {
  if (assets && assets.states) {
    return { states: assets.states, expressions: assets.expressions ?? {} };
  }
  const one = (u?: string | string[]): StateSpec | undefined =>
    u ? { frames: Array.isArray(u) ? u : [u] } : undefined;
  const states: Record<string, StateSpec> = {};
  const put = (k: string, v: StateSpec | undefined): void => { if (v) states[k] = v; };
  put('idle', one(assets?.idle));
  put('walk', one(assets?.walk));
  put('tap', one(assets?.tap));
  put('sleep', one(assets?.sleep));
  put('drag', one(assets?.drag));
  put('pet', one(assets?.pet));
  put('thrown', one(assets?.thrown));
  put('groom', one(assets?.groom ?? assets?.tap));
  return { states, expressions: {} };
}

/** 脉冲光晕色板（奶油纸感：低饱和暖色 + 薄荷点缀，与 site 设计同源） */
const PULSE_AURA_COLOR: Record<string, string> = {
  anxious: '247,140,160',    // 粉（不安）
  guilty: '214,170,140',     // 奶茶（内疚）
  numb: '171,167,149',       // 灰橄榄（麻木）
  restless: '240,180,120',   // 杏黄（躁动）
  grateful: '174,199,166',   // 薄荷（感激）
  determined: '255,201,60',  // 暖阳（坚定）
};

/* ─────────────────────────── 工厂 ─────────────────────────── */

export async function createSpriteSkin(assets: SkinAssetsV2, opts: SpriteSkinOptions): Promise<SpriteSkin> {
  const ctx = opts.ctx;
  const CX = opts.cx;
  const GROUND = opts.ground;
  const ImageCtor = opts.ImageCtor ?? (globalThis.Image as new () => HTMLImageElement);
  const load = (url?: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const im = new ImageCtor();
      im.onload = () => resolve(im);
      im.onerror = () => {
        console.warn('[skin] 图片加载失败', url);
        resolve(null);
      };
      im.src = url;
    });

  const norm = normalize(assets);
  interface Seq { imgs: HTMLImageElement[]; fps: number | null; anim: Partial<GaitAnimConfig> | null }
  const loadSeq = async (spec?: StateSpec | ExpressionSpec): Promise<Seq | null> => {
    if (!spec || !Array.isArray(spec.frames) || !spec.frames.length) return null;
    const imgs = (await Promise.all(spec.frames.map(load))).filter((v): v is HTMLImageElement => !!v);
    return imgs.length ? { imgs, fps: spec.fps || null, anim: (spec as StateSpec).anim ?? null } : null;
  };
  const states: Record<string, Seq> = {};
  for (const [name, spec] of Object.entries(norm.states)) {
    const s = await loadSeq(spec);
    if (s) states[name] = s;
  }
  interface ExprSeq extends Seq { once: boolean; hold: number }
  const expressions: Record<string, ExprSeq> = {};
  for (const [name, spec] of Object.entries(norm.expressions)) {
    const s = await loadSeq(spec);
    if (s) expressions[name] = { ...s, once: spec.once !== false, hold: spec.hold ?? 0 };
  }
  const idle = states['idle'];
  if (!idle) throw new Error('idle 图片加载失败');
  // 回退链：各状态缺帧 → idle
  for (const k of ['walk', 'tap', 'sleep', 'drag', 'pet', 'thrown', 'groom']) {
    if (!states[k]) states[k] = idle;
  }
  const fps = opts.fps ?? 8;
  const targetH = opts.targetHeight ?? 250;
  const scale = targetH / idle.imgs[0]!.naturalHeight;
  const hearts: { x: number; y: number; life: number; size: number; seed: number }[] = [];
  const stateClock: Record<string, number> = {}; // 每状态独立帧时钟：切状态清零，防相位跳变
  let expr: { name: string; def: ExprSeq; t: number } | null = null;
  let prevState = '';
  let lastFace: number | null = null; // 上一帧朝向：转身瞬间触发交叉溶解，消除镜像 pop
  let t = 0;
  let overlay: WeatherOverlay = 'none';
  let pulse: PulseReaction = 'none';
  let pulseIntensityV = 0;

  /* ─────────── 步态引擎：相位锁定的多帧走姿 ───────────
   * 帧切换不用墙上时钟，而用「步相位」φ∈[0,1)：每步时长在 interval 内随机抽取，
   * 并可按移动速度相对 refSpeed 缩放。颠簸/摇摆/压扁全部是 φ 的连续函数，
   * 且在换帧点（φ=0）取极值 0 → 换帧瞬间变换量连续，视觉无跳变。 */
  const DEF_ANIM: GaitAnimConfig = {
    interval: [0.14, 0.22],
    refSpeed: 46,
    bobAmp: 3,
    swayAmp: 0.02,
    swayPhase: Math.PI / 2,
    squashAmp: 0.012,
    crossfade: 0.3,
    entryT: 0.25,
    exitT: 0.18,
    stateXfade: 0.12,
  };
  const smooth01 = (x: number): number => x * x * (3 - 2 * x);
  const animOf = (state: string): GaitAnimConfig | null => {
    const def = states[state];
    return def && def.anim ? { ...DEF_ANIM, ...def.anim } : null;
  };
  let gait: { phi: number; idx: number; stepDur: number; age: number } | null = null;
  let gaitState = '';
  let snap: { bodies: Body[]; t: number; dur: number } | null = null;
  let lastBody: Body[] | null = null;
  let lastGait: GaitSnapshot | null = null;

  function gaitReset(a: GaitAnimConfig, owner: string): void {
    const [lo, hi] = a.interval;
    gait = { phi: 0, idx: 0, age: 0, stepDur: Math.max(0.05, lo + Math.random() * (hi - lo)) };
    gaitState = owner;
  }
  function gaitAdvance(a: GaitAnimConfig, dt: number, speed: number, n: number): void {
    if (!gait) return;
    // 速度同步：移速快 → 步频快（stepDur × refSpeed/speed，夹在 0.6–1.8 倍）
    const k = a.refSpeed > 0 && speed > 1 ? Math.min(1.8, Math.max(0.6, a.refSpeed / speed)) : 1;
    gait.phi += dt / gait.stepDur;
    while (gait.phi >= 1) {
      gait.phi -= 1;
      gait.idx = (gait.idx + 1) % n;
      const [lo, hi] = a.interval;
      gait.stepDur = Math.max(0.05, (lo + Math.random() * (hi - lo)) * k);
    }
  }
  /**
   * 步相位 ph：整个循环（n 帧 = 一个完整步态周期）为 2π，身体每周期颠簸 2 次
   * （对角腿组各一次，与真实猫步频一致，不随帧数翻倍）。bob/sway/squash 都是
   * (idx+phi) 的连续函数 → 任意换帧点变换量不跳。n=2 时退化为两帧版公式。
   */
  function gaitTransform(a: GaitAnimConfig, env: number, n: number): { bob: number; sway: number; sy: number; sx: number; lift: number } {
    if (!gait) return { bob: 0, sway: 0, sy: 1, sx: 1, lift: 0 };
    const ph = ((gait.idx + gait.phi) * Math.PI * 2) / Math.max(2, n | 0);
    const lift = Math.abs(Math.sin(ph));
    return {
      bob: -lift * a.bobAmp * env,
      sway: Math.sin(ph + a.swayPhase) * a.swayAmp * env,
      sy: 1 - lift * a.squashAmp * env,
      sx: 1 + lift * a.squashAmp * 0.7 * env,
      lift,
    };
  }

  function stateImg(state: string): HTMLImageElement {
    const def = states[state] ?? idle;
    // 配置了步态动画且步态归属本状态：取当前步帧（与 walk 渲染同源）
    if (def.anim && def.imgs.length > 1 && gait && gaitState === state) {
      return def.imgs[gait.idx % def.imgs.length]!;
    }
    const clock = stateClock[state] ?? 0;
    const f = def.fps ?? fps;
    return def.imgs[Math.floor(clock * f) % def.imgs.length]!;
  }

  interface Body { img: HTMLImageElement; bob: number; rot: number; sx: number; sy: number; face: number; alpha: number }

  function drawBody(img: HTMLImageElement, bob: number, rot: number, sx: number, sy: number, face: number, alpha: number): void {
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha *= alpha;
    ctx.translate(CX, GROUND + bob);
    ctx.rotate(rot);
    ctx.scale(face * sx, sy);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
  }

  /* ─────────── 融合层：天气挂件 + 脉冲光晕（奶油线稿风） ─────────── */

  function drawPulseAura(time: number): void {
    if (pulse === 'none' || pulseIntensityV <= 0) return;
    const rgb = PULSE_AURA_COLOR[pulse] ?? '174,199,166';
    const breathe = 0.72 + 0.28 * Math.sin(time * 2.2);
    const r = targetH * (0.5 + 0.14 * pulseIntensityV);
    const cy = GROUND - targetH * 0.52;
    const g = ctx.createRadialGradient(CX, cy, r * 0.2, CX, cy, r);
    g.addColorStop(0, `rgba(${rgb},${(0.16 * pulseIntensityV * breathe).toFixed(3)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(CX, cy, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const INK = '#20242a';
  function charmAnchor(): { x: number; y: number } {
    return { x: CX + 54, y: GROUND - targetH - 26 };
  }

  function drawWeatherOverlay(time: number): void {
    if (overlay === 'none') return;
    const { x, y } = charmAnchor();
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    switch (overlay) {
      case 'sunbeam': {
        // 小太阳：奶油暖阳 + 旋转光芒（墨线描边统一线稿风）
        const sy = y + Math.sin(time * 1.4) * 2;
        ctx.translate(x, sy);
        ctx.save();
        ctx.rotate(time * 0.5);
        ctx.strokeStyle = 'rgba(230,180,60,0.9)';
        ctx.lineWidth = 2.2;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 12, Math.sin(a) * 12);
          ctx.lineTo(Math.cos(a) * 17, Math.sin(a) * 17);
          ctx.stroke();
        }
        ctx.restore();
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 10);
        g.addColorStop(0, '#fff3b0');
        g.addColorStop(1, '#ffc93c');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        break;
      }
      case 'cloud-puff': {
        const cy = y + Math.sin(time * 1.1) * 2.5;
        ctx.translate(x, cy);
        ctx.fillStyle = '#F6F3ED';
        ctx.beginPath();
        ctx.arc(-8, 2, 8, 0, Math.PI * 2);
        ctx.arc(0, -3, 10.5, 0, Math.PI * 2);
        ctx.arc(9, 2, 7.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.stroke();
        break;
      }
      case 'rain-drop': {
        const cy = y + Math.sin(time * 1.1) * 2;
        ctx.translate(x, cy);
        ctx.fillStyle = '#dfe6ee';
        ctx.beginPath();
        ctx.arc(-9, 2, 9, 0, Math.PI * 2);
        ctx.arc(0, -4, 12, 0, Math.PI * 2);
        ctx.arc(10, 2, 8.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.stroke();
        // 雨丝（循环下落）
        ctx.strokeStyle = 'rgba(120,170,255,0.85)';
        ctx.lineWidth = 1.8;
        for (let i = 0; i < 4; i++) {
          const phase = (time * 1.6 + i * 0.25) % 1;
          const dx = -12 + i * 8;
          const dy = 12 + phase * 22;
          ctx.globalAlpha = 1 - phase;
          ctx.beginPath();
          ctx.moveTo(dx, dy);
          ctx.lineTo(dx - 1.5, dy + 6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'storm-bolt': {
        const cy = y + Math.sin(time * 1.3) * 2;
        ctx.translate(x, cy);
        ctx.fillStyle = '#cdd4de';
        ctx.beginPath();
        ctx.arc(-9, 2, 9.5, 0, Math.PI * 2);
        ctx.arc(0, -5, 12.5, 0, Math.PI * 2);
        ctx.arc(10, 2, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.stroke();
        // 闪电（周期性闪现）
        const flash = (time * 0.9) % 2.4;
        if (flash < 0.28) {
          ctx.globalAlpha = flash < 0.14 ? 1 : 0.6;
          ctx.fillStyle = '#ffe066';
          ctx.strokeStyle = '#f5b942';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(2, 8);
          ctx.lineTo(-4, 20);
          ctx.lineTo(0, 20);
          ctx.lineTo(-3, 30);
          ctx.lineTo(6, 17);
          ctx.lineTo(2, 17);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // 雨丝
        ctx.strokeStyle = 'rgba(120,170,255,0.7)';
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 3; i++) {
          const phase = (time * 2 + i * 0.33) % 1;
          const dx = -12 + i * 10;
          const dy = 12 + phase * 24;
          ctx.globalAlpha = 1 - phase;
          ctx.beginPath();
          ctx.moveTo(dx, dy);
          ctx.lineTo(dx - 1.5, dy + 6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
    }
    ctx.restore();
  }

  /* ─────────── 对外 ─────────── */

  return {
    playExpression(name: string): boolean {
      const def = expressions[name];
      if (!def) return false;
      expr = { name, def, t: 0 };
      return true;
    },
    gaitInfo(): GaitSnapshot | null {
      return lastGait;
    },
    setOverlay(next: WeatherOverlay): void {
      overlay = next;
    },
    setPulse(reaction: PulseReaction, intensity: number): void {
      pulse = reaction;
      pulseIntensityV = Math.max(0, Math.min(1, intensity));
    },
    expressionNames(): string[] {
      return Object.keys(expressions);
    },
    draw(p: SkinPose, now: number, info: DrawInfo): void {
      const dt = info.dt || 0.016;
      t = now;
      // 亚像素补偿：窗口只能整数步进，余量画进画布 → 移速轨迹真正连续（消除 0/1px 交替微跳）
      ctx.save();
      ctx.translate(info.subX ?? 0, 0);
      const state = info.state;
      const a = animOf(state);
      const walkDef = states['walk'];
      const walkActive = state === 'walk' && !expr && !!a && !!walkDef && walkDef.imgs.length > 1;
      const stateChanged = state !== prevState;
      if (stateChanged) {
        stateClock[state] = 0;
        if (expr && !expr.def.once) expr = null; // 循环表情随状态切换结束
        // 状态边界：把上一状态的最后一帧做交叉溶解快照，消除姿态/位置突跳
        // 离开带步态的状态（walk）用其 exitT：更长的渐出让停步更柔和
        if (lastBody && lastBody.length) {
          const prevA = animOf(prevState);
          const xf = prevA ? (prevA.exitT ?? prevA.stateXfade) : (a ?? DEF_ANIM).stateXfade;
          if (xf > 0) snap = { bodies: lastBody, t: 0, dur: xf };
        }
        if (state === 'walk' && a) gaitReset(a, state); // 起步相位归零，步态从头开始
      } else if (lastBody && lastBody.length && p.face !== lastFace) {
        // 转身边界：旧朝向最后一帧做溶解，消除镜像瞬间 pop
        //（FSM 已在转身前把速度刹到 ≈0，这里只过渡姿态；减速+溶解=自然转身）
        const xf = (a ?? DEF_ANIM).stateXfade;
        if (xf > 0) snap = { bodies: lastBody, t: 0, dur: xf };
      }
      lastFace = p.face;
      prevState = state;
      stateClock[state] = (stateClock[state] ?? 0) + dt;

      let img: HTMLImageElement | null = null;
      let bob = 0;
      let rot = p.rot;
      // pose 缩放单源：CatPose.sx/sy 已由 FSM computePose 统一合成呼吸（mood 驱动）、
      // 落地压扁（squashT）与自定义姿势覆盖 —— 皮肤层忠实呈现，不再自行叠算这两通道
      let sy = p.sy ?? 1;
      let sx = p.sx ?? 1;
      if (expr) {
        expr.t += dt;
        const def = expr.def;
        // 源 JS 语义保留：无 fps 的 once 表情 dur=Infinity（永不自动回落），帧号恒 0（首帧）
        const dur = def.fps == null ? Infinity : def.imgs.length / def.fps;
        if (def.once && expr.t >= dur + def.hold) {
          expr = null;
          img = stateImg(state);
        } else {
          img = def.imgs[Math.min(def.imgs.length - 1, Math.floor(expr.t * (def.fps ?? 0)))]!;
        }
      }
      if (!img) img = stateImg(state);

      // 摸头瞬间撒爱心
      if (state === 'pet' && stateChanged) {
        for (let i = 0; i < 3; i++) {
          hearts.push({
            x: CX + (Math.random() * 2 - 1) * 46,
            y: GROUND - 150 + Math.random() * 20,
            life: 1,
            size: 7 + Math.random() * 5,
            seed: Math.random() * 10,
          });
        }
      }

      // （原皮肤侧呼吸/落地压扁叠算已移除：两通道单一来源在 CatPose.sx/sy，
      //   避免与 FSM 合成值双重叠加 —— 见上方「pose 缩放单源」注释）

      let bodies: Body[] | null = null; // 多层本体（交叉溶解时两层）
      if (walkActive && a && walkDef && gait) {
        const env = smooth01(Math.min(1, gait.age / Math.max(0.001, a.entryT)));
        gait.age += dt;
        gaitAdvance(a, dt, Math.abs(info.speed ?? 0), walkDef.imgs.length);
        const g = gaitTransform(a, env, walkDef.imgs.length);
        lastGait = { phi: gait.phi, idx: gait.idx, n: walkDef.imgs.length, stepDur: gait.stepDur, bob: g.bob, sway: g.sway, sy: g.sy, env };
        bob += g.bob;
        rot += g.sway;
        sy *= g.sy;
        sx *= g.sx;
        // 步内交叉溶解：混合窗=步尾 crossfade×0.5（0=硬切，1=后半步溶解，2=全程连续 morph）
        const n = walkDef.imgs.length;
        const i0 = gait.idx % n;
        const i1 = (gait.idx + 1) % n;
        const m = Math.max(0, Math.min(1, a.crossfade * 0.5));
        const wgt = m > 0 && gait.phi > 1 - m ? (gait.phi - (1 - m)) / m : 0;
        bodies = [{ img: walkDef.imgs[i0]!, bob, rot, sx, sy, face: p.face, alpha: 1 }];
        if (wgt > 0 && i1 !== i0) {
          bodies.push({ img: walkDef.imgs[i1]!, bob, rot, sx, sy, face: p.face, alpha: smooth01(wgt) });
        }
      } else if (state === 'walk') {
        // 旧皮肤（无 anim 配置）：保留原墙上时钟颠簸/摇摆
        bob = -Math.abs(Math.sin(t * 8)) * 3;
        rot += Math.sin(t * 8) * 0.02;
      } else if (state === 'tap' || state === 'groom') {
        bob = -1.5;
        rot += p.face * 0.015;
      } else if (state === 'sleep') {
        sy *= 1 + Math.sin(t * 1.2) * 0.012;
      } else if (state === 'pet') {
        bob = -Math.abs(Math.sin((info.stateT ?? 0) * 9)) * 6;
      } else if (state === 'drag') {
        rot += Math.sin(t * 10) * 0.03;
      }
      if (!bodies) bodies = [{ img, bob, rot, sx, sy, face: p.face, alpha: 1 }];

      // 脉冲光晕（本体之前绘制：贴地柔光垫底，本体叠在其上）
      drawPulseAura(t);

      // 接地阴影（随 bob/squash 连续变化，换帧点不跳）
      const air = info.air ?? 0;
      ctx.fillStyle = `rgba(0,0,0,${0.16 * (1 - 0.6 * air)})`;
      ctx.beginPath();
      ctx.ellipse(CX, GROUND + 2, 62 * (1 - 0.5 * air) * sx, 9 * (1 - 0.4 * air), 0, 0, Math.PI * 2);
      ctx.fill();

      // 状态边界交叉溶解：先画上一状态最后一帧（淡出），再画当前帧
      if (snap) {
        snap.t += dt;
        const k = snap.t / snap.dur;
        if (k >= 1) snap = null;
        else {
          for (const b of snap.bodies) drawBody(b.img, b.bob, b.rot, b.sx, b.sy, b.face, 1 - smooth01(k));
        }
      }
      for (const b of bodies) drawBody(b.img, b.bob, b.rot, b.sx, b.sy, b.face, b.alpha);
      lastBody = bodies;

      // 睡觉 zzz（用户裁定 2026-10-27：zzz 属图形符号、不属于文字，保留）
      if (state === 'sleep') {
        ctx.fillStyle = INK;
        for (let i = 0; i < 3; i++) {
          const za = (Math.sin(t * 1.6 - i * 0.9) + 1) / 2;
          ctx.globalAlpha = 0.2 + 0.5 * za;
          ctx.font = `700 ${14 + i * 7}px ui-rounded, system-ui`;
          ctx.fillText('z', CX + 52 + i * 12, GROUND - 150 - i * 20 - za * 8);
        }
        ctx.globalAlpha = 1;
      }

      // 头顶天气挂件
      drawWeatherOverlay(t);

      // 爱心粒子
      for (let i = hearts.length - 1; i >= 0; i--) {
        const h2 = hearts[i]!;
        h2.life -= dt / 1.4;
        if (h2.life <= 0) {
          hearts.splice(i, 1);
          continue;
        }
        h2.y -= 26 * dt;
        h2.x += Math.sin((t + h2.seed) * 3.2) * 9 * dt;
        ctx.save();
        ctx.globalAlpha = Math.min(1, h2.life * 1.6);
        ctx.fillStyle = '#f78ca0';
        heartPath(ctx, h2.x, h2.y, h2.size);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore(); // 亚像素平移
    },
  };
}
