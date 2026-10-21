/**
 * GeoLocator —— 启动时 IP 定位用户城市（需求 4：天气读取实时数据，坐标跟随用户所在城市）。
 *
 * 设计：
 *  - 数据源：ip-api.com（免费、无需 key、返回中文城市名）。注意该服务**仅支持 HTTP**，
 *    桌面端主进程发起请求不受浏览器混合内容限制，可直接使用。
 *  - 缓存：DecisionLog.meta[GEO_META_KEY]，TTL 7 天（IP 变动不频繁，避免每次启动都请求）
 *  - 降级链：缓存（未过期）→ 在线定位 → 过期缓存 → 深圳兜底
 *  - 定位失败绝不打断启动：天气传感器拿到坐标前先用默认值，定位成功后 setLocation 热更新
 *  - 测试模式（注入 weatherFetcher）或显式 lat/lon 配置时跳过定位，保证离线确定性
 */

import type { DecisionLog } from '../storage/sqlite.js';

/** 定位缓存 TTL（ms）：7 天 */
export const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 定位请求超时（ms） */
export const GEO_FETCH_TIMEOUT_MS = 6000;
/** meta 键名（v2：新增 province 字段供 QQ 天气按省+市查询；
 *  旧 v1 缓存无 province，弃用键名强制所有用户下次启动重新定位一次） */
export const GEO_META_KEY = 'geo_cache_v2';

export interface GeoPoint {
  lat: number;
  lon: number;
  /** 城市名（中文，展示/日志用；腾讯天气 API 按 省+市 查询） */
  city: string;
  /** 省/自治区名（中文，如「浙江」「广东」；腾讯天气 API 必需） */
  province?: string;
}

/** 兜底坐标：深圳 */
export const FALLBACK_GEO: GeoPoint = { lat: 22.5431, lon: 114.0579, city: '深圳', province: '广东' };

export interface GeoFetcher {
  (signal: AbortSignal): Promise<GeoPoint>;
}

/** 默认定位器：ip-api.com（fields 精简响应，lang=zh-CN 拿中文省市名） */
export const ipApiGeoFetcher: GeoFetcher = async (signal) => {
  const url = 'http://ip-api.com/json/?fields=status,lat,lon,city,regionName&lang=zh-CN';
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`ip-api HTTP ${res.status}`);
  const json = await res.json() as { status?: string; lat?: number; lon?: number; city?: string; regionName?: string };
  if (json.status !== 'success' || typeof json.lat !== 'number' || typeof json.lon !== 'number') {
    throw new Error('ip-api: malformed payload');
  }
  return {
    lat: json.lat,
    lon: json.lon,
    city: typeof json.city === 'string' && json.city ? json.city : '',
    province: typeof json.regionName === 'string' && json.regionName ? json.regionName : '',
  };
};

interface GeoCacheRow extends GeoPoint {
  /** 缓存写入时刻（ms） */
  at: number;
}

function parseCache(raw: string | null): GeoCacheRow | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<GeoCacheRow>;
    if (typeof o.lat !== 'number' || typeof o.lon !== 'number' || typeof o.at !== 'number') return null;
    return {
      lat: o.lat,
      lon: o.lon,
      city: typeof o.city === 'string' ? o.city : '',
      province: typeof o.province === 'string' ? o.province : undefined,
      at: o.at,
    };
  } catch {
    return null;
  }
}

/**
 * 缓存行 → 对外 GeoPoint（剥离内部 at 字段，返回干净契约）。
 * province 为可选：仅在有值时才带上键，避免 `province: undefined` 幽灵键
 * 污染 strict deepEqual 断言与 JSON 结构。
 */
function toPoint(c: GeoCacheRow): GeoPoint {
  const p: GeoPoint = { lat: c.lat, lon: c.lon, city: c.city };
  if (c.province) p.province = c.province;
  return p;
}

/**
 * 同步读取未过期的定位缓存（启动构造期用，避免首帧天气请求等网络）。
 * 无缓存 / 已过期 / 解析失败 → null（调用方自行兜底）。
 */
export function readCachedGeo(log: DecisionLog, now: () => number = () => Date.now()): GeoPoint | null {
  const cached = parseCache(log.getMeta(GEO_META_KEY));
  if (!cached || now() - cached.at >= GEO_CACHE_TTL_MS) return null;
  return toPoint(cached);
}

/**
 * 解析当前应使用的坐标：缓存优先，过期则在线刷新；在线失败回退过期缓存 / 深圳。
 * 永不抛错 —— 定位是增强项，不是启动前置条件。
 */
export async function resolveGeo(
  log: DecisionLog,
  opts: { fetcher?: GeoFetcher; now?: () => number } = {},
): Promise<GeoPoint> {
  const now = opts.now ?? (() => Date.now());
  const fetcher = opts.fetcher ?? ipApiGeoFetcher;
  const cached = parseCache(log.getMeta(GEO_META_KEY));

  if (cached && now() - cached.at < GEO_CACHE_TTL_MS) return toPoint(cached);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEO_FETCH_TIMEOUT_MS);
    let point: GeoPoint;
    try {
      point = await fetcher(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
    log.setMeta(GEO_META_KEY, JSON.stringify({ ...point, at: now() }));
    return point;
  } catch {
    // 在线失败：过期缓存仍比兜底值更贴近用户
    return cached ? toPoint(cached) : FALLBACK_GEO;
  }
}
