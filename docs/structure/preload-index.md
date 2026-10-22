# `src/preload/index.ts` — 安全桥接

> 模块存根（原 STRUCTURE_MAP §3.15）· 层级 **L3** · 测试：—
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：contextIsolation:true + nodeIntegration:false 下的白名单桥接。
 * 渲染进程无法直接触达 Node/Electron 能力；所有写操作经 IPC → Coordinator → DecisionLog。
 */

type Unsub = () => void;   // 状态推送订阅句柄

const api = {
  getState(): Promise<AppState | null>;
  reportError(info: { source: string; message: string; stack?: string }): void;  // send
  onState(cb: (state: AppState) => void): Unsub;      // ⟨订阅 'state:update'，返回退订函数⟩
  hitRects(rects: { x: number; y: number; w: number; h: number }[]): void;       // send
  dragStart(x: number, y: number): void;
  dragMove(x: number, y: number): void;
  dragEnd(): void;
  setMode(mode: WindowMode): Promise<WindowMode>;
  slideRequest(kind: PendingSlide['kind'], refId: string): Promise<PendingSlide | null>;
  slidePreview(target: number): Promise<{ energy: number; emotion: EmotionState } | null>;
  slideConfirm(target: number, note?: string): Promise<DomainEvent | null>;
  slideCancel(): Promise<boolean>;
  taskCreate(title: string, estCost: number, dueAt?: number | null): Promise<boolean>;
  taskDrop(taskId: string): Promise<boolean>;
  taskComplete(taskId: string): Promise<PendingSlide | null>;
  recoveryTake(itemId: string): Promise<PendingSlide | null>;
  recoveryUpdateDelta(itemId: string, delta: number, reason: string): Promise<RecoveryItem | null>;
  recoveryVersions(itemId: string): Promise<RecoveryVersion[]>;
  energySet(target: number): Promise<number>;
  weatherRefresh(): Promise<WeatherState | null>;
  recommendationResolve(
    id: string, action: 'accepted' | 'modified' | 'rejected', delta?: number,
  ): Promise<boolean>;
  weeklyReport(): Promise<WeeklyReport | null>;
  emotionSummary(): Promise<string>;
  quit(): Promise<boolean>;
  reposition(): Promise<boolean>;
};

export type PetApi = typeof api;   // 被 renderer/app.ts 用于 declare global Window.pet
contextBridge.exposeInMainWorld('pet', api);
```
