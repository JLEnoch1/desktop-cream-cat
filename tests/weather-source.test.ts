/**
 * 天气数据源测试 —— QQ 天气抓取器 / 中文现象词映射 / 级联降级（根因修复回归）。
 *
 * 背景：原默认源 open-meteo 在境内网络被阻断（SSL_ERROR_SYSCALL），每次 refresh
 * 静默降级为缓存 → 表现为「刷新拿不到实时数据」。修复：默认源改为
 * QQ 天气（wis.qq.com，按省+市查询）→ open-meteo 级联。
 *
 * 运行：npm test（esbuild 编译后 node --test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionLog } from '../src/storage/sqlite.js';
import {
  cnWeatherToCondition, qqWeatherFetcher, openMeteoFetcher, defaultWeatherFetcher,
  WeatherSensor,
} from '../src/weather/sensor.js';

function tmpLog(): { log: DecisionLog; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'energy-pet-wsrc-'));
  return { log: new DecisionLog({ dbPath: join(dir, 'test.db') }), dir };
}

const HZ = { lat: 30.29, lon: 120.16, city: '杭州', province: '浙江' };

/* ── 中文现象词映射 ── */

test('cnWeatherToCondition: 晴/多云/阴/雨/雷/雪 归一化为 4 语义', () => {
  assert.equal(cnWeatherToCondition('晴'), 'sunny');
  assert.equal(cnWeatherToCondition('多云'), 'cloudy');
  assert.equal(cnWeatherToCondition('阴'), 'cloudy');
  assert.equal(cnWeatherToCondition('小雨'), 'rain');
  assert.equal(cnWeatherToCondition('中雨'), 'rain');
  assert.equal(cnWeatherToCondition('雷阵雨'), 'thunderstorm');
  assert.equal(cnWeatherToCondition('雷'), 'thunderstorm');
  assert.equal(cnWeatherToCondition('小雪'), 'rain');   // 雪并入 rain（v1 仅 4 语义）
  assert.equal(cnWeatherToCondition('阵雪'), 'rain');
  assert.equal(cnWeatherToCondition('雾'), 'cloudy');
  assert.equal(cnWeatherToCondition('霾'), 'cloudy');
});

test('cnWeatherToCondition: 空串/未知词 保守归为阴', () => {
  assert.equal(cnWeatherToCondition(''), 'cloudy');
  assert.equal(cnWeatherToCondition('  '), 'cloudy');
  assert.equal(cnWeatherToCondition('沙尘暴'), 'cloudy');
});

/* ── QQ 天气抓取器（mock fetch）── */

test('qqWeatherFetcher: 正常响应解析 degree/weather', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        status: 200,
        data: { observe: { degree: '18', weather: '阴', update_time: '202610212000' } },
      }),
    } as Response;
  });
  const r = await qqWeatherFetcher(HZ, new AbortController().signal);
  assert.deepEqual(r, { condition: 'cloudy', tempC: 18 });
  // 省市已 URL 编码进查询串
  assert.ok(calls[0].includes('province=') && calls[0].includes('city='));
  assert.ok(calls[0].includes(encodeURIComponent('浙江')));
});

test('qqWeatherFetcher: 缺省/市 → 主动抛错（触发级联到 open-meteo）', async () => {
  await assert.rejects(
    () => qqWeatherFetcher({ lat: 30, lon: 120 }, new AbortController().signal),
    /missing province\/city/,
  );
});

test('qqWeatherFetcher: HTTP 非 2xx → 抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 } as Response));
  await assert.rejects(() => qqWeatherFetcher(HZ, new AbortController().signal), /HTTP 503/);
});

test('qqWeatherFetcher: status≠200 或缺 observe/degree → malformed 抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ status: 200, data: { observe: { degree: 'NaN', weather: '阴' } } }),
  } as Response));
  await assert.rejects(() => qqWeatherFetcher(HZ, new AbortController().signal), /malformed/);
});

/* ── open-meteo 后备源 ── */

test('openMeteoFetcher: 解析 current 并映射 WMO 码', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ current: { temperature_2m: 22.5, weather_code: 61 } }),
  } as Response));
  const r = await openMeteoFetcher(HZ, new AbortController().signal);
  assert.deepEqual(r, { condition: 'rain', tempC: 22.5 });
});

test('openMeteoFetcher: payload 缺字段 → 抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) } as Response));
  await assert.rejects(() => openMeteoFetcher(HZ, new AbortController().signal), /malformed/);
});

/* ── 默认级联源 ── */

test('defaultWeatherFetcher: QQ 成功即用 QQ，不再调 open-meteo', async (t) => {
  let qq = 0, om = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('wis.qq.com')) { qq++; return { ok: true, json: async () => ({ status: 200, data: { observe: { degree: '20', weather: '晴' } } }) } as Response; }
    om++; return { ok: true, json: async () => ({ current: { temperature_2m: 5, weather_code: 0 } }) } as Response;
  });
  const r = await defaultWeatherFetcher(HZ, new AbortController().signal);
  assert.deepEqual(r, { condition: 'sunny', tempC: 20 });
  assert.equal(qq, 1);
  assert.equal(om, 0); // QQ 成功，后备未被调用
});

test('defaultWeatherFetcher: QQ 失败（如被阻断）→ 回退 open-meteo', async (t) => {
  let qq = 0, om = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('wis.qq.com')) { qq++; throw new Error('SSL_ERROR_SYSCALL'); } // 模拟境内阻断
    om++; return { ok: true, json: async () => ({ current: { temperature_2m: 12, weather_code: 3 } }) } as Response;
  });
  const r = await defaultWeatherFetcher(HZ, new AbortController().signal);
  assert.deepEqual(r, { condition: 'cloudy', tempC: 12 });
  assert.equal(qq, 1);
  assert.equal(om, 1); // 级联后备被调用
});

test('defaultWeatherFetcher: 两源全败 → 抛错（交 doRefresh 走缓存降级链）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  await assert.rejects(() => defaultWeatherFetcher(HZ, new AbortController().signal), /network down/);
});

/* ── 传感器端到端：默认源拿到 live 实时数据（根因回归）── */

test('sensor: 默认源刷新成功 → source=live 并入事件流', async (t) => {
  const { log, dir } = tmpLog();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ status: 200, data: { observe: { degree: '19', weather: '小雨' } } }),
  } as Response));
  try {
    const sensor = new WeatherSensor({ log });
    sensor.setLocation(HZ.lat, HZ.lon, HZ.city, HZ.province);
    const s = await sensor.refresh();
    assert.equal(s.source, 'live');           // 关键：实时而非 cache
    assert.equal(s.condition, 'rain');
    assert.equal(s.tempC, 19);
    // 快照已入事件流（跨重启缓存）
    assert.equal(log.byType('weather.observed', 1).length, 1);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sensor: 全源失败 → 降级为 cache/fallback，绝不抛错', async (t) => {
  const { log, dir } = tmpLog();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  try {
    const sensor = new WeatherSensor({ log });
    const s = await sensor.refresh();
    assert.ok(s.source === 'cache' || s.source === 'fallback');
    assert.equal(typeof s.tempC, 'number');
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
