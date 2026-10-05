import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';
import { abortError } from '../utils/abort.js';

// DuckDuckGo now runs through the real Chromium (Playwright/CDP) instead of a raw
// HTTP fetch, matching the persistent-browser approach used for Google. This keeps a real
// browser fingerprint and reuses the existing browser pool / proxy routing.
//
// NOTE: this file keeps its historical "duckduckgo_http" filename for a smaller
// diff / easier rollback; the engine id exposed to callers stays 'duckduckgo'.

let lastRequestTime = 0;
let rateLimitTail = Promise.resolve();
const MIN_INTERVAL_MS = 2000;
// Bound for the global DDG wait queue. Each waiting client already holds an MCP
// tool call (and often an HTTP socket); letting hundreds of them pile up behind a
// 2s spacing turns one slow stretch into a wall of engine timeouts. Overflow is
// refused immediately so clients can fall back to another engine instead.
const MAX_RATE_LIMIT_WAITERS = Math.max(1, Number(process.env.DUCKDUCKGO_MAX_QUEUED) || 8);
let rateLimitQueued = 0;

function randomDelay(minMs = 500, maxMs = 2000) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

function delayOrAbort(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

// Global 2s spacing between DuckDuckGo visits. The tail used to be unbounded and
// uncancellable: every client queued behind all previous ones, and a client whose
// caller had already given up still took its turn and still slept the full
// interval. Now the queue has a ceiling and each waiter bails out as soon as its
// caller stops listening, handing the turn to the next client immediately.
async function rateLimitWait(signal = null) {
  if (signal?.aborted) throw abortError(signal, 'DuckDuckGo rate-limit wait aborted');
  if (rateLimitQueued >= MAX_RATE_LIMIT_WAITERS) {
    throw new SearchEngineError(
      'DDG_THROTTLED',
      `DuckDuckGo throttle queue is full (${rateLimitQueued} waiting for a ${MIN_INTERVAL_MS}ms slot)`,
      { engine: 'duckduckgo', retry_hint: 'Retry in a few seconds, drop duckduckgo from engines[], or raise DUCKDUCKGO_MAX_QUEUED on a bigger machine.' }
    );
  }
  rateLimitQueued++;
  try {
    const job = rateLimitTail.then(async () => {
      if (signal?.aborted) return; // caller gone before our turn: skip the sleep
      const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - Date.now());
      if (wait > 0) await delayOrAbort(wait, signal);
      if (signal?.aborted) return;
      lastRequestTime = Date.now();
    });
    rateLimitTail = job.then(() => {}, () => {});
    await job;
  } finally {
    rateLimitQueued--;
  }
}

// The HTML endpoint is lightweight even inside a real browser and keeps the same stable
// selectors (.result__a / .result__snippet), independent of DuckDuckGo's rotating
// class names on the JS-rendered SERP.
async function parseHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result, .web-result').each((i, el) => {
    const a = $(el).find('.result__a').first();
    let href = a.attr('href');
    const title = normalizeWhitespace(a.text());
    const snippet = normalizeWhitespace($(el).find('.result__snippet').text() || $(el).find('.result__body').text());
    if (href?.startsWith('//duckduckgo.com/l/?')) {
      try { href = new URL('https:' + href).searchParams.get('uddg') || href; } catch {}
    }
    href = canonicalUrl(stripTrackingUrl(href));
    if (title && /^https?:\/\//.test(href || '')) results.push(makeResult({ title, url: href, snippet, engine: 'duckduckgo', rank: results.length + 1 }));
  });
  const unique = uniqueByUrl(results, limit);
  return unique.slice(0, limit);
}

export async function searchDuckDuckGo(query, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit || CONFIG.defaultSearchLimit)));
  const proxyProfile = opts.proxyProfile || 'direct';

  if (!opts.browserPool) {
    throw new SearchEngineError('BROWSER_UNAVAILABLE', 'DuckDuckGo now requires the Chromium browser pool', { engine: 'duckduckgo' });
  }

  // opts may come straight off an HTTP/MCP body, so only trust real signals.
  const signal = opts.signal instanceof AbortSignal ? opts.signal : null;
  await rateLimitWait(signal);

  return await opts.browserPool.withPage({
    proxyProfile,
    url: 'https://html.duckduckgo.com',
    closeDelayMs: [1500, 4000],
    signal
  }, async (page) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs || CONFIG.browserTimeoutMs || 45000 });

    // Small random settle so the page "loads" like a human visit before closing —
    // but only while nobody else is queued for a page. On a busy low-power device
    // this 0.8-2.5s plus the post-parse "glance" is pure queue delay: the SERP is
    // already parsed and the next client is idling. BROWSER_SIMULATE_BROWSING=false
    // removes them entirely.
    const contended = typeof opts.browserPool.isContended === 'function' && opts.browserPool.isContended();
    if (!contended) await page.waitForTimeout(randomDelay(800, 2500));

    const html = await page.content();
    if (isLikelyBlockedText(html)) {
      throw new SearchEngineError('ENGINE_BLOCKED', 'DuckDuckGo appears blocked/captcha in Chromium', { engine: 'duckduckgo' });
    }

    const results = await parseHtml(html, limit);
    if (results.length === 0) {
      throw new SearchEngineError('SERP_PARSE_FAILED', 'DuckDuckGo returned no parseable results in Chromium');
    }

    // Brief human-like glance before the pool closes the page.
    if (!contended) {
      try {
        await page.mouse.wheel(0, randomDelay(120, 400));
        await page.waitForTimeout(randomDelay(400, 1400));
      } catch {}
    }

    return results;
  });
}
