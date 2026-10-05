// Page-slot semaphore behaviour under multi-client load: strict FIFO, no
// oversubscription, bounded + cancellable queue, and a soft session-context cap.
// Env must be set before the pool module is imported (read at load time).
process.env.MAX_CONCURRENT_PAGES = '1';
process.env.MAX_PAGE_QUEUE_WAITERS = '3';
// envInt() floors this one at 1000ms, so 1000 is the shortest queue wait possible.
process.env.PAGE_QUEUE_TIMEOUT_MS = '1000';
process.env.MAX_SESSION_CONTEXTS = '2';
// Short enough to keep the test fast, above the min clamp of 100ms.
process.env.PAGE_TEARDOWN_TIMEOUT_MS = '200';
process.env.KEPT_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.MAX_KEPT_PAGES = '2';
process.env.SESSION_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.STATE_DIR_BASE = process.env.TEMP || process.cwd();

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-conc-'));
process.env.BROWSER_STATE_DIR = stateDir;

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

// When true, page.close() never settles -- Playwright does this for real on a
// wedged renderer (and the known close() hangs), so the pool must not depend on it.
let hangCloses = false;

class FakePage {
  constructor(context) {
    this.context = context;
    this.curr = '';
    this.closed = false;
    this.actions = [];
    this.gotoLog = [];
  }
  url() { return this.curr; }
  setDefaultTimeout() {}
  addInitScript() {}
  route() {}
  async goto(u) { this.gotoLog.push(u); this.curr = u; return {}; }
  async close() { if (hangCloses) return new Promise(() => {}); this.closed = true; }
  isClosed() { return this.closed; }
  async evaluate() { return undefined; }
  async waitForTimeout(ms) { return new Promise((r) => setTimeout(r, Math.min(ms, 5))); }
  mouse = {
    wheel: async () => { this.actions.push('wheel'); },
    move: async () => { this.actions.push('move'); },
    click: async () => { this.actions.push('click'); }
  };
  locator() { return { count: async () => 0, nth: () => ({ hover: async () => {} }) }; }
}

class FakeContext {
  constructor(browser) {
    this.browser = browser;
    this.pages_ = [];
    this.closed = false;
    this.opts = null;
  }
  async newPage() {
    if (this.closed) throw new Error('context closed');
    const p = new FakePage(this);
    this.pages_.push(p);
    return p;
  }
  pages() { return this.pages_.filter((p) => !p.closed); }
  async addCookies() {}
  async storageState() { return { cookies: [], origins: [] }; }
  async close() { this.closed = true; }
}

class FakeBrowser {
  constructor() {
    this.contexts_ = [];
    this.closed = false;
    this.handlers = {};
  }
  on(event, cb) { this.handlers[event] = cb; }
  isConnected() { return !this.closed; }
  contexts() { return [...this.contexts_]; }
  async newContext(opts = {}) {
    if (this.closed) throw new Error('browser closed');
    const ctx = new FakeContext(this);
    ctx.opts = opts;
    this.contexts_.push(ctx);
    return ctx;
  }
  async close() { this.closed = true; if (this.handlers.disconnected) this.handlers.disconnected(); }
}

let nextBrowser = null;
const st = playwrightState();
st.launchImpl = () => nextBrowser;

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

function newPool() {
  nextBrowser = new FakeBrowser();
  return new PlaywrightPool({ resolve: () => null });
}

// Releases one running task per tick so the next queued waiter starts and
// registers its own releaser (a single drain loop would stop after the first).
async function drain(pool, releasers) {
  for (let i = 0; i < 10; i++) {
    const release = releasers.shift();
    if (release) release();
    await tick(20);
    if (!releasers.length && pool._activePageCount === 0) break;
  }
}

test('page slots are never oversubscribed and waiters wake in FIFO order', async () => {
  const pool = newPool();
  const started = [];
  const activeAtStart = [];
  const releasers = [];
  const task = (name) => pool.withPage({}, async () => {
    started.push(name);
    activeAtStart.push(pool._activePageCount);
    await new Promise((resolve) => releasers.push(resolve));
    return name;
  });
  const pending = [task('a'), task('b'), task('c'), task('d')];
  await tick(40);
  assert.deepStrictEqual(started, ['a'], 'only MAX_CONCURRENT_PAGES tasks run at once');
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 3);
  assert.strictEqual(pool.isContended(), true);
  for (const expected of ['b', 'c', 'd']) {
    releasers.shift()();
    await tick(40);
    assert.strictEqual(started[started.length - 1], expected, expected + ' woke next');
    assert.strictEqual(pool._activePageCount, 1, 'never more than the cap');
  }
  releasers.shift()();
  assert.deepStrictEqual(await Promise.all(pending), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(activeAtStart, [1, 1, 1, 1], 'every task saw exactly one live page');
  assert.strictEqual(pool._activePageCount, 0);
  assert.strictEqual(pool.isContended(), false);
  await pool.close();
});

test('page queue overflow fails fast with PAGE_QUEUE_FULL', async () => {
  const pool = newPool();
  const releasers = [];
  const hold = pool.withPage({}, () => new Promise((r) => releasers.push(r)));
  await tick(30);
  const queued = ['b', 'c', 'd'].map((name) => pool.withPage({}, async () => {
    await new Promise((r) => releasers.push(r));
    return name;
  }));
  await tick(30);
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 3);
  await assert.rejects(pool.withPage({}, async () => 'never runs'), (err) => {
    assert.strictEqual(err.code, 'PAGE_QUEUE_FULL');
    assert.strictEqual(err.details.max_queued_pages, 3);
    assert.strictEqual(err.details.active_pages, 1);
    return true;
  });
  assert.strictEqual(pool._activePageCount, 1, 'a rejected caller never takes a slot');
  await drain(pool, releasers);
  assert.deepStrictEqual(await Promise.all([hold, ...queued]), [undefined, 'b', 'c', 'd']);
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});

test('an aborted waiter leaves the queue without stealing a slot', async () => {
  const pool = newPool();
  const releasers = [];
  const started = [];
  const hold = pool.withPage({}, async () => {
    started.push('a');
    await new Promise((r) => releasers.push(r));
  });
  await tick(30);
  const dying = new AbortController();
  const abandoned = pool.withPage({ signal: dying.signal }, async () => { started.push('b'); });
  const next = pool.withPage({}, async () => { started.push('c'); return 'c'; });
  await tick(30);
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 2);
  dying.abort();
  await assert.rejects(abandoned, { code: 'ABORTED' });
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 1, 'the aborted waiter left the queue');
  releasers.shift()();
  assert.strictEqual(await next, 'c', 'the freed slot reached the surviving waiter');
  await hold;
  assert.deepStrictEqual(started, ['a', 'c'], 'the aborted waiter never ran');
  assert.strictEqual(pool._pageWaiters.length, 0);
  assert.strictEqual(pool._activePageCount, 0, 'no slot leaked by the abort');
  await pool.close();
});

test('a queue timeout racing a release does not strand the slot', async () => {
  const pool = newPool();
  const releasers = [];
  const hold = pool.withPage({}, () => new Promise((r) => releasers.push(r)));
  await tick(30);
  const stuck = pool.withPage({}, async () => 'should never run');
  await assert.rejects(stuck, (err) => {
    assert.strictEqual(err.code, 'PAGE_BUSY');
    assert.strictEqual(err.details.max_pages, 1);
    assert.match(err.details.retry_hint, /MAX_CONCURRENT_PAGES/);
    return true;
  });
  assert.strictEqual(pool._pageWaiters.length, 0, 'timed-out waiter dropped itself');
  releasers.shift()();
  await hold;
  assert.strictEqual(await pool.withPage({}, async () => 'acquired'), 'acquired',
    'the pool still works after a queue timeout');
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});

test('release hands the slot past a stale settled waiter', async () => {
  const pool = newPool();
  let staleHandoffs = 0;
  pool._pageWaiters.push({
    settled: true, resolve: () => { staleHandoffs++; }, reject() {}, timer: null, signal: null, onAbort: null
  });
  let wakeLive;
  const live = new Promise((resolve) => {
    wakeLive = resolve;
    pool._pageWaiters.push({ settled: false, resolve, reject() {}, timer: null, signal: null, onAbort: null });
  });
  pool._activePageCount = 1;
  pool._releasePageSlot();
  await live;
  assert.strictEqual(staleHandoffs, 0, 'a settled waiter is never handed the slot');
  assert.strictEqual(pool._activePageCount, 1, 'the slot travelled with the hand-off');
  pool._releasePageSlot();
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});

test('caller abort during a page task closes the page and frees the slot', async () => {
  const pool = newPool();
  const ac = new AbortController();
  let page = null;
  const started = Date.now();
  await assert.rejects(pool.withPage({ signal: ac.signal, closeDelayMs: 4000 }, async (p) => {
    page = p;
    ac.abort();
    await new Promise(() => {});
  }), (err) => {
    assert.strictEqual(err.code, 'ABORTED');
    return true;
  });
  assert.strictEqual(page.closed, true, 'the hung page was closed instead of left running');
  assert.strictEqual(pool._activePageCount, 0);
  assert.ok(Date.now() - started < 2000, 'linger is skipped once the caller gave up');
  await pool.close();
});

test('an already-aborted signal is rejected before a browser is touched', async () => {
  const pool = newPool();
  const ac = new AbortController();
  ac.abort(new Error('client gone'));
  let ran = false;
  await assert.rejects(pool.withPage({ signal: ac.signal }, async () => { ran = true; }), (err) => {
    assert.strictEqual(err.code, 'ABORTED');
    assert.strictEqual(err.message, 'client gone', 'the abort reason surfaces');
    return true;
  });
  assert.strictEqual(ran, false);
  assert.strictEqual(nextBrowser.contexts_.length, 0, 'no context created for a dead caller');
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});

test('human-like linger is skipped while another client is queued', async () => {
  const pool = newPool();
  const idlePage = await pool.withPage({ closeDelayMs: 300 }, async (p) => p);
  assert.ok(idlePage.actions.length > 0, 'linger runs when nobody is waiting');

  const releasers = [];
  const held = pool.withPage({ closeDelayMs: 300 }, async (p) => {
    await new Promise((r) => releasers.push(r));
    return p;
  });
  await tick(30);
  const queued = pool.withPage({}, async () => 'queued');
  await tick(20);
  assert.strictEqual(pool.isContended(), true);
  releasers.shift()();
  const lingeringPage = await held;
  assert.strictEqual(lingeringPage.actions.length, 0, 'linger skipped while a waiter is queued');
  assert.strictEqual(await queued, 'queued');
  await pool.close();
});

test('session-context cap skips busy contexts instead of killing a running task', async () => {
  const pool = newPool();
  assert.strictEqual(pool._sessionPageIsLive('missing'), false);
  pool.sessionPages.set('broken', { page: { isClosed() { throw new Error('detached'); } } });
  assert.strictEqual(pool._sessionPageIsLive('broken'), false, 'a dead pinned page is not "live"');
  pool.sessionPages.delete('broken');

  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await pool.getSessionContext('s1');
    await pool.getSessionContext('s2');
    pool._contextHeld.set('s1', 1);
    pool.sessionPages.set('s2', { page: new FakePage(null) });
    await pool.getSessionContext('s3');
    assert.strictEqual(pool.sessionContexts.size, 3, 'cap exceeded rather than closing a busy context');
    pool._contextHeld.set('s3', 1);
    await pool.getSessionContext('s4');
    assert.strictEqual(pool.sessionContexts.size, 4);
    assert.strictEqual(lines.filter((line) => line.includes('every context is busy')).length, 1,
      'the cap warning is throttled to one per 30s');
  } finally {
    console.log = realLog;
  }

  pool._contextHeld.delete('s1');
  const s2Ctx = pool.sessionContexts.get('s2').context;
  await pool.getSessionContext('s5');
  assert.strictEqual(pool.sessionContexts.has('s2'), true, 'the pinned context survived');
  assert.strictEqual(s2Ctx.closed, false);
  assert.strictEqual(pool.sessionContexts.size, 4, 'an idle context became the victim instead');
  await pool.close();
});

// A wedged page must not be able to hold the only slot. storageState()/close() on
// a stuck page block for the Playwright protocol timeout (forever, for the known
// close() hangs) -- and a cancelled request is exactly what leaves a wedged page
// behind. Before the teardown budget this turned a MAX_CONCURRENT_PAGES=1 pool
// permanently into "page queue full" until restart.
test('a page whose close() hangs still releases the slot within the teardown budget', async () => {
  const pool = newPool();
  hangCloses = true;
  const hung = pool.withPage({}, async () => 'hung');
  await tick(30);
  assert.strictEqual(pool._activePageCount, 1, 'the running task holds the slot');
  hangCloses = false;
  const startedAt = Date.now();
  const next = await Promise.race([
    pool.withPage({}, async () => 'next').then((value) => ({ value, waited: Date.now() - startedAt })),
    tick(1500).then(() => null)
  ]);
  assert.ok(next, 'the queued client never got the slot back');
  assert.strictEqual(next.value, 'next');
  assert.ok(next.waited >= 150, `slot released early, before the teardown budget (${next.waited}ms)`);
  assert.ok(next.waited < 1200, `teardown is not bounded, waited ${next.waited}ms`);
  assert.strictEqual(await hung, 'hung');
  assert.strictEqual(pool._activePageCount, 0, 'no slot leaked');
  assert.strictEqual(pool._pageWaiters.length, 0);
  await pool.close();
});

test('pageQueueStatus reports the congestion snapshot', async () => {
  const pool = newPool();
  assert.deepStrictEqual(pool.pageQueueStatus(), {
    active_pages: 0,
    max_pages: 1,
    queued_pages: 0,
    max_queued_pages: 3,
    page_queue_timeout_ms: 1000,
    session_contexts: 0,
    max_session_contexts: 2,
    kept_pages: 0,
    max_kept_pages: 2,
    low_power_device: false
  });
  assert.strictEqual(pool.isContended(), false);
  await pool.close();
});

// A captcha/blocked page is parked open on purpose (keepPageOpen) so a human can
// finish it in noVNC, but the entry lives outside the page-slot accounting. With one
// slot and a 5 minute TTL, several clients hitting bot walls used to accumulate one
// live page *and* one live context each -- far more Chromium than
// MAX_CONCURRENT_PAGES=1 was meant to allow.
test('parked captcha pages are capped instead of piling up', async () => {
  const pool = newPool();
  for (let i = 0; i < 4; i++) {
    await pool.withPage({ sessionKey: `cap${i}` }, () => ({ keepPageOpen: true }));
    assert.ok(pool._keptPages.size <= 2, `parked pages stay capped (got ${pool._keptPages.size})`);
  }
  const contexts = nextBrowser.contexts_;
  const openPages = contexts.flatMap((context) => context.pages_).filter((page) => !page.closed);
  assert.strictEqual(openPages.length, pool._keptPages.size, 'evicted pages are really closed');
  assert.strictEqual(contexts.filter((context) => !context.closed).length, pool._keptPages.size,
    'the context an evicted page owned is closed too');

  // The throwaway park is the first to go, newest or not: a session page is the one
  // a human might still be working on.
  await pool.withPage({}, () => ({ keepPageOpen: true }));
  assert.strictEqual(pool._keptPages.size, 2);
  assert.ok(pool._keptPages.has('session:cap2') && pool._keptPages.has('session:cap3'),
    'session parks survive ahead of a throwaway one');
  await pool.close();
});
