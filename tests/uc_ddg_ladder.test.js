// The DuckDuckGo endpoint ladder: the main SERP is the only endpoint robots.txt allows,
// the static endpoints answer while somebody else holds the page slot, and a block has
// to stay distinguishable from a parse failure and from plain congestion.
process.env.DUCKDUCKGO_MIN_INTERVAL_MS = '0';

import { test } from 'node:test';
import assert from 'node:assert';

const { searchDuckDuckGo } = await import('../src/engines/duckduckgo_http.js');
const DDG_HTML = '<div class="result"><a class="result__a" href="https://html.example.com/1">Html One</a><div class="result__snippet">html snippet</div></div>';
const DDG_LITE = '<table><tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2F1%3Futm_source%3Dddg">Lite One</a></td></tr>' +
  '<tr><td class="result-snippet">lite snippet</td></tr>' +
  '<tr><td><a class="result-link" href="https://lite.example.com/2">Lite Two</a></td></tr>' +
  '<tr><td class="result-snippet">lite snippet two</td></tr></table>';
const DDG_MAIN = '<article><h2><a data-testid="result-title-a" href="https://main.example.com/1">Main One</a></h2><div data-result="snippet">main snippet</div></article>' +
  '<article><h2><a data-testid="result-title-a" href="https://main.example.com/2">Main Two</a></h2><div data-result="snippet">main snippet two</div></article>';
// What a shared egress IP gets back when DuckDuckGo soft-blocks it: a challenge page on
// HTTP 200 or 202, which a status check alone never catches.
const DDG_CHALLENGE = '<html><body><div class="anomaly-modal"><p>Unfortunately, bots use DuckDuckGo too.</p>' +
  '<p>Please complete the following challenge to confirm this search was made by a human.</p>' +
  '<p>Select all squares containing a duck</p>' +
  '<p>Please email the following code to: error-lite+4a8a@duckduckgo.com</p></div></body></html>';
const DDG_CLEAN = '<html><body>nothing here</body></html>';
const onMain = (url) => url.startsWith('https://duckduckgo.com/');
const onHtml = (url) => url.includes('html.duckduckgo.com');
const onLite = (url) => url.includes('lite.duckduckgo.com');
const hop = (url) => (onMain(url) ? 'main' : onHtml(url) ? 'html' : 'lite');
const failure = async (promise) => promise.then(() => null, (err) => err);
function scriptedPool({ contentFor = () => DDG_CLEAN, statusFor = () => 200, onGoto = null, contended = false } = {}) {
  const navs = [];
  const page = {
    mouse: { async wheel() {} },
    async waitForTimeout() {},
    async waitForSelector() {},
    async goto(url) {
      navs.push(url);
      if (onGoto) return onGoto(url);
      return { status: () => statusFor(url) };
    },
    async content() { return contentFor(navs[navs.length - 1]); }
  };
  return { navs, isContended: () => contended, async withPage(opts, fn) { return fn(page); } };
}
test('duckduckgo starts at the main SERP that robots.txt allows', async () => {
  const pool = scriptedPool({ contentFor: (url) => (onMain(url) ? DDG_MAIN : DDG_HTML) });
  const results = await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
  assert.deepStrictEqual(pool.navs, ['https://duckduckgo.com/?q=q&ia=web'], 'one navigation when the sanctioned SERP answers');
  assert.deepStrictEqual(results.map((r) => r.url), ['https://main.example.com/1', 'https://main.example.com/2'], 'main links are already direct');
  assert.strictEqual(results[0].snippet, 'main snippet');
});
test('a blocked main SERP falls through to the static endpoints', async () => {
  const pool = scriptedPool({ contentFor: (url) => (onMain(url) ? DDG_CHALLENGE : onLite(url) ? DDG_CLEAN : DDG_HTML) });
  const results = await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
  assert.deepStrictEqual(pool.navs.map(hop), ['main', 'html']);
  assert.strictEqual(results[0].url, 'https://html.example.com/1');
});
test('lite results keep their snippets and lose the redirect', async () => {
  const pool = scriptedPool({ contentFor: (url) => (onLite(url) ? DDG_LITE : DDG_CLEAN) });
  const results = await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
  assert.deepStrictEqual(pool.navs.map(hop), ['main', 'html', 'lite']);
  assert.deepStrictEqual(results.map((r) => r.url), ['https://lite.example.com/1', 'https://lite.example.com/2']);
  assert.strictEqual(results[0].snippet, 'lite snippet', 'sibling rows are matched by position');
});
test('a queued page holds the main SERP until the cheap ones answer', async () => {
  const pool = scriptedPool({ contentFor: (url) => (onHtml(url) ? DDG_HTML : DDG_CLEAN), contended: true });
  const results = await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
  assert.deepStrictEqual(pool.navs.map(hop), ['lite', 'html'], 'the cheapest hops answer first while a slot is queued');
  assert.strictEqual(results[0].url, 'https://html.example.com/1');
});
test('every endpoint blocked is a block, not a parse failure', async () => {
  const pool = scriptedPool({ contentFor: () => DDG_CHALLENGE });
  const err = await failure(searchDuckDuckGo('q', { browserPool: pool, limit: 5 }));
  assert.strictEqual(err.code, 'ENGINE_BLOCKED');
  assert.deepStrictEqual(err.details.endpoints_tried, ['main', 'html', 'lite'], 'the operator sees the whole ladder was tried');
});
test('an HTTP 202 with an innocent body is still a block', async () => {
  const pool = scriptedPool({ contentFor: () => DDG_MAIN, statusFor: () => 202 });
  const err = await failure(searchDuckDuckGo('q', { browserPool: pool }));
  assert.strictEqual(err.code, 'ENGINE_BLOCKED', 'a 2xx challenge must not read as selector rot');
  assert.match(err.message, /HTTP 202/);
});
test('a navigation failure on one endpoint tries the next', async () => {
  const pool = scriptedPool({
    contentFor: (url) => (onHtml(url) ? DDG_HTML : DDG_CLEAN),
    onGoto: (url) => { if (onMain(url)) throw new Error('page.goto: net::ERR_TIMEDOUT'); return { status: () => 200 }; }
  });
  const results = await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
  assert.deepStrictEqual(results.map((r) => r.url), ['https://html.example.com/1'], 'a slow main site does not kill the engine');
  assert.deepStrictEqual(pool.navs.map(hop), ['main', 'html']);
});
test('a budget too small to navigate is not reported as a parse failure', async () => {
  const pool = scriptedPool();
  const signal = new AbortController().signal;
  signal.deadlineAt = Date.now() + 500;
  const err = await failure(searchDuckDuckGo('q', { browserPool: pool, signal }));
  assert.strictEqual(err.code, 'ENGINE_TIMEOUT');
  assert.deepStrictEqual(pool.navs, [], 'no page slot is occupied for a navigation that cannot finish');
});
test('DUCKDUCKGO_ENDPOINTS controls the ladder', async () => {
  process.env.DUCKDUCKGO_ENDPOINTS = 'bogus,html';
  try {
    const pool = scriptedPool({ contentFor: (url) => (onHtml(url) ? DDG_HTML : DDG_CLEAN) });
    await searchDuckDuckGo('q', { browserPool: pool, limit: 5 });
    assert.deepStrictEqual(pool.navs.map(hop), ['html'], 'unknown ids drop, the rest is honoured');
  } finally {
    delete process.env.DUCKDUCKGO_ENDPOINTS;
  }
});
