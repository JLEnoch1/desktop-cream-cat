# `src/core/hittest.ts` — 命中区判定

> 模块存根（原 STRUCTURE_MAP §3.4）· 层级 **L0** · 测试：tests/hittest.test.ts（15 例）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：click-through 几何判定的纯逻辑，无 Electron/DOM 依赖，双进程可共用。
 * 误判代价不对称：漏判 → 窗口永久穿透按钮全失效；误判 → 宠物挡住桌面。
 */

export interface HotRect { x: number; y: number; w: number; h: number }  // 窗口内 DIP 坐标

export function pointInRects(
  x: number, y: number,
  rects: readonly HotRect[],
  width: number, height: number,
): boolean;
// ⟨光标是否落在任一命中区内。x/y 为相对窗口左上角坐标；
//   非有限值或窗口外一律 false（覆盖多显示器负坐标场景）；矩形为闭区间⟩

export function fallbackHotRects(width: number, height: number): HotRect[];
// ⟨上报链路异常时的保守兜底：窗口底部中央 72%×55% 单矩形。
//   宁可让宠物区可点，也不整窗穿透⟩

export function sanitizeRects(input: unknown): HotRect[];
// ⟨过滤脏数据：非数组 → []；剔除 NaN/非数字字段、w<1 或 h<1 的矩形⟩
```
