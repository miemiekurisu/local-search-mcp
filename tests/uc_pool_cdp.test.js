process.env.USE_EXISTING_CHROME = 'true';
process.env.CDP_URL = 'http://127.0.0.1:19222';
process.env.EXISTING_CHROME_CONNECT_TIMEOUT_MS = '5000';
process.env.EXISTING_CHROME_CONNECT_RETRY_MS = '200';
process.env.BROWSER_RESTORE_LOCALSTORAGE = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState, globalFetchState, makeResp } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cdp-'));
process.env.BROWSER_STATE_DIR = stateDir;

function makeFakePage() {
  const page = {
    curr: '',
    closed: false,
    routes: [],
    url: () => page.curr,
    setDefaultTimeout() {},
    addInitScript() {},
    route(pattern) { page.routes.push(pattern); },
    async goto(u, opts = {}) { page.curr = u; return {}; },
    async close() { page.closed = true; },
    isClosed() { return page.closed; },
    async evaluate() { return undefined; },
    async waitForTimeout(ms) { return new Promise(r => setTimeout(r, Math.min(ms, 5))); },
    mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} },
    locator() { return { count: async () => 0, nth: () => ({ hover: async () => {} }) }; }
  };
  return page;
}

class FakeContext {
  constructor(browser) {
    this.browser = browser;
    this.pages_ = [];
    this.closed = false;
    this.opts = null;
    this.failStorageState = false;
  }
  async newPage() { const p = makeFakePage(); p.context = this; this.pages_.push(p); return p; }
  pages() { if (this.closed) throw new Error('context closed'); return this.pages_.filter(p => !p.closed); }
  async addCookies(c) {}
  async storageState({ path: statePath } = {}) {
    if (this.failStorageState) throw new Error('cdp storage fail');
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: 'cdp1', value: 'v' }], origins: [] }));
    }
    return { cookies: [], origins: [] };
  }
  async close() { this.closed = true; }
}

class FakeCdpBrowser {
  constructor() {
    this.closed = false;
    this.handlers = {};
    this.contexts_ = [new FakeContext(this)];
  }
  on(e, cb) { this.handlers[e] = cb; }
  isConnected() { return !this.closed; }
  contexts() { return [...this.contexts_]; }
  async newContext() { throw new Error('cdp browser should not create new contexts'); }
  kill() { this.closed = true; if (this.handlers['disconnected']) this.handlers['disconnected'](); }
}

let cdpBrowser = null;
let cdpThrow = false;
const st = playwrightState();
st.launchImpl = () => { throw new Error('launch must not be called in CDP mode'); };
st.cdpImpl = async () => {
  if (cdpThrow) throw new Error('ws endpoint dead');
  return cdpBrowser;
};

const gfs = globalFetchState();
const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

function enqueueCdpVersion() {
  gfs.responses.push(makeResp({ json: { webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/browser/x' } }));
}

test('CDP: resolveCdpEndpoint passthrough for non-http and path forms', async () => {
  const pool = new PlaywrightPool({ resolve: () => null });
  // CDP_URL constant captured at import: http://127.0.0.1:19222 (no /json)
  gfs.responses.length = 0;
  enqueueCdpVersion();
  const ep = await pool.resolveCdpEndpoint();
  assert.strictEqual(ep, 'ws://127.0.0.1:19222/devtools/browser/x');
  assert.ok(gfs.calls.at(-1).url.endsWith('/json/version'));
  gfs.responses.length = 0;
  await pool.close();
});

test('CDP: connect, shared-cdp context reuse, resource release non-destructive', async () => {
  enqueueCdpVersion();
  cdpBrowser = new FakeCdpBrowser();
  const pool = new PlaywrightPool({ resolve: () => null });
  const b = await pool.getBrowser();
  assert.strictEqual(b, cdpBrowser);
  // second call reuses without refetch
  const callsBefore = gfs.calls.length;
  assert.strictEqual(await pool.getBrowser(), cdpBrowser);
  assert.strictEqual(gfs.calls.length, callsBefore);
  // withPage in cdp mode → shared context, no stealth injection route
  const res = await pool.withPage({ sessionKey: 'cdp1', reuseSession: true }, async page => {
    assert.strictEqual(pool.sessionContexts.size, 0, 'cdp mode does not create session contexts');
    page.goto('https://cdp.example.com');
    return { ok: true };
  });
  assert.strictEqual(res.ok, true);
  // openSessionPage → shared-cdp mode
  const r = await pool.openSessionPage({ sessionKey: 'cdp2', url: 'https://cdp2.example.com' });
  assert.strictEqual(r.mode, 'shared-cdp');
  assert.strictEqual(pool.sessionPages.size, 1);
  await pool.openSessionPage({ sessionKey: 'cdp3' });
  await pool.openSessionPage({ sessionKey: 'cdp4' });
  await pool.openSessionPage({ sessionKey: 'cdp5' });
  await pool.openSessionPage({ sessionKey: 'cdp6' });
  assert.strictEqual(pool.sessionPages.size, 3, 'session pages evicted at MAX_SESSION_CONTEXTS');
  assert.strictEqual(pool.sessionPages.has('cdp2'), false, 'oldest evicted');
  const status = pool.sessionStatus('cdp2');
  assert.strictEqual(status.browser_mode, 'existing-cdp');
  assert.strictEqual(status.cdp_url, 'http://127.0.0.1:19222');
  // saveSessionState through shared context
  const saved = await pool.saveSessionState('cdp2');
  assert.strictEqual(saved.saved, true);
  // release while busy / idle via cdp keeps connectedBrowser alive
  const rel = await pool.releaseSearchResources();
  assert.deepStrictEqual(rel, { released: true });
  assert.strictEqual(pool.connectedBrowser, cdpBrowser, 'cdp browser NOT closed by releaseSearchResources');
  // close(): keeps external browser alive but drops reference
  await pool.close();
  assert.strictEqual(pool.connectedBrowser, null);
  assert.strictEqual(cdpBrowser.closed, false, 'external cdp browser survives pool close');
});

test('CDP: reset on disconnected clears shared state and kept pages', async () => {
  const pool = new PlaywrightPool({ resolve: () => null });
  const fake = new FakeCdpBrowser();
  fake.on('disconnected', () => pool.resetConnectedBrowser('CDP connection closed'));
  pool.connectedBrowser = fake;
  pool.sharedContext = fake.contexts_[0];
  await pool.withPage({ sessionKey: 'keepme' }, async () => ({ keepPageOpen: true }));
  assert.strictEqual(pool._keptPages.size, 1);
  fake.kill();
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(pool.connectedBrowser, null, 'disconnected cleared');
  assert.strictEqual(pool.sharedContext, null);
  assert.strictEqual(pool.searchContext, null);
  assert.strictEqual(pool.sessionPages.size, 0);
  assert.strictEqual(pool._keptPages.size, 0, 'reset clears kept pages');
  assert.strictEqual([...fake.contexts_[0].pages_].every(p => p.closed), true, 'kept pages closed via reset');
  await pool.close();
});

test('CDP: unreachable endpoint exhausts connect timeout → BROWSER_UNAVAILABLE', async () => {
  cdpThrow = true;
  const pool = new PlaywrightPool({ resolve: () => null });
  const t0 = Date.now();
  let err = null;
  await pool.getBrowser().catch(e => { err = e; });
  assert.ok(err, 'getBrowser throws');
  assert.strictEqual(err.code, 'BROWSER_UNAVAILABLE');
  assert.strictEqual(err.details.browser_mode, 'existing-cdp');
  const detailsLast = err.details.last_error || '';
  assert.ok(detailsLast.length > 0, `last_error present: ${JSON.stringify(detailsLast)}`);
  assert.strictEqual(err.details.connect_timeout_ms, 5000);
  assert.ok(Date.now() - t0 >= 4800, 'waited the full connect timeout');
});
