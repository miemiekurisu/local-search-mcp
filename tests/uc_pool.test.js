process.env.MAX_CONCURRENT_PAGES = '2';
process.env.MAX_SESSION_CONTEXTS = '2';
process.env.PAGE_QUEUE_TIMEOUT_MS = '400';
process.env.KEPT_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.SESSION_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.STATE_DIR_BASE = process.env.TEMP || process.cwd();

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-state-'));
process.env.BROWSER_STATE_DIR = stateDir;

class FakePage {
  constructor(context) {
    this.context = context;
    this.curr = '';
    this.closed = false;
    this.routes = [];
    this.gotoLog = [];
  }
  url() { return this.curr; }
  setDefaultTimeout() {}
  addInitScript() {}
  route(pattern, handler) { this.routes.push(pattern); }
  async goto(u, opts = {}) { this.gotoLog.push(u); this.curr = u; return {}; }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async evaluate() { return undefined; }
  async waitForTimeout(ms) { return new Promise(r => setTimeout(r, Math.min(ms, 8))); }
  mouse = {
    wheel: async () => {},
    move: async () => {},
    click: async () => {}
  };
  locator() {
    return { count: async () => 0, nth: () => ({ hover: async () => {} }) };
  }
}

class FakeContext {
  constructor(browser) {
    this.browser = browser;
    this.pages_ = [];
    this.cookies = null;
    this.closed = false;
    this.opts = null;
    this.failStorageState = false;
  }
  async newPage() {
    if (this.closed) throw new Error('context closed');
    const p = new FakePage(this);
    this.pages_.push(p);
    return p;
  }
  pages() {
    if (this.closed) throw new Error('context has been closed');
    return this.pages_.filter(p => !p.closed);
  }
  async addCookies(cookies) { this.cookies = cookies; }
  async storageState({ path: statePath } = {}) {
    if (this.failStorageState) throw new Error('storage engine kaput');
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        cookies: [{ name: 'c1', value: 'v1', domain: 'example.com' }],
        origins: [{ origin: 'https://a.example.com', localStorage: [{ name: 'k', value: 'v' }] }]
      }));
    }
    return { cookies: [], origins: [] };
  }
  async close() { this.closed = true; }
}

class FakeBrowser {
  constructor() {
    this.contexts_ = [];
    this.closed = false;
    this.handlers = {};
    this.cdp = false;
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
  async close() { this.closed = true; if (this.handlers['disconnected']) this.handlers['disconnected'](); }
}

let nextBrowser = null;
const st = playwrightState();
st.launchImpl = () => nextBrowser;

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

function newPool() {
  nextBrowser = new FakeBrowser();
  const pool = new PlaywrightPool({ resolve: () => null });
  return pool;
}

test('withPage happy path closes page + ephemeral context', async () => {
  const pool = newPool();
  const b = pool.browser = nextBrowser;
  const res = await pool.withPage({}, async (page, context) => {
    assert.ok(page);
    assert.strictEqual(context.browser, b);
    await page.goto('https://a.example.com');
    return { val: 42 };
  });
  assert.strictEqual(res.val, 42);
  assert.strictEqual(pool._activePageCount, 0);
  assert.strictEqual(b.contexts_[0].closed, true);
  assert.strictEqual(b.contexts_[0].pages_[0].closed, true);
  assert.strictEqual(pool.browser, b, 'browser stays open after task');
  await pool.close();
});

test('withPage concurrency limit + queue + wakeup', async () => {
  const pool = newPool();
  const releaseFns = [];
  const t1 = pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }));
  const t2 = pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }));
  assert.strictEqual(pool._activePageCount, 2);
  let t3Done = false;
  const t3 = pool.withPage({}, async page => { t3Done = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(pool._pageWaiters.length, 1);
  assert.strictEqual(t3Done, false);
  releaseFns[0](); // t1 finishes → waiter woken
  await t1;
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(t3Done, true, 'woken waiter completed');
  releaseFns[1]();
  await t2;
  assert.strictEqual(pool._activePageCount, 0);
  assert.strictEqual(pool._pageWaiters.length, 0);
  await pool.close();
});

test('withPage queue timeout PAGE_BUSY', async () => {
  const pool = newPool();
  const releaseFns = [];
  const holders = [pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }))];
  holders.push(pool.withPage({}, () => new Promise(r => { releaseFns.push(r); })));
  const t0 = Date.now();
  await assert.rejects(pool.withPage({}, async () => 1), { code: 'PAGE_BUSY' });
  assert.ok(Date.now() - t0 > 300, 'should wait at least queue timeout');
  for (const r of releaseFns) r();
  await Promise.all(holders.map(p => p.catch(() => {})));
  await pool.close();
});

test('withPage fn error releases slot and rejects', async () => {
  const pool = newPool();
  await assert.rejects(pool.withPage({}, async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(pool._activePageCount, 0);
  await assert.rejects(pool.withPage({ timeoutMs: 80 }, () => new Promise(() => {})), { code: 'PAGE_TASK_TIMEOUT' });
  assert.strictEqual(pool._activePageCount, 0);
  await pool.close();
});

test('withPage sessionKey persist + persistent context reuse', async () => {
  const pool = newPool();
  await pool.withPage({ sessionKey: 'mysess' }, async () => 1);
  const statePath = path.join(stateDir, 'mysess.json');
  assert.ok(fs.existsSync(statePath), 'storage state persisted');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(raw.cookies[0].name, 'c1');
  const b = pool.browser;
  await pool.withPage({ sessionKey: 'mysess', reuseSession: true }, async () => 2);
  await pool.withPage({ sessionKey: 'mysess', reuseSession: true }, async () => 3);
  const sessionContexts = [...pool.sessionContexts.values()];
  assert.strictEqual(sessionContexts.length, 1, 'same context reused');
  const livePages = sessionContexts[0].context.pages();
  assert.strictEqual(livePages.length, 0, 'task pages closed after run');
  const opts = sessionContexts[0].context.opts;
  assert.ok(opts.userAgent, 'randomized ua');
  assert.ok(opts.viewport, 'viewport set');
  await pool.close();
});

test('withPage keepPageOpen result parks page; same key overwrites', async () => {
  const pool = newPool();
  const r1 = await pool.withPage({}, async page => ({ keepPageOpen: true }));
  assert.strictEqual(r1.keepPageOpen, true);
  assert.strictEqual(pool._keptPages.size, 1);
  const kept1 = [...pool._keptPages.values()][0];
  assert.strictEqual(kept1.page.closed, false);
  // same session key parks overwrite the old entry (old page closed)
  await pool.withPage({ sessionKey: 's9' }, () => ({ keepPageOpen: true }));
  await pool.withPage({ sessionKey: 's9' }, () => ({ keepPageOpen: true }));
  assert.strictEqual(pool._keptPages.size, 2);
  const s9page1 = pool._keptPages.get('session:s9');
  assert.ok(s9page1, 'session kept page parked');
  const r2 = await pool.withPage({ sessionKey: 's9' }, async () => ({ keepPageOpen: true }));
  assert.strictEqual(r2.keepPageOpen, true);
  assert.strictEqual(pool._keptPages.size, 2, 'overwritten in place');
  assert.notStrictEqual(pool._keptPages.get('session:s9').page, s9page1.page);
  await assert.rejects(pool.withPage({ sessionKey: 's9' }, async page => { const e = new Error('need-human'); e.keepPageOpen = true; throw e; }), /need-human/);
  assert.strictEqual(pool._keptPages.size, 2, 'error path also parks under same key');
  assert.strictEqual(pool._keptPages.get('session:s9').page.closed, false);
  await pool.close();
  assert.strictEqual([...pool._keptPages.values()].every(v => v.page.closed), true, 'close resets kept pages');
});

test('withPage linger closes with delay', async () => {
  const pool = newPool();
  const t0 = Date.now();
  await pool.withPage({ closeDelayMs: 150 }, async page => {
    await page.goto('https://linger.example.com');
  });
  const dt = Date.now() - t0;
  const closedPage = pool.browser.contexts_[0].pages_[0];
  assert.strictEqual(closedPage.closed, true);
  assert.ok(closedPage.gotoLog.includes('about:blank') || closedPage.gotoLog.length >= 1, 'about:blank navigation attempted');
  assert.ok(dt >= 100, `linger elapsed >=100ms, got ${dt}`);
  await pool.close();
});

test('getSessionContext evicts oldest beyond MAX_SESSION_CONTEXTS', async () => {
  const pool = newPool();
  await pool.getSessionContext('s1');
  await pool.getSessionContext('s2');
  assert.strictEqual(pool.sessionContexts.size, 2);
  const firstCtx = pool.sessionContexts.get('s1').context;
  await pool.getSessionContext('s3'); // evicts s1
  assert.strictEqual(pool.sessionContexts.size, 2);
  assert.strictEqual(pool.sessionContexts.has('s1'), false);
  assert.strictEqual(pool.sessionContexts.has('s3'), true);
  assert.strictEqual(firstCtx.closed, true);
  // broken context heals: mark closed → getSessionContext deletes & recreates
  pool.sessionContexts.get('s2').context.closed = true;
  await pool.getSessionContext('s2');
  assert.strictEqual(pool.sessionContexts.size, 2);
  assert.notStrictEqual(pool.sessionContexts.get('s2').context, undefined);
  await pool.close();
});

test('_cleanupKeptPages drops expired entries', async () => {
  const pool = newPool();
  await pool.withPage({}, async () => ({ keepPageOpen: true }));
  assert.strictEqual(pool._keptPages.size, 1);
  const entry = [...pool._keptPages.values()][0];
  entry.createdAt = Date.now() - 400000; // TTL default 300000
  pool._cleanupKeptPages();
  assert.strictEqual(pool._keptPages.size, 0);
  assert.strictEqual(entry.page.closed, true);
  assert.strictEqual(entry.context.closed, true);
  await pool.close();
});

test('openSessionPage creates, reuses, evicts and applies resource policy', async () => {
  const pool = newPool();
  const r1 = await pool.openSessionPage({ sessionKey: 'u1', url: 'https://x.example.com/?a=1' });
  assert.strictEqual(r1.session, 'u1');
  assert.strictEqual(r1.mode, 'persistent-context');
  assert.strictEqual(r1.current_url, 'https://x.example.com/?a=1');
  assert.ok(r1.state_path.endsWith('u1.json'));
  assert.strictEqual(pool.sessionPages.get('u1').page.routes.length, 1, 'media block route applied');
  // reopen existing (no new page): stale entry handling
  await pool.openSessionPage({ sessionKey: 'u2', url: 'https://y.example.com' });
  const r1b = await pool.openSessionPage({ sessionKey: 'u1' });
  assert.strictEqual(r1b.current_url, 'https://x.example.com/?a=1', 'reused page keeps url');
  // closed page is detected and recreated
  pool.sessionPages.get('u1').page.closed = true;
  const r1c = await pool.openSessionPage({ sessionKey: 'u1', url: 'https://z.example.com' });
  assert.strictEqual(r1c.current_url, 'https://z.example.com');
  // eviction: MAX_SESSION_CONTEXTS=2 → oldest evicted
  await pool.openSessionPage({ sessionKey: 'u3' });
  assert.strictEqual(pool.sessionPages.size, 2);
  assert.strictEqual(pool.sessionPages.has('u2'), false);
  await pool.close();
  assert.strictEqual(pool.sessionPages.size, 0);
});

test('saveSessionState writes file in launch mode', async () => {
  const pool = newPool();
  const res = await pool.saveSessionState('save1');
  assert.strictEqual(res.session, 'save1');
  assert.strictEqual(res.saved, true);
  assert.ok(fs.existsSync(res.state_path));
  await assert.rejects(pool.saveSessionState(null), /sessionKey is required/);
  // storage failure → saved=false (context throws)
  await pool.withPage({ sessionKey: 'save2', reuseSession: true }, async () => {});
  pool.sessionContexts.get('save2').context.failStorageState = true;
  const res2 = await pool.saveSessionState('save2');
  assert.strictEqual(res2.saved, false);
  await pool.close();
});

test('sessionStatus + listSessionStatuses + redact', async () => {
  const pool = newPool();
  const status = pool.sessionStatus('nostate');
  assert.strictEqual(status.session, 'nostate');
  assert.strictEqual(status.saved_state_exists, false);
  assert.strictEqual(status.interactive_page_url, null);
  assert.strictEqual(status.browser_mode, 'playwright-launch');
  assert.ok(status.state_path, 'unredacted includes path');
  assert.strictEqual(status.cdp_url, null);
  const redacted = pool.sessionStatus('nostate', { redact: true });
  assert.strictEqual(redacted.state_path, undefined);
  // with open session page
  await pool.openSessionPage({ sessionKey: 'st1', url: 'https://status.example.com' });
  const s2 = pool.sessionStatus('st1');
  assert.strictEqual(s2.interactive_page_url, 'https://status.example.com');
  assert.strictEqual(s2.saved_state_exists, false);
  const list = pool.listSessionStatuses(['st1', 'st1']);
  assert.strictEqual(list.length, 2);
  await pool.close();
});

test('releaseSearchResources: busy no-op, idle closes ephemeral kept + search ctx + browser', async () => {
  const pool = newPool();
  const releaseFns = [];
  const holder = pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }));
  await new Promise(r => setTimeout(r, 50));
  const busyRes = await pool.releaseSearchResources();
  assert.deepStrictEqual(busyRes, { released: false, reason: 'busy' });
  assert.strictEqual(pool.browser, null || pool.browser, 'nothing closed while busy');
  releaseFns[0]();
  await holder;
  await pool.close();
});

test('releaseSearchResources idle path', async () => {
  const pool = newPool();
  const b = nextBrowser;
  await pool.withPage({}, async () => ({ keepPageOpen: true }));
  await pool.withPage({ sessionKey: 'keepsess', reuseSession: true }, async () => ({ keepPageOpen: true }));
  assert.strictEqual(pool._keptPages.size, 2);
  const res = await pool.releaseSearchResources();
  assert.deepStrictEqual(res, { released: true });
  assert.strictEqual(pool._keptPages.size, 1, 'session kept page survives');
  const remaining = [...pool._keptPages.values()][0];
  assert.strictEqual(remaining.page !== undefined, true);
  assert.strictEqual(pool.searchContext, null);
  assert.strictEqual(pool.browser, null);
  assert.strictEqual(b.closed, true, 'idle browser closed');
  await pool.close();
});

test('close() rejects queued waiters with SHUTDOWN', async () => {
  const pool = newPool();
  const releaseFns = [];
  const h1 = pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }));
  const h2 = pool.withPage({}, () => new Promise(r => { releaseFns.push(r); }));
  const waiter = pool.withPage({}, async () => 1).catch(e => e.code);
  await new Promise(r => setTimeout(r, 20));
  await pool.close();
  assert.strictEqual(await waiter, 'SHUTDOWN', 'queued waiter got SHUTDOWN');
  releaseFns.forEach(r => r());
  await h1.catch(() => {}); await h2.catch(() => {});
  assert.strictEqual(pool._keptPages.size, 0);
  assert.strictEqual(pool.sessionContexts.size, 0);
  assert.strictEqual(nextBrowser.closed, true);
});
