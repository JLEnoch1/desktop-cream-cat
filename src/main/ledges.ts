/**
 * 窗口顶边（ledge）过滤 —— 纯函数、零依赖（移植自 desktop-pet lib/ledges.js）。
 *
 * 输入：winlist.swift 的窗口矩形数组 + 布局上下文；输出：可站立的顶边列表。
 * 每条 ledge：{ id, x, y, w, h, pid }，y = 窗口顶边屏幕坐标。
 */

export interface WinRect {
  id: number;
  pid: number;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

/** ledge 的 id：窗口 ledge 用数字窗口 id；屏幕顶沿用常量字符串 'screen-top' */
export type LedgeId = number | string;

export interface Ledge {
  id: LedgeId;
  x: number;
  y: number;
  w: number;
  h: number;
  pid: number;
}

export interface WorkAreaLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LedgeContext {
  workArea?: WorkAreaLike;
  selfPid?: number;
  minW?: number;
  minExposed?: number;
  minHeight?: number;
}

export function filterLedges(wins: unknown, ctx?: LedgeContext): Ledge[] {
  const wa = ctx?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const selfPid = ctx?.selfPid == null ? -1 : ctx.selfPid;
  const minW = ctx?.minW == null ? 240 : ctx.minW;
  const minExposed = ctx?.minExposed == null ? 120 : ctx.minExposed;
  const minHeight = ctx?.minHeight == null ? 260 : ctx.minHeight;
  const out: Ledge[] = [];
  if (!Array.isArray(wins)) return out;
  for (const w of wins as Partial<WinRect>[]) {
    if (!w || typeof w.id !== 'number') continue;
    if (w.pid === selfPid) continue; // 自己的透明窗口
    if (w.layer !== 0) continue; // 仅普通窗口层（菜单栏/Dock/浮层不要）
    const ww = w.w ?? 0;
    const wh = w.h ?? 0;
    if (ww < minW || wh < minHeight) continue;
    // 与主屏工作区求交：露出宽度不足不站
    const x0 = Math.max(w.x ?? 0, wa.x);
    const x1 = Math.min((w.x ?? 0) + ww, wa.x + wa.width);
    const exposed = x1 - x0;
    if (exposed < minExposed) continue;
    // 顶边必须在工作区内（全屏/贴菜单栏的窗口顶边猫站不上去，留给屏幕顶沿）
    const wy = w.y ?? 0;
    if (wy < wa.y) continue;
    if (wy - wa.y < 4) continue; // 顶边即菜单栏下缘，与屏幕顶沿 ledge 重合，去重
    out.push({ id: w.id, x: w.x ?? 0, y: wy, w: ww, h: wh, pid: w.pid ?? 0 });
  }
  return out;
}

/** 屏幕顶沿 ledge（菜单栏下缘）：常驻，横跨主屏工作区宽度 */
export function screenTopLedge(ctx?: LedgeContext): Ledge {
  const wa = ctx?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  return { id: 'screen-top', x: wa.x, y: wa.y, w: wa.width, h: 8, pid: 0 };
}
