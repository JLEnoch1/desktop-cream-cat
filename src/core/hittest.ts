/**
 * 命中区判定 —— 纯逻辑，无 Electron/DOM 依赖，主进程与渲染进程共用。
 *
 * click-through 的核心：窗口默认鼠标穿透，只有光标落在「可交互元素的包围盒」内
 * 才关闭穿透。判定错一个方向都会出事：
 *  - 误判为「不命中」→ 窗口永久穿透，所有按钮都点不了
 *  - 误判为「命中」→ 宠物挡住了桌面其他窗口
 */

/** 窗口内坐标（DIP）的矩形 */
export interface HotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 光标是否落在任一命中区内。
 * @param x 光标相对窗口左上角的 x（DIP）
 * @param y 光标相对窗口左上角的 y（DIP）
 * @param rects 命中区列表
 * @param width 窗口宽（用于排除窗口外的点）
 * @param height 窗口高
 */
export function pointInRects(
  x: number,
  y: number,
  rects: readonly HotRect[],
  width: number,
  height: number,
): boolean {
  // 窗口外一律不命中（多显示器/负坐标场景也覆盖到）
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > width || y > height) return false;
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

/**
 * 宠物本体在窗口内的几何比例（按 petBounds() 实测收紧）。
 *
 * 实测参考（400×620 窗口）：主体报出 137×166 ≈ 0.34w × 0.27h。
 * 兜底取略宽裕的 0.36 × 0.30，既罩得住本体，又不会把大片透明区变成死区。
 *
 * 旧值 0.72w × 0.55h（= 288×341）几乎等于整个下半窗，
 * 是「透明区域覆盖背后程序、点不动」的直接来源之一。
 */
export const FALLBACK_BODY_WIDTH_RATIO = 0.36;
export const FALLBACK_BODY_HEIGHT_RATIO = 0.3;

/**
 * 保守兜底命中区：上报链路异常时的最后防线。
 * 宁可让宠物区域可点，也不能整窗穿透——「应用完全不可操作」比「挡一点桌面」严重得多。
 *
 * 但「可点」必须收敛到本体量级：底部居中 + 本体比例，
 * 绝不放大成半窗矩形（那会让背后的程序无法点击）。
 */
export function fallbackHotRects(width: number, height: number): HotRect[] {
  const w = Math.round(width * FALLBACK_BODY_WIDTH_RATIO);
  const h = Math.round(height * FALLBACK_BODY_HEIGHT_RATIO);
  return [{ x: Math.round((width - w) / 2), y: height - h, w, h }];
}

/** 过滤掉脏数据（NaN / 非数字字段），避免污染判定 */
export function sanitizeRects(input: unknown): HotRect[] {
  if (!Array.isArray(input)) return [];
  const out: HotRect[] = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') continue;
    const { x, y, w, h } = r as Record<string, unknown>;
    if (![x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    if ((w as number) < 1 || (h as number) < 1) continue;
    out.push({ x: x as number, y: y as number, w: w as number, h: h as number });
  }
  return out;
}

/* ─────────────────────────── 拖拽钳制 ─────────────────────────── */

/** 工作区（屏幕可用区域，已排除菜单栏/Dock），与 Electron.Rectangle 同构 */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampBetween(v: number, lo: number, hi: number): number {
  // lo > hi 说明本体比工作区还大（极小屏）：退而居中，保证不会算出 NaN 或反向区间
  if (lo > hi) return Math.round((lo + hi) / 2);
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 拖拽时计算窗口左上角应处的位置，约束「**宠物本体**」留在工作区内。
 *
 * 为什么不能钳制窗口角（旧实现的 bug）：宠物画在一个很高的窗口**底部**
 * （本体约在窗口 y=434–602，窗口高 620）。若钳制窗口左上角「最多超出屏幕上沿 40px」，
 * 换算到本体就是「本体最低只能到屏幕 y≈394」——用户把光标拖到屏幕顶，
 * 宠物本体却卡在半屏，光标与宠物脱节数百像素，表现为「拖不到屏幕上部分」。
 *
 * 正确做法：让**本体的屏幕位置**（= 窗口位置 + 本体在窗口内的偏移）落在工作区内。
 *   本体屏幕 y = winY + body.y ∈ [wa.y, wa.y + wa.height - body.h]
 *   ⇒ winY ∈ [wa.y - body.y, wa.y + wa.height - body.y - body.h]
 * 这样窗口顶部大片透明区可以移出屏幕外（无害，热区已按视口裁剪），
 * 而宠物本体始终可见、可继续拖拽到屏幕任意位置。
 *
 * @param screenX 当前光标屏幕 x
 * @param screenY 当前光标屏幕 y
 * @param grabOffset 按下时记录的 { screenX - winX, screenY - winY }
 * @param body 宠物本体在**窗口内**的矩形（来自 petBounds，或 fallback 估算）
 * @param wa 当前光标所在显示器的工作区
 */
export function clampDragPosition(
  screenX: number,
  screenY: number,
  grabOffset: { x: number; y: number },
  body: HotRect,
  wa: WorkArea,
): { x: number; y: number } {
  // 未钳制的窗口左上角目标位置
  const rawX = screenX - grabOffset.x;
  const rawY = screenY - grabOffset.y;
  // 由「本体留在工作区」反推窗口左上角的允许区间
  const minX = wa.x - body.x;
  const maxX = wa.x + wa.width - body.x - body.w;
  const minY = wa.y - body.y;
  const maxY = wa.y + wa.height - body.y - body.h;
  return {
    x: Math.round(clampBetween(rawX, minX, maxX)),
    y: Math.round(clampBetween(rawY, minY, maxY)),
  };
}
