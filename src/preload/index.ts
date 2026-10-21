/**
 * Preload —— 渲染进程安全桥接（contextIsolation: true, nodeIntegration: false）。
 *
 * 只暴露白名单方法，渲染进程无法直接触达 Node/Electron 能力。
 * 所有写操作都经 IPC → Coordinator → DecisionLog（事件流唯一入口）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, PendingSlide, WindowMode, RecoveryItem, RecoveryVersion, WeeklyReport, WeatherState, AdjustWindow, TaskDurationRequest } from '../core/types.js';
import type { DomainEvent } from '../core/events.js';
import type { EmotionState } from '../core/types.js';

/** 状态推送订阅句柄 */
type Unsub = () => void;

const api = {
  /* ─────────── 状态 ─────────── */
  getState: (): Promise<AppState | null> => ipcRenderer.invoke('app:getState'),

  /* ─────────── 错误上报（黑匣子） ─────────── */
  /** 渲染进程异常 → 主进程 crash.log（便于事后定位闪退根因） */
  reportError: (info: { source: string; message: string; stack?: string }): void => {
    ipcRenderer.send('renderer:error', info);
  },
  onState: (cb: (state: AppState) => void): Unsub => {
    const listener = (_e: unknown, state: AppState): void => cb(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },

  /* ─────────── 命中区上报 / click-through ─────────── */
  /** 上报可交互元素包围盒（窗口内 DIP 坐标）；主进程轮询判断是否命中 */
  hitRects: (rects: { x: number; y: number; w: number; h: number }[]): void => {
    ipcRenderer.send('win:hotRects', rects);
  },

  /* ─────────── 拖拽 ─────────── */
  /** body = 宠物本体在窗口内的矩形（来自 petBounds），供主进程按「本体留在工作区」钳制 */
  dragStart: (x: number, y: number, body?: { x: number; y: number; w: number; h: number }): void =>
    ipcRenderer.send('win:dragStart', { x, y, body }),
  dragMove: (x: number, y: number): void => ipcRenderer.send('win:dragMove', { x, y }),
  dragEnd: (): void => ipcRenderer.send('win:dragEnd'),

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
  /** @deprecated 已迁至 recoveryStartAdjust（事件后调节窗口）；保留仅为兼容旧调用，主进程恒返回 null */
  recoveryTake: (itemId: string): Promise<PendingSlide | null> => ipcRenderer.invoke('recovery:take', itemId),
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

export type PetApi = typeof api;

contextBridge.exposeInMainWorld('pet', api);
