const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

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

async function geocode(location) {
  const lang = detectLanguage(location);
  const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(location)}&count=10&language=${lang}&format=json`);
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  const r = data.results[0];
  return { name: r.name, country: r.country, admin1: r.admin1 || '', latitude: r.latitude, longitude: r.longitude };
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,pressure_msl,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'auto',
    forecast_days: '7'
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  const data = await res.json();
  if (data.error) return { error: data.reason || data.error };
  return data;
}

function formatWeather(loc, data) {
  const c = data.current;
  const lines = [];
  lines.push(`🌤 天气预报`);
  lines.push(`📍 ${loc.name}`);
  if (loc.admin1) lines.push(`   ${loc.admin1}, ${loc.country}`);
  else lines.push(`   ${loc.country}`);
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

export async function searchWeather(query) {
  if (!query) return { error: '请输入城市名称，例如："北京" 或 "Tokyo"' };

  let loc = await geocode(query);
  if (loc) {
    const data = await fetchWeather(loc.latitude, loc.longitude);
    if (data.error) return { error: `天气数据获取失败: ${data.error}` };
    return { title: `${loc.name} 天气`, content: formatWeather(loc, data), location: loc, source: 'open-meteo.com' };
  }

  return { error: `找不到位置: ${query}` };
}
