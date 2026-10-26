/**
 * 主进程入口 —— 双窗口装配 + IPC + 模块协调（v2.0 奶油猫融合版）。
 *
 * 窗口策略：
 *  - `catWin`（360×380）：奶油猫行走窗口。渲染层 FSM 拥有窗口位置（px/py），
 *    经 `cat:moveWindow` 逐帧同步；透明、无边框、置顶（floating）、不进任务栏。
 *  - `uiWin`（400×620）：奶油卡片窗口（滑动卡/调节窗/周报/推荐/任务面板/恢复扇形）。
 *    锚定主屏右下角，**按需 show/hide**：领域状态或本地 hint 需要 UI 时才出现。
 *  - click-through：主进程 50ms 轮询光标 × 两窗口各自的 hotRect
 *    （猫体矩形 / UI 上报的 data-interactive 包围盒）。不用 forward:true 高频切换
 *    ——macOS 上 transparent + forward + 频繁切换是已知的 SIGABRT 来源。
 *
 * 领域层（Coordinator/事件流/精力账本/情绪/天气/洞察）与 v1.x 完全一致；
 * 本文件新增的是奶油猫壳层：皮肤管线、原生 helper（敲键/窗口顶边）、
 * 心情推送（cat:mood）、事件反应（cat:react）、右键动态菜单、开机自启。
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell, nativeImage } from 'electron';
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from './coordinator.js';
import { NativeHelpers } from './native.js';
import { resolveSkin, watchSkins, ensureUserSkins, SKINS_DIR } from './skins.js';
import { autoLaunchOn, setAutoLaunch, bootstrapAutoLaunch } from './autolaunch.js';
import type { AppState, PendingSlide, WindowMode, CatLayout, CatLedge, CatMoodPayload } from '../core/types.js';
import { pointInRects, fallbackHotRects as fallbackRectsOf, sanitizeRects, type HotRect } from '../core/hittest.js';

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

/* ─────────────────────────── 常量 ─────────────────────────── */

/** 猫窗口尺寸（与 renderer/cat 的 W/H 常量一致；底部含 38px 精力值胶囊条） */
const CAT_W = 360;
const CAT_H = 412;
/** UI 窗口尺寸：卡片区 + 底部 HUD */
const UI_W = 400;
const UI_H = 620;
/** UI 窗口距屏幕右下角边距 */
const EDGE_MARGIN = 24;
/** Windows AUMID，与 package.json build.appId 保持一致 */
const APP_ID = 'com.creamcat.pet';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

let catWin: BrowserWindow | null = null;
let uiWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let coordinator: Coordinator | null = null;
let helpers: NativeHelpers | null = null;
let quitting = false;
/** 猫行为暂停（右键菜单） */
let paused = false;
/** uiWin 渲染层本地活动 UI（恢复扇形/周报查看态）hint */
let uiHintActive = false;

/* ─────────────────────────── 布局 ─────────────────────────── */

function catLayout(): CatLayout {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x, y: wa.y, w: wa.width, h: wa.height,
    winW: CAT_W, winH: CAT_H,
    groundY: wa.y + wa.height - CAT_H,
  };
}

function computeUiBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  // 小屏保护：窗口不超过工作区，避免布局溢出屏幕外
  const h = Math.min(UI_H, Math.max(320, workArea.height - 16));
  const w = Math.min(UI_W, Math.max(280, workArea.width - 16));
  return {
    x: Math.max(workArea.x, workArea.x + workArea.width - w - EDGE_MARGIN),
    y: Math.max(workArea.y, workArea.y + workArea.height - h - EDGE_MARGIN),
    width: w,
    height: h,
  };
}

/* ─────────────────────────── 窗口 ─────────────────────────── */

function commonWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    backgroundThrottling: false, // 动画保持 60fps
  };
}

function createCatWindow(): void {
  const l = catLayout();
  catWin = new BrowserWindow({
    width: CAT_W,
    height: CAT_H,
    x: Math.round(l.x + l.w / 2 - CAT_W / 2),
    y: Math.round(l.groundY),
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
    acceptFirstMouse: true,
    show: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: commonWebPreferences(),
  });
  // floating：盖过普通窗口（顶边散步的观感需要），但不压系统 UI
  catWin.setAlwaysOnTop(true, 'floating');
  catWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  catWin.setIgnoreMouseEvents(true);
  catIgnoring = true;

  const url = process.env.ENERGY_PET_CAT_DEV_URL;
  if (url) void catWin.loadURL(url);
  else void catWin.loadFile(join(__dirname, '../renderer/cat/cat.html'));

  catWin.once('ready-to-show', () => { catWin?.showInactive(); });
  catWin.on('closed', () => { catWin = null; });

  if (process.argv.includes('--selftest-click')) setupSelftestClick();
  if (process.argv.includes('--selfcheck')) setupSelfcheck();
}

function createUiWindow(): void {
  uiWin = new BrowserWindow({
    ...computeUiBounds(),
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
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: commonWebPreferences(),
  });
  uiWin.setAlwaysOnTop(true, 'floating');
  uiWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  uiWin.setIgnoreMouseEvents(true);
  uiIgnoring = true;

  const url = process.env.ENERGY_PET_DEV_URL;
  if (url) void uiWin.loadURL(url);
  else void uiWin.loadFile(join(__dirname, '../renderer/ui/ui.html'));

  uiWin.on('closed', () => { uiWin = null; stopHitTestLoop(); });
}

/* ─────────────────────────── 状态 / 心情 / 反应推送 ─────────────────────────── */

function sendToUi(channel: string, payload: unknown): void {
  if (!uiWin || uiWin.isDestroyed()) return;
  uiWin.webContents.send(channel, payload);
}

function sendToCat(channel: string, payload: unknown): void {
  if (!catWin || catWin.isDestroyed()) return;
  catWin.webContents.send(channel, payload);
}

/** 统一的状态刷新入口（节流由 bus 的 debounce 负责） */
function flushState(): void {
  coordinator?.pushState(sendToUi);
  // 周报弹窗出现（null → 非 null）时提醒猫：领域事件 → 猫的反应
  const st = coordinator?.buildState();
  if (st?.reportModal && !lastReportSeen) {
    lastReportSeen = true;
    react('report-due');
  } else if (!st?.reportModal) {
    lastReportSeen = false;
  }
}

let lastReportSeen = false;

/** 猫心情推送（JSON 去重；AppState 的猫侧投影） */
let lastMoodJson = '';
function pushMood(): void {
  const st = coordinator?.buildState();
  if (!st) return;
  const mood: CatMoodPayload = { energy: st.energy, emotion: st.emotion, weather: st.weather };
  const json = JSON.stringify(mood);
  if (json === lastMoodJson) return;
  lastMoodJson = json;
  sendToCat('cat:mood', mood);
}

/** 领域事件 → 猫的轻量反应（表情插播 + 气泡由渲染层 mood.ts 决定） */
function react(reaction: string, text?: string): void {
  sendToCat('cat:react', text ? { reaction, text } : { reaction });
}

/**
 * uiWin 显隐同步：领域状态需要 UI（卡片/调节窗/周报/推荐/面板）或渲染层
 * 本地 hint（恢复扇形/周报查看）→ show；全部结束 → hide。
 * 面板模式额外 focus（用户明确要操作面板）。
 */
function syncUiVisibility(): void {
  if (!uiWin || uiWin.isDestroyed()) return;
  const st = coordinator?.buildState();
  const needUi = !!(
    st && (
      st.mode === 'panel' || st.pendingSlide || st.adjustWindow || st.reportModal
      || (st.recommendations?.length ?? 0) > 0
    )
  ) || uiHintActive;
  if (needUi && !uiWin.isVisible()) {
    uiWin.showInactive(); // 不抢焦点；panel 模式的 focus 由 applyModeToWindow 负责
    // 刚显示的窗口需要立刻可点：给命中区上报一个宽限窗
    forcedInteractiveUntil = Math.max(forcedInteractiveUntil, Date.now() + 400);
  } else if (!needUi && uiWin.isVisible()) {
    uiWin.hide();
    setUiIgnore(true);
    hotRects = [];
  }
  // 猫侧「安静陪伴」：UI 卡片出现时暂停自主散步，收起后恢复
  if (needUi !== lastNeedUi) {
    lastNeedUi = needUi;
    sendToCat('cat:cmd', { type: 'ui-hold', active: needUi });
  }
}

let lastNeedUi = false;

/* ─────────────────────────── 命中测试 / click-through（双窗口） ─────────────────────────── */

/**
 * 可交互区域（各窗口内 DIP 坐标）：
 *  - uiWin：渲染进程 [data-interactive] 包围盒上报（win:hotRects）
 *  - catWin：猫体矩形（cat:hotRect，窗口坐标恒定——猫画在固定锚点，窗口随猫走）
 * 主进程 50ms 轮询光标判断命中，避免 forward:true 高频切换的 macOS SIGABRT。
 */
let hotRects: HotRect[] = [];          // uiWin 命中区
let uiIgnoring = true;
let catIgnoring = true;
let catHotRect: HotRect | null = null; // 猫体命中区（渲染层上报前用默认值兜底）
let catDragActive = false;
let catDragLastAt = 0;
const DRAG_STALE_MS = 8000;
let hitTimer: ReturnType<typeof setInterval> | null = null;

/** 猫体默认命中区：窗口底部居中（CX=180，脚底线 GROUND=374，猫高约 250；
 *  底部 38px 精力值胶囊条是纯展示层，不进命中区） */
const CAT_DEFAULT_RECT: HotRect = { x: 92, y: 110, w: 176, h: 264 };

function setUiIgnore(ignore: boolean): void {
  if (!uiWin || uiWin.isDestroyed()) return;
  if (ignore === uiIgnoring) return;
  uiIgnoring = ignore;
  try {
    uiWin.setIgnoreMouseEvents(ignore);
  } catch (err) {
    logCrash('setIgnoreMouseEvents(ui) failed', err);
  }
}

function setCatIgnore(ignore: boolean): void {
  if (!catWin || catWin.isDestroyed()) return;
  if (ignore === catIgnoring) return;
  catIgnoring = ignore;
  try {
    catWin.setIgnoreMouseEvents(ignore);
  } catch (err) {
    logCrash('setIgnoreMouseEvents(cat) failed', err);
  }
}

function isCursorOverUiHotRect(): boolean {
  if (!uiWin || uiWin.isDestroyed() || !uiWin.isVisible()) return false;
  // 兜底：一个命中区都没有说明上报链路出了问题。此时宁可让底部区域可点，
  // 也不能全窗口穿透——「应用完全不可操作」比「偶尔挡一点桌面」严重得多。
  const b = uiWin.getBounds();
  const rects = hotRects.length > 0 ? hotRects : fallbackHotRects(b.width, b.height);
  const pt = screen.getCursorScreenPoint();
  return pointInRects(pt.x - b.x, pt.y - b.y, rects, b.width, b.height);
}

function isCursorOverCat(): boolean {
  if (!catWin || catWin.isDestroyed()) return false;
  const b = catWin.getBounds();
  const pt = screen.getCursorScreenPoint();
  const rect = catHotRect ?? CAT_DEFAULT_RECT;
  return pointInRects(pt.x - b.x, pt.y - b.y, [rect], b.width, b.height);
}

let warnedEmptyRects = false;
/** 启动宽限：渲染进程初始化期间还没有上报命中区是正常的，别刷告警 */
const APP_START_AT = Date.now();
const HIT_WARMUP_MS = 2500;

/** 兜底 + 告警（几何计算在 core/hittest 里，便于单测） */
function fallbackHotRects(width: number, height: number): HotRect[] {
  if (!warnedEmptyRects && Date.now() - APP_START_AT > HIT_WARMUP_MS) {
    warnedEmptyRects = true;
    logCrash('hotRects empty', '渲染进程未上报命中区，已启用兜底区域（底部中央）');
  }
  return fallbackRectsOf(width, height);
}

/**
 * 面板/卡片展开时的「可交互宽限期」。
 * class 变化 → MutationObserver → 200ms 节流 → IPC 上报热区之间有 ~250ms 空窗，
 * 宽限期只保证「展开瞬间可点」，之后立刻交回精确热区轮询。
 */
let forcedInteractiveUntil = 0;

function startHitTestLoop(): void {
  if (hitTimer) return;
  hitTimer = setInterval(() => {
    try {
      // ── 猫窗口 ──
      // 拖拽中强制保持可交互：光标可能瞬间移出猫体热区，一旦切回穿透拖拽就断了
      if (catDragActive) {
        // mouseup 丢失保护：拖拽状态超时未活动则强制复位，避免窗口永远挡住桌面
        if (Date.now() - catDragLastAt > DRAG_STALE_MS) catDragActive = false;
        else setCatIgnore(false);
      }
      if (!catDragActive) setCatIgnore(!isCursorOverCat());

      // ── UI 窗口 ──
      if (uiWin && !uiWin.isDestroyed() && uiWin.isVisible()) {
        if (Date.now() < forcedInteractiveUntil) setUiIgnore(false);
        else setUiIgnore(!isCursorOverUiHotRect());
      }
    } catch (err) {
      logCrash('hitTest loop failed', err);
    }
  }, 50);
}

function stopHitTestLoop(): void {
  if (hitTimer) { clearInterval(hitTimer); hitTimer = null; }
}

/* ─────────────────────────── 右键菜单（动态 popup，非托盘） ─────────────────────────── */

/**
 * 猫右键菜单：每次弹出时重建（Menu.popup 一次性，不存在托盘 setContextMenu
 * 的 SIGABRT 风险），因此可以携带动态信息（精力一句话/暂停状态/开关勾选）。
 */
function popupCatMenu(): void {
  if (!catWin || catWin.isDestroyed()) return;
  const st = coordinator?.buildState();
  const headline = st ? `${st.emotion.headline} · 精力 ${st.energy.toFixed(1)}` : '精力桌宠';
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: headline, enabled: false },
    { type: 'separator' },
    {
      label: '任务面板',
      click: () => {
        coordinator?.setMode('panel');
        applyModeToWindow('panel');
        syncUiVisibility();
        sendToUi('ui:cmd', { type: 'openPanel' });
        flushState();
      },
    },
    {
      label: '恢复一下',
      click: () => {
        ensureUiShown();
        sendToUi('ui:cmd', { type: 'openRecovery' });
      },
    },
    {
      label: '本周报告',
      click: () => {
        ensureUiShown();
        sendToUi('ui:cmd', { type: 'showWeekly' });
      },
    },
    {
      label: '临时调节 · 预览',
      click: () => {
        coordinator?.requestSlide('manual-adjust', 'manual');
        flushState();
        syncUiVisibility();
      },
    },
    { type: 'separator' },
    {
      label: paused ? '唤醒猫' : '暂停猫',
      click: () => {
        paused = !paused;
        sendToCat('cat:cmd', { type: paused ? 'pause' : 'resume' });
      },
    },
    { label: '现在睡觉', click: () => sendToCat('cat:cmd', { type: 'sleep-now' }) },
  ];
  if (isMac && helpers) {
    template.push({
      label: '窗口顶边散步',
      type: 'checkbox',
      checked: helpers.ledgeWalk,
      click: (item) => helpers?.setLedgeWalk(item.checked),
    });
  }
  template.push(
    { label: '重新加载皮肤', click: () => sendToCat('cat:cmd', { type: 'skins-updated' }) },
    { label: '打开皮肤文件夹', click: () => { void shell.openPath(SKINS_DIR); } },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoLaunchOn(),
      click: (item) => { setAutoLaunch(item.checked); },
    },
  );
  if (isMac && helpers) {
    template.push(
      {
        label: helpers.keyAccess === 'ok'
          ? '敲键监听：已授权'
          : helpers.keyAccess === 'no-access'
            ? '敲键监听：未授权(猫听不到键盘)'
            : helpers.keyAccess === 'unavailable'
              ? '敲键监听：不可用'
              : '敲键监听：检测中…',
        enabled: false,
      },
      { label: '打开敲键权限设置…', click: () => helpers?.openAccessibilitySettings() },
    );
  }
  template.push(
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit(); },
    },
  );
  Menu.buildFromTemplate(template).popup({ window: catWin });
}

/** 菜单入口需要 uiWin 可见（恢复扇形/周报查看是渲染层本地 UI，随后由 uiHint 维持） */
function ensureUiShown(): void {
  if (!uiWin || uiWin.isDestroyed()) return;
  if (!uiWin.isVisible()) {
    uiWin.showInactive();
    forcedInteractiveUntil = Math.max(forcedInteractiveUntil, Date.now() + 400);
  }
}

/* ─────────────────────────── 托盘 ─────────────────────────── */

/** 程序化托盘图标（无需外部资源文件，纯离线）：奶油猫头剪影点 */
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
        buf[i] = 0xa6;     // B（薄荷）
        buf[i + 1] = 0xc7; // G
        buf[i + 2] = 0xae; // R
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
  tray.setToolTip('奶油猫 · 精力桌宠');

  const toggleMode = (): void => {
    const next: WindowMode = coordinator?.getMode() === 'panel' ? 'pet' : 'panel';
    coordinator?.setMode(next);
    applyModeToWindow(next);
    syncUiVisibility();
    flushState();
    if (next === 'panel') sendToUi('ui:cmd', { type: 'openPanel' });
  };

  /**
   * 静态菜单：只在启动时构建一次。
   *
   * 为什么不动态重建：macOS 上如果在菜单**正在显示**时调用 setContextMenu 替换它，
   * Electron 原生层会 SIGABRT（整个应用消失）。点击托盘 → 菜单打开 → 状态变化
   * 触发 rebuild → 崩溃，这条链路正是「点一下就闪退」的成因。
   * 动态信息（精力/情绪）改用 tooltip 承载，tooltip 更新是安全的；
   * 需要动态勾选的入口全部放右键 popup 菜单（一次性，无此风险）。
   */
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 / 收起面板', click: toggleMode },
    { label: '刷新天气', click: () => { void coordinator?.weather.refresh().then(() => { flushState(); pushMood(); }); } },
    {
      label: '猫回地面',
      click: () => {
        sendToCat('cat:cmd', { type: 'go-ground' });
        if (uiWin && !uiWin.isDestroyed()) uiWin.setBounds(computeUiBounds());
      },
    },
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
        tray.setToolTip(`奶油猫 · 精力 ${st.energy.toFixed(1)} · ${st.emotion.headline}`);
      } catch { /* tooltip 失败不影响主流程 */ }
    }, 800);
  });
}

/** 面板模式需要可聚焦与可交互；宠物模式回到轮询穿透（作用于 uiWin） */
function applyModeToWindow(mode: WindowMode): void {
  if (!uiWin || uiWin.isDestroyed()) return;
  if (mode === 'panel') {
    if (!uiWin.isVisible()) uiWin.showInactive();
    // 幂等：重复展开只是重置宽限期截止时间，不累积任何状态
    forcedInteractiveUntil = Date.now() + 600;
    setUiIgnore(false);
    uiWin.focus();
  } else {
    forcedInteractiveUntil = 0;
    // 交回轮询控制：光标不在命中区就立刻穿透
    setUiIgnore(!isCursorOverUiHotRect());
  }
}

/* ─────────────────────────── IPC ─────────────────────────── */

function registerIpc(): void {
  const c = () => coordinator;

  ipcMain.handle('app:getState', (): AppState | null => c()?.buildState() ?? null);

  // 命中区上报（uiWin）：渲染进程布局变化时推送可交互元素包围盒（窗口内 DIP 坐标）
  ipcMain.on('win:hotRects', (_e, payload: HotRect[]) => {
    hotRects = sanitizeRects(payload);
    if (hotRects.length > 0 && warnedEmptyRects) {
      // 之前触发过兜底，现在拿到真实命中区了 —— 记录恢复，并允许下次异常再告警
      logCrash('hotRects recovered', { count: hotRects.length });
      warnedEmptyRects = false;
    }
    // 布局刚变化时立即重算一次，避免 50ms 空窗内点击落空
    try { setUiIgnore(!isCursorOverUiHotRect()); } catch (err) { logCrash('hotRects update failed', err); }
  });

  // 渲染进程错误上报（黑匣子）
  ipcMain.on('renderer:error', (_e, info: { source: string; message: string; stack?: string }) => {
    logCrash(`renderer:${info?.source ?? 'unknown'}`, `${info?.message ?? ''}\n${info?.stack ?? ''}`);
  });

  // UI 窗口本地活动 hint（恢复扇形/周报查看态：主进程看不见的 UI）
  ipcMain.on('ui:hint', (_e, active: boolean) => {
    uiHintActive = !!active;
    syncUiVisibility();
  });

  // 窗口模式
  ipcMain.handle('win:setMode', (_e, mode: WindowMode) => {
    c()?.setMode(mode);
    applyModeToWindow(mode);
    syncUiVisibility();
    flushState();
    return c()?.getMode() ?? 'pet';
  });

  /* ── 奶油猫壳层（catWin） ── */

  // 渲染层就绪：推布局/敲键状态/ledge，启动 helper
  ipcMain.on('cat:ready', () => {
    sendToCat('cat:cmd', { type: 'layout', layout: catLayout() });
    sendToCat('cat:cmd', { type: 'keystatus', ok: helpers?.keyAccess === 'ok' });
    if (lastLedges.length) sendToCat('cat:cmd', { type: 'ledges', ledges: lastLedges });
    if (paused) sendToCat('cat:cmd', { type: 'pause' });
    sendToCat('cat:cmd', { type: 'ui-hold', active: lastNeedUi });
    helpers?.startKeytap();
    startHitTestLoop();
    pushMood();
  });

  ipcMain.handle('cat:getLayout', (): CatLayout => catLayout());

  // 行走/拖拽/抛物线：渲染层拥有窗口位置，逐帧同步
  ipcMain.on('cat:moveWindow', (_e, x: number, y: number) => {
    if (!catWin || catWin.isDestroyed()) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    catDragLastAt = Date.now();
    catWin.setPosition(Math.round(x), Math.round(y), false);
  });

  ipcMain.handle('cat:getSkin', () => {
    try { return resolveSkin(); } catch (e) {
      console.error('[skin] 解析失败', e);
      return null;
    }
  });

  ipcMain.on('cat:showMenu', () => popupCatMenu());
  ipcMain.on('cat:openAccessibility', () => helpers?.openAccessibilitySettings());

  // 拖拽期间保持可交互（含 mouseup 丢失的超时保护，见轮询）
  ipcMain.on('cat:dragActive', (_e, active: boolean) => {
    catDragActive = !!active;
    catDragLastAt = Date.now();
    if (catDragActive) setCatIgnore(false);
  });

  // 猫体命中区（窗口内 DIP 坐标）
  ipcMain.on('cat:hotRect', (_e, rect: HotRect) => {
    const [r] = sanitizeRects([rect]);
    catHotRect = r ?? null;
    try { setCatIgnore(!isCursorOverCat()); } catch (err) { logCrash('cat hotRect update failed', err); }
  });

  /* ── 领域（与 v1.x 一致；写入点唯一：Coordinator → DecisionLog） ── */

  // 滑动确认
  ipcMain.handle('slide:request', (_e, p: { kind: PendingSlide['kind']; refId: string }) => {
    const slide = c()?.requestSlide(p.kind, p.refId) ?? null;
    flushState();
    syncUiVisibility();
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
  // 流程第二步：确认实际时长后才打开精力调节窗口
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
  // 周报弹窗确认/关闭（每天 17:30 弹一次，周五需确认）
  ipcMain.handle('report:confirm', () => { c()?.confirmReport(); flushState(); return true; });

  // 情绪摘要（气泡）
  ipcMain.handle('emotion:summary', () => c()?.emotionSummary() ?? '');

  // 应用
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); return true; });
  ipcMain.handle('app:reposition', () => {
    // 猫回地面默认位 + UI 窗口回右下角
    sendToCat('cat:cmd', { type: 'go-ground' });
    if (uiWin && !uiWin.isDestroyed()) uiWin.setBounds(computeUiBounds());
    return true;
  });
}

/* ─────────────────────────── 领域事件 → 猫的反应 ─────────────────────────── */

let lastLedges: CatLedge[] = [];

function subscribeCoordinator(): void {
  if (!coordinator) return;
  const bus = coordinator.bus;

  // 任何状态变化 → 推送 UI 窗口 + 猫心情 + 同步 uiWin 显隐
  bus.on('state:dirty', () => { flushState(); pushMood(); syncUiVisibility(); });
  bus.on('energy:changed', (p) => {
    flushState();
    // 跨阈值反应：下行破 3 → 提醒休息；上行到 8+ → 替用户高兴
    const e = (p as { energy: number; previous: number }).energy;
    const prev = (p as { energy: number; previous: number }).previous;
    if (prev >= 3 && e < 3) react('low-energy');
    else if (prev < 8 && e >= 8) react('energized');
  });
  bus.on('weather:changed', () => { flushState(); react('weather'); });
  bus.on('task:changed', () => flushState());
  bus.on('recovery:changed', () => flushState());
  bus.on('slide:requested', (p) => {
    flushState();
    const kind = (p as { kind: string }).kind;
    if (kind === 'morning-baseline') react('morning');
  });
  bus.on('slide:confirmed', () => flushState());
  bus.on('slide:cancelled', () => flushState());
  bus.on('recommendation:new', () => { flushState(); react('recommendation'); });
  // 调节窗口生命周期：任何相位变化/草稿变动都要立刻推给渲染端，
  // 否则倒计时角标与确认弹窗会滞后于主进程状态
  bus.on('adjust:opened', () => { flushState(); react('adjust-open'); });
  bus.on('adjust:changed', () => flushState());
  bus.on('adjust:confirming', () => flushState());
  bus.on('adjust:committed', (p) => {
    flushState();
    const delta = (p as { delta?: number }).delta ?? 0;
    react(delta > 0.05 ? 'committed-up' : delta < -0.05 ? 'committed-down' : 'committed-flat');
  });
  bus.on('adjust:cancelled', () => flushState());
  bus.on('mode:changed', (p) => { applyModeToWindow(p.mode as WindowMode); syncUiVisibility(); flushState(); });
}

/* ─────────────────────────── 自检 ─────────────────────────── */

/** 自检模式：程序化模拟「点击猫」全链路，验证不崩（--selftest-click） */
function setupSelftestClick(): void {
  if (!catWin) return;
  catWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const wc = catWin?.webContents;
      const fail = (msg: string): void => { logCrash('selftest-click FAILED', msg); quitting = true; app.quit(); };
      if (!wc || wc.isDestroyed()) { fail('webContents missing'); return; }
      try {
        // 1) 模拟点击猫：canvas 中央 mousedown → mouseup（= 摸头）
        const r1 = await wc.executeJavaScript(`(async () => {
          const cv = document.getElementById('stage');
          if (!cv) return 'no stage';
          const r = cv.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height * 0.72);
          cv.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: x, clientY: y }));
          window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
          return 'ok';
        })()`);
        // 2) 模拟光标进出命中区：反复切换 ignore 状态，验证原生层不崩
        for (let i = 0; i < 25; i++) {
          setCatIgnore(i % 2 === 0);
          await new Promise((res) => setTimeout(res, 20));
        }
        setCatIgnore(true);
        // 3) 验证窗口与渲染进程仍然存活
        await new Promise((res) => setTimeout(res, 300));
        const alive = !!catWin && !catWin.isDestroyed() && !wc.isDestroyed();
        if (!alive) { fail('process died after click simulation'); return; }
        const r2 = await wc.executeJavaScript('document.getElementById("stage") ? "canvas-ok" : "canvas-missing"');
        console.log(`[selftest-click] click=${r1} toggle25=ok render=${r2} alive=${alive}`);
        quitting = true;
        app.quit();
      } catch (err) {
        fail(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
      }
    }, 2600);
  });
}

/** 自检模式：截猫窗口 + UI 窗口各一张图后退出（--selfcheck [输出路径]） */
function setupSelfcheck(): void {
  if (!catWin) return;
  const idx = process.argv.indexOf('--selfcheck');
  const outPath = process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('-')
    ? process.argv[idx + 1]!
    : join(app.getPath('temp'), 'cream-cat-selfcheck.png');
  const uiPath = outPath.replace(/(\.png)?$/, '-ui.png');
  catWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        // 猫窗口体检：皮肤加载（false = 回退程序化猫）+ FSM 状态 + 精力胶囊
        // （模拟一次悬浮 mousemove → 胶囊应显示；截图时保持可见以便验收）
        const catInfo = await catWin!.webContents.executeJavaScript(
          'window.dispatchEvent(new MouseEvent("mousemove", { clientX: 180, clientY: 300, bubbles: true }));'
          + 'JSON.stringify({ skin: !!(window.petDebug && window.petDebug.exprLoaded && window.petDebug.exprLoaded()),'
          + ' state: window.petDebug ? window.petDebug.state() : null,'
          + ' pill: (document.getElementById("ep-num") || {}).textContent,'
          + ' pillTier: (document.getElementById("ep-tier") || {}).textContent,'
          + ' pillShown: !!(document.getElementById("energy-pill") || { classList: { contains() { return false; } } }).classList.contains("show") })',
        );
        console.log(`[selfcheck] cat info=${catInfo}`);
        const image = await catWin!.webContents.capturePage();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, image.toPNG());
        console.log(`[selfcheck] cat screenshot saved: ${outPath} (${image.getSize().width}x${image.getSize().height})`);
        // UI 窗口体检：hotRects + 滑动卡关键元素（id 契约与 v1.x 一致）
        if (uiWin && !uiWin.isDestroyed()) {
          const ready = await Promise.race([
            new Promise<boolean>((res) => { uiWin!.webContents.once('did-finish-load', () => res(true)); }),
            new Promise<boolean>((res) => setTimeout(() => res(false), 4000)),
          ]);
          if (ready || !uiWin.webContents.isLoading()) {
            await new Promise((res) => setTimeout(res, 1200));
            const hit = await uiWin.webContents.executeJavaScript(
              'JSON.stringify({ rects: window.__hotRects ?? [], innerW: window.innerWidth, innerH: window.innerHeight,'
              + ' slider: (() => { const s = document.getElementById("s-slider"); const v = document.getElementById("s-value"); const d = document.getElementById("s-delta");'
              + ' const p = document.getElementById("s-predicted"); const c = document.getElementById("slide-card");'
              + ' return s ? { min: s.min, max: s.max, value: s.value, shown: v ? v.textContent : null, delta: d ? d.textContent : null, predicted: p ? p.textContent : null, cardClass: c ? c.className : null } : null; })() })',
            );
            console.log(`[selfcheck] ui hitRects=${hit}`);
            const uiImage = await uiWin.webContents.capturePage();
            await writeFile(uiPath, uiImage.toPNG());
            console.log(`[selfcheck] ui screenshot saved: ${uiPath} (${uiImage.getSize().width}x${uiImage.getSize().height})`);
          }
        }
      } catch (err) {
        console.error('[selfcheck] capture failed:', err);
      }
      quitting = true;
      app.quit();
    }, 2500);
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
  // 安装后自启/重复点击图标：不新开窗口，只把猫窗口提到眼前
  app.on('second-instance', () => {
    if (catWin && !catWin.isDestroyed()) { catWin.showInactive(); }
  });

  if (isWin) app.setAppUserModelId(APP_ID);

  void app.whenReady().then(async () => {
    // ── 崩溃可观测性 + 自愈 ──
    // 主进程异常：记录但不退出（宠物应用「静默死掉」比崩溃更糟）
    process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
    process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

    ensureUserSkins();
    bootstrapAutoLaunch();

    coordinator = new Coordinator({ userDataPath: app.getPath('userData') });

    helpers = new NativeHelpers({
      onKey: (d) => sendToCat('cat:key', d),
      onKeyStatus: (ok) => sendToCat('cat:cmd', { type: 'keystatus', ok }),
      onLedges: (ledges, gone) => {
        lastLedges = ledges;
        sendToCat('cat:cmd', { type: 'ledges', ledges });
        for (const id of gone) sendToCat('cat:cmd', { type: 'ledge-gone', id });
      },
    });
    helpers.ensureHelper();
    helpers.ensureWinlist();
    if (isMac) helpers.setLedgeWalk(true); // 顶边散步默认开；采集失败自动纯地面模式

    registerIpc();
    createCatWindow();
    createUiWindow();
    await coordinator.start();

    const stopWatch = watchSkins(() => sendToCat('cat:cmd', { type: 'skins-updated' }));
    app.on('will-quit', stopWatch);

    if (isMac && app.dock) app.dock.hide();

    // 渲染进程崩溃：记录 + 自动重载（用户感知为「闪了一下」而非「闪退」）
    let rendererCrashes = 0;
    app.on('render-process-gone', (_e, wc, details) => {
      logCrash('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
      if (details.reason === 'clean-exit' || quitting) return;
      rendererCrashes++;
      // 崩溃循环保护：连续崩 3 次说明是确定性缺陷，继续 reload 只会变成「一直闪」
      if (rendererCrashes > 3) {
        logCrash('renderer crash loop', `crashes=${rendererCrashes}, stop auto-reload. See crash.log`);
        try { tray?.setToolTip('奶油猫 · 渲染进程反复崩溃，请查看 crash.log'); } catch { /* ignore */ }
        return;
      }
      setTimeout(() => {
        if (!wc.isDestroyed()) {
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

    subscribeCoordinator();
    createTray();
    flushState();
    pushMood();
    syncUiVisibility();

    // 显示器/分辨率变化：推新布局给猫 + 重算 ledge + UI 窗口回右下角
    screen.on('display-metrics-changed', () => {
      sendToCat('cat:cmd', { type: 'layout', layout: catLayout() });
      helpers?.invalidateWinlist();
      if (uiWin && !uiWin.isDestroyed()) uiWin.setBounds(computeUiBounds());
    });

    app.on('activate', () => {
      if (!catWin) createCatWindow();
    });
  });

  // macOS：点 Dock 不退出；关闭窗口只隐藏（托盘常驻）
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
    try { helpers?.killAll(); } catch { /* 已退出 */ }
    try { coordinator?.stop(); } catch (err) { console.error('[quit] stop failed:', err); }
    coordinator = null;
    stopHitTestLoop();
  });
}
