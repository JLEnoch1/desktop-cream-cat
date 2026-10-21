/**
 * Geo 定位测试 —— IP 定位缓存 / 降级 / 传感器坐标热更新（需求 4）。
 * 运行：npm test（esbuild 编译后 node --test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionLog } from '../src/storage/sqlite.js';
import {
  resolveGeo, readCachedGeo, GEO_META_KEY, GEO_CACHE_TTL_MS, FALLBACK_GEO,
} from '../src/weather/geo.js';
import type { GeoFetcher } from '../src/weather/geo.js';
import { WeatherSensor } from '../src/weather/sensor.js';

function tmpLog(): { log: DecisionLog; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-geo-'));
  return { log: new DecisionLog({ dbPath: join(dir, 'test.db') }), dir };
}

const T0 = 1_700_000_000_000;

test('geo: meta get/set 往返与 UPSERT', () => {
  const { log, dir } = tmpLog();
  try {
    assert.equal(log.getMeta('nope'), null);
    log.setMeta('k', 'v1');
    assert.equal(log.getMeta('k'), 'v1');
    log.setMeta('k', 'v2');
    assert.equal(log.getMeta('k'), 'v2'); // UPSERT 覆盖，不重复插
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 无缓存 → 在线定位并写缓存', async () => {
  const { log, dir } = tmpLog();
  let now = T0;
  let calls = 0;
  const fetcher: GeoFetcher = async () => { calls++; return { lat: 31.23, lon: 121.47, city: '上海' }; };
  try {
    assert.equal(readCachedGeo(log, () => now), null);
    const p = await resolveGeo(log, { fetcher, now: () => now });
    assert.equal(calls, 1);
    assert.deepEqual(p, { lat: 31.23, lon: 121.47, city: '上海' });
    // 缓存已落 meta，读回一致
    assert.deepEqual(readCachedGeo(log, () => now), { lat: 31.23, lon: 121.47, city: '上海' });
    assert.ok(log.getMeta(GEO_META_KEY)!.includes('121.47'));
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 缓存未过期 → 不发起在线请求', async () => {
  const { log, dir } = tmpLog();
  let now = T0;
  let calls = 0;
  const fetcher: GeoFetcher = async () => { calls++; return { lat: 1, lon: 2, city: 'X' }; };
  try {
    await resolveGeo(log, { fetcher, now: () => now });
    assert.equal(calls, 1);
    now += GEO_CACHE_TTL_MS - 1000; // 差 1s 过期
    const p = await resolveGeo(log, { fetcher, now: () => now });
    assert.equal(calls, 1);            // 第二次走缓存，未再请求
    assert.deepEqual(p, { lat: 1, lon: 2, city: 'X' });
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 缓存过期 → 重新在线定位并刷新缓存', async () => {
  const { log, dir } = tmpLog();
  let now = T0;
  let calls = 0;
  const fetcher: GeoFetcher = async () => { calls++; return calls === 1 ? { lat: 31.23, lon: 121.47, city: '上海' } : { lat: 39.9, lon: 116.4, city: '北京' }; };
  try {
    await resolveGeo(log, { fetcher, now: () => now });
    now += GEO_CACHE_TTL_MS + 1; // 已过期
    const p = await resolveGeo(log, { fetcher, now: () => now });
    assert.equal(calls, 2);
    assert.deepEqual(p, { lat: 39.9, lon: 116.4, city: '北京' });
    assert.deepEqual(readCachedGeo(log, () => now), { lat: 39.9, lon: 116.4, city: '北京' });
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 在线失败 → 回退过期缓存（仍比兜底贴近用户）', async () => {
  const { log, dir } = tmpLog();
  let now = T0;
  let calls = 0;
  const okFetcher: GeoFetcher = async () => { calls++; return { lat: 31.23, lon: 121.47, city: '上海' }; };
  const badFetcher: GeoFetcher = async () => { throw new Error('network down'); };
  try {
    await resolveGeo(log, { fetcher: okFetcher, now: () => now });
    now += GEO_CACHE_TTL_MS + 1;
    const p = await resolveGeo(log, { fetcher: badFetcher, now: () => now });
    assert.equal(calls, 1);
    assert.deepEqual(p, { lat: 31.23, lon: 121.47, city: '上海' }); // 过期缓存兜底
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 在线失败且无缓存 → 深圳兜底，绝不抛错', async () => {
  const { log, dir } = tmpLog();
  const badFetcher: GeoFetcher = async () => { throw new Error('network down'); };
  try {
    const p = await resolveGeo(log, { fetcher: badFetcher, now: () => T0 });
    assert.deepEqual(p, FALLBACK_GEO);
    // 失败不落缓存（下次启动仍会尝试在线定位）
    assert.equal(log.getMeta(GEO_META_KEY), null);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: readCachedGeo 对脏数据宽容（坏 JSON / 缺字段 → null）', () => {
  const { log, dir } = tmpLog();
  try {
    log.setMeta(GEO_META_KEY, 'not-json');
    assert.equal(readCachedGeo(log, () => T0), null);
    log.setMeta(GEO_META_KEY, JSON.stringify({ lat: 1 })); // 缺 lon/at
    assert.equal(readCachedGeo(log, () => T0), null);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: WeatherSensor 构造应用缓存坐标；setLocation 热更新生效', async () => {
  const { log, dir } = tmpLog();
  try {
    // 预写缓存：上海
    log.setMeta(GEO_META_KEY, JSON.stringify({ lat: 31.23, lon: 121.47, city: '上海', at: Date.now() }));
    const seen: Array<[number, number]> = [];
    const sensor = new WeatherSensor({
      log,
      fetcher: async (loc) => { seen.push([loc.lat, loc.lon]); return { condition: 'sunny', tempC: 20 }; },
    });
    // 构造期即应用缓存坐标（同步，无需等网络）
    assert.deepEqual(sensor.location(), { lat: 31.23, lon: 121.47 });
    await sensor.refresh();
    assert.deepEqual(seen[0], [31.23, 121.47]);
    // 热更新：下一次 refresh 用新坐标
    sensor.setLocation(39.9, 116.4);
    await sensor.refresh();
    assert.deepEqual(seen[1], [39.9, 116.4]);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('geo: 显式 lat/lon 配置优先于缓存', () => {
  const { log, dir } = tmpLog();
  try {
    log.setMeta(GEO_META_KEY, JSON.stringify({ lat: 31.23, lon: 121.47, city: '上海', at: Date.now() }));
    const sensor = new WeatherSensor({ log, lat: 10, lon: 20, fetcher: async () => ({ condition: 'sunny', tempC: 20 }) });
    assert.deepEqual(sensor.location(), { lat: 10, lon: 20 });
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
