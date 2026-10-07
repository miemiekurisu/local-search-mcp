// Wedged-tab reclamation: a page.close() that never answers is not retryable, so the
// sweep has to reach the DevTools target behind the tab. This is the bug the user sees
// as a wall of about:blank tabs after a batch of queries in the visible browser.
// Env must be set before the pool module is imported (read at load time).
process.env.USE_EXISTING_CHROME = 'true';
process.env.CDP_URL = 'http://127.0.0.1:19223';
process.env.EXISTING_CHROME_CONNECT_TIMEOUT_MS = '5000';
process.env.EXISTING_CHROME_CONNECT_RETRY_MS = '200';
process.env.MAX_CONCURRENT_PAGES = '1';
// closeFloor = min(400, 200) = 200, so a pre-close step is left 200ms -- below
// MIN_AWAITABLE_STEP_MS (250), which is what the "skip it, do not start it" test wants.
process.env.PAGE_TEARDOWN_TIMEOUT_MS = '400';
process.env.PAGE_CLOSE_MIN_TEARDOWN_MS = '400';
process.env.PAGE_CLOSE_WEDGE_MS = '500';
process.env.PAGE_ORPHAN_GRACE_MS = '2000';
// Driven by hand in these tests; the interval must not fire underneath them.
process.env.PAGE_REAPER_INTERVAL_MS = '0';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState, globalFetchState, makeResp } from './helpers/mocks.mjs';

process.env.BROWSER_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-wedge-'));

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

// When true, page.close() never settles: the wedged renderer Playwright really does
// get into, and the case the whole sweep exists for.
let hangCloses = false;
let targetSeq = 0;

function makeFakePage(context) {
  const page = {
    context,
    targetId: `T${++targetSeq}`,
    targetType: 'page',
    curr: '',
    closed: false,
    protocolClosed: false,
    closeCalls: 0,
    gotoLog: [],
    handlers: {},
    // openSessionPage attaches a framenavigated listener, so the fake needs listeners.
    on(event, cb) { (page.handlers[event] || (page.handlers[event] = [])).push(cb); },
    url: () => page.curr,
    setDefaultTimeout() {},
    addInitScript() {},
    route() {},
    async goto(u) { page.gotoLog.push(u); page.curr = u; return {}; },
    async close() {
      page.closeCalls += 1;
      if (hangCloses) return new Promise(() => {});
      page.closed = true;
    },
    isClosed() { return page.closed; },
    async evaluate() { return undefined; },
    async waitForTimeout(ms) { return new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
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
    this.jar = [];
  }
  async newPage() { const p = makeFakePage(this); this.pages_.push(p); return p; }
  pages() { if (this.closed) throw new Error('context closed'); return this.pages_.filter((p) => !p.closed); }
  async cookies() { return this.jar.map((c) => ({ ...c })); }
  async addCookies(list) { for (const c of list) this.jar.push({ ...c }); }
  async storageState({ path: statePath } = {}) {
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    }
    return { cookies: [], origins: [] };
  }
  // Playwright binds a page-scoped session: Target.getTargetInfo answers for that page
  // only, which is what makes the target lookup safe when several pages exist.
  async newCDPSession(page) {
    return {
      async send(method) {
        if (method !== 'Target.getTargetInfo') throw new Error(`unsupported ${method}`);
        return { targetInfo: { targetId: page.targetId, type: page.targetType } };
      },
      async detach() {}
    };
  }
  async close() { this.closed = true; }
}
class FakeCdpBrowser {
  constructor() {
    this.closed = false;
    this.handlers = {};
    this.detached = 0;
    // The tab the human already had open when we attached. It is theirs, not ours.
    this.contexts_ = [new FakeContext(this)];
    this.closedTargets = [];
    this.extraTargets = [];
  }
  allPages() { return this.contexts_.flatMap((c) => c.pages_); }
  on(e, cb) { this.handlers[e] = cb; }
  isConnected() { return !this.closed; }
  contexts() { return [...this.contexts_]; }
  async newContext() { throw new Error('cdp browser should not create new contexts'); }
  async newBrowserCDPSession() {
    const browser = this;
    return {
      async send(method, params = {}) {
        if (method === 'Target.getTargets') {
          const pages = browser.allPages().filter((p) => !p.closed)
            .map((p) => ({ targetId: p.targetId, type: p.targetType }));
          return { targetInfos: [...pages, ...browser.extraTargets] };
        }
        if (method === 'Target.closeTarget') {
          const page = browser.allPages().find((p) => p.targetId === params.targetId);
          if (!page || page.closed) return { success: false };
          browser.closedTargets.push(params.targetId);
          // Chromium kills the tab: the renderer goes whether or not Playwright was
          // still waiting on it, which is exactly the point of the protocol close.
          page.closed = true;
          page.protocolClosed = true;
          return { success: true };
        }
        throw new Error(`unsupported ${method}`);
      },
      async detach() { browser.detached += 1; }
    };
  }
  kill() { this.closed = true; if (this.handlers.disconnected) this.handlers.disconnected(); }
}

let cdpBrowser = null;
const st = playwrightState();
st.launchImpl = () => { throw new Error('launch must not be called in CDP mode'); };
st.cdpImpl = async () => cdpBrowser;
const gfs = globalFetchState();

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

async function newPool() {
  cdpBrowser = new FakeCdpBrowser();
  const context = cdpBrowser.contexts_[0];
  // The human tab: not opened by us, on a real page, and open before the pool ever
  // looks at this context, which is what makes it foreign.
  const theirs = await context.newPage();
  theirs.curr = 'https://news.ycombinator.com/';
  gfs.responses.push(makeResp({ json: { webSocketDebuggerUrl: 'ws://127.0.0.1:19223/devtools/browser/x' } }));
  const pool = new PlaywrightPool({ resolve: () => null });
  await pool.getBrowser();
  return { pool, context, theirs };
}

// One query whose close is abandoned, leaving exactly the tab the user complains about.
// Returns the page object: it stays on the ledger because nobody confirmed the close.
async function leaveWedgedTab(pool) {
  hangCloses = true;
  try {
    await pool.withPage({}, async () => 'ok');
  } finally {
    hangCloses = false;
  }
  assert.strictEqual(pool._ownedPages.size, 1, 'the abandoned page is still on the ledger');
  const [page] = [...pool._ownedPages.keys()];
  assert.strictEqual(pool.pageQueueStatus().wedged_pages, 1, 'the ledger knows we asked for it');
  assert.strictEqual(page.isClosed(), false, 'and it did not go away');
  return page;
}

test('a wedged tab is retired through the DevTools protocol', async () => {
  const { pool, theirs } = await newPool();
  const page = await leaveWedgedTab(pool);
  if (pool._reapTimer) clearTimeout(pool._reapTimer);
  assert.strictEqual(pool._browserCdp, null, 'no protocol session until one is needed');

  // Inside the wedge window waiting is still the right call: a close can be merely slow.
  await pool._reapOrphanPages();
  assert.strictEqual(page.closed, false, 'nothing escalated yet');
  assert.strictEqual(cdpBrowser.closedTargets.length, 0);

  await tick(600);
  await pool._reapOrphanPages();

  assert.strictEqual(page.protocolClosed, true, 'the tab behind the wedged page is gone');
  assert.deepStrictEqual(cdpBrowser.closedTargets, [page.targetId]);
  assert.strictEqual(page.closeCalls, 1, 'Playwright is not asked to close a second time');
  const status = pool.pageQueueStatus();
  assert.strictEqual(status.tracked_pages, 0, 'the ledger is clear');
  assert.strictEqual(status.wedged_pages, 0);
  assert.strictEqual(status.reaped_pages, 1);
  assert.strictEqual(status.reaped_targets, 1);
  assert.strictEqual(cdpBrowser.closed, false, 'the browser survives its wedged tab');
  assert.strictEqual(theirs.closed, false, "the human's tab is untouched");

  // Retire-once: a second sweep must not count the same tab again.
  await pool._reapOrphanPages();
  assert.strictEqual(pool.pageQueueStatus().reaped_pages, 1);
  await pool.close();
});

test('the protocol close will not empty the browser or invent a target', async () => {
  const { pool, context } = await newPool();
  const [solo] = context.pages();
  assert.strictEqual(await pool._closeTargetByCdp(solo.targetId), 'last-page',
    'the last page in the browser is the window, and the window is the browser');
  assert.strictEqual(cdpBrowser.closedTargets.length, 0, 'refused means refused');
  assert.strictEqual(await pool._closeTargetByCdp('T-not-a-target'), 'gone');

  // A dead cached session is a failed sweep, not a wedged pool: drop it, reopen next time.
  pool._browserCdp = { async send() { throw new Error('Target closed'); }, async detach() {} };
  assert.strictEqual(await pool._closeTargetByCdp(solo.targetId), 'failed');
  assert.strictEqual(pool._browserCdp, null, 'the dead session is not cached any more');

  // A browser that does not speak the page-level protocol (a mocked or non-Chromium
  // backend) must answer 'unsupported', not guess.
  cdpBrowser.newBrowserCDPSession = undefined;
  assert.strictEqual(await pool._closeTargetByCdp(solo.targetId), 'unsupported');
  delete cdpBrowser.newBrowserCDPSession;

  // Only a page target may ever become a tracked page: a session bound to something else
  // would hand the pool the ability to close the browser itself.
  const odd = await context.newPage();
  odd.targetType = 'service_worker';
  const entry = { context, targetId: null, targetAttemptedAt: 0 };
  assert.strictEqual(await pool._resolvePageTarget(odd, entry), null);
  assert.strictEqual(entry.targetId, null);
  await pool.close();
});
test('a teardown step that cannot be awaited is skipped instead of started', async () => {
  const { pool, context } = await newPool();
  await pool.withPage({}, async (page) => {
    await page.goto('https://example.com/');
    return 'ok';
  });
  const page = context.pages_[context.pages_.length - 1];
  assert.ok(page.gotoLog.includes('https://example.com/'), 'the task navigation still runs');
  assert.ok(!page.gotoLog.includes('about:blank'),
    'with 200ms left the blank navigation is not started, because an unwaited-for '
    + 'navigation is what the close then hangs on');
  assert.strictEqual(page.closeCalls, 1, 'the close is still asked for');
  assert.strictEqual(page.closed, true, 'and it answered here');
  assert.strictEqual(pool.pageQueueStatus().tracked_pages, 0);
  await pool.close();
});

test('an abandoned blank tab that survives the polite close goes by target id', async () => {
  const { pool, context, theirs } = await newPool();
  // The sweep only walks contexts the pool has adopted, and the human tab has to be
  // marked foreign before the strays exist or it would be a candidate too.
  await pool.getSharedContext();
  const stray = await context.newPage();
  stray.curr = 'about:blank';
  const decoy = await context.newPage();
  decoy.curr = 'https://keep.test/reading';

  await pool._reapOrphanPages();
  assert.strictEqual(stray.closeCalls, 0, 'one sighting is never enough');
  assert.ok(pool._strayPages.has(stray), 'it is registered as a candidate');

  hangCloses = true;
  await tick(2100);
  await pool._reapOrphanPages();
  hangCloses = false;
  assert.strictEqual(stray.closeCalls, 1, 'the first try is still the polite close');
  assert.strictEqual(stray.closed, false, 'and it did not work');

  await pool._reapOrphanPages();
  assert.strictEqual(stray.protocolClosed, true, 'the second try reaches the target');
  assert.ok(cdpBrowser.closedTargets.includes(stray.targetId));
  assert.strictEqual(decoy.closed, false, 'a tab with a page in it is never a stray');
  assert.strictEqual(theirs.closed, false, "the human's tab is never a stray");
  assert.ok(pool.pageQueueStatus().reaped_targets >= 1);
  await pool.close();
});

test('the last page of a CDP context is a window and is left alone', async () => {
  const { pool, context, theirs } = await newPool();
  theirs.closed = true; // the human closed their own tab; ours is the only one left
  await pool.getSharedContext();
  const stray = await context.newPage();
  stray.curr = 'about:blank';
  await pool._reapOrphanPages();
  await tick(2100);
  await pool._reapOrphanPages();
  assert.strictEqual(stray.closeCalls, 0, 'closing it would close the visible window');
  assert.strictEqual(stray.protocolClosed, false);
  await pool.close();
});

test('shutdown hands back the borrowed browser protocol session', async () => {
  const { pool } = await newPool();
  await leaveWedgedTab(pool);
  if (pool._reapTimer) clearTimeout(pool._reapTimer);
  await tick(600);
  await pool._reapOrphanPages();
  const session = pool._browserCdp;
  assert.ok(session, 'the sweep borrowed a browser-level protocol session');
  await pool.close();
  assert.strictEqual(pool._browserCdp, null, 'the pool stops holding it');
  assert.strictEqual(cdpBrowser.detached, 1, 'and detaches it from the attached browser');
});

// The bug behind "a wall of about:blank after a while": the CDP connection drops (the log
// says "existing Chrome disconnected"), the page ledger goes with it, and on re-attach
// every tab that is still open -- including the wedged tab we left behind -- looks like it
// belonged to the browser all along. Ownership therefore has to live on the DevTools
// target, which survives the connection, not on the Page object, which does not.
test('a tab we opened is still ours after the browser connection drops', async () => {
  const { pool, theirs } = await newPool();
  await pool.getSharedContext(); // from now on the attach-time baseline is foreign
  const page = await leaveWedgedTab(pool);
  page.curr = 'about:blank'; // exactly the tab the user complains about
  if (pool._reapTimer) clearTimeout(pool._reapTimer);
  await tick(50);
  assert.ok(pool._ourTargetIds.has(page.targetId), 'the target id is recorded when the page opens');

  // The connection drops: every Page object we knew about is gone, the tab is not.
  pool.resetConnectedBrowser('test disconnect');
  assert.strictEqual(pool._ownedPages.size, 0, 'the ledger went with the connection');
  assert.ok(pool._ourTargetIds.has(page.targetId), 'the ownership record did not');
  assert.strictEqual(page.closed, false, 'and the tab itself is still open');

  // Re-attach to the same browser and adopt its context a second time.
  gfs.responses.push(makeResp({ json: { webSocketDebuggerUrl: 'ws://127.0.0.1:19223/devtools/browser/x' } }));
  await pool.getBrowser();
  await pool.getSharedContext();
  await tick(50);
  assert.strictEqual(pool._foreignPages.has(theirs), true, "the human's tab is still somebody else's");
  assert.strictEqual(pool._foreignPages.has(page), false, 'our own leftover is not');

  // The revisit only re-claims ownership; it is the sweep that closes the tab.
  hangCloses = true;
  await pool._reapOrphanPages();
  await tick(2100);
  await pool._reapOrphanPages();
  hangCloses = false;
  await pool._reapOrphanPages();
  assert.strictEqual(page.protocolClosed, true, 'the leftover from before the reconnect is retired');
  assert.ok(cdpBrowser.closedTargets.includes(page.targetId));
  assert.strictEqual(theirs.closed, false, "the human's tab survived it");
  await pool.close();
});

// An interactive (session) page is opened by us and closed by a TTL sweep that used to
// fire-and-forget the close, and the page was never registered at all: a wedge there
// leaked a tab that no reaper was allowed to touch.
test('a wedged interactive session page is retired too', async () => {
  const { pool, theirs } = await newPool();
  await pool.getSharedContext();
  hangCloses = true;
  try {
    await pool.openSessionPage({ sessionKey: 'google' });
  } finally {
    hangCloses = false;
  }
  const page = pool.sessionPages.get('google').page;
  assert.strictEqual(pool.pageQueueStatus().session_pages, 1, 'the pinned page is reported');
  assert.ok(pool._ownedPages.has(page), 'and it is on the ledger');

  // While it is pinned the sweep keeps its hands off: a human may be logging in there.
  if (pool._reapTimer) clearTimeout(pool._reapTimer);
  await pool._reapOrphanPages();
  assert.strictEqual(page.closed, false, 'a pinned page is not a leaked page');

  // The TTL sweep unpins it and asks it to close; that close never answers.
  pool.sessionPages.get('google').lastAccessedAt = 0;
  hangCloses = true;
  pool._cleanupSessionPages();
  hangCloses = false;
  if (pool._reapTimer) clearTimeout(pool._reapTimer);
  assert.strictEqual(pool.sessionPages.size, 0, 'it is no longer pinned');
  assert.strictEqual(pool.pageQueueStatus().wedged_pages, 1, 'and the ledger saw the close');

  await tick(600);
  await pool._reapOrphanPages();
  assert.strictEqual(page.protocolClosed, true, 'the wedged session tab goes by target id');
  assert.strictEqual(theirs.closed, false, "the human's tab is untouched");
  assert.strictEqual(pool.pageQueueStatus().tracked_pages, 0);
  await pool.close();
});