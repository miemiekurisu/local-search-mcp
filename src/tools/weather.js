const GEO_API = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

const WEATHER_CODES = {
  0: '☀️ 晴朗', 1: '🌤️ 大致晴朗', 2: '⛅ 多云', 3: '☁️ 阴天',
  45: '🌫️ 雾', 48: '🌫️ 雾凇',
  51: '🌦️ 小毛毛雨', 53: '🌦️ 毛毛雨', 55: '🌧️ 中毛毛雨',
  56: '🌧️ 冻毛毛雨', 57: '🌧️ 强冻毛毛雨',
  61: '🌧️ 小雨', 63: '🌧️ 中雨', 65: '🌧️ 大雨',
  66: '🌧️ 冻雨', 67: '🌧️ 强冻雨',
  71: '🌨️ 小雪', 73: '🌨️ 中雪', 75: '❄️ 大雪',
  77: '🌨️ 雪粒',
  80: '🌦️ 小阵雨', 81: '🌧️ 中阵雨', 82: '🌧️ 大阵雨',
  85: '🌨️ 小阵雪', 86: '🌨️ 大阵雪',
  95: '⛈️ 雷暴', 96: '⛈️ 雷暴冰雹', 99: '⛈️ 强雷暴冰雹'
};

async function geocode(location) {
  const url = `${GEO_API}?name=${encodeURIComponent(location)}&count=1&language=zh`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    return { error: `找不到位置: ${location}` };
  }
  const r = data.results[0];
  return { name: r.name, country: r.country, admin1: r.admin1, latitude: r.latitude, longitude: r.longitude };
}

async function fetchWeather(lat, lon, { forecastDays = 1, hourly = false } = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,pressure_msl',
    timezone: 'auto',
    forecast_days: forecastDays
  });
  if (forecastDays > 1) {
    params.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max');
  }
  if (hourly) {
    params.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code');
  }
  const res = await fetch(`${WEATHER_API}?${params}`);
  return await res.json();
}

function formatWeather(loc, data) {
  const c = data.current;
  const lines = [
    `🌤 天气预报`,
    `📍 ${loc.name}${loc.admin1 ? `, ${loc.admin1}` : ''}${loc.country ? `, ${loc.country}` : ''}`,
    `🕐 ${c.time}`,
    `━━━━━━━━━━━━━━━━`,
    `🌡 体感 ${c.apparent_temperature}°C  实际 ${c.temperature_2m}°C`,
    `💧 湿度 ${c.relative_humidity_2m}%`,
    `💨 风速 ${c.wind_speed_10m} km/h (${c.wind_direction_10m}°)`,
    `🌪 阵风 ${c.wind_gusts_10m} km/h`,
    `🌡 ${(WEATHER_CODES[c.weather_code] || `天气代码 ${c.weather_code}`)}`,
    `🔵 气压 ${c.pressure_msl} hPa`
  ];

  if (data.daily) {
    const d = data.daily;
    lines.push('');
    lines.push('📅 未来几天:');
    const maxDays = Math.min(d.time.length, 7);
    for (let i = 1; i < maxDays; i++) {
      const date = new Date(d.time[i]).toLocaleDateString('zh-CN', { weekday: 'short', month: 'numeric', day: 'numeric' });
      const icon = WEATHER_CODES[d.weather_code[i]] || '?';
      lines.push(`  ${date}  ${icon}  ${d.temperature_2m_min[i]}°C ~ ${d.temperature_2m_max[i]}°C  降水 ${d.precipitation_sum[i]}mm`);
    }
  }

  if (data.hourly) {
    const h = data.hourly;
    const now = new Date(c.time);
    const nowHour = now.getHours();
    lines.push('');
    lines.push('⏰ 逐时预报 (未来12小时):');
    for (let i = nowHour; i < Math.min(nowHour + 12, h.time.length); i++) {
      const hour = new Date(h.time[i]).getHours();
      const icon = WEATHER_CODES[h.weather_code[i]] || '?';
      lines.push(`  ${hour.toString().padStart(2, '0')}:00  ${icon}  ${h.temperature_2m[i]}°C  降水概率 ${h.precipitation_probability[i]}%`);
    }
  }

  return lines.join('\n');
}

export async function searchWeather(query) {
  if (!query) {
    return { error: '请输入城市名称，例如："北京" 或 "Tokyo"' };
  }

  const loc = await geocode(query);
  if (loc.error) return { error: loc.error };

  const data = await fetchWeather(loc.latitude, loc.longitude, { forecastDays: 7, hourly: true });

  if (data.error) {
    return { error: `天气数据获取失败: ${data.error}` };
  }

  const text = formatWeather(loc, data);

  return {
    title: `${loc.name} 天气`,
    content: text,
    location: loc,
    current: data.current,
    daily: data.daily,
    hourly: data.hourly,
    source: 'open-meteo.com'
  };
}
