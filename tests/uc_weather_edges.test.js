import { test } from 'node:test';
import assert from 'node:assert';
import { globalFetchState, jsonResponse } from './helpers/mocks.mjs';

const gfs = globalFetchState();

const WEATHER_PAYLOAD = {
  current: {
    time: '2026-09-05T10:00',
    temperature_2m: 21.4, relative_humidity_2m: 55, apparent_temperature: 20.9,
    wind_speed_10m: 8.2, wind_direction_10m: 90, wind_gusts_10m: 15.1,
    weather_code: 1, pressure_msl: 1015.2, is_day: 1
  },
  daily: {
    time: ['2026-09-05', '2026-09-06'],
    weather_code: [1, 3],
    temperature_2m_max: [26, 24],
    temperature_2m_min: [18, 17],
    precipitation_sum: [0.2, 0]
  },
  latitude: 39.9, longitude: 116.4
};

test('weather: city-alone with administrative suffix goes curated pinyin route', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.calls.length = 0;
  gfs.router = (url) => url.includes('geocoding-api')
    ? jsonResponse({ results: [{ name: 'Beijing', country: 'China', country_code: 'cn', population: 21000000, latitude: 39.9, longitude: 116.4 }] })
    : jsonResponse(WEATHER_PAYLOAD);
  const res = await searchWeather('北京市');
  gfs.router = null;
  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.ok(res.content.includes('北京') || res.content.includes('Beijing'), res.content?.slice(0, 120));
  const geoCalls = gfs.calls.filter(c => c.url.includes('geocoding-api'));
  assert.ok(geoCalls.some(c => c.url.includes('name=BEIJING')), 'curated pinyin query used');
  assert.ok(res.location.latitude === 39.9);
  gfs.calls.length = 0;
});

test('weather: zh non-city name builds prefix/suffix pinyin candidates', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.calls.length = 0;
  // Photon returns no features; open-meteo geocoding finds nothing for any pinyin query
  gfs.router = (url) => (url.includes('photon') ? jsonResponse({ features: [] }) : jsonResponse({ results: [] }));
  const res = await searchWeather('康桥花园');
  gfs.router = null;
  assert.ok(res.error.includes('找不到位置'), JSON.stringify(res));
  const geoUrls = gfs.calls.filter(c => c.url.includes('geocoding-api')).map(c => decodeURIComponent(c.url));
  const pinyinQueries = geoUrls.map(u => u.match(/name=([^&]+)/)?.[1]).filter(Boolean);
  // prefix (kangqie...) AND suffix (huayuan) candidates from slice loop
  assert.ok(pinyinQueries.some(q => /HUAYUAN$/i.test(q)), JSON.stringify(pinyinQueries));
  assert.ok(pinyinQueries.some(q => /KANGQIE$/i.test(q)), JSON.stringify(pinyinQueries));
  assert.ok(pinyinQueries.some(q => /KANGQIEHUAYUAN/i.test(q)), JSON.stringify(pinyinQueries));
  gfs.calls.length = 0;
});

test('weather: english last-resort OSM fallback resolves location', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.calls.length = 0;
  gfs.router = (url) => {
    if (url.includes('geocoding-api')) return jsonResponse({ results: [] });
    if (url.includes('photon')) {
      return jsonResponse({ features: [{ properties: { name: 'Cambridge', city: 'Cambridge', state: 'Massachusetts', country: 'United States' }, geometry: { coordinates: [-71.1097, 42.3736] } }] });
    }
    return jsonResponse(WEATHER_PAYLOAD);
  };
  const res = await searchWeather('Cambridge, Massachusetts');
  gfs.router = null;
  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.equal(res.location.name, 'Cambridge');
  assert.ok(res.content.includes('🌤'));
  gfs.calls.length = 0;
});

test('weather: malformed geocode payload surfaces top-level error message', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.calls.length = 0;
  gfs.router = (url) => (url.includes('geocoding-api') || url.includes('photon'))
    ? jsonResponse({ results: [null] })
    : jsonResponse(WEATHER_PAYLOAD);
  const res = await searchWeather('Marsville');
  gfs.router = null;
  assert.ok(res.error.includes('天气查询失败'), JSON.stringify(res));
  gfs.calls.length = 0;
});

test('weather: forecast fetch failure inside try/catch returns network error', async () => {
  const { searchWeather } = await import('../src/tools/weather.js');
  gfs.responses.length = 0;
  gfs.calls.length = 0;
  gfs.router = (url) => {
    if (url.includes('geocoding-api')) {
      return jsonResponse({ results: [{ name: 'Beijing', country: 'China', country_code: 'cn', population: 21000000, latitude: 39.9, longitude: 116.4 }] });
    }
    throw new Error('forecast endpoint unreachable');
  };
  const res = await searchWeather('北京市');
  gfs.router = null;
  assert.ok(res.error.includes('天气数据获取失败'), JSON.stringify(res));
  gfs.calls.length = 0;
});
