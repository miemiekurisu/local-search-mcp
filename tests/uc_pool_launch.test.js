import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playwrightState, sleep } from './helpers/mocks.mjs';

// install mock hooks BEFORE loading the module that imports playwright
playwrightState();
const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

function makePage(over = {}) {
  const page = {
    closedGently: false,
    isClosed: () => page.closedGently,
    close: async () => { page.closedGently = true; },
    goto: async () => ({}),
    evaluate: async () => undefined,
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
    pages: () => { if (ctx.pagesThrow) throw new Error('context torn down'); return pages; },
    newPage: async () => { const p = makePage(); pages.push(p); return p; },
    close: async () => { ctx.closedGently = true; },
    ...over
  };
  return ctx;
}

function makeBrowser({ isConnectedValue = true } = {}) {
  const b = {
    cbs: {},
    contextsList: [],
    closeCalled: false,
    isConnected: () => isConnectedValue,
    on: (ev, cb) => { (b.cbs[ev] = b.cbs[ev] || []).push(cb); },
    contexts: () => b.contextsList,
    newContext: async () => { const c = makeContext(); b.contextsList.push(c); return c; },
    close: async () => { b.closeCalled = true; }
  };
  return b;
}

const pstate = playwrightState();

test('launched mode: torn search context recovers and healthy context reused', async () => {
  const browser = makeBrowser();
  pstate.launchImpl = async () => browser;
  const pool = new PlaywrightPool({});
  const torn = makeContext();
  torn.pagesThrow = true;
  pool.searchContext = torn;

  const ctx = await pool.getSearchContext();
  assert.notEqual(ctx, torn);
  assert.equal(pool.searchContext, ctx);

  const again = await pool.getSearchContext();
  assert.equal(again, ctx, 'healthy searchContext reused');

  pool.searchContext = makeContext();
  pool.searchContext.pagesThrow = true;
  const third = await pool.getSearchContext();
  assert.notEqual(third, torn);
});

test('launched mode: releaseSearchResources closes search pages and browser', async () => {
  const browser = makeBrowser();
  pstate.launchImpl = async () => browser;
  const pool = new PlaywrightPool({});
  const p1 = makePage();
  const p2 = makePage();
  const sctx = makeContext();
  sctx.pagesList.push(p1, p2);
  pool.searchContext = sctx;
  pool.browser = browser;

  assert.deepEqual(await pool.releaseSearchResources(), { released: true });
  assert.equal(p1.closedGently, true);
  assert.equal(p2.closedGently, true);
  assert.equal(sctx.closedGently, true);
  assert.equal(pool.searchContext, null);
  assert.equal(pool.browser, null);
  assert.equal(browser.closeCalled, true);

  const kept = makePage();
  pool._keptPages.set('eph:drop', { page: kept, context: makeContext(), ownsContext: false, createdAt: Date.now() });
  pool._keptPages.set('session:keep', { page: makePage(), context: makeContext(), ownsContext: true, createdAt: Date.now() });
  await pool.releaseSearchResources();
  await sleep(250);
  assert.equal(kept.closedGently, true);
  assert.ok(pool._keptPages.has('session:keep'));
  assert.ok(!pool._keptPages.has('eph:drop'));
});

test('launched mode: close() closes shared context too', async () => {
  const browser = makeBrowser();
  pstate.launchImpl = async () => browser;
  const pool = new PlaywrightPool({});
  const shared = makeContext();
  const sharedPage = makePage();
  shared.pagesList.push(sharedPage);
  pool.sharedContext = shared;

  await pool.close();
  assert.equal(sharedPage.closedGently, true);
  assert.ok(shared.closedGently, 'sharedContext closed when browser not CDP-attached');
});

