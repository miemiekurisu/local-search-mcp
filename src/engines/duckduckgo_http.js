import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 2000;

function randomDelay(minMs = 200, maxMs = 1000) {
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

export async function searchDuckDuckGoHttp(query, opts = {}) {
  await rateLimitWait();
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  const proxy = opts.proxyRouter?.resolve(opts.proxyProfile || 'auto', 'https://html.duckduckgo.com')?.proxyUrl;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs || CONFIG.defaultTimeoutMs, proxyUrl: proxy });
  const html = await resp.text();
  if (!resp.ok) throw new SearchEngineError('ENGINE_HTTP_ERROR', `DuckDuckGo HTTP ${resp.status}`, { status: resp.status });
  if (isLikelyBlockedText(html)) throw new SearchEngineError('ENGINE_BLOCKED', 'DuckDuckGo appears blocked/captcha');
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
  if (results.length === 0) {
    // Lite fallback is less pretty but often works when the html endpoint changes.
    return await searchDuckDuckGoLite(query, opts);
  }
  return uniqueByUrl(results, limit).slice(0, limit);
}

async function searchDuckDuckGoLite(query, opts = {}) {
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  const proxy = opts.proxyRouter?.resolve(opts.proxyProfile || 'auto', 'https://lite.duckduckgo.com')?.proxyUrl;
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs || CONFIG.defaultTimeoutMs, proxyUrl: proxy });
  const html = await resp.text();
  if (!resp.ok) throw new SearchEngineError('ENGINE_HTTP_ERROR', `DuckDuckGo Lite HTTP ${resp.status}`, { status: resp.status });
  if (isLikelyBlockedText(html)) throw new SearchEngineError('ENGINE_BLOCKED', 'DuckDuckGo Lite appears blocked/captcha');
  const $ = cheerio.load(html);
  const results = [];
  $('a[href]').each((i, el) => {
    let href = $(el).attr('href');
    const title = normalizeWhitespace($(el).text());
    if (!title || !href) return;
    if (href.includes('/l/?')) {
      try { href = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') || href; } catch {}
    }
    href = canonicalUrl(stripTrackingUrl(href));
    if (/^https?:\/\//.test(href) && !href.includes('duckduckgo.com')) {
      results.push(makeResult({ title, url: href, snippet: '', engine: 'duckduckgo_lite', rank: results.length + 1 }));
    }
  });
  if (results.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', 'DuckDuckGo returned no parseable results');
  return uniqueByUrl(results, limit).slice(0, limit);
}
