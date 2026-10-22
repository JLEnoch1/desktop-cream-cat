# `src/weather/geo.ts` — IP 定位（128 行）

> 模块存根（原 STRUCTURE_MAP §3.11b）· 层级 **L2** · 测试：tests/geo.test.ts（9 例）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
> ⚠️ **本节为 v1.3 补写**。首版 STRUCTURE_MAP 声称"全量覆盖 17 个文件"，
> 但 `geo.ts` 既未计入文件数、也无存根章节（`grep -c "resolveGeo" STRUCTURE_MAP.md` 曾 = **0**）。
> 旧编号 **3.11b**（避免破坏当时的 §3.x 交叉引用）；渐进式披露重构后，本文件即 `geo.ts` 的唯一详情文档。

```ts
/**
 * GeoLocator —— 启动时 IP 定位用户城市（需求 4：天气读实时数据，坐标跟随用户所在城市）。
 *
 * 设计（源码文件头注释，已核实）：
 *  - 数据源：**ip-api.com**（免费、无需 key、返回中文城市名）。该服务**仅支持 HTTP**，
 *    桌面端主进程发起请求不受浏览器混合内容限制，可直接使用。
 *    ⚠️ 这意味着 geo 请求是**明文 HTTP**，且只用于取经纬度+省市名，不含任何用户标识。
 *  - 缓存：`DecisionLog.meta[GEO_META_KEY]`，TTL 7 天（IP 变动不频繁，避免每次启动都请求）
 *  - 降级链：缓存（未过期）→ 在线定位 → **过期缓存** → 深圳兜底
 *  - 定位失败**绝不打断启动**：天气传感器拿到坐标前先用默认值，定位成功后 setLocation 热更新
 *  - 测试模式（注入 weatherFetcher）或显式 lat/lon 配置时**跳过定位**，保证离线确定性
 */

export const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天
export const GEO_FETCH_TIMEOUT_MS = 6000;                  // 请求超时
export const GEO_META_KEY = 'geo_cache_v2';
// ⚠️ v2 新增 `province` 字段（QQ 天气按「省+市」查询，必需）。
//    **旧 v1 缓存无 province** ⇒ 故意改键名，强制所有用户下次启动重新定位一次。
//    勿"优化"回 v1 键名，那会让老用户的天气查询缺 province 而失败。

export interface GeoPoint {
  lat: number;
  lon: number;
  city: string;        // 中文城市名（展示/日志 + 腾讯天气按 省+市 查询）
  province?: string;   // 中文省/自治区名（如「浙江」「广东」）；腾讯天气 API 必需
}

export const FALLBACK_GEO: GeoPoint;
// ⟨{ lat: 22.5431, lon: 114.0579, city: '深圳', province: '广东' }⟩

export interface GeoFetcher { (signal: AbortSignal): Promise<GeoPoint> }

export const ipApiGeoFetcher: GeoFetcher;
// ⟨GET http://ip-api.com/json/?fields=status,lat,lon,city,regionName&lang=zh-CN
//   status!=='success' 或 lat/lon 非 number → throw（由 resolveGeo 兜住）；
//   regionName → province，lang=zh-CN 拿中文省市名⟩

/** **同步**读取未过期缓存（启动构造期用，避免首帧天气请求等网络） */
export function readCachedGeo(log: DecisionLog, now?: () => number): GeoPoint | null;
// ⟨parseCache(log.getMeta(GEO_META_KEY))；无缓存 / 已过期 / 解析失败 → **null**（调用方自行兜底）
//   🔗 调用方：`weather/sensor.ts:16` import 本函数⟩

/** 解析当前应使用的坐标。**永不抛错** —— 定位是增强项，不是启动前置条件 */
export async function resolveGeo(
  log: DecisionLog,
  opts?: { fetcher?: GeoFetcher; now?: () => number },
): Promise<GeoPoint>;
// ⟨① 缓存未过期（now - at < GEO_CACHE_TTL_MS）→ 直接返回，不发请求
//   ② 否则 fetcher(signal) + AbortController 6s 超时（finally 里 clearTimeout）
//      成功 → setMeta(GEO_META_KEY, JSON.stringify({...point, at: now()})) 后返回
//   ③ catch → **过期缓存仍比兜底值更贴近用户**，故 cached ? toPoint(cached) : FALLBACK_GEO
//   🔗 调用方：`main/coordinator.ts:20` import，在 geoTimer(setTimeout) 里调用，
//      成功后 weather.setLocation(...) + bus.emit('geo:changed')⟩

/* 模块私有（未导出）：parseCache(json) / toPoint(cached) */
```

> **测试**：`tests/geo.test.ts` 9 例（解析 + 7 天缓存 TTL + 降级链 + 超时）。
> 🔴 **与 R18「完全离线」的关系**：R18 禁的是"需要网络的**推理/渲染**依赖"，
> 天气与定位是**可选增强**且有完整降级链（缓存 → 兜底深圳），断网时产品仍完全可用。
> 改动本文件时必须保持 `resolveGeo()` **永不抛错**的契约。
