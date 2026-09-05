import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

function envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

let lastRequestTime = 0;
let rateLimitTail = Promise.resolve();
const MIN_INTERVAL_MS = envInt('GOOGLE_MIN_INTERVAL_MS', 3000, 0);

function randomDelay(minMs = 500, maxMs = 2000) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

function rateLimitWait() {
  const job = rateLimitTail.then(async () => {
    const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();
  });
  rateLimitTail = job.then(() => {}, () => {});
  return job;
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

export async function searchGoogle(query, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit || CONFIG.defaultSearchLimit)));
  return await searchGoogleBrowser(query, { ...opts, limit });
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
