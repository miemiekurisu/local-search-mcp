import { test } from 'node:test';
import assert from 'node:assert';
import { globalFetchState, jsonResponse } from './helpers/mocks.mjs';

const gfs = globalFetchState();

const WEATHER_PAYLOAD = {
  current: {
    time: '2026-09-04T10:00',
    temperature_2m: 27.4, relative_humidity_2m: 61, apparent_temperature: 29.1,
    wind_speed_10m: 12.2, wind_direction_10m: 180, wind_gusts_10m: 20.1,
    weather_code: 2, pressure_msl: 1013.2, is_day: 1
  },
  daily: {
    time: ['2026-09-04', '2026-09-05', '2026-09-06'],
    weather_code: [2, 61, 61],
    temperature_2m_max: [30, 29, 27],
    temperature_2m_min: [24, 23, 22],
    precipitation_sum: [0, 4.5, 1]
  },
  latitude: 31.23, longitude: 121.47
};

test('getCurrentTime zones + utc query + default', async () => {
  const { getCurrentTime } = await import('../src/tools/time.js');
  const def = getCurrentTime();
  assert.ok(def.timezone);
  assert.strictEqual(typeof def.epoch, 'number');
  const utc = getCurrentTime('utc');
  assert.strictEqual(utc.timezone, 'UTC');
  const jp = getCurrentTime('tokyo');
  assert.strictEqual(jp.timezone, 'Asia/Tokyo');
  const us = getCurrentTime('new york');
  assert.strictEqual(us.timezone, 'America/New_York');
  const uk = getCurrentTime('london');
  assert.strictEqual(uk.timezone, 'Europe/London');
  const cn = getCurrentTime('beijing');
  assert.strictEqual(cn.timezone, 'Asia/Shanghai');
  const kr = getCurrentTime('seoul');
  assert.strictEqual(kr.timezone, 'Asia/Seoul');
  const ru = getCurrentTime('moscow');
  assert.strictEqual(ru.timezone, 'Europe/Moscow');
  const ind = getCurrentTime('delhi');
  assert.strictEqual(ind.timezone, 'Asia/Kolkata');
  const zh = getCurrentTime('中文查询时间');
  assert.ok(zh.display);
  const ja = getCurrentTime('現在の時刻');
  assert.ok(ja.display);
  const jaKana = getCurrentTime('こんばんは');
  assert.ok(jaKana.display);
  const en = getCurrentTime('english');
  assert.ok(en.display);
});

// ── weather: pure fetch plumbing via global fetch mock ──────
test('weather: direct coordinates happy path', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse(WEATHER_PAYLOAD));
  const res = await searchWeather('45.53, -122.70');
  assert.strictEqual(res.error, undefined);
  assert.ok(res.content.includes('🌤 天气预报'));
  assert.ok(res.content.includes('45.53, -122.70'));
  assert.strictEqual(res.location.latitude, 45.53);
  gfs.calls.length = 0;
});

test('weather: coordinate weather error paths', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({ error: true, reason: 'coordinate out of range' }));
  let res = await searchWeather('1,1');
  assert.ok(res.error.includes('out of range'));

  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({ current: null, daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } }));
  res = await searchWeather('2,2');
  assert.strictEqual(res.error, undefined);
  assert.ok(res.content.includes('天气数据为空'));

  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse(500, 500));
  res = await searchWeather('3,3');
  assert.ok(res.error.includes('500'));
  gfs.responses.length = 0;

  assert.deepStrictEqual(await searchWeather(''), { error: '请输入城市名称，例如："北京" 或 "Tokyo"' });
});

test('weather: named city via open-meteo geocode happy + ambiguous + not found', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  // single unambiguous result
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({ results: [
    { name: 'Prague', country: 'Czechia', country_code: 'CZ', admin1: 'Prague', latitude: 50.08, longitude: 14.43, population: 1300000 }
  ] }));
  gfs.responses.push(jsonResponse(WEATHER_PAYLOAD));
  const res = await searchWeather('Prague');
  assert.ok(res.title.includes('Prague'));
  assert.ok(res.content.includes('体感'));
  assert.ok(res.content.includes('未来 6 天'));
  assert.strictEqual(res.source, 'open-meteo.com');

  // ambiguous: two cities
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({ results: [
    { name: 'Cambridge', country: 'United Kingdom', country_code: 'GB', admin1: 'England', latitude: 52.2, longitude: 0.1, population: 150000 },
    { name: 'Cambridge', country: 'United States', country_code: 'US', admin1: 'Massachusetts', latitude: 42.37, longitude: -71.1, population: 118000 }
  ] }));
  const res2 = await searchWeather('Cambridge');
  assert.strictEqual(res2.type, 'location_options');
  assert.ok(res2.locations.length >= 1);
  assert.ok(res2.content.includes('请选择'));

  // no results at all
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({}));
  const res3 = await searchWeather('Nowheresville Xyz');
  assert.ok(res3.error.startsWith('找不到位置'));

  // geocode network failure → null
  gfs.responses.length = 0;
  gfs.responses.push((_url, _init, state) => { throw new Error('geocode down'); });
  const res4 = await searchWeather('Winterfell');
  assert.ok(res4.error.startsWith('找不到位置'));
});

test('weather: chinese city via curated pinyin path', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  // BEIJING candidate hits immediately
  gfs.responses.push(jsonResponse({ results: [
    { name: 'Beijing', country: 'China', country_code: 'CN', admin1: 'Beijing', latitude: 39.9, longitude: 116.4, population: 21000000 }
  ] }));
  gfs.responses.push(jsonResponse(WEATHER_PAYLOAD));
  const res = await searchWeather('北京');
  assert.ok(res.title.includes('Beijing'));
  gfs.calls.length = 0;
});

test('weather: chinese sub-city strips city prefix via photon', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  // photon response for "三林"
  gfs.responses.push(jsonResponse({ features: [
    { geometry: { coordinates: [121.53, 31.13] }, properties: { name: '三林', country: '中国', state: '上海', city: '上海市' } }
  ] }));
  gfs.responses.push(jsonResponse(WEATHER_PAYLOAD));
  const res = await searchWeather('上海三林');
  assert.ok(res.title.includes('三林'), `got ${res.title || JSON.stringify(res)}`);
});

test('weather: geocode hint filters by country', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.responses.push(jsonResponse({ results: [
    { name: 'Paris', country: 'France', country_code: 'FR', admin1: 'Île-de-France', latitude: 48.85, longitude: 2.35, population: 2000000 }
  ] }));
  gfs.responses.push(jsonResponse(WEATHER_PAYLOAD));
  const res = await searchWeather('Paris, France');
  assert.ok(res.title.includes('Paris'));
  gfs.calls.length = 0;
});
