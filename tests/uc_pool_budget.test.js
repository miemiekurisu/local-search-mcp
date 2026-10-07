// Budget-aware page-slot queueing. An engine attempt / tool call owns a wall-clock
// budget and publishes it on its signal; the queue must bound its own wait by that
// budget, otherwise the caller is killed by its own deadline while still queued --
// a bogus ENGINE_TIMEOUT that also occupies queue capacity for a doomed waiter.
// Env must be set before the pool module is imported (read at load time).
process.env.MAX_CONCURRENT_PAGES = '1';
process.env.MAX_PAGE_QUEUE_WAITERS = '4';
// Deliberately far longer than any budget used below so the budget, not the queue
// timeout, is what ends the wait.
process.env.PAGE_QUEUE_TIMEOUT_MS = '30000';
process.env.MAX_SESSION_CONTEXTS = '2';
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
import { markSignalDeadline, signalRemainingMs } from '../src/utils/abort.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-budget-'));
process.env.BROWSER_STATE_DIR = stateDir;

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

class FakePage {
  constructor(context) {
    this.context = context;
    this.curr = '';
    this.closed = false;
  }
  url() { return this.curr; }
  setDefaultTimeout() {}
  addInitScript() {}
  route() {}
  async goto(u) { this.curr = u; return {}; }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async evaluate() { return undefined; }
  async waitForTimeout() {}
  mouse = { wheel: async () => {}, move: async () => {}, click: async () => {} };
  locator() { return { count: async () => 0, nth: () => ({ hover: async () => {} }) }; }
}

class FakeContext {
  constructor(browser) {
    this.browser = browser;
    this.pages_ = [];
    this.closed = false;
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
  async newContext() {
    if (this.closed) throw new Error('browser closed');
    const ctx = new FakeContext(this);
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

test('markSignalDeadline publishes a budget that downstream layers can read', () => {
  const plain = new AbortController().signal;
  assert.strictEqual(signalRemainingMs(plain), null, 'an unbudgeted signal has no budget');
  assert.strictEqual(signalRemainingMs(null), null);
  assert.strictEqual(signalRemainingMs({ deadlineAt: 'nope' }), null);

  const marked = markSignalDeadline(new AbortController().signal, 5000);
  const remaining = signalRemainingMs(marked);
  assert.ok(remaining > 4000 && remaining <= 5000, `remaining was ${remaining}`);
  assert.strictEqual(signalRemainingMs(marked, Date.now() + 9000), 0, 'a passed deadline clamps to 0');

  // A sealed signal must not break the request; the budget simply stays unknown.
  const sealed = new AbortController().signal;
  Object.freeze(sealed);
  assert.strictEqual(markSignalDeadline(sealed, 1000), sealed);
  assert.strictEqual(signalRemainingMs(sealed), null);
  // Invalid budgets are ignored instead of producing an instant deadline.
  assert.strictEqual(signalRemainingMs(markSignalDeadline(new AbortController().signal, 0)), null);
  assert.strictEqual(signalRemainingMs(markSignalDeadline(null, 1000)), null);
});

test('a queued waiter stops at its own budget, not at the queue timeout', async () => {
  const pool = newPool();
  const releasers = [];
  const hold = pool.withPage({}, () => new Promise((r) => releasers.push(r)));
  await tick(30);

  const controller = new AbortController();
  markSignalDeadline(controller.signal, 1200);
  const started = Date.now();
  await assert.rejects(pool.withPage({ signal: controller.signal }, async () => 'never runs'), (err) => {
    assert.strictEqual(err.code, 'PAGE_BUSY', 'congestion, not a fake engine outage');
    assert.strictEqual(err.details.max_pages, 1);
    // The budget is measured off the wall clock when the waiter is enqueued, so it can
    // legitimately land a millisecond short of what the caller asked for.
    assert.ok(err.details.waited_ms >= 1100 && err.details.waited_ms <= 1200,
      `the queue reported the budget it honoured (got ${err.details.waited_ms})`);
    assert.strictEqual(err.details.page_queue_timeout_ms, 30000, 'the queue cap is unchanged for others');
    assert.match(err.details.retry_hint, /parallel clients/);
    return true;
  });
  const waited = Date.now() - started;
  assert.ok(waited >= 1100 && waited < 6000, `waited ${waited}ms; expected ~1200ms, never 30000ms`);
  assert.strictEqual(pool._pageWaiters.length, 0, 'the budgeted waiter left the queue');

  releasers.shift()();
  await hold;
  assert.strictEqual(pool._activePageCount, 0, 'no slot leaked by the budget timeout');
  await pool.close();
});

test('a caller with no usable budget left fails fast instead of joining the queue', async () => {
  const pool = newPool();
  const releasers = [];
  const hold = pool.withPage({}, () => new Promise((r) => releasers.push(r)));
  await tick(30);

  const controller = new AbortController();
  markSignalDeadline(controller.signal, 200);
  await tick(260);

  const started = Date.now();
  await assert.rejects(pool.withPage({ signal: controller.signal }, async () => 'never runs'), (err) => {
    assert.strictEqual(err.code, 'PAGE_BUSY');
    assert.strictEqual(err.details.waited_ms, 0, 'it never joined the queue');
    assert.ok(err.details.budget_ms <= 200, `budget_ms was ${err.details.budget_ms}`);
    assert.match(err.details.retry_hint, /no time left to wait/);
    return true;
  });
  assert.ok(Date.now() - started < 250, 'must fail immediately, not sit in the queue');
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 0, 'a doomed waiter does not eat queue capacity');
  assert.strictEqual(pool._activePageCount, 1, 'the busy slot stays busy');

  releasers.shift()();
  await hold;
  await pool.close();
});

test('an unbudgeted caller still waits for the queue cap and gets the freed slot', async () => {
  const pool = newPool();
  const releasers = [];
  const hold = pool.withPage({}, () => new Promise((r) => releasers.push(r)));
  await tick(30);

  const next = pool.withPage({}, async () => 'acquired');
  await tick(30);
  assert.strictEqual(pool.pageQueueStatus().queued_pages, 1, 'no budget means no early rejection');
  releasers.shift()();
  assert.strictEqual(await next, 'acquired');
  await hold;
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});
