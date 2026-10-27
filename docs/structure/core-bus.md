# `src/core/bus.ts` — 事件总线

> 模块存根（原 STRUCTURE_MAP §3.3）· 层级 **L0** · 测试：—（无直接测试）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/** 职责边界：主进程内模块解耦。不做持久化、不做重放（那是 DecisionLog 的事）。 */

export type BusEventName =
  | 'event:appended' | 'energy:changed' | 'weather:changed'
  | 'task:changed' | 'recovery:changed'
  | 'slide:requested' | 'slide:confirmed' | 'slide:cancelled'
  | 'recommendation:new' | 'mode:changed' | 'state:dirty';

export interface BusPayloads {
  'event:appended': { id: number; type: string };
  'energy:changed': { energy: number; previous: number };
  // ⟨changed=天气语义（condition）是否真的翻转：壳层仅在 true 时让猫吐槽天气；
  //   无论变没变都 emit → 壳层重推 state + cat:mood（头顶天气挂件随实时天气更新）。
  //   condition/previous 供诊断；渲染层一律以 cat:mood 推送为准⟩
  'weather:changed': { source: string; changed: boolean; condition: WeatherCondition; previous: WeatherCondition };
  'task:changed': undefined;
  'recovery:changed': undefined;
  'slide:requested': { kind: string; refId: string };
  'slide:confirmed': { kind: string; refId: string; delta: number };
  'slide:cancelled': { kind: string; refId: string };
  'recommendation:new': { id: string; itemId: string };
  'mode:changed': { mode: string };
  'state:dirty': undefined;
}

export class EventBus {
  constructor(errorHandler?: (name: BusEventName, err: unknown) => void);
    // ⟨默认 handler 走 console.error；单 handler 抛错不影响其他订阅者⟩

  on<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): () => void;
    // ⟨返回退订函数⟩
  once<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): () => void;
    // ⟨只触发一次⟩ ⚠️ 无调用方，见 [问题清单](known-issues.md)
  off<K extends BusEventName>(name: K, fn: (payload: BusPayloads[K]) => void): void;
  emit<K extends BusEventName>(name: K, payload?: BusPayloads[K]): void;
    // ⟨同步派发；迭代前复制 handler 集合，避免 on/off 造成迭代异常⟩
  emitDebounced<K extends BusEventName>(name: K, payload?: BusPayloads[K], ms?: number): void;
    // ⟨合并高频 emit，默认 60ms⟩ ⚠️ 无调用方，节流实际由 app.ts 的 200ms 上报节流承担
  clear(): void;                          // ⟨清空全部定时器与 handler⟩
  listenerCount(name: BusEventName): number;  // ⚠️ 无调用方，见 [问题清单](known-issues.md)

  private handlers: Map<BusEventName, Set<Handler<any>>>;
  private errorHandler: (name: BusEventName, err: unknown) => void;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export const bus: EventBus;   // 全局单例 ⚠️ 实际未被 import，Coordinator 自建实例，见 [问题清单](known-issues.md)
```
