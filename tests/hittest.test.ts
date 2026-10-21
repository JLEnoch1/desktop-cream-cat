/**
 * 命中区判定测试 —— 防的是「窗口永久穿透，所有按钮都点不了」。
 * 这是上一版真实踩过的坑：把 pointer-events:none 纳入祖先链判断，
 * 结果 #stage 的 none 让所有元素被过滤，hotRects 恒为空。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pointInRects, fallbackHotRects, sanitizeRects, clampDragPosition, type HotRect } from '../src/core/hittest.js';

const W = 400;
const H = 620;

/** 与 selfcheck 实测一致的三块命中区：宠物 / dock / 滑动卡 */
const LIVE: HotRect[] = [
  { x: 80, y: 384, w: 240, h: 230 },   // pet-wrap
  { x: 120, y: 414, w: 160, h: 34 },   // dock
  { x: 35, y: 104, w: 330, h: 308 },   // slide-card
];

test('hit: 真实布局的三个命中区内部都判为命中', () => {
  assert.equal(pointInRects(200, 500, LIVE, W, H), true, '宠物中心');
  assert.equal(pointInRects(200, 430, LIVE, W, H), true, 'dock 中心');
  assert.equal(pointInRects(200, 200, LIVE, W, H), true, '滑动卡中心');
});

test('hit: 边界值命中（左/上闭区间，右/下闭区间）', () => {
  const r: HotRect[] = [{ x: 10, y: 20, w: 100, h: 50 }];
  assert.equal(pointInRects(10, 20, r, W, H), true, '左上角');
  assert.equal(pointInRects(110, 70, r, W, H), true, '右下角');
  assert.equal(pointInRects(9, 20, r, W, H), false, '左外');
  assert.equal(pointInRects(111, 70, r, W, H), false, '右外');
});

test('hit: 命中区之外不命中', () => {
  // 卡片区 y 104–412、宠物区 y 384–614 有重叠，所以「间隙」要往左右两侧找
  assert.equal(pointInRects(350, 560, LIVE, W, H), false, '宠物区右上角空白');
  assert.equal(pointInRects(20, 500, LIVE, W, H), false, '宠物区左侧空白');
  assert.equal(pointInRects(390, 40, LIVE, W, H), false, '窗口右上空白');
  assert.equal(pointInRects(10, 300, LIVE, W, H), false, '卡片左侧空白');
});

test('hit: 窗口外一律不命中（多显示器负坐标场景）', () => {
  assert.equal(pointInRects(-5, 500, LIVE, W, H), false);
  assert.equal(pointInRects(200, -1, LIVE, W, H), false);
  assert.equal(pointInRects(W + 1, 500, LIVE, W, H), false);
  assert.equal(pointInRects(200, H + 1, LIVE, W, H), false);
});

test('hit: NaN/Infinity 不命中（避免脏坐标把整窗变可点）', () => {
  assert.equal(pointInRects(NaN, 500, LIVE, W, H), false);
  assert.equal(pointInRects(200, Infinity, LIVE, W, H), false);
});

test('hit: 空命中区 → 全部不命中（调用方需用兜底，见 fallbackHotRects）', () => {
  assert.equal(pointInRects(200, 500, [], W, H), false);
});

test('hit: 兜底区覆盖窗口底部中央（宠物常驻位）且不含窗口顶部', () => {
  const fb = fallbackHotRects(W, H);
  assert.equal(fb.length, 1);
  const r = fb[0]!;
  // 宠物中心必须落在兜底区内 —— 这是「上报挂掉也不至于全窗穿透」的底线
  assert.equal(pointInRects(200, 500, fb, W, H), true, '兜底区应覆盖宠物位置');
  assert.equal(pointInRects(200, 40, fb, W, H), false, '兜底区不应覆盖窗口顶部');
  // 兜底区不能是整窗（否则挡住整个桌面）
  assert.ok(r.w < W, '兜底区宽度应小于窗口');
  assert.ok(r.h < H, '兜底区高度应小于窗口');
});

test('hit: sanitizeRects 过滤脏数据但保留合法矩形', () => {
  const dirty = [
    { x: 1, y: 2, w: 3, h: 4 },
    { x: NaN, y: 0, w: 10, h: 10 },
    { x: 0, y: 0, w: 0, h: 10 },        // 零宽
    { x: 0, y: 0, w: 10, h: -5 },       // 负高
    { x: '1', y: 0, w: 10, h: 10 },      // 字符串
    null,
    'garbage',
    { x: 5, y: 5, w: 20, h: 20 },
  ];
  const clean = sanitizeRects(dirty);
  assert.equal(clean.length, 2);
  assert.deepEqual(clean[0], { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(clean[1], { x: 5, y: 5, w: 20, h: 20 });
});

test('hit: sanitizeRects 对非数组输入返回空数组', () => {
  assert.deepEqual(sanitizeRects(null), []);
  assert.deepEqual(sanitizeRects(undefined), []);
  assert.deepEqual(sanitizeRects({ x: 1 }), []);
  assert.deepEqual(sanitizeRects('[]'), []);
});

/* ─────────────────────────── clampDragPosition ───────────────────────────
 *
 * 防的是「拖不到屏幕上部分」：宠物画在 620 高窗口的**底部**（本体 y≈434–602），
 * 旧实现钳制窗口左上角「最多超出屏幕上沿 40px」，换算到本体就是「最低只能到
 * 屏幕 y≈394」——光标拖到屏幕顶，宠物却卡在半屏。
 * 新钳制必须保证：**本体**的屏幕位置落在工作区内，窗口透明区可任意出屏。
 */

/** 实测本体矩形（窗口内坐标） */
const BODY: HotRect = { x: 134, y: 434, w: 138, h: 168 };
/** 典型工作区：macOS 菜单栏在顶部，y 从 25 开始 */
const WA = { x: 0, y: 25, width: 1512, height: 919 };

test('clamp: 光标拖到屏幕顶 → 本体贴住工作区上沿（旧 bug 的回归测试）', () => {
  // 按下时窗口在默认位（底部右侧）：winY ≈ 944-620+25 ≈ 324 场景化取值，
  // 这里直接用 grab offset = 光标屏幕坐标 - 窗口坐标 的关系构造：
  // 本体中心按下 → grab.y ≈ BODY.y + BODY.h/2 = 518
  const grab = { x: 200, y: 518 };
  // 光标拖到屏幕最顶端（menu bar 下缘）
  const pos = clampDragPosition(700, 25, grab, BODY, WA);
  // 本体屏幕 y = pos.y + BODY.y，必须 >= WA.y（贴住上沿而不是卡在半屏）
  assert.equal(pos.y + BODY.y, WA.y, '本体应恰好贴住工作区上沿');
  // 窗口左上角此时应在屏幕外（透明区出屏是合法且必要的）
  assert.ok(pos.y < 0, '窗口 y 应为负值（透明顶部移出屏幕）');
  // x 方向跟随光标无钳制时 = 700-200 = 500，在工作区内应原样保留
  assert.equal(pos.x, 500);
});

test('clamp: 拖到屏幕底 → 本体底边贴住工作区下沿', () => {
  const grab = { x: 200, y: 518 };
  const bottom = WA.y + WA.height; // 944
  const pos = clampDragPosition(700, bottom + 200, grab, BODY, WA);
  assert.equal(pos.y + BODY.y + BODY.h, bottom, '本体底边应贴住工作区下沿');
});

test('clamp: 水平方向同理（左右出屏时本体贴边）', () => {
  const grab = { x: 200, y: 518 };
  // 光标拖出左屏外
  const p1 = clampDragPosition(-500, 500, grab, BODY, WA);
  assert.equal(p1.x + BODY.x, WA.x, '本体左边贴工作区左沿');
  // 光标拖出右屏外
  const p2 = clampDragPosition(WA.width + 500, 500, grab, BODY, WA);
  assert.equal(p2.x + BODY.x + BODY.w, WA.x + WA.width, '本体右边贴工作区右沿');
});

test('clamp: 工作区内部移动不受钳制（1:1 跟随光标）', () => {
  const grab = { x: 200, y: 518 };
  const pos = clampDragPosition(800, 500, grab, BODY, WA);
  assert.deepEqual(pos, { x: 600, y: -18 });
});

test('clamp: 多显示器负坐标工作区正常', () => {
  const grab = { x: 200, y: 518 };
  const leftWa = { x: -1920, y: 0, width: 1920, height: 1080 };
  // 光标在左屏顶部（y=0）→ 本体应贴左屏工作区上沿，而不是卡在下半屏
  const pos = clampDragPosition(-1500, 0, grab, BODY, leftWa);
  assert.equal(pos.y + BODY.y, 0, '本体顶边贴左屏工作区上沿');
  // 水平方向未越界 → 1:1 跟随光标：x = screenX - grab.x = -1700
  assert.equal(pos.x, -1700);
  assert.equal(pos.x + BODY.x, -1566, '本体在左屏范围内');
});

test('clamp: 极小屏（本体比工作区还大）退化为居中，不产生 NaN', () => {
  const grab = { x: 0, y: 0 };
  const tiny = { x: 0, y: 0, width: 100, height: 100 }; // 远小于本体 138×168
  const pos = clampDragPosition(50, 50, grab, BODY, tiny);
  assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y), '不得产生 NaN/Infinity');
  // lo > hi → clampBetween 取区间中点：
  //   x 区间 [minX=-134, maxX=-172] → (-134 + -172)/2 = -153
  //   y 区间 [minY=-434, maxY=-502] → (-434 + -502)/2 = -468
  assert.equal(pos.x, -153);
  assert.equal(pos.y, -468);
});
