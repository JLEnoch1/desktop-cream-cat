/**
 * 主进程入口 —— 窗口初始化 + IPC + 模块协调。
 *
 * 窗口策略（v1：单宠物单进程）：
 *  - 透明、无边框、置顶、不进任务栏（skipTaskbar）、不可调大小
 *  - 一个窗口承载「宠物层 + 卡片层」：宠物常驻底部，面板/卡片在其上方展开
 *  - click-through：主进程按 50ms 轮询光标位置，只有落在渲染进程上报的
 *    hotRect（可交互元素包围盒）内才关闭穿透。这样宠物平时完全不挡桌面操作，
 *    又不会因为渲染进程 mousemove → IPC → setIgnoreMouseEvents 的高频切换而崩溃
 *    （macOS 上 transparent + forward:true + 频繁切换是已知的 SIGABRT 来源）。
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } from 'electron';
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from './coordinator.js';
import type { AppState, PendingSlide, WindowMode } from '../core/types.js';
import { pointInRects, fallbackHotRects as fallbackRectsOf, sanitizeRects, clampDragPosition, FALLBACK_BODY_WIDTH_RATIO, FALLBACK_BODY_HEIGHT_RATIO, type HotRect } from '../core/hittest.js';

// 受限环境（沙箱/无 GPU）兼容：显式传入 --no-sandbox 时自动关闭硬件加速，
// 避免 GPU 进程反复崩溃导致应用退出。正常桌面环境不受影响。
if (process.argv.includes('--no-sandbox')) {
  app.disableHardwareAcceleration();
}

/** 崩溃/异常日志落盘（默认 userData/crash.log），便于事后定位 */
let crashLogPath: string | null = null;
const CRASH_LOG_MAX_BYTES = 256 * 1024;

function logCrash(tag: string, detail: unknown): void {
  const text = `[${new Date().toISOString()}] ${tag} :: ${
    detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : JSON.stringify(detail)
  }\n`;
  console.error(text.trim());
  try {
    crashLogPath ??= join(app.getPath('userData'), 'crash.log');
    // 简单轮转：超过上限就把当前文件挪成 .1，只保留一份历史
    try {
      if (statSync(crashLogPath).size > CRASH_LOG_MAX_BYTES) {
        renameSync(crashLogPath, `${crashLogPath}.1`);
      }
    } catch { /* 文件不存在或轮转失败，忽略 */ }
    appendFileSync(crashLogPath, text);
  } catch { /* 日志失败不影响主流程 */ }
}


/** 窗口尺寸：宠物区 + 面板区 */
const WIN_WIDTH = 400;
const WIN_HEIGHT = 620;
/** 距屏幕右下角边距 */
const EDGE_MARGIN = 24;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let coordinator: Coordinator | null = null;
let quitting = false;

/* ─────────────────────────── 窗口 ─────────────────────────── */

function computeBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  // 小屏保护：窗口不超过工作区，避免布局溢出屏幕外
  const h = Math.min(WIN_HEIGHT, Math.max(320, workArea.height - 16));
  const w = Math.min(WIN_WIDTH, Math.max(280, workArea.width - 16));
  return {
    x: Math.max(workArea.x, workArea.x + workArea.width - w - EDGE_MARGIN),
    y: Math.max(workArea.y, workArea.y + workArea.height - h - EDGE_MARGIN),
    width: w,
    height: h,
  };
}

function createWindow(): void {
  const bounds = computeBounds();
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 不用 focusable:false —— macOS 上该窗口收不到鼠标事件（点击直接穿透），
    // 且与 setIgnoreMouseEvents 组合会触发原生层断言。不抢焦点靠 showInactive() 保证。
    focusable: true,
    acceptFirstMouse: true,    // 首次点击即生效，不需要先「激活」窗口
    show: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false, // 动画保持 60fps
    },
  });

  // 置顶级别：screen-saver 保证盖过普通窗口，但不挡系统 UI
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 默认鼠标穿透；命中区由渲染进程上报，主进程轮询切换（见 isCursorOverHotRect）
  win.setIgnoreMouseEvents(true);
  ignoring = true;

  const url = process.env.ENERGY_PET_DEV_URL;
  if (url) {
    void win.loadURL(url);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win?.showInactive();
  });

  // 启动命中区轮询
  startHitTestLoop();

  // 自检模式：程序化模拟「点击宠物」全链路，验证不崩（--selftest-click）
  if (process.argv.includes('--selftest-click')) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const wc = win?.webContents;
        const fail = (msg: string): void => { logCrash('selftest-click FAILED', msg); quitting = true; app.quit(); };
        if (!wc || wc.isDestroyed()) { fail('webContents missing'); return; }
        try {
          // 1) 模拟点击宠物：mousedown → dragStart → mouseup → dragEnd → emotionSummary
          const r1 = await wc.executeJavaScript(`(async () => {
            const petWrap = document.getElementById('pet-wrap');
            if (!petWrap) return 'no pet-wrap';
            const r = petWrap.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2) + window.screenX;
            const y = Math.round(r.top + r.height / 2) + window.screenY;
            petWrap.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, screenX: x, screenY: y }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const summary = await window.pet.emotionSummary();
            return 'ok:' + (summary ? summary.slice(0, 12) : 'null');
          })()`);
          // 2) 模拟光标进出命中区：反复切换 ignore 状态，验证原生层不崩
          for (let i = 0; i < 25; i++) {
            setIgnoreMouseEvents(i % 2 === 0);
            await new Promise(res => setTimeout(res, 20));
          }
          setIgnoreMouseEvents(true);
          // 3) 验证窗口与渲染进程仍然存活
          await new Promise(res => setTimeout(res, 300));
          const alive = !!win && !win.isDestroyed() && !wc.isDestroyed();
          if (!alive) { fail('process died after click simulation'); return; }
          const r2 = await wc.executeJavaScript('document.getElementById("pet-canvas") ? "canvas-ok" : "canvas-missing"');
          console.log(`[selftest-click] click=${r1} toggle25=ok render=${r2} alive=${alive}`);
          quitting = true;
          app.quit();
        } catch (err) {
          fail(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
        }
      }, 2600);
    });
  }

  // 自检模式：截一张窗口图后退出（--selfcheck [输出路径]）
  if (process.argv.includes('--selfcheck')) {
    const idx = process.argv.indexOf('--selfcheck');
    const outPath = process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('-')
      ? process.argv[idx + 1]!
      : join(app.getPath('temp'), 'energy-pet-selfcheck.png');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 命中区体检：hotRects 为空 = 窗口永久穿透 = 所有按钮都点不了
          const hit = await win!.webContents.executeJavaScript(
            'JSON.stringify({ rects: window.__hotRects ?? [], innerW: window.innerWidth, innerH: window.innerHeight,'
            + ' slider: (() => { const s = document.getElementById("s-slider"); const v = document.getElementById("s-value"); const d = document.getElementById("s-delta");'
            + ' const p = document.getElementById("s-predicted"); const c = document.getElementById("slide-card");'
            + ' return s ? { min: s.min, max: s.max, value: s.value, shown: v ? v.textContent : null, delta: d ? d.textContent : null, predicted: p ? p.textContent : null, cardClass: c ? c.className : null } : null; })() })',
          );
          console.log(`[selfcheck] hitRects=${hit}`);
          const image = await win!.webContents.capturePage();
          const { writeFile } = await import('node:fs/promises');
          await writeFile(outPath, image.toPNG());
          console.log(`[selfcheck] screenshot saved: ${outPath} (${image.getSize().width}x${image.getSize().height})`);
        } catch (err) {
          console.error('[selfcheck] capture failed:', err);
        }
        quitting = true;
        app.quit();
      }, 2500);
    });
  }

  win.on('closed', () => { win = null; stopHitTestLoop(); });
}

/* ─────────────────────────── 状态推送 ─────────────────────────── */

function sendToRenderer(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/** 统一的状态刷新入口（节流由 bus 的 debounce 负责） */
function flushState(): void {
  coordinator?.pushState(sendToRenderer);
}

/* ─────────────────────────── 命中测试 / click-through ─────────────────────────── */

/**
 * 可交互区域（窗口内 DIP 坐标）。渲染进程布局变化时上报，
 * 主进程按 50ms 轮询光标判断是否命中。
 *
 * 为什么不用 setIgnoreMouseEvents(true, {forward:true}) + 渲染进程 mousemove 命中：
 * macOS 上 transparent + forward 模式在鼠标进出边界时高频切换会触发原生层 SIGABRT
 * （表现为「点一下就闪退」）。轮询方案把切换频率压到人类不可感知的粒度，且完全
 * 不依赖窗口服务器转发鼠标事件。
 */
let hotRects: HotRect[] = [];
let ignoring = true;
let hitTimer: ReturnType<typeof setInterval> | null = null;

function setIgnoreMouseEvents(ignore: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (ignore === ignoring) return;
  ignoring = ignore;
  try {
    win.setIgnoreMouseEvents(ignore);
  } catch (err) {
    logCrash('setIgnoreMouseEvents failed', err);
  }
}

function isCursorOverHotRect(): boolean {
  if (!win || win.isDestroyed()) return false;
  // 兜底：一个命中区都没有说明上报链路出了问题。此时宁可让宠物区域可点，
  // 也不能全窗口穿透——「应用完全不可操作」比「偶尔挡一点桌面」严重得多。
  const b = win.getBounds();
  const rects = hotRects.length > 0 ? hotRects : fallbackHotRects(b.width, b.height);
  const pt = screen.getCursorScreenPoint();
  return pointInRects(pt.x - b.x, pt.y - b.y, rects, b.width, b.height);
}

let warnedEmptyRects = false;
/** 启动宽限：渲染进程初始化期间还没有上报命中区是正常的，别刷告警 */
const APP_START_AT = Date.now();
const HIT_WARMUP_MS = 2500;

/** 兜底 + 告警（几何计算在 core/hittest 里，便于单测） */
function fallbackHotRects(width: number, height: number): HotRect[] {
  if (!warnedEmptyRects && Date.now() - APP_START_AT > HIT_WARMUP_MS) {
    warnedEmptyRects = true;
    logCrash('hotRects empty', '渲染进程未上报命中区，已启用兜底区域（宠物底部中央）');
  }
  return fallbackRectsOf(width, height);
}

function startHitTestLoop(): void {
  if (hitTimer) return;
  hitTimer = setInterval(() => {
    try {
      // 拖拽中强制保持可交互：光标可能瞬间移出命中区，一旦切回穿透拖拽就断了
      if (dragOffset) {
        // mouseup 丢失保护：拖拽状态超时未活动则强制复位，避免窗口永远挡住桌面
        if (Date.now() - dragLastAt > DRAG_STALE_MS) { endDrag(); }
        else { setIgnoreMouseEvents(false); return; }
      }
      if (Date.now() < forcedInteractiveUntil) { setIgnoreMouseEvents(false); return; }
      setIgnoreMouseEvents(!isCursorOverHotRect());
    } catch (err) {
      logCrash('hitTest loop failed', err);
    }
  }, 50);
}

function stopHitTestLoop(): void {
  if (hitTimer) { clearInterval(hitTimer); hitTimer = null; }
}

/* ─────────────────────────── 拖拽移动窗口 ─────────────────────────── */

/**
 * 拖拽状态。
 * grab = 按下瞬间 { screenX - winX, screenY - winY }（光标相对窗口左上角）。
 * body = 宠物本体在**窗口内**的矩形，用于钳制「本体留在工作区」而非「窗口角留白」。
 *   渲染端随 dragStart 上报（来自 petBounds）；缺失时用 fallback 估算兜底。
 */
let dragOffset: { x: number; y: number; body: HotRect } | null = null;
/** 最后一次拖拽活动时间：mouseup 可能丢失（拖到屏幕外/失焦），超时强制复位 */
let dragLastAt = 0;
const DRAG_STALE_MS = 8000;

/** dragStart 未带 body（旧渲染端/异常）时的兜底：底部居中的本体量级矩形 */
function fallbackDragBody(): HotRect {
  const w = Math.round(WIN_WIDTH * FALLBACK_BODY_WIDTH_RATIO);
  const h = Math.round(WIN_HEIGHT * FALLBACK_BODY_HEIGHT_RATIO);
  return { x: Math.round((WIN_WIDTH - w) / 2), y: WIN_HEIGHT - h, w, h };
}

function startDrag(screenX: number, screenY: number, body?: HotRect): void {
  if (!win) return;
  const [wx, wy] = win.getPosition();
  const b = sanitizeRects([body])[0] ?? fallbackDragBody();
  dragOffset = { x: screenX - wx, y: screenY - wy, body: b };
  dragLastAt = Date.now();
}

function moveDrag(screenX: number, screenY: number): void {
  if (!win || !dragOffset) return;
  dragLastAt = Date.now();
  const { workArea } = screen.getDisplayNearestPoint({ x: screenX, y: screenY });
  // 钳制「宠物本体」留在工作区（而非窗口角）——修复「拖不到屏幕上部分」：
  // 宠物画在高窗底部，旧实现按窗口角留白会把本体卡死在下半屏。
  const pos = clampDragPosition(
    screenX, screenY,
    { x: dragOffset.x, y: dragOffset.y },
    dragOffset.body,
    { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
  );
  win.setPosition(pos.x, pos.y, false);
}

function endDrag(): void {
  dragOffset = null;
  dragLastAt = 0;
}

/* ─────────────────────────── IPC ─────────────────────────── */

function registerIpc(): void {
  const c = () => coordinator;

  ipcMain.handle('app:getState', (): AppState | null => c()?.buildState() ?? null);

  // 命中区上报：渲染进程布局变化时推送可交互元素包围盒（窗口内 DIP 坐标）
  ipcMain.on('win:hotRects', (_e, payload: HotRect[]) => {
    hotRects = sanitizeRects(payload);
    if (hotRects.length > 0 && warnedEmptyRects) {
      // 之前触发过兜底，现在拿到真实命中区了 —— 记录恢复，并允许下次异常再告警
      logCrash('hotRects recovered', { count: hotRects.length });
      warnedEmptyRects = false;
    }
    // 布局刚变化时立即重算一次，避免 50ms 空窗内点击落空
    try { setIgnoreMouseEvents(!isCursorOverHotRect()); } catch (err) { logCrash('hotRects update failed', err); }
  });

  // 兼容旧通道（渲染进程若仍在用状态式上报，不报错、不切换，
  // 一切以 hotRects 轮询为准，避免两套机制互相打架）
  ipcMain.on('win:hitTest', () => { /* deprecated: 见 win:hotRects */ });

  // 渲染进程错误上报（黑匣子）
  ipcMain.on('renderer:error', (_e, info: { source: string; message: string; stack?: string }) => {
    logCrash(`renderer:${info?.source ?? 'unknown'}`, `${info?.message ?? ''}\n${info?.stack ?? ''}`);
  });

  // 拖拽
  ipcMain.on('win:dragStart', (_e, p: { x: number; y: number; body?: HotRect }) => startDrag(p.x, p.y, p.body));
  ipcMain.on('win:dragMove', (_e, p: { x: number; y: number }) => moveDrag(p.x, p.y));
  ipcMain.on('win:dragEnd', () => endDrag());

  // 窗口模式
  ipcMain.handle('win:setMode', (_e, mode: WindowMode) => {
    c()?.setMode(mode);
    applyModeToWindow(mode);
    flushState();
    return c()?.getMode() ?? 'pet';
  });

  // 滑动确认
  ipcMain.handle('slide:request', (_e, p: { kind: PendingSlide['kind']; refId: string }) => {
    const slide = c()?.requestSlide(p.kind, p.refId) ?? null;
    flushState();
    return slide;
  });
  ipcMain.handle('slide:preview', (_e, target: number) => c()?.previewSlide(Number(target) || 0) ?? null);
  ipcMain.handle('slide:confirm', (_e, p: { target: number; note?: string }) => {
    const ev = c()?.confirmSlide(Number(p.target) || 0, p.note) ?? null;
    flushState();
    return ev;
  });
  ipcMain.handle('slide:cancel', () => { c()?.cancelSlide(); flushState(); return true; });

  // 任务
  ipcMain.handle('task:create', (_e, p: { title: string; estCost: number; dueAt?: number | null; estMinutes?: number }) => {
    c()?.createTask(p.title, Number(p.estCost) || 0, p.dueAt ?? null, Number(p.estMinutes) || 0);
    flushState();
    return true;
  });
  ipcMain.handle('task:drop', (_e, taskId: string) => { c()?.dropTask(taskId); flushState(); return true; });
  // 旧通道：任务完成已迁至「先确认时长 → 事件后调节窗口」两步流程。
  // requestSlide 对 task-complete/recovery 恒返回 null（写入点收敛到 adjust:commit），
  // 保留 handler 仅为兼容旧渲染端调用，不再产生任何副作用。
  ipcMain.handle('task:complete', (_e, taskId: string) => {
    const slide = c()?.requestSlide('task-complete', taskId) ?? null;
    flushState();
    return slide;
  });
  // 流程第一步：取任务名称与预估时长（不开窗口、不落库）
  ipcMain.handle('task:durationRequest', (_e, taskId: string) => c()?.taskDurationRequest(String(taskId)) ?? null);
  // 流程第二步：确认实际时长后才打开调节窗口
  ipcMain.handle('task:completeWithDuration', (_e, p: { taskId: string; actualMinutes: number }) => {
    const w = c()?.taskCompleteWithDuration(String(p.taskId), Number(p.actualMinutes) || 0) ?? null;
    flushState();
    return w;
  });

  // 恢复
  ipcMain.handle('recovery:take', (_e, itemId: string) => {
    const slide = c()?.requestSlide('recovery', itemId) ?? null;
    flushState();
    return slide;
  });
  // 恢复项：时长固定，直接打开调节窗口
  ipcMain.handle('recovery:startAdjust', (_e, itemId: string) => {
    const w = c()?.recoveryStartAdjust(String(itemId)) ?? null;
    flushState();
    return w;
  });
  ipcMain.handle('recovery:updateDelta', (_e, p: { itemId: string; delta: number; reason: string }) => {
    const item = c()?.deck.updateDelta(p.itemId, Number(p.delta) || 0, p.reason || '手动调整') ?? null;
    flushState();
    return item;
  });
  ipcMain.handle('recovery:versions', (_e, itemId: string) => c()?.deck.versions(itemId) ?? []);

  // 事件后精力调节窗口（写入点唯一：adjust:commit → Coordinator.commitAdjust）
  ipcMain.handle('adjust:draft', (_e, target: number) => c()?.adjustDraft(Number(target) || 0) ?? null);
  ipcMain.handle('adjust:commit', (_e, note?: string) => {
    const ev = c()?.commitAdjust(note) ?? null;
    flushState();
    return ev;
  });
  ipcMain.handle('adjust:cancel', () => { c()?.cancelAdjust(); flushState(); return true; });

  // 精力手动校准
  ipcMain.handle('energy:set', (_e, target: number) => {
    c()?.ledger.setEnergy(Number(target) || 0, '手动校准');
    flushState();
    return c()?.ledger.current() ?? 0;
  });

  // 天气
  ipcMain.handle('weather:refresh', async () => {
    const w = await (c()?.weather.refresh() ?? Promise.resolve(null));
    flushState();
    return w;
  });

  // AI 推荐
  ipcMain.handle('recommendation:resolve', (_e, p: { id: string; action: 'accepted' | 'modified' | 'rejected'; delta?: number }) => {
    const ok = c()?.resolveRecommendation(p.id, p.action, p.delta) ?? false;
    flushState();
    return ok;
  });

  // 周报
  ipcMain.handle('insight:weeklyReport', () => c()?.weeklyReport() ?? null);
  // 周报弹窗确认/关闭（需求 5：每天 17:30 弹一次，周五需确认）
  ipcMain.handle('report:confirm', () => { c()?.confirmReport(); flushState(); return true; });

  // 情绪摘要（气泡）
  ipcMain.handle('emotion:summary', () => c()?.emotionSummary() ?? '');

  // 应用
  ipcMain.handle('app:quit', () => { app.quit(); return true; });
  ipcMain.handle('app:reposition', () => { win?.setBounds(computeBounds()); return true; });
}

/** 面板模式需要可聚焦与可交互；宠物模式回到穿透 */
/**
 * 窗口模式切换。
 *
 * 注意：不用 setFocusable(false) 来做「不抢焦点」。macOS 上 focusable=false 的窗口
 * 同时会失去鼠标事件接收能力（点击直接穿透到下层），这是「点了没反应/异常退出」的
 * 经典来源。改为始终 focusable，只在面板模式显式 focus()，宠物模式靠 showInactive()
 * 保证不夺走当前 App 的焦点。
 */
/**
 * 面板展开时的「可交互宽限期」。
 *
 * 为什么需要：面板 class 变化 → MutationObserver → 200ms 节流 → IPC 上报热区，
 * 这中间有最多 ~250ms 的空窗，若完全交给轮询，用户点面板第一下可能落空。
 * 宽限期只保证「展开瞬间可点」，之后立刻交回精确热区轮询 ——
 * 这样收起时命中区随 class 变化即刻回收，不会像旧的 forcedInteractive
 * 那样长期整窗放行（那正是「面板收起后热区过大、挡住背后程序」的主进程侧根因）。
 */
const PANEL_INTERACTIVE_GRACE_MS = 600;
let forcedInteractiveUntil = 0;

function applyModeToWindow(mode: WindowMode): void {
  if (!win || win.isDestroyed()) return;
  if (mode === 'panel') {
    // 幂等：重复展开只是重置宽限期截止时间，不累积任何状态
    forcedInteractiveUntil = Date.now() + PANEL_INTERACTIVE_GRACE_MS;
    setIgnoreMouseEvents(false);
    win.focus();
  } else {
    forcedInteractiveUntil = 0;
    // 交回轮询控制：光标不在命中区就立刻穿透
    setIgnoreMouseEvents(!isCursorOverHotRect());
  }
}

/* ─────────────────────────── 托盘 ─────────────────────────── */

/** 程序化托盘图标（无需外部资源文件，纯离线）：画一个圆点 */
function buildTrayIcon(): Electron.NativeImage {
  const size = 16;
  // createFromBitmap 期望 BGRA 原始像素
  const buf = Buffer.alloc(size * size * 4, 0);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dist = Math.hypot(x - c, y - c);
      if (dist <= r) {
        const alpha = dist > r - 1 ? Math.max(0, Math.min(255, (r - dist) * 255)) : 255;
        buf[i] = 0x66;     // B
        buf[i + 1] = 0xc8; // G
        buf[i + 2] = 0xff; // R（暖黄）
        buf[i + 3] = Math.round(alpha);
      }
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  img.setTemplateImage(true); // 跟随系统深浅色
  return img;
}

function createTray(): void {
  try {
    tray = new Tray(buildTrayIcon());
  } catch (err) {
    console.warn('[tray] unavailable:', err);
    return;
  }
  tray.setToolTip('桌面精力宠物');

  const toggleMode = (): void => {
    const next: WindowMode = coordinator?.getMode() === 'panel' ? 'pet' : 'panel';
    coordinator?.setMode(next);
    applyModeToWindow(next);
    flushState();
  };

  /**
   * 静态菜单：只在启动时构建一次。
   *
   * 为什么不动态重建：macOS 上如果在菜单**正在显示**时调用 setContextMenu 替换它，
   * Electron 原生层会 SIGABRT（整个应用消失）。点击托盘 → 菜单打开 → 状态变化
   * 触发 rebuild → 崩溃，这条链路正是「点一下就闪退」的成因。
   * 动态信息（精力/情绪）改用 tooltip 承载，tooltip 更新是安全的。
   */
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 / 收起面板', click: toggleMode },
    { label: '刷新天气', click: () => { void coordinator?.weather.refresh().then(() => flushState()); } },
    { label: '回到默认位置', click: () => { if (win && !win.isDestroyed()) win.setBounds(computeBounds()); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));

  // macOS 上左键点击托盘默认会弹菜单；这里额外把面板也一并打开，符合直觉
  tray.on('click', toggleMode);

  // 动态信息走 tooltip（节流 800ms，避免频繁 setToolTip）
  let timer: ReturnType<typeof setTimeout> | null = null;
  coordinator?.bus.on('state:dirty', () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!tray || tray.isDestroyed()) return;
      const st = coordinator?.buildState();
      if (!st) return;
      try {
        tray.setToolTip(`桌面精力宠物 · 精力 ${st.energy.toFixed(1)} · ${st.emotion.headline}`);
      } catch { /* tooltip 失败不影响主流程 */ }
    }, 800);
  });
}

/* ─────────────────────────── 应用生命周期 ─────────────────────────── */

// 终止信号审计：「应用莫名消失」时先确认是信号还是异常。
// 终端关闭 / 父进程退出会发 SIGHUP/SIGTERM，这里记录清楚并在崩溃日志里留下痕迹。
let lastSignal: string | null = null;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    lastSignal = sig;
    logCrash('received signal', sig);
    quitting = true;
    app.quit();
  });
}

// 单实例锁：避免多个宠物抢同一个 DB
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 拿不到锁 = 已有实例在跑。记录清楚，别让它看起来像「闪退」
  logCrash('single-instance lock denied', { argv: process.argv, note: '已有实例在运行，本进程退出' });
  quitting = true;
  app.quit();
} else {
  logCrash('app start', { argv: process.argv, pid: process.pid, selfcheck: process.argv.includes('--selfcheck'), selftestClick: process.argv.includes('--selftest-click') });
  app.on('second-instance', () => {
    if (win) { win.showInactive(); }
  });

  void app.whenReady().then(async () => {
    // ── 崩溃可观测性 + 自愈 ──
    // 主进程异常：记录但不退出（宠物应用「静默死掉」比崩溃更糟）
    process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
    process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

    coordinator = new Coordinator({ userDataPath: app.getPath('userData') });
    registerIpc();
    createWindow();
    await coordinator.start();

    // 渲染进程崩溃：记录 + 自动重载（用户感知为「闪了一下」而非「闪退」）
    let rendererCrashes = 0;
    app.on('render-process-gone', (_e, wc, details) => {
      logCrash('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
      if (details.reason === 'clean-exit' || quitting) return;
      rendererCrashes++;
      // 崩溃循环保护：连续崩 3 次说明是确定性缺陷，继续 reload 只会变成「一直闪」
      if (rendererCrashes > 3) {
        logCrash('renderer crash loop', `crashes=${rendererCrashes}, stop auto-reload. See crash.log`);
        try { tray?.setToolTip('桌面精力宠物 · 渲染进程反复崩溃，请查看 crash.log'); } catch { /* ignore */ }
        return;
      }
      setTimeout(() => {
        if (win && !win.isDestroyed() && !wc.isDestroyed()) {
          try { wc.reload(); } catch (err) { logCrash('renderer reload failed', err); }
        }
      }, 400);
    });

    // 稳定运行 30s 后清零崩溃计数（避免长时间运行中偶发崩溃累积触发保护）
    setInterval(() => { rendererCrashes = 0; }, 30_000);

    // 子进程（GPU/Utility）崩溃：不影响主流程，只记录
    app.on('child-process-gone', (_e, details) => {
      logCrash('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
    });

    // 任何状态变化 → 节流推送渲染进程
    coordinator.bus.on('state:dirty', () => flushState());
    coordinator.bus.on('energy:changed', () => flushState());
    coordinator.bus.on('weather:changed', () => flushState());
    coordinator.bus.on('task:changed', () => flushState());
    coordinator.bus.on('recovery:changed', () => flushState());
    coordinator.bus.on('slide:requested', () => flushState());
    coordinator.bus.on('slide:confirmed', () => flushState());
    coordinator.bus.on('slide:cancelled', () => flushState());
    coordinator.bus.on('recommendation:new', () => flushState());
    // 调节窗口生命周期：任何相位变化/草稿变动都要立刻推给渲染端，
    // 否则倒计时角标与确认弹窗会滞后于主进程状态
    coordinator.bus.on('adjust:opened', () => flushState());
    coordinator.bus.on('adjust:changed', () => flushState());
    coordinator.bus.on('adjust:confirming', () => flushState());
    coordinator.bus.on('adjust:committed', () => flushState());
    coordinator.bus.on('adjust:cancelled', () => flushState());
    coordinator.bus.on('mode:changed', (p) => { applyModeToWindow(p.mode as WindowMode); flushState(); });

    createTray();
    flushState();

    app.on('activate', () => { if (!win) createWindow(); });
  });

  // macOS：点 Dock 不退出；关闭窗口只隐藏
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  // 退出原因审计：非用户主动退出的「闪退」必须能在 crash.log 里找到元凶
  app.on('before-quit', () => {
    logCrash('app quitting', {
      userInitiated: quitting,
      recentSignal: lastSignal,
      stack: new Error('quit caller').stack,
    });
    quitting = true;
    try { coordinator?.stop(); } catch (err) { console.error('[quit] stop failed:', err); }
    coordinator = null;
  });
}
