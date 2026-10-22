# `src/main/index.ts` — 主进程入口

> 模块存根（原 STRUCTURE_MAP §3.14）· 层级 **L4** · 测试：—（--selfcheck / --selftest-click 自检）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：Electron 主进程。窗口创建、IPC 注册、托盘、命中轮询、拖拽、崩溃可观测性与自愈。
 * 不含任何业务逻辑——全部委托 Coordinator。
 *
 * 窗口策略（v1 单宠物单进程）：透明/无边框/置顶(screen-saver)/skipTaskbar/不可调大小。
 * click-through 用「主进程 50ms 轮询光标 + 渲染进程上报 hotRect」而非 forward:true，
 * 因为 macOS 上 transparent + forward 高频切换会触发原生层 SIGABRT。
 */

// ── 模块级常量 ──
const WIN_WIDTH = 400;  const WIN_HEIGHT = 620;  const EDGE_MARGIN = 24;
const CRASH_LOG_MAX_BYTES = 256 * 1024;
const DRAG_STALE_MS = 8000;      // mouseup 丢失保护
const HIT_WARMUP_MS = 2500;      // 启动宽限，期间不告警空命中区
// ── 模块级状态 ──
let win / tray / coordinator / quitting / hotRects / ignoring / hitTimer
let dragOffset / dragLastAt / forcedInteractive / warnedEmptyRects / lastSignal
const APP_START_AT: number;

// ── 崩溃可观测性 ──
function logCrash(tag: string, detail: unknown): void;
// ⟨落盘 <userData>/crash.log；超 256KB 轮转为 .1（只留一份历史）；
//   写日志失败不影响主流程⟩

// ── 窗口 ──
function computeBounds(): Electron.Rectangle;
// ⟨屏幕右下角对齐，留 EDGE_MARGIN；小屏保护：h∈[320, workArea.h-16]，w∈[280, workArea.w-16]⟩
function createWindow(): void;
// ⟨BrowserWindow 配置要点：frame:false, transparent:true, alwaysOnTop('screen-saver'),
//   setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}), focusable:true（不可设 false，
//   否则 macOS 收不到鼠标事件）, acceptFirstMouse:true, showInactive() 不抢焦点；
//   webPreferences: contextIsolation:true, nodeIntegration:false, sandbox:false,
//   backgroundThrottling:false（保 60fps）；
//   初始 setIgnoreMouseEvents(true)；启动 startHitTestLoop()；
//   处理 --selftest-click / --selfcheck 两种自检模式⟩

// ── 状态推送 ──
function sendToRenderer(channel: string, payload: unknown): void;   // ⟨win 已销毁则静默跳过⟩
function flushState(): void;                                        // ⟨统一刷新入口⟩

// ── 命中测试 / click-through ──
function setIgnoreMouseEvents(ignore: boolean): void;   // ⟨同值跳过；异常走 logCrash⟩
function isCursorOverHotRect(): boolean;
// ⟨screen.getCursorScreenPoint() 减窗口原点转窗口内坐标；hotRects 为空则用兜底区⟩
function fallbackHotRects(width: number, height: number): HotRect[];
// ⟨包装 core/hittest 同名函数，附加「空命中区」告警（宽限期后仅告警一次）⟩
function startHitTestLoop(): void;
// ⟨50ms setInterval。优先级：拖拽中(强制可交互，含 DRAG_STALE_MS 超时复位)
//   → forcedInteractive(panel 模式) → 按命中判定⟩
function stopHitTestLoop(): void;

// ── 拖拽移动窗口 ──
function startDrag(screenX: number, screenY: number): void;
function moveDrag(screenX: number, screenY: number): void;
// ⟨限制在目标显示器工作区内，避免拖出屏幕找不回来⟩
function endDrag(): void;

// ── IPC 注册（通道名 → Coordinator 方法）──
function registerIpc(): void;
```

**IPC 通道全表**（`invoke` = 双向有返回，`on` = 单向）：

| 通道 | 类型 | 入参 | 返回 |
|---|---|---|---|
| `app:getState` | invoke | — | `AppState \| null` |
| `win:hotRects` | on | `HotRect[]` | — |
| `win:hitTest` | on | — | — （**deprecated 空实现**，避免与 hotRects 两套机制打架） |
| `renderer:error` | on | `{source, message, stack?}` | — |
| `win:dragStart` / `dragMove` | on | `{x, y}` | — |
| `win:dragEnd` | on | — | — |
| `win:setMode` | invoke | `WindowMode` | `WindowMode` |
| `slide:request` | invoke | `{kind, refId}` | `PendingSlide \| null` |
| `slide:preview` | invoke | `target: number` | `{energy, emotion} \| null` |
| `slide:confirm` | invoke | `{target, note?}` | `DomainEvent \| null` |
| `slide:cancel` | invoke | — | `true` |
| `task:create` | invoke | `{title, estCost, dueAt?}` | `true` |
| `task:drop` | invoke | `taskId: string` | `true` |
| `task:complete` | invoke | `taskId: string` | `PendingSlide \| null` |
| `recovery:take` | invoke | `itemId: string` | `PendingSlide \| null` |
| `recovery:updateDelta` | invoke | `{itemId, delta, reason}` | `RecoveryItem \| null` |
| `recovery:versions` | invoke | `itemId: string` | `RecoveryVersion[]` |
| `energy:set` | invoke | `target: number` | `number`（当前精力） |
| `weather:refresh` | invoke | — | `WeatherState \| null` |
| `recommendation:resolve` | invoke | `{id, action, delta?}` | `boolean` |
| `insight:weeklyReport` | invoke | — | `WeeklyReport \| null` |
| `emotion:summary` | invoke | — | `string` |
| `app:quit` / `app:reposition` | invoke | — | `true` |
| `state:update` | **主→渲染** | — | `AppState`（由 `pushState` 推送） |

```ts
// ── 窗口模式 ──
function applyModeToWindow(mode: WindowMode): void;
// ⟨panel → forcedInteractive=true + 关闭穿透 + focus()；
//   pet → forcedInteractive=false + 交回轮询控制⟩

// ── 托盘 ──
function buildTrayIcon(): Electron.NativeImage;
// ⟨程序化绘制 16×16 BGRA 圆点，无需外部资源；setTemplateImage(true) 跟随系统深浅色⟩
function createTray(): void;
// ⟨静态菜单只构建一次 —— macOS 上菜单显示中调 setContextMenu 会 SIGABRT；
//   动态信息（精力/情绪）改由 tooltip 承载，节流 800ms；
//   菜单项：打开/收起面板 · 刷新天气 · 回到默认位置 · 退出⟩

// ── 应用生命周期 ──
app.requestSingleInstanceLock();   // 拿不到锁 → logCrash + quit，避免多实例抢同一 DB
app.whenReady().then(async () => {
  // process.on('uncaughtException' | 'unhandledRejection') → logCrash 但不退出
  //   （宠物应用「静默死掉」比崩溃更糟）
  // new Coordinator → registerIpc → createWindow → await coordinator.start()
  // app.on('render-process-gone')：自动 reload；连续 >3 次判定为崩溃循环，停止 reload
  // setInterval 30s 清零崩溃计数
  // app.on('child-process-gone')：GPU/Utility 崩溃仅记录
  // coordinator.bus.on(10 个事件) → flushState()；mode:changed 额外 applyModeToWindow
  // createTray() → flushState()
});
process.on('SIGTERM'|'SIGINT'|'SIGHUP') → logCrash + quit;   // 终止信号审计
app.on('window-all-closed') → 仅 quitting 时真退出（macOS 点 Dock 不退出）;
app.on('before-quit') → logCrash(退出原因审计) + coordinator.stop();
app.on('activate') → win 为空则重建;
// 若 process.argv 含 --no-sandbox → app.disableHardwareAcceleration()
```
