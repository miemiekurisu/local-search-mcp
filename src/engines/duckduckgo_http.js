import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

// DuckDuckGo now runs through the real Chromium (Playwright/CDP) instead of a raw
// HTTP fetch, matching the persistent-browser approach used for Google. This keeps a real
// browser fingerprint and reuses the existing browser pool / proxy routing.
//
// NOTE: this file keeps its historical "duckduckgo_http" filename for a smaller
// diff / easier rollback; the engine id exposed to callers stays 'duckduckgo'.

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 2000;

function randomDelay(minMs = 500, maxMs = 2000) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
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
  return uniqueByUrl(results, limit).slice(0, limit);
}

export async function searchDuckDuckGo(query, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit || CONFIG.defaultSearchLimit)));
  const proxyProfile = opts.proxyProfile || 'direct';

  if (!opts.browserPool) {
    throw new SearchEngineError('BROWSER_UNAVAILABLE', 'DuckDuckGo now requires the Chromium browser pool', { engine: 'duckduckgo' });
  }

  await rateLimitWait();

  return await opts.browserPool.withPage({
    proxyProfile,
    url: 'https://html.duckduckgo.com',
    closeDelayMs: [1500, 4000]
  }, async (page) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs || CONFIG.browserTimeoutMs || 45000 });

    // Small random settle so the page "loads" like a human visit before closing.
    await page.waitForTimeout(randomDelay(800, 2500));

    const html = await page.content();
    if (isLikelyBlockedText(html)) {
      throw new SearchEngineError('ENGINE_BLOCKED', 'DuckDuckGo appears blocked/captcha in Chromium', { engine: 'duckduckgo' });
    }

    const results = parseHtml(html, limit);
    if (results.length === 0) {
      throw new SearchEngineError('SERP_PARSE_FAILED', 'DuckDuckGo returned no parseable results in Chromium');
    }

    // Brief human-like glance before the pool closes the page.
    try {
      await page.mouse.wheel(0, randomDelay(120, 400));
      await page.waitForTimeout(randomDelay(400, 1400));
    } catch {}

    return results;
  });
}
