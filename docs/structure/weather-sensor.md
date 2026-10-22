# `src/weather/sensor.ts` — 天气感知（216 行）

> 模块存根（原 STRUCTURE_MAP §3.11）· 层级 **L2** · 测试：tests/weather-source.test.ts（13 例）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：API 抓取 + 双层缓存 + 三级降级。完全离线可用——网络失败不抛错只降级。
 * 降级链：live → 内存缓存 → 事件流缓存 → FALLBACK_WEATHER
 * fetcher 可注入，便于单测与替换数据源。
 * 🆕 v1.3：默认抓取器是 **QQ 天气(wis.qq.com) → Open-Meteo 级联**，
 *    坐标可由 `weather/geo.ts` 的 IP 定位热更新（`setLocation()`）。
 */

export const CACHE_TTL_MS = 30 * 60 * 1000;   // 缓存 TTL 30min
export const FETCH_TIMEOUT_MS = 6000;         // 请求超时

/** 🆕 位置对象（QQ 天气按 省+市 查询，必需 city/province；Open-Meteo 只用经纬度） */
export interface WeatherLocation {
  lat: number;
  lon: number;
  city?: string;        // 中文城市名，如「杭州」
  province?: string;    // 中文省名，如「浙江」
}

export interface WeatherFetcher {
  // ⚠️ 签名已变：收 **WeatherLocation 对象**（旧存根写 `(lat, lon, signal)` 已失效）
  (loc: WeatherLocation, signal: AbortSignal): Promise<{ condition: WeatherCondition; tempC: number }>;
}

export interface WeatherSensorOptions {
  log: DecisionLog;
  lat?: number;              // 默认 22.5431（深圳）
  lon?: number;              // 默认 114.0579
  fetcher?: WeatherFetcher;  // 🆕 默认 **defaultWeatherFetcher**（QQ → Open-Meteo 级联）
  ttlMs?: number;
  now?: () => number;        // 可注入时钟，便于测试
}

export function wmoToCondition(code: number): WeatherCondition;
// ⟨Open-Meteo 的 WMO 天气码 → 4 种语义：
//   >=95 thunderstorm；51–67 或 80–82 rain；71–77/85–86（雪霰）按 rain；
//   45/48（雾）cloudy；>=3 cloudy；0–2 sunny⟩

export function cnWeatherToCondition(text: string): WeatherCondition;
// 🆕 ⟨**QQ 天气的中文实况文本**（如「阴」「多云」「雷阵雨」「小雨」）→ 同一 4 种语义。
//   与 WMO 码**不同源**，故单独映射：含「雷」→thunderstorm；雪/雨/霰/冰雹→rain；
//   阴/云/雾/霾/沙/尘→cloudy；晴→sunny；**空串或无法识别→按「阴」保守处理**⟩

export const qqWeatherFetcher: WeatherFetcher;
// 🆕 ⟨**主源①**：GET https://wis.qq.com/weather/common?source=pc&weather_type=observe
//        &province=<省>&city=<市>（国内可达、实时观测）。
//   缺 city/province → throw('qq-weather: missing province/city')；
//   非 2xx / status!==200 / degree 非有限数 → throw（由级联兜住）⟩

export const openMeteoFetcher: WeatherFetcher;
// ⟨**后备②**：GET api.open-meteo.com/v1/forecast（current=temperature_2m,weather_code）。
//   境外源，部分网络环境不可达；非 2xx 或 payload 缺字段则抛错⟩

export const defaultWeatherFetcher: WeatherFetcher;
// 🆕 ⟨**级联**：`try qqWeatherFetcher(loc) catch → openMeteoFetcher(loc)`。
//   ⚠️ 这是 `WeatherSensorOptions.fetcher` 的实际默认值（旧存根误称默认为 openMeteoFetcher）⟩

export class WeatherSensor {
  constructor(opts: WeatherSensorOptions);
    // ⟨构造时 fromEventLog() 恢复缓存，跨进程重启仍有效；
    //   坐标未显式给则用深圳默认值，等 `resolveGeo` 完成后由 setLocation 热更新⟩

  setLocation(lat: number, lon: number, city?: string, province?: string): void;
  // 🆕 ⟨IP 定位成功后热更新坐标（下一次 refresh 生效）。city/province 为 undefined 时不覆盖⟩
  location(): { lat: number; lon: number };   // 🆕 ⟨当前坐标（调试/自检用）⟩

  current(): WeatherState;
    // ⟨**永不抛错**。TTL 内返回缓存(source 保持原值)；过期返回 {...cache, source:'cache'}；
    //   无缓存返回 FALLBACK_WEATHER⟩
  refresh(): Promise<WeatherState>;
    // ⟨inflight 去重：并发调用复用同一 Promise⟩

  private log / lat / lon / city / province / fetcher / ttlMs / now;
  private cache: WeatherState | null;
  private inflight: Promise<WeatherState> | null;
  private doRefresh(): Promise<WeatherState>;
    // ⟨AbortController 超时控制；成功 → source='live' 且 append(weatherObservedDraft)；
    //   失败 → 内存缓存 ?? 事件流缓存（source='cache'）?? FALLBACK_WEATHER⟩
  private fromEventLog(): WeatherState | null;
    // ⟨log.byType('weather.observed', 1) 取最近一条，source 改写为 'cache'⟩
}
```

> **测试**：`tests/weather-source.test.ts` 13 例（主源/后备/降级链、`source=live|cache|fallback`、绝不抛错）。
> 🔗 **与 [`geo.ts`](weather-geo.md) 的关系**：geo 负责"**在哪**"（经纬度+省市名），sensor 负责"**什么天气**"。
> sensor 依赖 geo 的 `readCachedGeo()`（`sensor.ts:16`）；coordinator 依赖 geo 的 `resolveGeo()`
> 并在成功后调 `weather.setLocation()` + `bus.emit('geo:changed')`。
