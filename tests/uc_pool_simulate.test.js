process.env.MAX_CONCURRENT_PAGES = '2';
process.env.MAX_SESSION_CONTEXTS = '2';
process.env.PAGE_QUEUE_TIMEOUT_MS = '2000';
process.env.KEPT_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.SESSION_PAGE_CLEANUP_INTERVAL_MS = '10000';
process.env.STATE_DIR_BASE = process.env.TEMP || process.cwd();

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sim-state-'));
process.env.BROWSER_STATE_DIR = stateDir;

class SimPage {
  constructor(context) {
    this.context = context;
    this.curr = '';
    this.closed = false;
    this.routes = [];
    this.gotoLog = [];
    this.actions = [];
    this.failWheel = false;
    this.mouse = {
      wheel: async (x, y) => {
        this.actions.push('wheel:' + x);
        if (this.failWheel) throw new Error('wheel kaput');
      },
      move: async () => { this.actions.push('move'); },
      click: async (x, y, opts) => { this.actions.push('click:' + (opts?.clickCount ?? 1)); }
    };
    this.links = [];
  }
  url() { return this.curr; }
  setDefaultTimeout() {}
  addInitScript() {}
  route(p, h) { this.routes.push(p); }
  async goto(u) { this.gotoLog.push(u); this.curr = u; return {}; }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async evaluate() { return undefined; }
  async waitForTimeout() {}
  locator() {
    const page = this;
    return { count: async () => page.links.length, nth: () => ({ hover: async () => { page.actions.push('hover'); } }) };
  }
}

class SimContext {
  constructor(browser) {
    this.browser = browser;
    this.pages_ = [];
    this.closed = false;
    this.opts = null;
  }
  async newPage() {
    if (this.closed) throw new Error('context closed');
    const p = new SimPage(this);
    this.pages_.push(p);
    return p;
  }
  pages() {
    if (this.closed) throw new Error('context has been closed');
    return this.pages_.filter(p => !p.closed);
  }
  async addCookies() {}
  async storageState({ path: statePath } = {}) {
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    }
    return { cookies: [], origins: [] };
  }
  async close() { this.closed = true; }
}

class SimBrowser {
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
    const ctx = new SimContext(this);
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
  nextBrowser = new SimBrowser();
  const pool = new PlaywrightPool({ resolve: () => null });
  return pool;
}

test('simulateBrowsing covers wheel/move/hover/click branches via planned rolls', async () => {
  const pool = newPool();
  const pages = [];
  // Warm up launch/context so any pool-level Math.random consumers are done.
  await pool.withPage({}, async page => { pages.push(page); await page.goto('https://warmup.example.com'); });
  const realNow = Date.now.bind(Date);
  const realRandom = Math.random.bind(Math);

  const runLinger = async (rolls, actPage, ms) => {
    Math.random = () => rolls[idx++ % rolls.length];
    try {
      await pool.withPage({ closeDelayMs: [ms, ms] }, async page => {
        pages.push(page);
        actPage(page);
        await page.goto('https://sim.example.com/x');
      });
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  };

  // Cycle all branch-roll values so every branch is hit regardless of the exact
  // per-iteration random alignment inside the linger loop.
  let idx = 0;
  await runLinger([0.2, 0.4, 0.55, 0.75, 0.95, 0.2, 0.55, 0.75, 0.95, 0.4], (page) => {
    page.links = [1, 2, 3];
  }, 1200);
  // Low fillers make the click-count roll < 0.2 → double-click branch.
  idx = 0;
  await runLinger([0.95, 0.09, 0.09, 0.09, 0.5, 0.95, 0.09, 0.09, 0.09, 0.4], (page) => {
    page.links = [];
  }, 500);

  const acts = pages.filter(Boolean).flatMap(p => p.actions);
  const joined = acts.join(',');
  const brief = joined.slice(0, 200);
  assert.ok(joined.includes('wheel:0'), brief);
  assert.ok(joined.includes('move'), brief);
  assert.ok(joined.includes('hover'), brief);
  assert.ok(joined.includes('click:1'), brief, 'single-click branch');
  await pool.close();
});

test('simulateBrowsing survives per-action throw, hover rejection, and teardown', async () => {
  const pool = newPool();
  const pages = [];
  const realNow = Date.now.bind(Date);
  let simCalls = 0;
  Date.now = () => realNow() + (simCalls++) * 250;
  const rolls = [0, 0.2, 0.9, 0.9, 0.75, 0.9, 0.9, 0.95, 0.9, 0.9, 0.9];
  const realRandom = Math.random.bind(Math);
  let idx = 0;
  Math.random = () => rolls[idx++ % rolls.length];
  try {
    await pool.withPage({ closeDelayMs: [6000, 6000] }, async page => {
      page.links = [1];
      page.failWheel = true;
      page.locator = () => ({ count: async () => 2, nth: () => ({ hover: async () => { throw new Error('hover rejected'); } }) });
      let wtCalls = 0;
      page.waitForTimeout = async () => {
        wtCalls++;
        if (wtCalls >= 3) { page.closed = true; throw new Error('page torn down mid-linger'); }
      };
      pages.push(page);
      await page.goto('https://sim.example.com/y');
    });
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
  assert.ok(pages[0].actions.filter(a => a.startsWith('wheel')).length >= 1, 'wheel called despite throw');
  await pool.close();
});

test('getBrowser relaunches after disconnect and getSearchContext handles stale context', async () => {
  const pool = newPool();
  const b1 = await pool.getBrowser();
  assert.equal(b1 === nextBrowser, true);
  b1.closed = true;
  nextBrowser = new SimBrowser();
  const b2 = await pool.getBrowser();
  assert.equal(b2 === b1, false, 'relaunched fresh browser');

  const stale = { pages: () => [1, 2] };
  pool.searchContext = stale;
  const ctx = await pool.getSearchContext();
  assert.equal(ctx === stale, true, 'healthy searchContext reused');

  pool.searchContext = { pages: () => { throw new Error('dead context'); } };
  const ctx2 = await pool.getSearchContext();
  assert.equal(ctx2 === stale, false);
  assert.equal(pool.searchContext === ctx2, true);
  await pool.close();
});
