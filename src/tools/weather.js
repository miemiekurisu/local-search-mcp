import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tinyPinyin = require('tiny-pinyin');

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const PHOTON_URL = 'https://photon.komoot.io/api/';

let lastPhotonTime = 0;

// Derived lazily — COMMON_CITY_PINYIN is declared later in this module.
let _cityPrefixes = null;
function cityPrefixes() {
  if (!_cityPrefixes) {
    _cityPrefixes = Object.keys(COMMON_CITY_PINYIN).sort((a, b) => b.length - a.length);
  }
  return _cityPrefixes;
}

const SUFFIX_ONLY_RE = /^[市区县镇乡省]*$/;

function stripKnownCityPrefix(text) {
  const t = String(text).trim();
  for (const c of cityPrefixes()) {
    if (t.length > c.length && t.startsWith(c)) {
      const sub = t.slice(c.length).trim();
      if (sub && sub.length >= 2 && !SUFFIX_ONLY_RE.test(sub)) {
        return { city: c, sub };
      }
      return { city: null, sub: '' };
    }
  }
  return { city: null, sub: t };
}

function hitMatchesCity(hit, city) {
  if (!city) return true;
  const hay = `${hit.city || ''} ${hit.state || ''}`.toLowerCase();
  return hay.includes(city.toLowerCase());
}

// Guard against non-place-name input (digits, underscores, etc.) — Photon's
// fuzzy search would otherwise match arbitrary POIs for junk queries.
function looksLikePlaceName(text) {
  return /^[\p{L}\s'.,-]+$/u.test(String(text).trim());
}

// Geocode Chinese districts/landmarks/towns via Photon (OpenStreetMap).
// Open-Meteo geocoding has no data for Chinese sub-city places, while
// Photon resolves exact names like 武侯区, 三林镇, 人民广场 natively.
async function geocodeSubCity(query) {
  const now = Date.now();
  const elapsed = now - lastPhotonTime;
  if (elapsed < 600) {
    await new Promise(r => setTimeout(r, 600 - elapsed));
  }
  lastPhotonTime = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=3`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const feats = data.features || [];
    if (feats.length === 0) return null;
    const f = feats[0];
    const props = f.properties || {};
    const coords = f.geometry?.coordinates || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      name: props.name || query,
      city: props.city || '',
      state: props.state || '',
      country: props.country || '',
      latitude: lat,
      longitude: lon
    };
  } catch {
    return null;
  }
}

function toPinyin(text) {
  // Convert Chinese to concatenated pinyin (no spaces, uppercase)
  return tinyPinyin.convertToPinyin(text);
}

const WMO_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight shower', 81: 'Moderate shower', 82: 'Violent shower',
  85: 'Slight snow shower', 86: 'Heavy snow shower',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
};

function detectLanguage(text) {
  const chinese = /[\u4e00-\u9fff]/;
  const hiragana = /[\u3040-\u309f]/;
  const katakana = /[\u30a0-\u30ff]/;
  const french = /[àâæéèêëîïôùûüÿçœ]/i;
  const german = /[äöüß]/;
  if (hiragana.test(text) || katakana.test(text)) return 'ja';
  if (chinese.test(text)) return 'zh';
  if (german.test(text)) return 'de';
  if (french.test(text)) return 'fr';
  return 'en';
}

function windDir(deg) {
  if (deg == null) return '';
  const dirs = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];
  return dirs[Math.round(deg / 45) % 8];
}

function parseCoordinates(text) {
  const m = String(text).trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

const COUNTRY_ALIASES = {
  uk: ['gb', 'united kingdom'],
  'u.k.': ['gb', 'united kingdom'],
  england: ['gb'],
  usa: ['us', 'united states'],
  'u.s.a': ['us', 'united states'],
  america: ['us'],
  prc: ['cn', 'china'],
  '中国': ['cn', 'china'],
  '美国': ['us', 'united states'],
  '英国': ['gb', 'united kingdom', 'england'],
  '日本': ['jp', 'japan'],
  '法国': ['fr', 'france'],
  '德国': ['de', 'germany'],
  '韩国': ['kr', 'south korea'],
  '意大利': ['it', 'italy'],
  '西班牙': ['es', 'spain'],
  '加拿大': ['ca', 'canada'],
  '澳大利亚': ['au', 'australia'],
  '印度': ['in', 'india'],
  '泰国': ['th', 'thailand'],
  '俄罗斯': ['ru', 'russia'],
  '巴西': ['br', 'brazil'],
  '墨西哥': ['mx', 'mexico'],
  '新加坡': ['sg', 'singapore'],
  '荷兰': ['nl', 'netherlands'],
  '瑞士': ['ch', 'switzerland'],
  '瑞典': ['se', 'sweden'],
  '挪威': ['no', 'norway'],
  '丹麦': ['dk', 'denmark'],
  '芬兰': ['fi', 'finland'],
  '波兰': ['pl', 'poland'],
  '葡萄牙': ['pt', 'portugal'],
  '比利时': ['be', 'belgium'],
  '奥地利': ['at', 'austria'],
  '爱尔兰': ['ie', 'ireland'],
  '新西兰': ['nz', 'new zealand'],
  '土耳其': ['tr', 'turkey'],
  '马来西亚': ['my', 'malaysia'],
  '越南': ['vn', 'vietnam'],
  '印度尼西亚': ['id', 'indonesia'],
  '菲律宾': ['ph', 'philippines'],
  '埃及': ['eg', 'egypt'],
  '南非': ['za', 'south africa'],
  '阿根廷': ['ar', 'argentina'],
  '智利': ['cl', 'chile']
};

function splitLocation(text) {
  const parts = String(text).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { main: parts[0], hint: parts.slice(1).join(' ') };
  }
  return { main: text, hint: null };
}

function matchHint(results, hint) {
  if (!hint) return results;
  const h = hint.toLowerCase();
  const tokens = new Set([h, ...(COUNTRY_ALIASES[h] || [])]);
  const matched = results.filter(r => {
    const hay = [r.name, r.admin1, r.admin2, r.country, r.country_code].filter(Boolean).join(' ').toLowerCase();
    return [...tokens].some(t => hay.includes(t));
  });
  return matched.length > 0 ? matched : results;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const la1 = a.latitude * Math.PI / 180;
  const la2 = b.latitude * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Merge same-metro duplicates (e.g. "New York City" + "Manhattan") keeping the largest city
function compactMetro(results) {
  const sorted = [...results].sort((a, b) => (b.population || 0) - (a.population || 0));
  const out = [];
  for (const r of sorted) {
    const absorbed = out.some(c => haversineKm(c, r) < 15);
    if (!absorbed) out.push(r);
  }
  return out;
}

// Returns the clearly dominant candidate, or null when genuinely ambiguous
function hasDominant(results) {
  const sorted = [...results].sort((a, b) => (b.population || 0) - (a.population || 0));
  const best = sorted[0];
  const second = sorted[1] || {};
  const bestPop = best.population || 0;
  const secondPop = second.population || 0;
  if (bestPop <= 0) return null;
  if (secondPop === 0 || bestPop / secondPop >= 3) return best;
  return null;
}

const COMMON_CITY_PINYIN = {
  '北京': 'BEIJING', '上海': 'SHANGHAI', '广州': 'GUANGZHOU', '深圳': 'SHENZHEN',
  '杭州': 'HANGZHOU', '苏州': 'SUZHOU', '成都': 'CHENGDU', '重庆': 'CHONGQING',
  '天津': 'TIANJIN', '武汉': 'WUHAN', '南京': 'NANJING', '西安': 'XIAN',
  '长沙': 'CHANGSHA', '青岛': 'QINGDAO', '大连': 'DALIAN', '厦门': 'XIAMEN',
  '郑州': 'ZHENGZHOU', '济南': 'JINAN', '昆明': 'KUNMING', '沈阳': 'SHENYANG',
  '哈尔滨': 'HARBIN', '长春': 'CHANGCHUN', '石家庄': 'SHIJIAZHUANG', '太原': 'TAIYUAN',
  '合肥': 'HEFEI', '南昌': 'NANCHANG', '福州': 'FUZHOU', '泉州': 'QUANZHOU',
  '东莞': 'DONGGUAN', '佛山': 'FOSHAN', '宁波': 'NINGBO', '无锡': 'WUXI',
  '温州': 'WENZHOU', '南通': 'NANTONG', '常州': 'CHANGZHOU', '徐州': 'XUZHOU',
  '烟台': 'YANTAI', '潍坊': 'WEIFANG', '淄博': 'ZIBO', '珠海': 'ZHUHAI',
  '中山': 'ZHONGSHAN', '惠州': 'HUIZHOU', '汕头': 'SHANTOU', '南宁': 'NANNING',
  '桂林': 'GUILIN', '贵阳': 'GUIYANG', '海口': 'HAIKOU', '三亚': 'SANYA',
  '兰州': 'LANZHOU', '西宁': 'XINING', '银川': 'YINCHUAN', '乌鲁木齐': 'URUMQI',
  '拉萨': 'LHASA', '呼和浩特': 'HOHHOT', '台北': 'TAIPEI', '高雄': 'KAOHSIUNG',
  '台中': 'TAICHUNG', '香港': 'HONG KONG', '澳门': 'MACAU', '新加坡': 'SINGAPORE',
  '伦敦': 'LONDON', '纽约': 'NEW YORK', '巴黎': 'PARIS', '东京': 'TOKYO',
  '柏林': 'BERLIN', '罗马': 'ROME', '悉尼': 'SYDNEY', '墨尔本': 'MELBOURNE',
  '洛杉矶': 'LOS ANGELES', '旧金山': 'SAN FRANCISCO', '多伦多': 'TORONTO',
  '温哥华': 'VANCOUVER', '莫斯科': 'MOSCOW', '迪拜': 'DUBAI', '曼谷': 'BANGKOK',
  '首尔': 'SEOUL', '吉隆坡': 'KUALA LUMPUR', '马德里': 'MADRID', '巴塞罗那': 'BARCELONA',
  '慕尼黑': 'MUNICH', '米兰': 'MILAN', '维也纳': 'VIENNA', '苏黎世': 'ZURICH',
  '日内瓦': 'GENEVA', '布鲁塞尔': 'BRUSSELS', '阿姆斯特丹': 'AMSTERDAM',
  '斯德哥尔摩': 'STOCKHOLM', '奥斯陆': 'OSLO', '赫尔辛基': 'HELSINKI',
  '哥本哈根': 'COPENHAGEN', '华沙': 'WARSAW', '布拉格': 'PRAGUE',
  '布达佩斯': 'BUDAPEST', '雅典': 'ATHENS', '伊斯坦布尔': 'ISTANBUL',
  '开罗': 'CAIRO', '内罗毕': 'NAIROBI', '约翰内斯堡': 'JOHANNESBURG',
  '圣保罗': 'SAO PAULO', '里约热内卢': 'RIO DE JANEIRO', '布宜诺斯艾利斯': 'BUENOS AIRES',
  '墨西哥城': 'MEXICO CITY', '芝加哥': 'CHICAGO', '休斯顿': 'HOUSTON',
  '波士顿': 'BOSTON', '华盛顿': 'WASHINGTON', '西雅图': 'SEATTLE',
  '迈阿密': 'MIAMI', '丹佛': 'DENVER', '凤凰城': 'PHOENIX', '拉斯维加斯': 'LAS VEGAS',
  '费城': 'PHILADELPHIA', '檀香山': 'HONOLULU', '都柏林': 'DUBLIN', '里斯本': 'LISBON',
  '爱丁堡': 'EDINBURGH', '曼彻斯特': 'MANCHESTER', '伯明翰': 'BIRMINGHAM'
};

function zhPinyinCandidates(text) {
  const base = String(text).replace(/[市区县镇乡省]$/, '');
  const candidates = [];
  const mapped = COMMON_CITY_PINYIN[base];
  if (mapped) candidates.push(mapped);
  candidates.push(toPinyin(base));
  for (let len = 2; len <= Math.min(base.length, 4); len++) {
    const prefix = base.slice(0, len);
    const suffix = base.slice(-len);
    if (prefix !== suffix) {
      candidates.push(toPinyin(prefix));
      candidates.push(toPinyin(suffix));
    }
  }
  return [...new Set(candidates)];
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = `${(r.latitude || 0).toFixed(3)},${(r.longitude || 0).toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function geocode(main, hint) {
  const lang = detectLanguage(main);
  let queries = [];

  if (lang === 'zh') {
    // Chinese geocoding strategy — try several romanizations of the main
    // name in order of reliability and keep the first one that yields an
    // unambiguous real city; the hint (e.g. "英国") is only used for filtering:
    // 1. Curated pinyin for common cities (e.g. "北京" -> BEIJING)
    // 2. Polyphonic pinyin (e.g. "shanghaisanlin")
    // 3. Prefix 2 chars (e.g. "黄浦" -> "huangpu" for districts)
    // 4. Suffix 2 chars (e.g. "三林" -> "sanlin" for townships)
    queries = zhPinyinCandidates(main);
  } else {
    queries.push(hint ? `${main}, ${hint}` : main);
    if (hint) queries.push(main);
  }

  const collected = [];
  for (const q of queries) {
    const data = await fetchGeo(q, 'en');
    if (!data || !data.results || data.results.length === 0) continue;
    const matched = matchHint(data.results, hint);
    if (matched.length === 0) continue;
    const dominant = hasDominant(compactMetro(matched));
    if (dominant) return [dominant];
    collected.push(...matched);
  }
  if (collected.length === 0) return null;

  const compact = compactMetro(collected);
  const dominant = hasDominant(compact);
  if (dominant) return [dominant];
  return dedupeResults(compact);
}

async function fetchGeo(name, lang) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(name)}&count=10&language=${lang}&format=json`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchWeather(lat, lon) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,pressure_msl,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
      timezone: 'auto',
      forecast_days: '7'
    });
    const res = await fetch(`${FORECAST_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: data.reason || data.error };
    return data;
  } catch {
    return { error: '网络请求失败' };
  }
}

function formatWeather(loc, data) {
  if (!data.current) return '天气数据为空';
  const c = data.current;
  const lines = [];
  lines.push(`🌤 天气预报`);
  lines.push(`📍 ${loc.name}`);
  if (loc.admin1) lines.push(`   ${loc.admin1}, ${loc.country}`);
  else if (loc.country) lines.push(`   ${loc.country}`);
  lines.push(`🕐 ${c.time}`);
  lines.push('──');
  const icon = WMO_CODES[c.weather_code] || `天气代码 ${c.weather_code}`;
  lines.push(`${icon} 体感 ${c.apparent_temperature}°C  实际 ${c.temperature_2m}°C`);
  lines.push(`💧 湿度 ${c.relative_humidity_2m}%`);
  lines.push(`💨 ${windDir(c.wind_direction_10m)} ${c.wind_speed_10m} km/h  阵风 ${c.wind_gusts_10m} km/h`);
  lines.push(`🔵 气压 ${c.pressure_msl} hPa`);
  lines.push(c.is_day ? '☀️ 白天' : '🌙 夜间');
  lines.push('');
  lines.push('📅 未来 6 天:');
  const d = data.daily;
  for (let i = 1; i < Math.min(d.time.length, 7); i++) {
    const date = new Date(d.time[i]).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const icon = WMO_CODES[d.weather_code[i]] || '?';
    const precip = d.precipitation_sum[i] > 0 ? `  降水 ${d.precipitation_sum[i]}mm` : '';
    lines.push(`  ${date}  ${icon}  ${d.temperature_2m_min[i]}°C ~ ${d.temperature_2m_max[i]}°C${precip}`);
  }
  lines.push('');
  lines.push(`数据: open-meteo.com | 坐标: ${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)}`);
  return lines.join('\n');
}

function formatLocationOptions(results) {
  const lines = [
    '📍 找到多个同名地点，请选择（选择后请再次调用 get_weather 用所选坐标或更精确名称查询）:',
    ''
  ];
  const isChinese = /[\u4e00-\u9fff]/.test(results[0]?.name || '');
  const sorted = [...results].sort((a, b) => {
    const aCN = a.country_code === 'CN' ? 1 : 0;
    const bCN = b.country_code === 'CN' ? 1 : 0;
    if (aCN !== bCN) return bCN - aCN;
    return (b.population || 0) - (a.population || 0);
  });
  const seen = new Set();
  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const r = sorted[i];
    const region = r.admin1 || '';
    const country = r.country || '';
    const key = `${r.name}-${region}-${country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lat = r.latitude.toFixed(2);
    const lon = r.longitude.toFixed(2);
    lines.push(`${i + 1}. ${r.name} (${region}, ${country})  坐标: ${lat}, ${lon}`);
  }
  lines.push('');
  lines.push('请选择与需求最匹配的编号，然后【再次调用 get_weather】，用该编号对应的坐标（如 "45.53, -122.70"）或更精确的名称重新查询，以获得该地点的天气。');
  return lines.join('\n');
}

export async function searchWeather(query) {
  if (!query) return { error: '请输入城市名称，例如："北京" 或 "Tokyo"' };
  try {
    const coords = parseCoordinates(query);
    if (coords) {
      const data = await fetchWeather(coords.latitude, coords.longitude);
      if (data.error) return { error: `天气数据获取失败: ${data.error}` };
      const loc = { name: `${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}`, country: '', admin1: '', latitude: coords.latitude, longitude: coords.longitude };
      return { title: `${loc.name} 天气`, content: formatWeather(loc, data), location: loc, source: 'open-meteo.com' };
    }

    const { main, hint } = splitLocation(query);
    const isZh = detectLanguage(main) === 'zh';
    let loc = null;

    if (isZh) {
      // Chinese sub-city names (districts/landmarks/towns): strip the known
      // city prefix and resolve the sub-name via Photon (OSM), which has
      // native Chinese coverage that Open-Meteo geocoding lacks. Pure city
      // names are excluded — they go through the curated-pinyin path.
      const { city, sub } = stripKnownCityPrefix(main);
      if (sub && !COMMON_CITY_PINYIN[main] && looksLikePlaceName(sub)) {
        const hit = await geocodeSubCity(sub);
        if (hit && hitMatchesCity(hit, city)) {
          loc = { name: hit.name, country: hit.country, admin1: hit.city || hit.state, latitude: hit.latitude, longitude: hit.longitude };
        }
      }
    }

    if (!loc) {
      const results = await geocode(main, hint);
      if (results) {
        if (results.length > 1) {
          return { content: formatLocationOptions(results), type: 'location_options', locations: results.slice(0, 5) };
        }
        const r = results[0];
        loc = { name: r.name, country: r.country, admin1: r.admin1 || '', latitude: r.latitude, longitude: r.longitude };
      }
    }

    if (!loc && !isZh && looksLikePlaceName(main)) {
      // English last-resort fallback via OSM
      const hit = await geocodeSubCity(main);
      if (hit) {
        loc = { name: hit.name, country: hit.country, admin1: hit.city || hit.state, latitude: hit.latitude, longitude: hit.longitude };
      }
    }

    if (!loc) {
      return { error: `找不到位置: ${query}` };
    }

    const data = await fetchWeather(loc.latitude, loc.longitude);
    if (data.error) return { error: `天气数据获取失败: ${data.error}` };

    return { title: `${loc.name} 天气`, content: formatWeather(loc, data), location: loc, source: 'open-meteo.com' };
  } catch (err) {
    return { error: `天气查询失败: ${err.message}` };
  }
}
