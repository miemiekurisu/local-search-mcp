import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

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

async function humanScroll(page) {
  const scrollCount = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < scrollCount; i++) {
    await page.mouse.wheel(Math.random() * 200 - 100, Math.random() * 300 + 100);
    await page.waitForTimeout(randomDelay(200, 800));
  }
}

async function humanMove(page, startX, startY, endX, endY) {
  const steps = 5 + Math.floor(Math.random() * 10);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = startX + (endX - startX) * t + (Math.random() * 20 - 10);
    const y = startY + (endY - startY) * t + (Math.random() * 20 - 10);
    await page.mouse.move(x, y);
    await page.waitForTimeout(randomDelay(10, 50));
  }
}

async function randomClick(page) {
  const box = await page.$('#search') || await page.$('html');
  if (box) {
    const rect = await box.boundingBox();
    if (rect) {
      const x = rect.x + Math.random() * rect.width;
      const y = rect.y + Math.random() * 100;
      await page.mouse.click(x, y);
    }
  }
}

async function initGoogleSession(page) {
  await page.goto('https://www.google.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(randomDelay(1000, 2500));
  if (page.url().includes('sorry')) throw new SearchEngineError('ENGINE_BLOCKED', 'Google IP blocked');
}

async function typeAndSearch(page, query, limit) {
  const searchBox = await page.$('input[name="q"]');
  if (searchBox) {
    await searchBox.click();
    await page.waitForTimeout(randomDelay(100, 300));
    await searchBox.fill('');
    await page.waitForTimeout(randomDelay(50, 150));
    await searchBox.type(query, { delay: randomDelay(50, 150) });
    await page.waitForTimeout(randomDelay(100, 300));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(randomDelay(1500, 3000));
  } else {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(randomDelay(1500, 3000));
  }
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
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  
  const results = await searchGoogleBrowser(query, { ...opts, limit });
  if (results.length > 0) return results;
  
  const apiResults = await searchGoogleApi(query, limit);
  if (apiResults.length > 0) return apiResults;
  
  throw new SearchEngineError('ENGINE_BLOCKED', 'Google search failed (browser + API fallback exhausted)');
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
        if (isLikelyBlockedText(html)) throw new SearchEngineError('ENGINE_BLOCKED', 'Google appears blocked/captcha');
        
        const parsed = parseGoogleHtml(html, limit);
        if (parsed.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', 'Google returned no results');
        return parsed;
      });
    } catch (err) {
      lastError = err;
      if (err.code === 'ENGINE_BLOCKED') break;
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
