/**
 * WeatherSensor —— 天气感知（API + 缓存 + 降级）。
 *
 * 设计：
 *  - 数据源：Open-Meteo（免费、无需 API key、可离线部署镜像），WMO 天气码归一化为 4 种语义
 *  - 缓存：双层 —— 内存 TTL（默认 30 分钟）+ DecisionLog 中最近一条 weather.observed 事件
 *  - 降级链：live → 内存缓存 → 事件流缓存 → FALLBACK_WEATHER（阴/20°C）
 *  - 完全离线可用：网络失败不报错，只降级，source 字段标注来源
 *  - fetcher 可注入，便于单测与替换数据源
 */

import type { DecisionLog } from '../storage/sqlite.js';
import { weatherObservedDraft } from '../core/events.js';
import { FALLBACK_WEATHER } from '../core/types.js';
import type { WeatherCondition, WeatherState } from '../core/types.js';
import { readCachedGeo } from './geo.js';

/** 缓存 TTL（ms） */
export const CACHE_TTL_MS = 30 * 60 * 1000;
/** 请求超时（ms） */
export const FETCH_TIMEOUT_MS = 6000;

/** 天气查询位置（QQ 天气按省+市查询；open-meteo 用经纬度） */
export interface WeatherLocation {
  lat: number;
  lon: number;
  /** 城市名（中文，如「杭州」） */
  city?: string;
  /** 省/自治区名（中文，如「浙江」） */
  province?: string;
}

export interface WeatherFetcher {
  (loc: WeatherLocation, signal: AbortSignal): Promise<{ condition: WeatherCondition; tempC: number }>;
}

export interface WeatherSensorOptions {
  log: DecisionLog;
  /** 经纬度（默认深圳；实际部署可由用户配置） */
  lat?: number;
  lon?: number;
  /** 注入的抓取器（默认：QQ 天气 → open-meteo 级联） */
  fetcher?: WeatherFetcher;
  ttlMs?: number;
  now?: () => number;
}

/** WMO 天气码 → 归一化语义（屏蔽上游差异的核心映射） */
export function wmoToCondition(code: number): WeatherCondition {
  // 雷暴：95–99
  if (code >= 95) return 'thunderstorm';
  // 雨：51–67（毛毛雨/雨）、80–82（阵雨）、66/67 冻雨
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  // 雪/霰（71–77, 85–86）按「雨」处理 —— v1 只保留 4 种语义
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'rain';
  // 雾（45,48）按阴处理
  if (code === 45 || code === 48) return 'cloudy';
  // 阴/多云：1–4（主要晴朗/部分多云/阴）中 >=3 视为阴
  if (code >= 3) return 'cloudy';
  return 'sunny'; // 0,1,2 晴到少云
}

/**
 * 腾讯天气中文现象词 → 归一化语义。
 * wis.qq.com 的 observe.weather 是中文（如「阴」「多云」「雷阵雨」「小雨」），
 * 与 open-meteo 的 WMO 码不同源，单独映射。无法识别时按「阴」保守处理。
 */
export function cnWeatherToCondition(text: string): WeatherCondition {
  const t = (text || '').trim();
  if (!t) return 'cloudy';
  if (t.includes('雷')) return 'thunderstorm';
  if (t.includes('雪') || t.includes('雨') || t.includes('霰') || t.includes('冰雹')) return 'rain';
  if (t.includes('阴') || t.includes('云') || t.includes('雾') || t.includes('霾') || t.includes('沙') || t.includes('尘')) return 'cloudy';
  if (t.includes('晴')) return 'sunny';
  return 'cloudy';
}

/** 默认抓取器①：腾讯天气 wis.qq.com（国内可达、实时观测，按省+市查询） */
export const qqWeatherFetcher: WeatherFetcher = async (loc, signal) => {
  if (!loc.city || !loc.province) throw new Error('qq-weather: missing province/city');
  const url = 'https://wis.qq.com/weather/common?source=pc&weather_type=observe'
    + `&province=${encodeURIComponent(loc.province)}&city=${encodeURIComponent(loc.city)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`qq-weather HTTP ${res.status}`);
  const json = await res.json() as {
    status?: number;
    data?: { observe?: { degree?: string; weather?: string } };
  };
  const obs = json.data?.observe;
  const degree = Number(obs?.degree);
  if (json.status !== 200 || !obs || !Number.isFinite(degree)) throw new Error('qq-weather: malformed payload');
  return { condition: cnWeatherToCondition(obs.weather ?? ''), tempC: degree };
};

/** 抓取器②：Open-Meteo current_weather（境外源，作 QQ 失败时的后备；部分网络环境不可达） */
export const openMeteoFetcher: WeatherFetcher = async (loc, signal) => {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&current=temperature_2m,weather_code&timezone=auto`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  const json = await res.json() as { current?: { temperature_2m?: number; weather_code?: number } };
  const tempC = json.current?.temperature_2m;
  const code = json.current?.weather_code;
  if (typeof tempC !== 'number' || typeof code !== 'number') throw new Error('open-meteo: malformed payload');
  return { condition: wmoToCondition(code), tempC };
};

/**
 * 默认数据源级联：QQ 天气（国内实时）→ open-meteo（境外后备）。
 * 任一源成功即返回；全部失败才抛错，交由 doRefresh 走缓存降级链。
 * 根因修复：此前仅用 open-meteo，在境内网络被阻断 → 每次 refresh 静默降级为缓存，
 * 表现为「刷新拿不到实时数据」。
 */
export const defaultWeatherFetcher: WeatherFetcher = async (loc, signal) => {
  try {
    return await qqWeatherFetcher(loc, signal);
  } catch {
    return await openMeteoFetcher(loc, signal);
  }
};

export class WeatherSensor {
  private readonly log: DecisionLog;
  private lat: number;
  private lon: number;
  private city: string;
  private province: string;
  private readonly fetcher: WeatherFetcher;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: WeatherState | null = null;
  private inflight: Promise<WeatherState> | null = null;

  constructor(opts: WeatherSensorOptions) {
    this.log = opts.log;
    // 坐标优先级：显式配置 > 未过期的 IP 定位缓存 > 深圳兜底。
    // 启动期同步读缓存，避免首帧天气请求阻塞等网络；过期/缺失时由 coordinator 异步
    // resolveGeo 后调 setLocation 热更新（下一次 refresh 生效）。
    const cachedGeo = readCachedGeo(this.log, opts.now ?? (() => Date.now()));
    this.lat = opts.lat ?? cachedGeo?.lat ?? 22.5431; // 深圳
    this.lon = opts.lon ?? cachedGeo?.lon ?? 114.0579;
    // 省市来自定位缓存（QQ 天气按省+市查询）；显式 lat/lon 配置无省市时留空，
    // 此时 qqWeatherFetcher 主动抛错、级联自动落到 open-meteo（按经纬度）。
    this.city = cachedGeo?.city ?? '';
    this.province = cachedGeo?.province ?? '';
    this.fetcher = opts.fetcher ?? defaultWeatherFetcher;
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    // 启动时尝试从事件流恢复缓存（跨进程重启仍有效）
    this.cache = this.fromEventLog();
  }

  /** 热更新位置（IP 定位成功后调用）；下次 refresh 即用新位置 */
  setLocation(lat: number, lon: number, city?: string, province?: string): void {
    this.lat = lat;
    this.lon = lon;
    if (city !== undefined) this.city = city;
    if (province !== undefined) this.province = province;
  }

  /** 当前坐标（调试/自检用） */
  location(): { lat: number; lon: number } {
    return { lat: this.lat, lon: this.lon };
  }

  /** 当前天气（可能来自缓存/降级，永不抛错） */
  current(): WeatherState {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache;
    if (this.cache) return { ...this.cache, source: 'cache' };
    return FALLBACK_WEATHER;
  }

  /** 强制刷新（成功 → live 并入事件流；失败 → 降级链） */
  async refresh(): Promise<WeatherState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<WeatherState> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let result: { condition: WeatherCondition; tempC: number };
      try {
        result = await this.fetcher({ lat: this.lat, lon: this.lon, city: this.city, province: this.province }, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      const state: WeatherState = {
        condition: result.condition,
        tempC: Math.round(result.tempC * 10) / 10,
        source: 'live',
        at: this.now(),
      };
      this.cache = state;
      // 天气快照入事件流（既是审计，也是跨重启缓存）
      this.log.append(weatherObservedDraft(state));
      return state;
    } catch {
      // 降级链：内存缓存 → 事件流缓存 → fallback
      const cached = this.cache ?? this.fromEventLog();
      if (cached) return { ...cached, source: 'cache' };
      return { ...FALLBACK_WEATHER, at: this.now() };
    }
  }

  /** 从事件流取最近一条 weather.observed */
  private fromEventLog(): WeatherState | null {
    const evs = this.log.byType('weather.observed', 1);
    if (!evs.length) return null;
    const ev = evs[evs.length - 1]!;
    if (ev.payload.kind !== 'weather.observed') return null;
    return { ...ev.payload.weather, source: 'cache' };
  }
}
