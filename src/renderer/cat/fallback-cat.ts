/**
 * 程序化线稿猫（零素材回退渲染器，移植自 desktop-pet renderer/cat.js drawCat）。
 *
 * 图像皮肤不可用（无素材/加载失败/渲染异常）时的保底：把 FSM 的 pose 参数
 * 画成一只墨线卡通猫。融合版沿用奶油猫的线稿语言（INK 描边 + 白身 + 粉点缀）。
 */

import { CAT_GROUND as GROUND, CAT_CX as CX, type CatPose } from './cat-fsm.js';

const INK = '#20242a';
const PINK = '#f78ca0';
const CREAM = '#FFF6E8'; // 奶油底色：白身偏一点点奶油（融合点题）

export interface FallbackExtras {
  /** 全局时间（抖动/翅膀扇动用） */
  t: number;
  /** 空气高度归一化 0–1（接地阴影） */
  air: number;
}

export function drawFallbackCat(ctx: CanvasRenderingContext2D, p: CatPose, ex: FallbackExtras): void {
  const { t, air } = ex;
  // 接地阴影：离地越高越小越淡
  ctx.fillStyle = `rgba(0,0,0,${0.16 * (1 - 0.65 * air)})`;
  ctx.beginPath();
  ctx.ellipse(CX, GROUND + 2, 60 * (1 - 0.5 * air) * p.sx, 9 * (1 - 0.4 * air), 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(CX, GROUND);
  ctx.rotate(p.rot);
  ctx.scale(p.face * p.sx, p.sy);
  ctx.lineWidth = 5;
  ctx.strokeStyle = INK;
  ctx.fillStyle = CREAM;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const shape = (pathFn: () => void, fill = true): void => {
    ctx.beginPath();
    pathFn();
    if (fill) ctx.fill();
    ctx.stroke();
  };
  const ell = (x: number, y: number, rx: number, ry: number, fill = true): void => {
    shape(() => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2), fill);
  };
  const circle = (x: number, y: number, r: number, fill = true): void => {
    shape(() => ctx.arc(x, y, r, 0, Math.PI * 2), fill);
  };
  // 描边管状（先粗黑后细白 => 线稿风轮廓）
  const tube = (pathFn: () => void, w: number): void => {
    ctx.beginPath();
    pathFn();
    ctx.lineWidth = w;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    pathFn();
    ctx.lineWidth = w - 7;
    ctx.strokeStyle = CREAM;
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
  };

  // 尾巴（身体后）
  if (p.tailWrap) {
    tube(() => { ctx.moveTo(-46, -12); ctx.quadraticCurveTo(0, 8, 46, -10); }, 15);
  } else {
    const ph = p.tailPh;
    const amp = p.tailAmp;
    tube(() => {
      ctx.moveTo(44, -36);
      ctx.quadraticCurveTo(86, -46 - Math.sin(ph) * 14 * amp, 92, -96 - Math.sin(ph + 1.1) * 18 * amp);
    }, 15);
  }

  // 走路的小脚
  if (p.legsOn) {
    for (let i = 0; i < 4; i++) {
      const lift = Math.max(0, Math.sin(p.legPh + i * Math.PI)) * 7;
      ell(-36 + i * 24, -6 - lift, 10, 8);
    }
  }

  // 身体
  ell(0, -46, 54, 42);

  // 被拎起来/飞出去时四肢张开
  if (p.splay > 0) {
    const s = p.splay;
    const flap = Math.sin(t * 26) * 4 * s;
    for (const sd of [-1, 1]) {
      tube(() => { ctx.moveTo(sd * 28, -72); ctx.lineTo(sd * (28 + 30 * s), -72 - 26 * s - flap); }, 13);
      circle(sd * (28 + 30 * s), -72 - 26 * s - flap, 9);
      tube(() => { ctx.moveTo(sd * 24, -14); ctx.lineTo(sd * (24 + 26 * s), -14 + 18 * s); }, 13);
      circle(sd * (24 + 26 * s), -14 + 18 * s, 9);
    }
  }

  // 头（耳 → 脸）
  ctx.save();
  ctx.translate(0, -96);
  ctx.rotate(p.headTilt);
  for (const sd of [-1, 1]) {
    const droop = sd < 0 ? p.earL || 0 : p.earR || 0;
    const tipX = sd * (30 - droop * 6);
    const tipY = -60 + droop * 24;
    shape(() => { ctx.moveTo(sd * 10, -34); ctx.lineTo(sd * 36, -26); ctx.lineTo(tipX, tipY); ctx.closePath(); });
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.moveTo(sd * 17, -30); ctx.lineTo(sd * 30, -26); ctx.lineTo(tipX * 0.82, tipY * 0.82 - 4); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = CREAM;
  }
  circle(0, -8, 40);
  // 眼睛
  for (const sd of [-1, 1]) {
    const ex2 = sd * 15;
    const ey = -12;
    if (p.eyes === 'open') { ctx.fillStyle = INK; circle(ex2, ey, 4.5); ctx.fillStyle = CREAM; }
    else if (p.eyes === 'blink') { ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(ex2 - 5, ey); ctx.lineTo(ex2 + 5, ey); ctx.stroke(); ctx.lineWidth = 5; }
    else if (p.eyes === 'happy') { ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(ex2, ey + 3, 6, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); ctx.lineWidth = 5; }
    else if (p.eyes === 'closed') { ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(ex2, ey - 3, 6, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke(); ctx.lineWidth = 5; }
    else if (p.eyes === 'wide') { circle(ex2, ey, 8); ctx.fillStyle = INK; circle(ex2, ey + 1, 3); ctx.fillStyle = CREAM; }
  }
  // 嘴
  ctx.lineWidth = 4;
  if (p.mouth === 'w') {
    ctx.beginPath(); ctx.arc(-6, 2, 6, 0, Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(6, 2, 6, 0, Math.PI); ctx.stroke();
  } else if (p.mouth === 'o') {
    ctx.beginPath(); ctx.arc(0, 5, 4.5, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(-5, 6); ctx.lineTo(5, 6); ctx.stroke();
  }
  ctx.lineWidth = 5;
  // 胡须
  ctx.lineWidth = 3;
  for (const sd of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(sd * 30, -2); ctx.lineTo(sd * 52, -6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sd * 30, 4); ctx.lineTo(sd * 52, 6); ctx.stroke();
  }
  ctx.lineWidth = 5;
  // 脸红
  if (p.blush) {
    ctx.fillStyle = 'rgba(247,140,160,0.55)';
    ctx.beginPath(); ctx.ellipse(-27, 2, 7, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(27, 2, 7, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = CREAM;
  }
  ctx.restore(); // 头

  // 前爪拍键（bongo cat）
  if (p.pawL > 0) {
    tube(() => { ctx.moveTo(-24, -58); ctx.lineTo(-34, -58 - 26 * p.pawL); }, 13);
    circle(-34, -58 - 26 * p.pawL, 8);
  }
  if (p.pawR > 0) {
    tube(() => { ctx.moveTo(24, -58); ctx.lineTo(34, -58 - 26 * p.pawR); }, 13);
    circle(34, -58 - 26 * p.pawR, 8);
  }

  ctx.restore();
}
