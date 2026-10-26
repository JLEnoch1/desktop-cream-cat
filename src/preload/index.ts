/**
 * Preload —— 渲染进程安全桥接（contextIsolation: true, nodeIntegration: false）。
 *
 * v2.0 融合版：双窗口共用一份 preload，暴露两个命名空间——
 *  - `window.pet`：领域 API（uiWin 卡片流用；与 v1.x 完全兼容 + uiHint/onUiCmd）
 *  - `window.cat`：奶油猫壳层 API（catWin 行走窗口用：布局/皮肤/敲键/命令/心情/反应）
 *
 * 所有领域写操作都经 IPC → Coordinator → DecisionLog（事件流唯一入口）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppState, PendingSlide, WindowMode, RecoveryItem, RecoveryVersion, WeeklyReport,
  WeatherState, AdjustWindow, TaskDurationRequest, CatLayout, CatCmd, CatMoodPayload,
  CatReactPayload, UiCmd,
} from '../core/types.js';
import type { DomainEvent } from '../core/events.js';
import type { EmotionState } from '../core/types.js';

/** 状态推送订阅句柄 */
type Unsub = () => void;

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* ─────────────────────────── 领域 API（window.pet） ─────────────────────────── */

const petApi = {
  /* ─────────── 状态 ─────────── */
  getState: (): Promise<AppState | null> => ipcRenderer.invoke('app:getState'),

  /* ─────────── 错误上报（黑匣子） ─────────── */
  /** 渲染进程异常 → 主进程 crash.log（便于事后定位闪退根因） */
  reportError: (info: { source: string; message: string; stack?: string }): void => {
    ipcRenderer.send('renderer:error', info);
  },
  onState: (cb: (state: AppState) => void): Unsub => subscribe('state:update', cb),

  /* ─────────── UI 窗口显隐协同 ─────────── */
  /**
   * 上报渲染层本地 UI 状态（恢复扇形/周报查看等主进程看不见的活动 UI）。
   * 主进程合并「领域状态需要 UI」与本 hint 决定 uiWin 显隐。
   */
  uiHint: (active: boolean): void => {
    ipcRenderer.send('ui:hint', active);
  },
  /** 主进程命令：打开面板 / 打开恢复菜单 / 查看周报 */
  onUiCmd: (cb: (cmd: UiCmd) => void): Unsub => subscribe('ui:cmd', cb),

  /* ─────────── 命中区上报 / click-through ─────────── */
  /** 上报可交互元素包围盒（窗口内 DIP 坐标）；主进程轮询判断是否命中 */
  hitRects: (rects: { x: number; y: number; w: number; h: number }[]): void => {
    ipcRenderer.send('win:hotRects', rects);
  },

  /* ─────────── 窗口模式 ─────────── */
  setMode: (mode: WindowMode): Promise<WindowMode> => ipcRenderer.invoke('win:setMode', mode),

  /* ─────────── 滑动确认 ─────────── */
  slideRequest: (kind: PendingSlide['kind'], refId: string): Promise<PendingSlide | null> =>
    ipcRenderer.invoke('slide:request', { kind, refId }),
  /** 预览：target 为目标绝对精力值（不落库） */
  slidePreview: (target: number): Promise<{ energy: number; emotion: EmotionState } | null> =>
    ipcRenderer.invoke('slide:preview', target),
  /** 确认：target 为用户确认的当前真实精力值（绝对） */
  slideConfirm: (target: number, note?: string): Promise<DomainEvent | null> =>
    ipcRenderer.invoke('slide:confirm', { target, note }),
  slideCancel: (): Promise<boolean> => ipcRenderer.invoke('slide:cancel'),

  /* ─────────── 任务 ─────────── */
  taskCreate: (title: string, estCost: number, dueAt?: number | null, estMinutes?: number): Promise<boolean> =>
    ipcRenderer.invoke('task:create', { title, estCost, dueAt: dueAt ?? null, estMinutes: estMinutes ?? 0 }),
  taskDrop: (taskId: string): Promise<boolean> => ipcRenderer.invoke('task:drop', taskId),
  /** 流程第一步：取任务名称与预估时长（不开调节窗口、不落库） */
  taskDurationRequest: (taskId: string): Promise<TaskDurationRequest | null> =>
    ipcRenderer.invoke('task:durationRequest', taskId),
  /** 流程第二步：用户确认实际时长后，才打开精力调节窗口 */
  taskCompleteWithDuration: (taskId: string, actualMinutes: number): Promise<AdjustWindow | null> =>
    ipcRenderer.invoke('task:completeWithDuration', { taskId, actualMinutes }),

  /* ─────────── 事件后精力调节窗口 ─────────── */
  /** 恢复项：时长固定，直接打开调节窗口 */
  recoveryStartAdjust: (itemId: string): Promise<AdjustWindow | null> =>
    ipcRenderer.invoke('recovery:startAdjust', itemId),
  /** 窗口内微调草稿；无窗口时主进程返回 null（= 平时拖动被拒绝写入） */
  adjustDraft: (target: number): Promise<AdjustWindow | null> =>
    ipcRenderer.invoke('adjust:draft', target),
  /** 确认弹窗 → 落库（唯一写入点） */
  adjustCommit: (note?: string): Promise<DomainEvent | null> =>
    ipcRenderer.invoke('adjust:commit', note),
  /** 放弃调节：草稿丢弃，事件不落库 */
  adjustCancel: (): Promise<boolean> => ipcRenderer.invoke('adjust:cancel'),

  /* ─────────── 恢复 ─────────── */
  recoveryUpdateDelta: (itemId: string, delta: number, reason: string): Promise<RecoveryItem | null> =>
    ipcRenderer.invoke('recovery:updateDelta', { itemId, delta, reason }),
  recoveryVersions: (itemId: string): Promise<RecoveryVersion[]> => ipcRenderer.invoke('recovery:versions', itemId),

  /* ─────────── 精力 ─────────── */
  energySet: (target: number): Promise<number> => ipcRenderer.invoke('energy:set', target),

  /* ─────────── 天气 ─────────── */
  weatherRefresh: (): Promise<WeatherState | null> => ipcRenderer.invoke('weather:refresh'),

  /* ─────────── AI 推荐 ─────────── */
  recommendationResolve: (id: string, action: 'accepted' | 'modified' | 'rejected', delta?: number): Promise<boolean> =>
    ipcRenderer.invoke('recommendation:resolve', { id, action, delta }),

  /* ─────────── 洞察 ─────────── */
  weeklyReport: (): Promise<WeeklyReport | null> => ipcRenderer.invoke('insight:weeklyReport'),
  reportConfirm: (): Promise<boolean> => ipcRenderer.invoke('report:confirm'),
  emotionSummary: (): Promise<string> => ipcRenderer.invoke('emotion:summary'),

  /* ─────────── 应用 ─────────── */
  quit: (): Promise<boolean> => ipcRenderer.invoke('app:quit'),
  reposition: (): Promise<boolean> => ipcRenderer.invoke('app:reposition'),
};

/* ─────────────────────────── 奶油猫壳层 API（window.cat） ─────────────────────────── */

const catApi = {
  /** 渲染层就绪：主进程随即推布局/敲键状态/ledge 并启动 helper */
  ready: (): void => {
    ipcRenderer.send('cat:ready');
  },
  getLayout: (): Promise<CatLayout> => ipcRenderer.invoke('cat:getLayout'),
  /** 行走/拖拽/抛物线：渲染层拥有窗口位置，逐帧同步给主进程 */
  moveWindow: (x: number, y: number): void => {
    ipcRenderer.send('cat:moveWindow', x, y);
  },
  getSkin: (): Promise<unknown> => ipcRenderer.invoke('cat:getSkin'),
  /** 右键弹菜单（菜单内容由主进程动态构建） */
  showMenu: (): void => {
    ipcRenderer.send('cat:showMenu');
  },
  openAccessibility: (): void => {
    ipcRenderer.send('cat:openAccessibility');
  },
  /** 拖拽期间保持窗口可交互（光标可能瞬间离开猫体热区） */
  setDragActive: (active: boolean): void => {
    ipcRenderer.send('cat:dragActive', active);
  },
  /** 猫体命中区（窗口内 DIP 坐标）：主进程 50ms 轮询光标做 click-through */
  hotRect: (rect: { x: number; y: number; w: number; h: number }): void => {
    ipcRenderer.send('cat:hotRect', rect);
  },
  /** 全局敲键（Bongo Cat）：{code, down} */
  onKey: (cb: (d: { code: number; down: boolean }) => void): Unsub => subscribe('cat:key', cb),
  /** 壳层命令：布局/敲键权限/暂停/睡觉/皮肤热更/ledge/回地面 */
  onCmd: (cb: (cmd: CatCmd) => void): Unsub => subscribe('cat:cmd', cb),
  /** 领域心情推送：精力/情绪/天气（驱动活力、表情偏向、overlay、pulse 光晕） */
  onMood: (cb: (mood: CatMoodPayload) => void): Unsub => subscribe('cat:mood', cb),
  /** 领域事件反应：{reaction, text?} → 表情插播 + 气泡 */
  onReact: (cb: (r: CatReactPayload) => void): Unsub => subscribe('cat:react', cb),
  reportError: (info: { source: string; message: string; stack?: string }): void => {
    ipcRenderer.send('renderer:error', info);
  },
};

export type PetApi = typeof petApi;
export type CatApi = typeof catApi;

contextBridge.exposeInMainWorld('pet', petApi);
contextBridge.exposeInMainWorld('cat', catApi);
