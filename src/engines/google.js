import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;
const ENABLE_GOOGLE_API_FALLBACK = process.env.ENABLE_GOOGLE_API_FALLBACK === 'true';

function envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

let lastRequestTime = 0;
const MIN_INTERVAL_MS = envInt('GOOGLE_MIN_INTERVAL_MS', 3000, 0);

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

function blockedError(page) {
  // Treated as a normal HUMAN_REQUIRED state, not a browser crash. Do NOT reset the
  // profile, clear cookies, or open a second browser. keepPageOpen=true keeps the
  // verification page alive in the persistent Chromium so the user can finish it via noVNC.
  const err = new SearchEngineError('ENGINE_BLOCKED', 'Google requires human verification (CAPTCHA/robot check)', {
    session: 'google',
    reason: 'captcha_or_robot_verification',
    recovery: 'novnc',
    retryable: true,
    current_url: page.url(),
    retry_hint: 'Open the google session in noVNC, complete the human verification in the visible Chromium, then retry. Do not reset the profile or clear cookies.'
  });
  err.keepPageOpen = true;
  return err;
}

function emptyResultsError(page) {
  return new SearchEngineError('SERP_PARSE_FAILED', 'Google returned no results from the Chromium browser session', {
    session: 'google',
    current_url: page.url()
  });
}

async function typeLikeHuman(page, text) {
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: randomDelay(40, 110) });
    const roll = Math.random();
    if (roll < 0.08) {
      await page.waitForTimeout(randomDelay(80, 250));
    } else if (roll < 0.12) {
      await page.waitForTimeout(randomDelay(350, 900));
    }
  }
}

async function searchViaHomepage(page, query, limit) {
  await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(randomDelay(1500, 4000));

  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.waitFor({ state: 'visible', timeout: 20000 });
  await searchBox.click();
  await page.waitForTimeout(randomDelay(300, 900));
  await typeLikeHuman(page, query);
  await page.waitForTimeout(randomDelay(400, 1200));
  await page.keyboard.press('Enter');
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
  await page.waitForTimeout(randomDelay(2500, 5000));

  const html = await page.content();
  if (isLikelyBlockedText(html)) throw blockedError(page);
  return parseGoogleHtml(html, limit);
}

async function searchViaDirectUrl(page, query, limit) {
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  await page.waitForTimeout(randomDelay(2000, 4000));
  return extractSearchResults(page, limit);
}

async function humanGlance(page) {
  await page.mouse.move(randomDelay(300, 1400), randomDelay(200, 900), { steps: 5 });
  await page.waitForTimeout(randomDelay(400, 1200));
  await page.mouse.wheel(0, randomDelay(200, 500));
  await page.waitForTimeout(randomDelay(600, 1500));
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
        url: 'https://www.google.com',
        sessionKey: 'google',
        reuseSession: true,
        closeDelayMs: [7000, 12000],
        timeoutMs: 140000
      }, async (page) => {
        let parsed;
        try {
          parsed = await searchViaHomepage(page, query, limit);
        } catch (err) {
          if (err.code === 'ENGINE_BLOCKED') throw err;
          parsed = [];
        }
        if (parsed.length === 0) {
          parsed = await searchViaDirectUrl(page, query, limit);
        }
        if (parsed.length === 0) {
          throw emptyResultsError(page);
        }
        await humanGlance(page);
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
