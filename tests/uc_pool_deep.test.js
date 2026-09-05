import './helpers/mocks.mjs';

process.env.USE_EXISTING_CHROME = 'true';
process.env.CDP_URL = 'http://127.0.0.1:9222';
process.env.EXISTING_CHROME_CONNECT_TIMEOUT_MS = '5000';
process.env.EXISTING_CHROME_CONNECT_RETRY_MS = '100';
process.env.BROWSER_RESTORE_LOCALSTORAGE = 'true';
process.env.BROWSER_RESTORE_MAX_ORIGINS = '3';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { undiciState, jsonResponse, sleep } from './helpers/mocks.mjs';

const undici = undiciState();
const st = await import('./helpers/mocks.mjs');
const { playwrightState } = st;

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-pool-'));
process.env.BROWSER_STATE_DIR = STATE_DIR;

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:9222')) {
    undici.calls.push({ url: u, init: rest[0] });
    const next = undici.responses.length ? undici.responses.shift() : null;
    if (typeof next === 'function') return next(url, ...rest);
    return next ?? jsonResponse({ webSocketDebuggerUrl: 'ws://default' });
  }
  return realFetch(url, ...rest);
};
test.after(() => { globalThis.fetch = realFetch; });

function makePage(over = {}) {
  const page = {
    closedGently: false,
    gotoCalls: [],
    evalCalls: [],
    isClosed: () => page.closedGently,
    close: async () => { page.closedGently = true; },
    goto: async (url, opts) => { page.gotoCalls.push({ url, opts }); return { ok: true }; },
    evaluate: async (fn, args) => { page.evalCalls.push(args); return undefined; },
    addInitScript: async () => {},
    route: () => {},
    url: () => 'http://page',
    ...over
  };
  return page;
}

function makeContext(over = {}) {
  const pages = [];
  const ctx = {
    closedGently: false,
    pagesList: pages,
    addCookies: async () => { ctx.cookiesAdded = true; },
    pages: () => { if (ctx.pagesThrow) throw new Error('context torn down'); return pages; },
    newPage: async () => { const p = makePage(); pages.push(p); return p; },
    close: async () => { ctx.closedGently = true; },
    ...over
  };
  return ctx;
}

function makeBrowser({ isConnectedValue = true, fail = null, contexts = [] } = {}) {
  const b = {
    cbs: {},
    closeCalled: false,
    isConnected: () => isConnectedValue,
    on: (ev, cb) => { (b.cbs[ev] = b.cbs[ev] || []).push(cb); },
    contexts: () => contexts,
    newContext: async (opts) => { const c = makeContext(); contexts.push(c); return c; },
    close: async () => { b.closeCalled = true; }
  };
  if (fail !== null) throw fail;
  return b;
}

function kvAppState() {
  const st = playwrightState();
  st.cdpConnects = [];
  return st;
}

test('resolveCdpEndpoint fetches webSocketDebuggerUrl and rejects bad status', async () => {
  const pool = new PlaywrightPool({});
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' })];
  assert.equal(await pool.resolveCdpEndpoint(), 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(undici.calls[undici.calls.length - 1].url, 'http://127.0.0.1:9222/json/version');

  undici.responses = [jsonResponse({}, 500)];
  await assert.rejects(pool.resolveCdpEndpoint(), /HTTP 500/);
});

test('connectToExistingChrome retries dead browser and succeeds', async () => {
  const pstate = kvAppState();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' }), jsonResponse({ webSocketDebuggerUrl: 'ws://x2' })];
  let calls = 0;
  pstate.cdpImpl = async () => {
    calls += 1;
    if (calls === 1) return makeBrowser({ isConnectedValue: false });
    return makeBrowser({ isConnectedValue: true });
  };
  const pool = new PlaywrightPool({});
  const browser = await pool.getBrowser();
  assert.ok(browser.isConnected());
  assert.ok(pool.connectedBrowser);
});

test('disconnected event resets the pool and reconnects on next getBrowser', async () => {
  const pstate = kvAppState();
  const b1 = makeBrowser();
  pstate.cdpImpl = async () => b1;
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' }), jsonResponse({ webSocketDebuggerUrl: 'ws://x2' })];
  const pool = new PlaywrightPool({});
  const first = await pool.getBrowser();

  const b2 = makeBrowser();
  pstate.cdpImpl = async () => b2;
  first.cbs['disconnected'][0]();
  assert.equal(pool.connectedBrowser, null);

  const second = await pool.getBrowser();
  assert.equal(second, b2);
});

test('stale connected browser is replaced via browserIsConnected check', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://stale-endpoint' })];
  const pool = new PlaywrightPool({});
  const stale = makeBrowser({ isConnectedValue: true });
  stale.isConnected = () => false;
  pool.connectedBrowser = stale;
  const browser = await pool.getBrowser();
  assert.notEqual(browser, stale);
  assert.ok(browser.isConnected());
});

test('getSharedContext uses browser contexts, torn context recovers via newContext', async () => {
  const pstate = kvAppState();
  const existing = makeContext();
  pstate.cdpImpl = async () => makeBrowser({ contexts: [existing] });
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' })];
  const pool = new PlaywrightPool({});
  const shared = await pool.getSharedContext();
  assert.equal(shared, existing);
  assert.equal(await pool.getSharedContext(), existing);

  // torn shared context + browser with no contexts -> torn recovered (485-486) + newContext (493)
  const fallbackCtx = makeContext();
  const fresh = makeBrowser({ contexts: [] });
  fresh.newContext = async () => fallbackCtx;
  pool.connectedBrowser = fresh;
  existing.pagesThrow = true;
  pool.sharedContext = existing;
  const shared2 = await pool.getSharedContext();
  assert.equal(shared2, fallbackCtx);
  assert.equal(await pool.getSharedContext(), fallbackCtx);
});

test('hydrateSessionContext restores cookies and localStorage per origin', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' })];
  fs.writeFileSync(path.join(STATE_DIR, 'sess_w_loc.json'), JSON.stringify({
    cookies: [{ name: 'c', value: 'v' }],
    origins: [
      { origin: 'https://a.example', localStorage: [{ name: 'k', value: 'v' }] },
      { origin: 'https://broken.example', localStorage: null },
      { origin: 'https://boom.example', localStorage: [{ name: 'k2', value: 'v2' }] }
    ]
  }));
  const pool = new PlaywrightPool({});
  const ctx = makeContext();
  const pagesMade = [];
  let gotoSeq = 0;
  ctx.newPage = async () => {
    gotoSeq += 1;
    pagesMade.push(gotoSeq);
    if (gotoSeq === 2) {
      const p = makePage();
      p.goto = async () => { throw new Error('nav boom'); };
      ctx.pagesList.push(p);
      return p;
    }
    const np = makePage();
    ctx.pagesList.push(np);
    return np;
  };
  await pool.hydrateSessionContext(ctx, 'sess_w_loc');
  assert.equal(ctx.cookiesAdded, true);
  assert.ok(ctx.pagesList.length >= 2, `pages: ${pagesMade}`);
  assert.ok(ctx.pagesList.some(p => p.evalCalls.length === 1), 'localStorage evaluate ran');
  await pool.hydrateSessionContext(ctx, 'sess_w_loc');

  fs.writeFileSync(path.join(STATE_DIR, 'sess_bad.json'), '{ not json');
  const ctx2 = makeContext();
  await pool.hydrateSessionContext(ctx2, 'sess_bad');
  assert.equal(ctx2.cookiesAdded, undefined);

  fs.writeFileSync(path.join(STATE_DIR, 'sess_empty.json'), JSON.stringify({ cookies: [] }));
  await pool.hydrateSessionContext(makeContext(), 'sess_missing');
});

test('openSessionPage and saveSessionState guard missing keys', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' })];
  const pool = new PlaywrightPool({});
  await assert.rejects(pool.openSessionPage({}), /sessionKey is required/);
  await assert.rejects(pool.saveSessionState(''), /sessionKey is required/);
});

test('session page cleanup removes stale and closed pages', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' })];
  const pool = new PlaywrightPool({});
  const fresh = makePage();
  const closed = makePage();
  closed.closedGently = true;
  const stale = makePage();
  pool.sessionPages.set('s:fresh', { page: fresh, lastAccessedAt: Date.now() });
  pool.sessionPages.set('s:closed', { page: closed, lastAccessedAt: Date.now() });
  pool.sessionPages.set('s:stale', { page: stale, lastAccessedAt: Date.now() - 60 * 60 * 1000 });
  await pool._cleanupSessionPages();
  await sleep(200);
  assert.ok(pool.sessionPages.has('s:fresh'));
  assert.ok(!pool.sessionPages.has('s:closed'));
  assert.ok(!pool.sessionPages.has('s:stale'));
  assert.equal(stale.closedGently, true);
});

test('releaseSearchResources closes search context and browser when not CDP-attached', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [jsonResponse({ webSocketDebuggerUrl: 'ws://x' })];
  const pool = new PlaywrightPool({});
  const p1 = makePage();
  const p2 = makePage();
  const sctx = makeContext();
  sctx.pagesList.push(p1, p2);
  pool.searchContext = sctx;
  pool.browser = makeBrowser();

  const out = await pool.releaseSearchResources();
  assert.deepEqual(out, { released: true });
  assert.equal(p1.closedGently, true);
  assert.equal(p2.closedGently, true);
  assert.equal(pool.searchContext, null);
  assert.equal(pool.browser, null);

  // second pass: nothing to release
  assert.deepEqual(await pool.releaseSearchResources(), { released: true });

  const kept = makePage();
  const skeyEntry = { page: makePage(), context: makeContext(), ownsContext: true, createdAt: Date.now() };
  pool._keptPages.set('session:keep', skeyEntry);
  pool._keptPages.set('eph:drop', { page: kept, context: makeContext(), ownsContext: false, createdAt: Date.now() });
  await pool.releaseSearchResources();
  await sleep(250);
  assert.ok(pool._keptPages.has('session:keep'), 'kept session page survives');
  assert.ok(!pool._keptPages.has('eph:drop'), 'ephemeral kept page removed');
  assert.equal(kept.closedGently, true);
});

test('close() drains kept pages, session pages, contexts, and browsers', async () => {
  const pstate = kvAppState();
  pstate.cdpImpl = async () => makeBrowser();
  undici.responses = [
    jsonResponse({ webSocketDebuggerUrl: 'ws://x' }),
    jsonResponse({ webSocketDebuggerUrl: 'ws://x2' })
  ];
  // pool A: CDP-attached -> sharedContext close skipped, context close when not connected
  const pool = new PlaywrightPool({});
  const page = makePage();
  const parked = { page, context: makeContext(), ownsContext: true, createdAt: Date.now() };
  pool._keptPages.set('k:1', parked);
  const sp = makePage();
  pool.sessionPages.set('s:1', { page: sp, lastAccessedAt: Date.now() });
  const sctxPage = makePage();
  const sctx = makeContext();
  sctx.pagesList.push(sctxPage);
  pool.searchContext = sctx;
  await pool.close();

  assert.equal(page.closedGently, true);
  assert.equal(parked.context.closedGently, true);
  assert.equal(sp.closedGently, true);
  assert.equal(sctxPage.closedGently, true);
  assert.ok(sctx.closedGently);

  // pool B: launched mode (no connectedBrowser) -> browser + shared context closed
  const pool2 = new PlaywrightPool({});
  pool2.connectedBrowser = null;
  pool2.browser = makeBrowser();
  const sharedCtx = makeContext();
  const sharedPage = makePage();
  sharedCtx.pagesList.push(sharedPage);
  pool2.sharedContext = sharedCtx;
  await pool2.close();
  assert.equal(sharedPage.closedGently, true);
  assert.ok(sharedCtx.closedGently);
});

test('launchOptions attaches uBlock args when the extension directory exists', async () => {
  const origCwd = process.cwd();
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-ublock-'));
  fs.mkdirSync(path.join(extRoot, 'extensions', 'ublock-origin'), { recursive: true });
  process.chdir(extRoot);
  try {
    const pool = new PlaywrightPool({});
    const opts = pool.launchOptions();
    assert.ok(opts.args.some(a => a.startsWith('--load-extension=') && a.endsWith('ublock-origin')), 'uBlock load arg present');
    assert.ok(opts.args.some(a => a.startsWith('--disable-extensions-except=') && a.endsWith('ublock-origin')));
    fs.rmSync(path.join(extRoot, 'extensions', 'ublock-origin'), { recursive: true });
    const opts2 = pool.launchOptions();
    assert.ok(!opts2.args.some(a => a.startsWith('--load-extension=')), 'no extension args when dir missing');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(extRoot, { recursive: true, force: true });
  }
});
