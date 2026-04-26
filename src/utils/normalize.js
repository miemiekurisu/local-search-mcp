export function normalizeWhitespace(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/(\n[ \t]*){2,}/g, '\n')
    .trim();
}

export function truncateText(s, maxChars = 12000) {
  const text = String(s || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars)) + `\n[TRUNCATED ${text.length - maxChars} chars]`;
}

export function stripTrackingUrl(url) {
  if (!url) return url;
  try {
    if (url.startsWith('/url?')) {
      const u = new URL('https://www.google.com' + url);
      return u.searchParams.get('q') || url;
    }
    if (url.includes('/url?')) {
      const u = new URL(url, 'https://www.google.com');
      return u.searchParams.get('q') || url;
    }
    return url;
  } catch {
    return url;
  }
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ved', 'usg']) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function isLikelyBlockedText(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('unusual traffic') ||
    t.includes('captcha') ||
    t.includes('verify you are human') ||
    t.includes('access denied') ||
    t.includes('too many requests') ||
    t.includes('temporarily unavailable') ||
    t.includes('robot check') ||
    t.includes('are you a robot');
}

export function uniqueByUrl(items, limit = 20) {
  const filtered = filterBlockedDomains(items);
  const seen = new Set();
  const out = [];
  for (const item of filtered) {
    const key = canonicalUrl(item.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const BLOCKED_DOMAINS = [
  'baidu.com',
  'csdn.net',
  'csdn.blog',
  'aiqiyi.com',
  'youku.com',
  'iqiyi.com',
  'nipic.com',
  'so.com',
  'sogou.com',
  'zhihu.com',
  'toutiao.com',
  'SegmentFault',
  'jianshu.com',
  'cnblogs.com',
  'aliyun.com',
  'tencent.com',
  'cloudflare',
  'security.verizon'
];

export function filterBlockedDomains(items) {
  return items.filter(item => {
    const host = hostOf(item.url || '');
    return !BLOCKED_DOMAINS.some(d => host.includes(d));
  });
}
