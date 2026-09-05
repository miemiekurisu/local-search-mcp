process.env.BROWSER_RESTORE_LOCALSTORAGE = 'true';
process.env.BROWSER_RESTORE_MAX_ORIGINS = '2';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-restore-'));
process.env.BROWSER_STATE_DIR = stateDir;

function makeFakePage(context) {
  const page = {
    context,
    curr: '',
    closed: false,
    routes: [],
    gotoLog: [],
    initScripts: [],
    url: () => page.curr,
    setDefaultTimeout() {},
    addInitScript(fn) { page.initScripts.push(fn); },
    route(pattern, handler) { page.routes.push(pattern); },
    async goto(u, opts = {}) { page.gotoLog.push(u); page.curr = u; return {}; },
    async close() { page.closed = true; },
    isClosed() { return page.closed; },
    async evaluate(fn, args) {
      if (fn === 'storageWrite') return undefined;
      evalEntries.push(args);
      return undefined;
    },
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
    this.cookiesAdded = [];
    this.closed = false;
    this.opts = null;
  }
  async newPage() { const p = makeFakePage(this); this.pages_.push(p); return p; }
  pages() { return this.pages_.filter(p => !p.closed); }
  async addCookies(c) { this.cookiesAdded.push(c); }
  async storageState({ path: statePath } = {}) {
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        cookies: [{ name: 'sid', value: 'x' }],
        origins: [
          { origin: 'https://r1.example.com', localStorage: [{ name: 'a', value: '1' }] },
          { origin: 'https://r2.example.com', localStorage: [{ name: 'b', value: '2' }] },
          { origin: 'https://r3.example.com', localStorage: [{ name: 'c', value: '3' }] },
          { origin: '', localStorage: [{ name: 'skip', value: '' }] }
        ]
      }));
    }
    return { cookies: [], origins: [] };
  }
  async close() { this.closed = true; this.pages_.forEach(p => { p.closed = true; }); }
}

class FakeBrowser {
  constructor(sharedCtx = null) {
    this.sharedCtx = sharedCtx;
    this.contexts_ = sharedCtx ? [sharedCtx] : [];
    this.closed = false;
    this.handlers = {};
    this.newContextOpts = [];
  }
  on(e, cb) { this.handlers[e] = cb; }
  isConnected() { return !this.closed; }
  contexts() { return [...this.contexts_]; }
  async newContext(opts = {}) {
    if (this.closed) throw new Error('browser closed');
    const ctx = new FakeContext(this);
    ctx.opts = opts;
    this.newContextOpts.push(opts);
    this.contexts_.push(ctx);
    return ctx;
  }
  async close() { this.closed = true; if (this.handlers['disconnected']) this.handlers['disconnected'](); }
}

let nextBrowser = null;
const st = playwrightState();
st.launchImpl = () => nextBrowser;
const evalEntries = [];
globalThis.__recordHydrateEval = evalEntries;

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

test('localStorage restore restores bounded origins on first hydrate, skips repeats and skips empty origin', async () => {
  nextBrowser = new FakeBrowser();
  const pool = new PlaywrightPool({ resolve: () => null });
  // pre-existing saved state on disk
  fs.writeFileSync(path.join(stateDir, 'restore1.json'), JSON.stringify({
    cookies: [{ name: 'sid', value: 'x' }],
    origins: [
      { origin: 'https://r1.example.com', localStorage: [{ name: 'a', value: '1' }] },
      { origin: 'https://r2.example.com', localStorage: [{ name: 'b', value: '2' }] },
      { origin: 'https://r3.example.com', localStorage: [{ name: 'c', value: '3' }] },
      { origin: '', localStorage: [{ name: 'skip', value: '' }] }
    ]
  }));
  const { context } = await pool.getSessionContext('restore1');
  assert.strictEqual(context.cookiesAdded.length, 1, 'cookies hydrated');
  const originGotos = [];
  for (const p of context.pages_) originGotos.push(...p.gotoLog);
  assert.deepStrictEqual(originGotos.filter(u => u.startsWith('https://r')), ['https://r1.example.com', 'https://r2.example.com'], 'only first 2 origins restored (empty origin skipped)');
  assert.ok(context.pages_.every(p => p.closed), 'restore helper pages closed after use');
  // second getSessionContext for same session → no re-hydrate
  await pool.getSessionContext('restore1');
  const afterCount = context.pages_.length;
  await pool.getSessionContext('restore1');
  assert.strictEqual(context.pages_.length, afterCount, 'hydrate only once per session');
  await pool.close();
});

test('localStorage restore survives malformed state file via catch path', async () => {
  nextBrowser = new FakeBrowser();
  const pool = new PlaywrightPool({ resolve: () => null });
  fs.writeFileSync(path.join(stateDir, 'badstate.json'), '{not json');
  const { context } = await pool.getSessionContext('badstate');
  assert.strictEqual(context.pages_.length, 0, 'no restore attempts on parse failure');
  assert.ok(fs.existsSync(path.join(stateDir, 'badstate.json')));
  await pool.close();
});
