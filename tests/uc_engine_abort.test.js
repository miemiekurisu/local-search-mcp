// Cancellation and backpressure below the registry: an engine deadline must abort
// the engine (not just ignore it), a gone caller must stop the fan-out, and the
// DuckDuckGo throttle queue must stay bounded and cancellable.
process.env.ENGINE_TIMEOUT_MS = '120';
process.env.DUCKDUCKGO_MAX_QUEUED = '1';

import { test } from 'node:test';
import assert from 'node:assert';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { EngineRegistry } = await import('../src/engines/index.js');
const { searchDuckDuckGo } = await import('../src/engines/duckduckgo_http.js');
const { signalRemainingMs } = await import('../src/utils/abort.js');

function makeRegistry() {
  return new EngineRegistry({
    proxyRouter: {
      resolveForEngine: () => ({ profile: 'direct' }),
      resolve: () => null,
      status: () => ({ profiles: {}, engine_proxies: {} })
    },
    browserPool: { sessionStatus: () => ({}) }
  });
}

const SERP_HTML = `<div class="result"><div class="result__body">
  <a class="result__a" href="https://one.example.com/a">Title One</a>
  <a class="result__snippet">Snip one</a>
</div></div>`;

function makeDuckPage({ content = SERP_HTML } = {}) {
  const calls = [];
  return {
    calls,
    async goto(url) { calls.push('goto:' + url); },
    async waitForTimeout(ms) { calls.push('wait:' + ms); },
    async content() { return content; },
    mouse: { async wheel() { calls.push('wheel'); } }
  };
}

function makeDuckPool(page, { contended = false, withPageImpl = null } = {}) {
  const seen = [];
  return {
    seen,
    isContended: () => contended,
    async withPage(opts, fn) {
      seen.push(opts);
      if (withPageImpl) return await withPageImpl(opts, fn);
      if (opts.signal?.aborted) {
        throw Object.assign(new Error('task aborted by caller'), { code: 'ABORTED' });
      }
      return await fn(page);
    }
  };
}

test('an engine deadline aborts the engine instead of only ignoring it', async () => {
  const reg = makeRegistry();
  const signals = [];
  reg.searchOne = async (engine, query, opts = {}) => {
    signals.push(opts.signal);
    await sleep(400); // hangs past the 120ms engine deadline
    return [];
  };
  const res = await reg.searchMany('q', { engines: ['google'], limit: 3 });
  assert.strictEqual(res.failures.length, 1);
  assert.strictEqual(res.failures[0].code, 'ENGINE_TIMEOUT');
  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0].aborted, true, 'the abandoned engine was cancelled, not orphaned');
  assert.match(String(signals[0].reason), /engine timeout: google/);
  assert.deepStrictEqual(res.fallback_attempted_for, [], 'chromium-only engines do not hit the paid fallback');
});

test('a caller that already gave up skips the whole engine fan-out', async () => {
  const reg = makeRegistry();
  let started = 0;
  reg.searchOne = async () => { started++; return []; };
  const ac = new AbortController();
  ac.abort(new Error('MCP client disconnected'));
  const res = await reg.searchMany('q', { engines: ['google', 'deepseek'], signal: ac.signal });
  assert.strictEqual(started, 0, 'no engine work started for an abandoned search');
  assert.deepStrictEqual(res.failures.map((f) => f.code), ['ABORTED', 'ABORTED']);
  assert.strictEqual(res.failures[0].message, 'MCP client disconnected', 'the abort reason is preserved');
  assert.deepStrictEqual(res.engines_tried, ['google', 'deepseek']);
});

test('a caller abort mid-search cancels the running engine and skips the rest', async () => {
  const reg = makeRegistry();
  const signals = [];
  reg.searchOne = async (engine, query, opts = {}) => {
    signals.push(opts.signal);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([]), 400);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      }, { once: true });
    });
  };
  const ac = new AbortController();
  const running = reg.searchMany('q', { engines: ['google', 'deepseek'], signal: ac.signal });
  await sleep(40);
  ac.abort();
  const res = await running;
  assert.strictEqual(signals.length, 1, 'the next engine never started');
  assert.strictEqual(signals[0].aborted, true, 'the running engine got the cancel');
  assert.deepStrictEqual(res.failures.map((f) => f.code), ['ABORTED', 'ABORTED']);
});

test('a non-AbortSignal opts.signal never reaches an engine', async () => {
  const reg = makeRegistry();
  let received = 'unset';
  reg.searchOne = async (engine, query, opts = {}) => { received = opts.signal; return []; };
  const res = await reg.searchMany('q', { engines: ['google'], signal: 'junk-from-http-body' });
  assert.ok(res.failures.length === 0);
  assert.ok(received instanceof AbortSignal, 'searchMany owns the per-engine controller');

  const page = makeDuckPage();
  const pool = makeDuckPool(page);
  const results = await searchDuckDuckGo('q', { browserPool: pool, signal: 'junk-from-http-body' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(pool.seen[0].signal, null, 'junk is dropped before the pool dereferences it');
});

test('duckduckgo drops optional human-like waiting while a page is queued', async () => {
  const idlePage = makeDuckPage();
  const idleResults = await searchDuckDuckGo('q', { browserPool: makeDuckPool(idlePage), limit: 3 });
  assert.strictEqual(idleResults.length, 1);
  assert.ok(idlePage.calls.some((entry) => entry.startsWith('wait:')), 'an idle device keeps the settle pause');
  assert.ok(idlePage.calls.includes('wheel'), 'an idle device keeps the closing glance');

  const busyPage = makeDuckPage();
  const busyResults = await searchDuckDuckGo('q', {
    browserPool: makeDuckPool(busyPage, { contended: true }), limit: 3
  });
  assert.strictEqual(busyResults.length, 1);
  assert.deepStrictEqual(busyPage.calls.filter((entry) => entry.startsWith('wait:')), [],
    'no fake reading time while the next client waits for the only page slot');
  assert.ok(!busyPage.calls.includes('wheel'));
});

test('the duckduckgo throttle queue is bounded and cancellable', async () => {
  // The previous test just made a request, so the next caller is provably stuck
  // behind the global 2s spacing: the queue is occupied when a second arrives.
  const startedAt = Date.now();
  const dying = new AbortController();
  const waiting = searchDuckDuckGo('q', {
    browserPool: makeDuckPool(makeDuckPage(), {
      withPageImpl: async () => {
        throw Object.assign(new Error('task aborted by caller'), { code: 'ABORTED' });
      }
    }),
    signal: dying.signal
  });
  await assert.rejects(searchDuckDuckGo('q', { browserPool: makeDuckPool(makeDuckPage()) }), (err) => {
    assert.strictEqual(err.code, 'DDG_THROTTLED');
    assert.match(err.details.retry_hint, /DUCKDUCKGO_MAX_QUEUED/);
    return true;
  }, 'a third client is refused instead of piling up behind the 2s spacing');

  // Abandoning the waiter must release the queue turn immediately.
  dying.abort();
  await assert.rejects(waiting, { code: 'ABORTED' });
  assert.ok(Date.now() - startedAt < 1500, 'an abandoned waiter stops waiting');
});

test('the engine deadline travels on the signal so the page queue can honour it', async () => {
  // The queue cannot read the registry-local timeout, so the budget has to be
  // published: without it a congested pool waits its own 60s cap and the caller
  // dies as ENGINE_TIMEOUT while merely queued (uc_pool_budget.test.js covers the
  // queue side of this contract).
  const reg = makeRegistry();
  const budgets = [];
  reg.searchOne = async (engine, query, opts = {}) => {
    budgets.push(signalRemainingMs(opts.signal));
    return [];
  };
  await reg.searchMany('q', { engines: ['bing'], limit: 3 });
  assert.strictEqual(budgets.length, 1);
  assert.ok(Number.isFinite(budgets[0]) && budgets[0] > 0 && budgets[0] <= 120,
    `expected a budget of at most 120ms, got ${budgets[0]}`);
});
