import { fetch, ProxyAgent } from 'undici';
import { hostIsPrivate, assertPublicHost } from './ssrf.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0'
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9',
  'zh-CN,zh;q=0.9,en-US;q=0.8',
  'zh-TW,zh;q=0.9,en-US;q=0.8'
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomAcceptLanguage() {
  return ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];
}

export function createHeaders(extra = {}, forGoogle = false) {
  const ua = randomUserAgent();
  const base = {
    'user-agent': ua,
    'accept-language': randomAcceptLanguage(),
    ...extra
  };
  if (forGoogle) {
    base['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
    base['accept-encoding'] = 'gzip, deflate, br';
    base['cache-control'] = 'no-cache';
    base['sec-ch-ua'] = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126", "WebKit";v="126"';
    base['sec-ch-ua-mobile'] = '?0';
    base['sec-ch-ua-platform'] = '"Windows"';
    base['sec-fetch-dest'] = 'document';
    base['sec-fetch-mode'] = 'navigate';
    base['sec-fetch-site'] = 'none';
    base['sec-fetch-user'] = '?1';
    base['upgrade-insecure-requests'] = '1';
  }
  return { ...DEFAULT_HEADERS, ...base };
}

export const DEFAULT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
};

function isInternalHost(hostname) {
  if (!hostname) return true;
  return hostIsPrivate(hostname);
}

export async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = 15000, proxyUrl = null, headers = {}, method = 'GET', body } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    const init = {
      method,
      headers: createHeaders(headers),
      signal: controller.signal,
      redirect: 'manual'
    };
    if (body !== undefined && body !== null) {
      init.body = body;
      if (typeof body === 'string' && !init.headers['content-type']) {
        init.headers['content-type'] = 'application/json';
      }
    }
    if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
      init.dispatcher = new ProxyAgent(proxyUrl);
    }
    // DNS-rebinding guard: resolve the target hostname and refuse if it maps to
    // a private/reserved address. Applied before the initial request and before
    // every redirect hop.
    await assertPublicHost(currentUrl);
    let resp = await fetch(currentUrl, init);
    let redirectCount = 0;
    while (resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307 || resp.status === 308) {
      redirectCount++;
      if (redirectCount > 10) throw new Error(`Too many redirects (${redirectCount})`);
      const location = resp.headers.get('location');
      if (!location) break;
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`Invalid redirect location: ${location}`);
      }
      if (isInternalHost(nextUrl.hostname)) {
        throw Object.assign(new Error(`Redirect to internal address blocked: ${nextUrl.hostname}`), { code: 'SSRF_REDIRECT_BLOCKED' });
      }
      currentUrl = nextUrl.toString();
      await assertPublicHost(currentUrl);
      resp = await fetch(currentUrl, { ...init, method: 'GET', body: undefined });
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export function contentTypeOf(resp) {
  return (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

export async function readBodyBounded(resp, { maxBytes = 8 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  const body = resp.body;
  if (!body) return '';
  let timerId;
  const timeoutP = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      if (typeof body.cancel === 'function') body.cancel().catch(() => {});
      reject(Object.assign(new Error(`body read timed out after ${timeoutMs}ms`), { code: 'BODY_TIMEOUT' }));
    }, timeoutMs);
    if (typeof timerId?.unref === 'function') timerId.unref();
  });
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let total = 0;
        for await (const chunk of body) {
          total += chunk.length;
          if (total > maxBytes) {
            if (typeof body.cancel === 'function') body.cancel().catch(() => {});
            throw Object.assign(new Error(`response body exceeds ${maxBytes} bytes`), { code: 'BODY_TOO_LARGE' });
          }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
      })(),
      timeoutP
    ]);
  } finally {
    clearTimeout(timerId);
  }
}