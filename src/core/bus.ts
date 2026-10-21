/**
 * EventBus —— 主进程内的轻量发布订阅。
 *
 * 职责：模块间解耦。任何模块 append 事件后 publish，
 * 协调层（Coordinator）订阅并推送渲染进程 + 触发副作用（天气刷新、洞察重算）。
 *
 * 不做持久化、不做重放 —— 那是 DecisionLog 的事。
 */

export type BusEventName =
  | 'event:appended'      // 新事件已落库
  | 'energy:changed'      // 精力值变化
  | 'weather:changed'     // 天气刷新
  | 'geo:changed'         // IP 定位完成，坐标已热更新
  | 'task:changed'        // 任务列表变化
  | 'recovery:changed'    // 恢复项变化
  | 'slide:requested'     // 请求弹出滑动确认卡（晨间基线 / 临时预览）
  | 'slide:confirmed'     // 滑动确认完成
  | 'slide:cancelled'     // 滑动取消
  | 'adjust:opened'       // 事件后精力调节窗口打开（7s 计时开始）
  | 'adjust:changed'      // 窗口内微调草稿（不落库）
  | 'adjust:confirming'   // 计时到点，转入确认弹窗相位
  | 'adjust:committed'    // 用户确认，事件已落库
  | 'adjust:cancelled'    // 用户放弃，草稿丢弃
  | 'recommendation:new'  // 新推荐卡片
  | 'mode:changed'        // 窗口模式切换
  | 'state:dirty';        // 需要重算 AppState 并推送

export interface BusPayloads {
  'event:appended': { id: number; type: string };
  'energy:changed': { energy: number; previous: number };
  'weather:changed': { source: string };
  'geo:changed': { lat: number; lon: number; city: string };
  'task:changed': undefined;
  'recovery:changed': undefined;
  'slide:requested': { kind: string; refId: string };
  'slide:confirmed': { kind: string; refId: string; delta: number };
  'slide:cancelled': { kind: string; refId: string };
  'adjust:opened': { kind: string; refId: string };
  'adjust:changed': { draft: number };
  'adjust:confirming': { refId: string };
  'adjust:committed': { refId: string; delta: number; energy: number };
  'adjust:cancelled': { refId: string };
  'recommendation:new': { id: string; itemId: string };
  'mode:changed': { mode: string };
  'state:dirty': undefined;
}

type Handler<K extends BusEventName> = (payload: BusPayloads[K]) => void;

export class EventBus {
  private handlers = new Map<BusEventName, Set<Handler<any>>>();
  /** 错误隔离：单个 handler 抛错不影响其他订阅者 */
  private errorHandler: (name: BusEventName, err: unknown) => void;

  constructor(errorHandler?: (name: BusEventName, err: unknown) => void) {
    this.errorHandler = errorHandler ?? ((name, err) => {
      console.error(`[bus] handler error on "${name}":`, err);
    });
  }

  on<K extends BusEventName>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) { set = new Set(); this.handlers.set(name, set); }
    set.add(fn);
    return () => this.off(name, fn);
  }

  /** 只触发一次 */
  once<K extends BusEventName>(name: K, fn: Handler<K>): () => void {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  off<K extends BusEventName>(name: K, fn: Handler<K>): void {
    this.handlers.get(name)?.delete(fn);
  }

  /** payload 为 undefined 的事件（如 state:dirty）可省略参数 */
  emit<K extends BusEventName>(name: K, payload?: BusPayloads[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    // 复制一份，避免 handler 内 on/off 造成迭代异常
    for (const fn of [...set]) {
      try {
        fn(payload as BusPayloads[K]);
      } catch (err) {
        this.errorHandler(name, err);
      }
    }
  }

  /** 合并高频 emit（同一窗口内多次触发只推一次） */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  emitDebounced<K extends BusEventName>(name: K, payload?: BusPayloads[K], ms = 60): void {
    const key = String(name);
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.emit(name, payload);
    }, ms));
  }

  clear(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.handlers.clear();
  }

  listenerCount(name: BusEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

/** 全局单例（主进程内） */
export const bus = new EventBus();
