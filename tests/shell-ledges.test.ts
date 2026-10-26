/**
 * ledge 过滤单测 —— 移植自 desktop-pet test/ledges.test.js（M3）。
 *
 * 覆盖：空/异常输入防御、正常窗口取顶边、排除规则（自身 PID / 非 0 层 /
 * 太窄 / 太矮 / 全屏 y<wa.y / 贴菜单栏 y-wa.y<4）、露出宽度阈值、
 * 屏幕顶沿 ledge 常驻（字符串 id 'screen-top'）。
 *
 * 运行：npm test（或 esbuild 打包后 node --test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterLedges, screenTopLedge } from '../src/main/ledges.js';
import type { LedgeContext, WinRect } from '../src/main/ledges.js';

const ctx: LedgeContext = {
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  selfPid: 4242,
};

function win(id: number, pid: number, x: number, y: number, w: number, h: number, layer: number): WinRect {
  return { id, pid, x, y, w, h, layer };
}

test('filterLedges: 1) 空/异常输入 → 空列表不崩', () => {
  assert.deepEqual(filterLedges(null, ctx), []);
  assert.deepEqual(filterLedges([], ctx), []);
  assert.deepEqual(filterLedges([null, {}, { id: 'x' }], ctx), []);
});

test('filterLedges: 2) 正常窗口 → 1 条 ledge，y = 窗口顶边', () => {
  const r = filterLedges([win(1, 10, 100, 100, 800, 600, 0)], ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].y, 100);
  assert.equal(r[0].id, 1); // 窗口 ledge 用数字窗口 id
  assert.equal(r[0].pid, 10);
});

test('filterLedges: 3) 排除规则：自身 PID / 非 0 层 / 太窄 / 太矮 / 全屏 / 贴菜单栏', () => {
  const wins = [
    win(1, 4242, 0, 100, 800, 600, 0), // self：自己的透明窗口
    win(2, 10, 0, 100, 800, 600, 3),   // 浮层：非 0 层
    win(3, 10, 0, 100, 200, 600, 0),   // 窄：w < minW(240)
    win(4, 10, 0, 100, 800, 100, 0),   // 矮：h < minHeight(260)
    win(5, 10, 0, 0, 1440, 875, 0),    // 全屏：y < wa.y
    win(6, 10, 0, 26, 1440, 874, 0),   // 贴菜单栏：y - wa.y < 4
  ];
  assert.deepEqual(filterLedges(wins, ctx), []);
});

test('filterLedges: 4) 露出宽度：屏外露出 <120 排除，≥120 保留', () => {
  const wins = [win(7, 10, 1350, 100, 800, 600, 0)]; // 露出 90
  assert.deepEqual(filterLedges(wins, ctx), []);
  const wins2 = [win(8, 10, 1250, 100, 800, 600, 0)]; // 露出 190
  assert.equal(filterLedges(wins2, ctx).length, 1);
});

test('screenTopLedge: 5) 屏幕顶沿 ledge 常驻（字符串 id，横跨工作区）', () => {
  const s = screenTopLedge(ctx);
  assert.equal(s.id, 'screen-top');
  assert.equal(s.y, 25);
  assert.equal(s.w, 1440);
  assert.equal(s.h, 8);
  assert.equal(s.pid, 0);
});
