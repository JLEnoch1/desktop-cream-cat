/**
 * CatFsm —— 奶油猫行为状态机（移植自 desktop-pet renderer/cat.js，融合扩展版）。
 *
 * 状态：idle / walk / groom / pet / sleep / drag / thrown / climb / perch / fall
 * 职责：
 *  - 自主行为调度（散步/舔毛/打盹/登高），节奏由 mood 活力参数驱动
 *  - 拖拽 + 甩出物理（抛物线/落地弹跳压扁/顶边吸附）
 *  - 窗口顶边（ledge）登高：climb 抛物线 / perch 踱步·坐下·探头 / fall 落下
 *  - 窗口位置所有权：px/py 是窗口左上角屏幕坐标，syncWindow() 推给主进程
 *
 * 与皮肤无关：update() 推进状态，computePose() 产出 pose 参数对象，
 * 渲染层（sprite-skin / fallback-cat）只负责把 pose 画出来。
 */

import type { CatCmd, CatLedge, CatLayout } from '../../core/types.js';
import type { MoodParams } from './mood.js';
import { NEUTRAL_MOOD } from './mood.js';

export const CAT_W = 360;
/** 窗口高 = 猫体区 374 + 底部精力值 HUD 条带 50（原有 #energy-hud 迁移至此，悬浮显示） */
export const CAT_H = 424;
/** 脚底线：物理/绘制锚点（窗口底部留出 HUD 条带，脚底线不随窗高变化） */
export const CAT_GROUND = 374;
export const CAT_CX = CAT_W / 2;

export type CatState =
  | 'idle' | 'walk' | 'groom' | 'pet' | 'sleep'
  | 'drag' | 'thrown' | 'climb' | 'perch' | 'fall';

export type PerchMode = 'stand' | 'walk' | 'look';

/** pose 参数对象（皮肤接口）：程序化猫用全量字段，图像皮肤主要用 face/rot/sx/sy */
export interface CatPose {
  face: number;
  sx: number;
  sy: number;
  rot: number;
  eyes: 'open' | 'blink' | 'happy' | 'closed' | 'wide';
  mouth: 'w' | 'o' | 'line';
  pawL: number;
  pawR: number;
  legsOn: boolean;
  legPh: number;
  splay: number;
  tailPh: number;
  tailAmp: number;
  headTilt: number;
  tailWrap: boolean;
  earL: number;
  earR: number;
  zzz: boolean;
  zzzPh: number;
  blush: boolean;
}

export interface FsmHooks {
  /** 移动窗口（屏幕坐标，已取整由调用方保证） */
  moveWindow(x: number, y: number): void;
  /** 拖拽开始/结束（主进程据此保持窗口可交互） */
  setDragActive(active: boolean): void;
  /** 气泡 */
  bubble(text: string, ms?: number): void;
  /** 表情插播（皮肤层）；无素材返回 false */
  playExpr(name: string): boolean;
  /** 当前心情参数（mood.ts computeMoodParams；领域未就绪时 NEUTRAL_MOOD） */
  moodParams(): MoodParams;
  /** 摸头气泡候选文案（按精力档） */
  petLines(): string[];
}

interface Climb {
  x0: number; y0: number;
  x1: number; y1: number;
  T: number; arch: number; t: number;
  id: number | string;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)] as T;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export class CatFsm {
  /* ── 窗口位置 ── */
  px = 0;
  py = 0;
  private lastX: number | null = null;
  private lastY: number | null = null;

  /* ── FSM ── */
  st: CatState = 'idle';
  stT = 0;
  dir = 1;
  private walkDur = 0;
  private nextWalkIn = rand(2.5, 5);
  private nextGroomIn = rand(8, 16);
  private groomSide = 1;
  legPh = 0;
  t = 0;
  private blinkIn = rand(1.5, 3);
  blinkT = 0;
  private pawTapT = 0;
  private pawSide = 1;
  squashT = 0;
  private bounces = 0;
  paused = false;
  private lastAct = performance.now();
  private readonly vel = { x: 0, y: 0 };

  /* ── 拖拽 ── */
  private dragging = false;
  private moved = false;
  private readonly dragOff = { x: 0, y: 0 };
  private readonly dragStart = { x: 0, y: 0 };
  private lastMoveT = 0;

  /* ── 窗口顶边（ledge） ── */
  ledges: CatLedge[] = [];
  private surface: { id: number | string } | null = null;
  /** 当前站立面（调试/诊断用） */
  get surfaceId(): number | string | null {
    return this.surface ? this.surface.id : null;
  }
  perchMode: PerchMode = 'stand';
  private perchT = 0;
  private perchWalkDur = 0;
  private lookDur = 0;
  private nextPerchIn = rand(4, 10);
  private nextClimbIn = rand(12, 25);
  private climb: Climb | null = null;
  private fallSkip: number | string | null = null;
  private dragFromSurface: { id: number | string } | null = null;

  /* ── 融合扩展 ── */
  /** UI 卡片窗口打开期间：停止自主散步（安静陪伴），互动照常响应 */
  uiHold = false;

  layout: CatLayout | null = null;

  constructor(private readonly hooks: FsmHooks) {}

  private get mood(): MoodParams {
    return this.hooks.moodParams() ?? NEUTRAL_MOOD;
  }

  private readonly walkMin = (): number => this.layout?.x ?? 0;
  private readonly walkMax = (): number => (this.layout ? this.layout.x + this.layout.w - CAT_W : CAT_W);
  readonly feetY = (): number => this.py + CAT_GROUND;
  readonly cx = (): number => this.px + CAT_W / 2;

  /* ─────────────────────────── ledge 工具 ─────────────────────────── */

  ledgeById(id: number | string): CatLedge | null {
    return this.ledges.find((l) => l.id === id) ?? null;
  }

  /** 顶边上猫中心的允许范围 → 窗口 px 范围 */
  private perchRange(l: CatLedge): [number, number] {
    return [l.x + 30 - CAT_W / 2, l.x + l.w - 30 - CAT_W / 2];
  }

  private setPerch(mode: PerchMode): void {
    this.st = 'perch';
    this.stT = 0;
    this.perchMode = mode;
    this.perchT = 0;
    if (mode === 'walk') this.perchWalkDur = rand(1.5, 3.5);
    if (mode === 'look') this.lookDur = rand(2, 4);
    this.nextPerchIn = rand(4, 10);
  }

  startFall(): void {
    this.fallSkip = this.surface ? this.surface.id : null;
    this.surface = null;
    this.climb = null;
    this.vel.x = 0;
    this.vel.y = 0;
    this.set('fall');
  }

  startClimb(l: CatLedge): void {
    const [a, b] = this.perchRange(l);
    const tx = clamp(this.cx(), a + 20, Math.max(a + 20, b - 20)) - CAT_W / 2;
    const dy = this.feetY() - l.y;
    this.climb = {
      x0: this.px, y0: this.py,
      x1: tx, y1: l.y - CAT_GROUND,
      T: 0.5 + Math.min(0.5, dy * 0.0008),
      arch: Math.min(140, 40 + dy * 0.25),
      t: 0, id: l.id,
    };
    this.dir = tx >= this.px ? 1 : -1;
    this.set('climb');
  }

  /** 地面想上去：选上方 40–500px、水平距 <400 的最近 ledge */
  private pickClimbLedge(): CatLedge | null {
    let best: CatLedge | null = null;
    let bestDy = 1e9;
    for (const l of this.ledges) {
      const dy = this.feetY() - l.y;
      if (dy < 40 || dy > 500) continue;
      const gap = Math.max(0, l.x - this.cx(), this.cx() - (l.x + l.w));
      if (gap > 400) continue;
      if (dy < bestDy) { bestDy = dy; best = l; }
    }
    return best;
  }

  /** 顶边间互跳：高度差 <160、水平间隙 <260 的最近 ledge */
  private pickAdjacentLedge(cur: CatLedge): CatLedge | null {
    let best: CatLedge | null = null;
    let bestD = 1e9;
    for (const l of this.ledges) {
      if (l.id === cur.id) continue;
      if (Math.abs(l.y - cur.y) > 160) continue;
      const gap = Math.max(0, cur.x - (l.x + l.w), l.x - (cur.x + cur.w));
      if (gap > 260) continue;
      if (gap < bestD) { bestD = gap; best = l; }
    }
    return best;
  }

  /** 拖拽/甩出落点吸附：脚底 ±24px 内的 ledge 顶边 */
  private snapLedge(): CatLedge | null {
    let best: CatLedge | null = null;
    let bestD = 25;
    for (const l of this.ledges) {
      if (this.cx() < l.x + 10 || this.cx() > l.x + l.w - 10) continue;
      const d = Math.abs(this.feetY() - l.y);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  /** 顶边趴着时 UI 需要猫回地面？——不需要（UI 是独立窗口），仅菜单/托盘触发 */
  goGround(): void {
    if (this.surface) this.startFall();
  }

  /* ─────────────────────────── 状态切换 ─────────────────────────── */

  set(name: CatState, dur?: number): void {
    this.st = name;
    this.stT = 0;
    const m = this.mood;
    if (name === 'idle') {
      this.nextWalkIn = rand(3.5, 7) / m.activity;
      this.nextGroomIn = rand(9, 20) / m.activity;
    }
    if (name === 'walk') this.walkDur = dur ?? rand(1.8, 4.2);
    if (name === 'groom') this.groomSide = Math.random() < 0.5 ? -1 : 1;
  }

  sleepNow(): void {
    this.set('sleep');
    this.hooks.bubble('zzz');
  }

  wakeUp(): void {
    if (this.st === 'sleep') {
      this.set('idle');
      this.lastAct = performance.now();
    }
  }

  /* ─────────────────────────── 行为更新 ─────────────────────────── */

  update(dt: number): void {
    const m = this.mood;
    this.t += dt;
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blinkT = 0.12;
      this.blinkIn = rand(2.2, 4.5) * m.blinkScale;
    }
    this.blinkT = Math.max(0, this.blinkT - dt);
    this.pawTapT = Math.max(0, this.pawTapT - dt);
    this.squashT = Math.max(0, this.squashT - dt);
    if (!this.layout) return;
    const layout = this.layout;

    if (!this.paused) {
      this.stT += dt;
      switch (this.st) {
        case 'idle':
          if (performance.now() - this.lastAct > m.sleepIdleMs) this.set('sleep');
          else if (this.uiHold) { /* 安静陪伴：卡片打开时不自主散步 */ }
          else if (this.stT > this.nextGroomIn) this.set('groom');
          else if (this.stT > this.nextWalkIn) { this.dir = Math.random() < 0.5 ? -1 : 1; this.set('walk'); }
          else if (!this.surface && this.stT > this.nextClimbIn) {
            this.nextClimbIn = this.stT + rand(20, 40) / m.activity;
            if (Math.random() < 0.3 * Math.min(1, m.activity)) {
              const l = this.pickClimbLedge();
              if (l) this.startClimb(l);
            }
          }
          break;
        case 'walk': {
          const l = this.surface ? this.ledgeById(this.surface.id) : null;
          if (this.surface && !l) { this.startFall(); break; }
          this.legPh += dt * 10;
          this.px += this.dir * this.currentSpeed() * dt;
          const lo = l ? l.x + 30 - CAT_W / 2 : this.walkMin();
          const hi = l ? l.x + l.w - 30 - CAT_W / 2 : this.walkMax();
          if (this.px < lo) { this.px = lo; this.dir = 1; }
          if (this.px > hi) { this.px = hi; this.dir = -1; }
          if (this.stT > this.walkDur) this.set('idle');
          break;
        }
        case 'groom':
          if (this.stT > 1.5) this.set('idle');
          break;
        case 'pet':
          if (this.stT > 1.1) this.set('idle');
          break;
        case 'climb': {
          const climb = this.climb;
          if (!climb) { this.set('idle'); break; }
          climb.t += dt;
          const k = Math.min(1, climb.t / climb.T);
          this.px = climb.x0 + (climb.x1 - climb.x0) * k;
          this.py = climb.y0 + (climb.y1 - climb.y0) * k - Math.sin(Math.PI * k) * climb.arch;
          this.legPh += dt * 14;
          if (k >= 1) {
            const l = this.ledgeById(climb.id);
            const done = { x: climb.x1, y: climb.y1, id: climb.id };
            this.climb = null;
            if (!l) { this.surface = null; this.vel.y = 0; this.set('fall'); }
            else {
              this.surface = { id: done.id };
              this.px = done.x;
              this.py = done.y;
              this.setPerch('stand');
            }
          }
          break;
        }
        case 'perch': {
          const l = this.surface ? this.ledgeById(this.surface.id) : null;
          if (!l) { this.startFall(); break; }
          const [lo, hi] = this.perchRange(l);
          this.px = clamp(this.px, lo, hi);
          this.py = l.y - CAT_GROUND;
          this.perchT += dt;
          if (this.perchMode === 'walk') {
            this.legPh += dt * 10;
            this.px += this.dir * this.currentSpeed() * dt;
            if (this.px <= lo) { this.px = lo; this.dir = 1; this.setPerch('look'); }
            else if (this.px >= hi) { this.px = hi; this.dir = -1; this.setPerch('look'); }
            else if (this.perchT > this.perchWalkDur) this.setPerch('stand');
          } else if (this.perchMode === 'look') {
            if (this.perchT > this.lookDur) this.setPerch('stand');
          } else if (this.stT > this.nextPerchIn && !this.uiHold) {
            this.nextPerchIn = this.stT + rand(4, 10);
            const r = Math.random();
            if (r < 0.4) this.setPerch('walk');
            else if (r < 0.6) this.setPerch('look');
            else if (r < 0.75) {
              const nl = this.pickAdjacentLedge(l);
              if (nl) this.startClimb(nl);
              else this.setPerch('walk');
            } else if (r < 0.9) this.startFall();
            else this.set('sleep'); // 顶边睡觉
          }
          break;
        }
        case 'fall': {
          const prevY = this.py;
          this.vel.y += 1600 * dt;
          this.py += this.vel.y * dt;
          this.px = clamp(this.px + this.vel.x * dt, this.walkMin(), this.walkMax());
          let landed: CatLedge | 'ground' | null = null;
          if (this.py >= layout.groundY) { this.py = layout.groundY; landed = 'ground'; }
          else {
            for (const l of this.ledges) {
              if (l.id === this.fallSkip) continue;
              if (this.cx() < l.x + 10 || this.cx() > l.x + l.w - 10) continue;
              const top = l.y - CAT_GROUND;
              if (this.py >= top && prevY <= top) { this.py = top; landed = l; break; }
            }
          }
          if (landed) {
            this.squashT = 0.22;
            this.fallSkip = null;
            if (landed === 'ground') { this.surface = null; this.set('idle'); }
            else { this.surface = { id: landed.id }; this.setPerch('stand'); }
          }
          break;
        }
        case 'thrown': {
          const prevY = this.py;
          this.vel.y += 1600 * dt;
          this.px += this.vel.x * dt;
          this.py += this.vel.y * dt;
          this.px = clamp(this.px, this.walkMin(), this.walkMax());
          let landed: CatLedge | 'ground' | null = null;
          if (this.py >= layout.groundY) landed = 'ground';
          else if (this.vel.y > 0) {
            for (const l of this.ledges) {
              if (this.cx() < l.x + 10 || this.cx() > l.x + l.w - 10) continue;
              const top = l.y - CAT_GROUND;
              if (this.py >= top && prevY <= top) { landed = l; break; }
            }
          }
          if (landed) {
            if (landed === 'ground') {
              this.py = layout.groundY;
              if (this.vel.y > 260 && this.bounces < 2) {
                this.vel.y *= -0.42; this.vel.x *= 0.65; this.bounces++; this.squashT = 0.18;
              } else {
                this.squashT = 0.22;
                this.surface = null;
                this.set('idle');
              }
            } else {
              this.py = landed.y - CAT_GROUND;
              this.vel.x = 0; this.vel.y = 0;
              this.squashT = 0.18;
              this.surface = { id: landed.id };
              this.setPerch('stand');
            }
          }
          break;
        }
        // sleep / drag 无自推进
      }
      // 位置约束：climb/thrown/drag 自管坐标，其余按当前 surface 收敛
      if (this.st !== 'climb' && this.st !== 'thrown' && this.st !== 'drag') {
        const l = this.surface ? this.ledgeById(this.surface.id) : null;
        if (this.surface && !l) { this.surface = null; this.startFall(); }
        else if (l) {
          this.py = l.y - CAT_GROUND;
          this.px = clamp(this.px, l.x + 30 - CAT_W / 2, l.x + l.w - 30 - CAT_W / 2);
        } else {
          this.py = Math.min(this.py, layout.groundY);
          this.px = clamp(this.px, this.walkMin(), this.walkMax());
        }
      }
    }
  }

  /** 当前移速（步态引擎速度同步用）：地面 walk 全速，顶边踱步略慢 */
  currentSpeed(): number {
    const m = this.mood;
    if (this.st === 'walk') return this.surface ? m.walkSpeed * 0.87 : m.walkSpeed;
    if (this.st === 'perch' && this.perchMode === 'walk') return m.walkSpeed * 0.87;
    return 0;
  }

  /* ─────────────────────────── pose ─────────────────────────── */

  computePose(): CatPose {
    const m = this.mood;
    const p: CatPose = {
      face: this.dir, sx: 1, sy: 1, rot: 0,
      eyes: this.blinkT > 0 ? 'blink' : 'open',
      mouth: 'w',
      pawL: 0, pawR: 0,
      legsOn: false, legPh: this.legPh,
      splay: 0,
      tailPh: this.t * 2.4, tailAmp: 1,
      headTilt: 0, tailWrap: false,
      earL: 0, earR: 0,
      zzz: false, zzzPh: this.t, blush: false,
    };
    // 呼吸：周期走情绪 tier（疲惫呼吸更沉），幅度随活力微增
    const breathFreq = this.st === 'sleep' ? 1.2 : (Math.PI * 2) / Math.max(0.8, m.breathPeriod);
    p.sy *= 1 + Math.sin(this.t * breathFreq) * (0.014 + 0.006 * Math.min(1, m.activity));
    switch (this.st) {
      case 'walk':
      case 'climb':
        p.legsOn = true; p.tailAmp = 1.5; p.sy *= 1 + Math.sin(this.legPh * 2) * 0.02;
        break;
      case 'perch':
        if (this.perchMode === 'walk') { p.legsOn = true; p.tailAmp = 1.5; }
        else if (this.perchMode === 'look') { p.headTilt = 0.3; p.tailAmp = 0.6; }
        else p.tailAmp = 1;
        break;
      case 'fall':
        p.splay = 0.5; p.eyes = 'wide'; p.tailAmp = 2.2; p.tailPh = this.t * 10;
        break;
      case 'groom':
        if (this.groomSide < 0) p.pawL = 1; else p.pawR = 1;
        p.headTilt = 0.22 * this.groomSide; p.eyes = 'closed'; p.tailAmp = 0.5;
        break;
      case 'sleep':
        p.sy *= 0.74; p.headTilt = 0.28; p.eyes = 'closed'; p.mouth = 'line';
        p.tailWrap = true; p.tailAmp = 0.12; p.zzz = true;
        break;
      case 'pet':
        p.eyes = 'happy'; p.blush = true; p.rot = Math.sin(this.stT * 20) * 0.05; p.tailAmp = 2.2;
        break;
      case 'drag':
        p.splay = 1; p.eyes = 'wide'; p.mouth = 'o'; p.tailAmp = 2.4; p.tailPh = this.t * 10;
        break;
      case 'thrown':
        p.splay = 0.7; p.eyes = 'wide'; p.mouth = 'o';
        p.rot = clamp(this.vel.x / 1400, -0.4, 0.4); p.tailAmp = 2.6; p.tailPh = this.t * 12;
        break;
    }
    if (this.st === 'drag' || this.st === 'thrown' || this.st === 'fall') { p.earL = 0.55; p.earR = 0.55; }
    else if (this.st === 'idle') {
      if (this.t % 4.7 < 0.16) p.earR = 0.6; // 偶尔抖耳，显得警觉
      if (this.t % 6.1 < 0.14) p.earL = 0.6;
    }
    if (this.pawTapT > 0 && this.st !== 'drag' && this.st !== 'thrown') {
      if (this.pawSide < 0) p.pawL = Math.max(p.pawL, 0.95); else p.pawR = Math.max(p.pawR, 0.95);
    }
    if (this.squashT > 0) {
      const k = this.squashT / 0.22;
      p.sy *= 1 - 0.16 * k;
      p.sx *= 1 + 0.12 * k;
    }
    return p;
  }

  /* ─────────────────────────── 鼠标交互 ─────────────────────────── */

  /** 猫体命中（窗口坐标椭圆）：mousedown 只在命中时启动拖拽 */
  hitCat(x: number, y: number): boolean {
    const dx = (x - CAT_CX) / 82;
    const dy = (y - (CAT_GROUND - 92)) / 104;
    if (dx * dx + dy * dy <= 1) return true;
    // 图像皮肤猫比线稿猫高：补充身体矩形命中（250 高）
    return x > CAT_CX - 85 && x < CAT_CX + 85 && y > CAT_GROUND - 250 && y < CAT_GROUND + 6;
  }

  attachMouse(canvas: HTMLElement): void {
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging || !this.layout) return;
      const nx = e.screenX - this.dragOff.x;
      const ny = e.screenY - this.dragOff.y;
      const now = performance.now();
      const dtms = Math.max(1, now - this.lastMoveT);
      this.vel.x = this.vel.x * 0.65 + ((nx - this.px) / dtms) * 1000 * 0.35;
      this.vel.y = this.vel.y * 0.65 + ((ny - this.py) / dtms) * 1000 * 0.35;
      this.lastMoveT = now;
      this.px = clamp(nx, this.walkMin(), this.walkMax());
      this.py = clamp(ny, this.layout.y - 260, this.layout.groundY);
      this.moved = this.moved || Math.hypot(e.screenX - this.dragStart.x, e.screenY - this.dragStart.y) > 4;
      this.lastAct = now;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 只在猫体上启动拖拽（热区轮询已保证窗口可交互时光标基本在猫身上，
      // 但气泡等非猫区域点击不应抓起猫）
      if (!this.hitCat(e.clientX, e.clientY)) return;
      this.dragging = true;
      this.moved = false;
      this.dragFromSurface = this.surface;
      this.surface = null;
      this.climb = null;
      this.dragOff.x = e.screenX - this.px;
      this.dragOff.y = e.screenY - this.py;
      this.dragStart.x = e.screenX;
      this.dragStart.y = e.screenY;
      this.lastMoveT = performance.now();
      this.vel.x = 0; this.vel.y = 0;
      if (this.st !== 'thrown') this.set('drag');
      this.lastAct = performance.now();
      this.hooks.setDragActive(true);
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragging || !this.layout) return;
      this.dragging = false;
      this.hooks.setDragActive(false);
      this.lastAct = performance.now();
      const speed = Math.hypot(this.vel.x, this.vel.y);
      if (!this.moved) {
        // 原地点击 = 摸头：回到拖拽前的面（顶边或地面），不触发掉落
        const back = this.dragFromSurface ? this.ledgeById(this.dragFromSurface.id) : null;
        this.dragFromSurface = null;
        if (back) {
          this.surface = { id: back.id };
          this.py = back.y - CAT_GROUND;
          this.px = clamp(this.px, back.x + 30 - CAT_W / 2, back.x + back.w - 30 - CAT_W / 2);
        } else {
          this.surface = null;
        }
        this.set('pet');
        this.hooks.playExpr('happy');
        this.hooks.bubble(pick(this.hooks.petLines()), 1200);
        return;
      }
      this.dragFromSurface = null;
      const l = this.snapLedge();
      if (l) {
        this.surface = { id: l.id };
        this.py = l.y - CAT_GROUND;
        this.px = clamp(this.px, l.x + 30 - CAT_W / 2, l.x + l.w - 30 - CAT_W / 2);
        this.setPerch('stand');
        this.hooks.bubble('站高高~', 1200);
      } else if (speed > 420) {
        const k = Math.min(1, 2600 / speed);
        this.vel.x *= k; this.vel.y *= k;
        this.bounces = 0;
        this.set('thrown');
      } else if (this.feetY() < this.layout.groundY - 24) {
        this.startFall();
      } else {
        this.set('idle');
      }
    });
  }

  /* ─────────────────────────── 敲键（Bongo Cat） ─────────────────────────── */

  private lastTapExpr = 0;

  onKey(d: { code: number; down: boolean }): void {
    if (!d.down || this.paused) return;
    this.lastAct = performance.now();
    if (this.st === 'sleep') { this.set('idle'); this.hooks.bubble(pick(['哈欠…喵?', '嗯?叫我?']), 1400); }
    this.pawSide *= -1;
    this.pawTapT = 0.13;
    if (this.st === 'drag' || this.st === 'thrown') return;
    if (d.code === 53) {
      this.hooks.bubble('!', 700); // Esc
      this.hooks.playExpr('surprise');
    } else {
      // 敲键抬爪表情：节流 350ms，避免连打时表情反复重启
      const now = performance.now();
      if (now - this.lastTapExpr > 350) {
        this.lastTapExpr = now;
        this.hooks.playExpr('tap');
      }
    }
  }

  /* ─────────────────────────── 主进程命令 ─────────────────────────── */

  /** 返回需要外壳处理的命令（skins-updated 由 cat-app 重载皮肤） */
  applyCmd(d: CatCmd, onKeyWarn?: (ok: boolean) => void): void {
    switch (d.type) {
      case 'layout': {
        this.layout = d.layout;
        this.px = clamp(this.px || d.layout.x + d.layout.w / 2 - CAT_W / 2, this.walkMin(), this.walkMax());
        this.py = Math.min(this.py || d.layout.groundY, d.layout.groundY);
        break;
      }
      case 'keystatus':
        onKeyWarn?.(d.ok);
        break;
      case 'pause':
        this.paused = true;
        this.hooks.bubble('暂停中~', 1200);
        break;
      case 'resume':
        this.paused = false;
        this.lastAct = performance.now();
        this.hooks.bubble('回来啦!');
        break;
      case 'sleep-now':
        this.sleepNow();
        break;
      case 'ledges':
        this.ledges = Array.isArray(d.ledges) ? d.ledges : [];
        if (this.surface && !this.ledgeById(this.surface.id)) this.startFall();
        if (this.climb && !this.ledgeById(this.climb.id)) { this.climb = null; this.startFall(); }
        break;
      case 'ledge-gone':
        if (this.surface && this.surface.id === d.id) this.startFall();
        else if (this.climb && this.climb.id === d.id) { this.climb = null; this.startFall(); }
        break;
      case 'go-ground':
        this.goGround();
        break;
      case 'ui-hold':
        this.uiHold = d.active;
        if (d.active) this.lastAct = performance.now(); // 卡片打开期间先别睡
        break;
      case 'skins-updated':
        break; // cat-app 处理
    }
  }

  initLayout(l: CatLayout): void {
    this.layout = l;
    this.px = l.x + l.w / 2 - CAT_W / 2;
    this.py = l.groundY;
  }

  /* ─────────────────────────── 窗口同步 ─────────────────────────── */

  syncWindow(): void {
    const X = Math.round(this.px);
    const Y = Math.round(this.py);
    if (X !== this.lastX || Y !== this.lastY) {
      this.hooks.moveWindow(X, Y);
      this.lastX = X;
      this.lastY = Y;
    }
  }

  /** 空气高度归一化（接地阴影用） */
  air(): number {
    if (!this.layout) return 0;
    return clamp((this.layout.groundY - this.py) / 500, 0, 1);
  }
}
