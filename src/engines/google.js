import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;
const ENABLE_GOOGLE_API_FALLBACK = process.env.ENABLE_GOOGLE_API_FALLBACK === 'true';

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 3000;

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

async function extractSearchResults(page, limit) {
  const html = await page.content();
  if (isLikelyBlockedText(html)) throw new SearchEngineError('ENGINE_BLOCKED', 'Google appears blocked/captcha');
  return parseGoogleHtml(html, limit);
}

async function searchGoogleApi(query, limit) {
  if (!GOOGLE_API_KEY) return [];
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${limit}`;
  const resp = await fetchWithTimeout(url, { timeoutMs: CONFIG.defaultTimeoutMs });
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => ({}));
  if (!data.items || !Array.isArray(data.items)) return [];
  return data.items.map((item, i) => makeResult({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    engine: 'google',
    rank: i + 1
  }));
}

export async function searchGoogle(query, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit || CONFIG.defaultSearchLimit)));
  
  const results = await searchGoogleBrowser(query, { ...opts, limit });
  if (results.length > 0) return results;

  if (ENABLE_GOOGLE_API_FALLBACK) {
    const apiResults = await searchGoogleApi(query, limit);
    if (apiResults.length > 0) return apiResults;
  }
  
  throw new SearchEngineError('ENGINE_BLOCKED', 'Google search failed in the Chromium browser session');
}

export async function searchGoogleBrowser(query, opts = {}) {
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  
  await rateLimitWait();
  
  const proxyProfile = opts.proxyProfile || 'direct';
  
  let lastError = null;
  const retries = 2;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await opts.browserPool.withPage({
        proxyProfile,
        url: 'https://google.com',
        sessionKey: 'google',
        reuseSession: true
      }, async (page) => {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`, { 
          waitUntil: 'domcontentloaded', 
          timeout: 45000 
        });
        await page.waitForTimeout(randomDelay(2000, 4000));
        
        const html = await page.content();
        if (isLikelyBlockedText(html)) {
          throw new SearchEngineError('ENGINE_BLOCKED', 'Google appears blocked/captcha in the Chromium browser session', {
            session: 'google',
            current_url: page.url(),
            retry_hint: 'Open the google session in noVNC, complete the human verification in the visible Chromium, then retry.'
          });
        }
        
        const parsed = parseGoogleHtml(html, limit);
        if (parsed.length === 0) {
          throw new SearchEngineError('SERP_PARSE_FAILED', 'Google returned no results from the Chromium browser session', {
            session: 'google',
            current_url: page.url()
          });
        }
        return parsed;
      });
    } catch (err) {
      lastError = err;
      if (err.code === 'ENGINE_BLOCKED' || err.code === 'BROWSER_UNAVAILABLE') break;
    }
  }
  
  throw lastError || new SearchEngineError('ENGINE_BLOCKED', 'Google failed');
}

function parseGoogleHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('a').each((i, el) => {
    const h3 = $(el).find('h3').first();
    if (!h3.length) return;
    const title = normalizeWhitespace(h3.text());
    let href = stripTrackingUrl($(el).attr('href'));
    href = canonicalUrl(href);
    if (!title || !/^https?:\/\//.test(href || '')) return;
    const block = $(el).parent().parent().parent();
    const snippet = normalizeWhitespace(block.text().replace(title, '').slice(0, 500));
    results.push(makeResult({ title, url: href, snippet, engine: 'google', rank: results.length + 1 }));
  });
  return uniqueByUrl(results, limit).slice(0, limit);
}
