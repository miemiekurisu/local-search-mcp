import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';
import { abortError, signalRemainingMs } from '../utils/abort.js';

// DuckDuckGo now runs through the real Chromium (Playwright/CDP) instead of a raw
// HTTP fetch, matching the persistent-browser approach used for Google. This keeps a real
// browser fingerprint and reuses the existing browser pool / proxy routing.
//
// NOTE: this file keeps its historical "duckduckgo_http" filename for a smaller
// diff / easier rollback; the engine id exposed to callers stays 'duckduckgo'.

let lastRequestTime = 0;
let rateLimitTail = Promise.resolve();
// Same knob shape as GOOGLE_MIN_INTERVAL_MS: the spacing exists to stay polite to a
// rate limiter that now actively challenges shared egress IPs, so an operator on a
// quiet residential line (or a test suite) may want it shorter, not longer.
function envInt(name, fallback, min) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.max(min, Math.trunc(raw)) : fallback;
}
const MIN_INTERVAL_MS = envInt('DUCKDUCKGO_MIN_INTERVAL_MS', 2000, 0);
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

// DuckDuckGo answers the same query in three shapes. Measured from this deployment
// (one query, one proxy profile, real Chromium):
//   duckduckgo.com/?q=          200, ~172 KB, 10 results  article + [data-result="snippet"]
//   html.duckduckgo.com/html/   200, ~30 KB,   8 results  .result__a
//   lite.duckduckgo.com/lite/   200, ~22 KB,  10 results  a.result-link
//
// The main site is the default because it is the endpoint DuckDuckGo itself points
// crawlers at: its robots.txt carries "Disallow: /lite", "Disallow: /html" and then,
// immediately after "Disallow: /*?", an "Allow: /?*" - the root SERP is the sanctioned
// URL, the two cheap endpoints are the ones it is trying to retire. That is also where
// the blocks land (a shared egress got HTTP 202 on 8/8 plain-HTTP tries against /html,
// while a real browser kept getting 200), and /html plus /lite are Bing-backed - the
// ddgs project labels its DuckDuckGo text engine provider="bing" for exactly that
// reason - so they mostly duplicate the bing engine instead of adding coverage.
//
// The price is ~6x the bytes plus client-side rendering, which is real CPU on a
// one-slot ARM box, so while somebody is queued for a page the ladder runs cheapest
// first: when the scarce resource is the page slot a short hold matters more than the
// sanctioned URL, and main still answers when both cheap hops are blocked (measured on
// this deployment: /html answered 202 while /lite and the main SERP answered 200).
// DUCKDUCKGO_ENDPOINTS overrides the idle order - "html,lite" never touches the main
// site, "main" turns the ladder off.
const ENDPOINTS = {
  main: (q) => ({
    id: 'main',
    url: `https://duckduckgo.com/?q=${q}&ia=web`,
    parse: parseMainEndpoint,
    // Results render client-side, so domcontentloaded can beat the first <article>.
    waitFor: 'a[data-testid="result-title-a"]'
  }),
  html: (q) => ({ id: 'html', url: `https://html.duckduckgo.com/html/?q=${q}`, parse: parseHtmlEndpoint }),
  lite: (q) => ({ id: 'lite', url: `https://lite.duckduckgo.com/lite/?q=${q}`, parse: parseLiteEndpoint })
};
const DEFAULT_ENDPOINTS = ['main', 'html', 'lite'];

// Unknown ids are dropped rather than trusted: this arrives from an env var (and the
// env is the last place a typo should silently disable a whole endpoint).
function endpointOrder(raw = process.env.DUCKDUCKGO_ENDPOINTS) {
  const ids = String(raw || '').split(',').map((id) => id.trim().toLowerCase()).filter((id) => ENDPOINTS[id]);
  return ids.length ? [...new Set(ids)] : [...DEFAULT_ENDPOINTS];
}

// Under load the ladder runs cheapest-first by measured SERP size (lite ~22 KB, html
// ~30 KB, main ~172 KB). Main is the heaviest hop and the only client-rendered one, so
// it holds a scarce slot longest; /html is the hop that answers 202 from a shared
// egress, so it is not first either. Array#sort is stable, so ids an operator adds keep
// their relative order.
const CHEAPNESS = { lite: 0, html: 1, main: 2 };
function idleOrderToContended(ids) {
  return [...ids].sort((a, b) => (CHEAPNESS[a] ?? 9) - (CHEAPNESS[b] ?? 9));
}

// A navigation that cannot finish inside the engine's remaining budget only occupies
// the page slot on someone else's behalf, so an attempt under this is not started.
const MIN_ATTEMPT_BUDGET_MS = 4000;

function unwrapDuckDuckGoLink(href) {
  if (href?.startsWith('//duckduckgo.com/l/?')) {
    try { href = new URL('https:' + href).searchParams.get('uddg') || href; } catch {}
  }
  return canonicalUrl(stripTrackingUrl(href));
}

function pushResult(results, title, href, snippet) {
  const url = unwrapDuckDuckGoLink(href);
  if (title && /^https?:\/\//.test(url || '')) {
    results.push(makeResult({ title, url, snippet, engine: 'duckduckgo', rank: results.length + 1 }));
  }
}

// The HTML endpoint stays the default: it is cheap even inside a real browser and
// keeps stable selectors (.result__a / .result__snippet), independent of the
// rotating class names on the JS-rendered main SERP.
function parseHtmlEndpoint(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result, .web-result').each((i, el) => {
    const a = $(el).find('.result__a').first();
    const snippet = $(el).find('.result__snippet').text() || $(el).find('.result__body').text();
    pushResult(results, normalizeWhitespace(a.text()), a.attr('href'), normalizeWhitespace(snippet));
  });
  return uniqueByUrl(results, limit).slice(0, limit);
}

// lite.duckduckgo.com renders the SERP as a table where .result-link and
// .result-snippet are sibling rows, so snippets are matched positionally (both held
// exactly one entry per result). A missing snippet can only shift snippet text,
// never a url.
function parseLiteEndpoint(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  const snippets = $('.result-snippet');
  $('a.result-link').each((i, el) => {
    const a = $(el);
    pushResult(results, normalizeWhitespace(a.text()), a.attr('href'), normalizeWhitespace(snippets.eq(i).text()));
  });
  return uniqueByUrl(results, limit).slice(0, limit);
}

// The main SERP carries data-testid hooks instead of hashed class names, and links
// are already direct, so nothing has to be unwrapped.
function parseMainEndpoint(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('article').each((i, el) => {
    const a = $(el).find('a[data-testid="result-title-a"]').first();
    if (!a.length) return;
    const snippet = $(el).find('[data-result="snippet"]').first().text();
    pushResult(results, normalizeWhitespace(a.text()), a.attr('href'), normalizeWhitespace(snippet));
  });
  return uniqueByUrl(results, limit).slice(0, limit);
}

// A DuckDuckGo soft block answers HTTP 202 with a ~14 KB challenge page. 202 is a
// 2xx status, so a status check alone never fires and the body parses to zero
// results - upstream then reads "no parseable results" and blames the parser. The
// same challenge also arrives as 403/429, and on the main site it arrives as a plain
// 200, so the status, the emptiness and the body markers are all checked together.
function serpBlockSignal(status, html) {
  if (status === 429) return 'HTTP 429 (rate limited)';
  if (status === 403) return 'HTTP 403';
  if (status === 202) return 'HTTP 202 (soft rate limit / challenge)';
  if (!(html || '').trim()) return 'empty body';
  if (isLikelyBlockedText(html)) return 'challenge page';
  // anomaly-modal is the class the DuckDuckGo challenge markup carries. It stays here
  // instead of joining the shared isLikelyBlockedText markers, which also gate generic
  // page fetches: a blog post about captchas must not read as a blocked page.
  if (html.includes('anomaly-modal')) return 'anomaly-modal challenge';
  return null;
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
  const encoded = encodeURIComponent(query);

  // The ladder spans three DuckDuckGo hosts, so proxy and no-proxy resolution gets
  // the zone origin rather than one specific host that may not be visited first.
  return await opts.browserPool.withPage({
    proxyProfile,
    url: 'https://duckduckgo.com/',
    closeDelayMs: [1500, 4000],
    signal
  }, async (page) => {
    // Small random settle so the page "loads" like a human visit before closing —
    // but only while nobody else is queued for a page. On a busy low-power device
    // this 0.8-2.5s plus the post-parse "glance" is pure queue delay: the SERP is
    // already parsed and the next client is idling. BROWSER_SIMULATE_BROWSING=false
    // removes them entirely. It belongs to the first visit only: once an endpoint
    // has failed, paying it again per attempt would multiply the exact queue delay
    // this guard exists to avoid.
    const contended = typeof opts.browserPool.isContended === 'function' && opts.browserPool.isContended();
    const order = endpointOrder();
    const attempts = (contended ? idleOrderToContended(order) : order).map((id) => ENDPOINTS[id](encoded));

    const tried = [];
    const blocks = [];
    const errors = [];
    const empties = [];
    for (const attempt of attempts) {
      const remaining = signalRemainingMs(signal);
      if (remaining !== null && remaining < MIN_ATTEMPT_BUDGET_MS) break;
      const baseTimeout = opts.timeoutMs || CONFIG.browserTimeoutMs || 45000;
      const timeout = remaining === null ? baseTimeout : Math.max(1000, Math.min(baseTimeout, remaining));

      tried.push(attempt.id);
      let html = '';
      // The status/emptiness/challenge classification below runs after a navigation
      // that threw as well, so the status cannot be scoped inside the try.
      let status = null;
      try {
        const response = await page.goto(attempt.url, { waitUntil: 'domcontentloaded', timeout });
        if (attempt === attempts[0] && !contended) await page.waitForTimeout(randomDelay(800, 2500));
        if (attempt.waitFor) {
          // The main SERP paints its results after load. Give it a bounded head start
          // and then parse whatever is there anyway: a slow render should fall through
          // to the next endpoint, not spend the remaining budget on a selector.
          try {
            await page.waitForSelector?.(attempt.waitFor, { timeout: Math.max(1000, Math.min(8000, timeout - 1000)) });
          } catch {}
        }
        status = typeof response?.status === 'function' ? response.status() : null;
        html = await page.content();
      } catch (err) {
        // A cancelled or pool-killed task must not be swallowed by the ladder.
        if (signal?.aborted || err?.code === 'ABORTED' || err?.code === 'PAGE_TASK_TIMEOUT') throw err;
        // A slow or unreachable endpoint is a reason to try the next shape, not to
        // fail the engine: the main site is the heaviest of the three and the first
        // to time out on a weak device, while /html is a static page behind the same
        // browser. The block/empty classifications below still need a body, so record
        // the failure and move on.
        // Playwright call-log tails are multi-line; the engine message carries all three
        // hops, so only the first line of each failure belongs there.
        errors.push(`${attempt.id} ${String(err?.message || err).split('\n')[0]}`);
        continue;
      }

      const block = serpBlockSignal(status, html);
      if (block) {
        blocks.push(`${attempt.id} ${block}`);
        continue;
      }
      const results = attempt.parse(html, limit);
      if (results.length === 0) {
        empties.push(attempt.id);
        continue;
      }

      // Brief human-like glance before the pool closes the page.
      if (!contended) {
        try {
          await page.mouse.wheel(0, randomDelay(120, 400));
          await page.waitForTimeout(randomDelay(400, 1400));
        } catch {}
      }
      return results;
    }

    // Nothing was navigated: the caller deadline was already too close to start a
    // page. Calling that a parse failure would invent an outage the engine never had;
    // it is congestion/timeout, which is what the caller has to act on.
    if (!tried.length) {
      if (signal?.aborted) throw abortError(signal, 'DuckDuckGo aborted before any endpoint was tried');
      throw new SearchEngineError(
        'ENGINE_TIMEOUT',
        `DuckDuckGo was not attempted: under ${MIN_ATTEMPT_BUDGET_MS}ms of budget left`,
        { engine: 'duckduckgo', retry_hint: 'Raise ENGINE_TIMEOUT_MS/the tool timeout, or let another engine answer while the page pool is busy.' }
      );
    }
    // A block is reported as a block even when a later endpoint merely came back
    // empty: the rate limit is the cause, and "no parseable results" reads like
    // selector rot, which sends the next reader hunting for a broken parser.
    const emptiesText = empties.map((id) => `${id} returned a page with no parseable results`);
    const detail = `${tried.join(' -> ')}: ${[...blocks, ...errors, ...emptiesText].join('; ')}`;
    if (blocks.length) {
      throw new SearchEngineError(
        'ENGINE_BLOCKED',
        `DuckDuckGo blocked in Chromium (${detail})`,
        {
          engine: 'duckduckgo',
          endpoints_tried: tried,
          retry_hint: 'DuckDuckGo soft-blocks by IP/fingerprint and it clears on its own: wait a minute, or let another engine answer by dropping duckduckgo from engines[]. A shared or datacenter proxy exit triggers it far sooner than a direct one - engine_proxies can pin duckduckgo to a different profile.'
        }
      );
    }
    throw new SearchEngineError(
      'SERP_PARSE_FAILED',
      empties.length
        ? `DuckDuckGo returned no parseable results in Chromium (${detail})`
        : `DuckDuckGo SERP navigations failed in Chromium (${detail})`,
      { engine: 'duckduckgo', endpoints_tried: tried, retry_hint: 'Each endpoint parses independently, so a simultaneous markup change is unlikely - check the browser session and the exit IP first.' }
    );
  });
}
