const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function isUtcQuery(q) {
  return /^(utc|epoch|unix|timestamp|unixtime)/i.test(q);
}

export function getCurrentTime(query) {
  const now = new Date();

  let tz = TIMEZONE;
  let lang = 'zh-CN';

  if (query) {
    const q = query.trim().toLowerCase();

    if (isUtcQuery(q)) {
      tz = 'UTC';
    } else if (/[\u4e00-\u9fff]/.test(query)) {
      lang = 'zh-CN';
    } else if (/[\u3040-\u309f\u30a0-\u30ff]/.test(query)) {
      lang = 'ja-JP';
    } else if (/jp|japan|tokyo/i.test(q)) {
      tz = 'Asia/Tokyo';
    } else if (/us|america|new york|la|chicago/i.test(q)) {
      tz = 'America/New_York';
      lang = 'en-US';
    } else if (/uk|britain|london|gmt/i.test(q)) {
      tz = 'Europe/London';
      lang = 'en-GB';
    } else if (/cn|china|beijing|shanghai|guangzhou|shenzhen|hangzhou/i.test(q)) {
      tz = 'Asia/Shanghai';
    } else if (/kr|korea|seoul/i.test(q)) {
      tz = 'Asia/Seoul';
    } else if (/ru|russia|moscow/i.test(q)) {
      tz = 'Europe/Moscow';
    } else if (/india|mumbai|delhi|kolkata/i.test(q)) {
      tz = 'Asia/Kolkata';
    } else if (/^en\b/i.test(q) || /^english/i.test(q)) {
      lang = 'en-US';
    }
  }

  const fmt = new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long'
  });

  const dateFmt = new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
    fractionalSecondDigits: 3
  });

  const display = fmt.format(now);
  const utcStr = now.toISOString();
  const epoch = Math.floor(now.getTime() / 1000);

  const lines = [];
  lines.push(`🕐 当前时间 (${tz})`);
  lines.push(`  ${display}`);
  lines.push(`  UTC: ${utcStr}`);
  lines.push(`  Unix: ${epoch}`);
  lines.push('');
  lines.push(`系统时区: ${TIMEZONE} | 查询时区: ${tz}`);
  if (query) lines.push(`查询: "${query}"`);
  lines.push(`数据: 服务器本地时钟`);

  return {
    title: '当前时间',
    content: lines.join('\n'),
    timezone: tz,
    utc: utcStr,
    epoch,
    display
  };
}
