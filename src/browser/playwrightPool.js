import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { CONFIG, safeJoin } from '../config/index.js';
import { abortError, signalRemainingMs } from '../utils/abort.js';

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const USE_EXISTING_CHROME = process.env.USE_EXISTING_CHROME === 'true';
const EXISTING_CHROME_CONNECT_TIMEOUT_MS = envInt('EXISTING_CHROME_CONNECT_TIMEOUT_MS', 60000, 5000);
const EXISTING_CHROME_CONNECT_RETRY_MS = envInt('EXISTING_CHROME_CONNECT_RETRY_MS', 500, 100);
const VISIBLE_BROWSER_PROFILE_DIR = process.env.VISIBLE_BROWSER_PROFILE_DIR || null;
const LOW_POWER_DEVICE = process.env.LOW_POWER_DEVICE === 'true';
const MAX_CONCURRENT_PAGES = envInt('MAX_CONCURRENT_PAGES', LOW_POWER_DEVICE ? 1 : 2, 1);
const MAX_SESSION_CONTEXTS = envInt('MAX_SESSION_CONTEXTS', LOW_POWER_DEVICE ? 1 : 3, 1);
const KEPT_PAGE_TTL_MS = envInt('KEPT_PAGE_TTL_MS', 300000, 10000);
const KEPT_PAGE_CLEANUP_INTERVAL_MS = envInt('KEPT_PAGE_CLEANUP_INTERVAL_MS', 60000, 10000);
// Hard cap on parked pages (keepPageOpen). They live outside the page-slot
// accounting, so without a cap MAX_CONCURRENT_PAGES does not bound resident
// Chromium at all: every blocked/captcha page that a browser fetch hits parks its
// page -- and, in launch mode, the whole ephemeral context it owns -- for
// KEPT_PAGE_TTL_MS (5 min) under a unique key. A handful of parallel clients
// scraping bot-walled sites therefore leaves a dozen live contexts on a host that
// was configured for exactly one page, which is how a small device OOMs.
const MAX_KEPT_PAGES = envInt('MAX_KEPT_PAGES', LOW_POWER_DEVICE ? 2 : 4, 1);
const SESSION_PAGE_TTL_MS = envInt('SESSION_PAGE_TTL_MS', 600000, 60000);
const SESSION_PAGE_CLEANUP_INTERVAL_MS = envInt('SESSION_PAGE_CLEANUP_INTERVAL_MS', 60000, 10000);
const PAGE_QUEUE_TIMEOUT_MS = envInt('PAGE_QUEUE_TIMEOUT_MS', 60000, 1000);
// A queued attempt needs at least this much of its own budget left to be worth
// queueing for: with less, even an instant slot hand-off could not navigate and
// read before the caller gives up, so the queue reports congestion up front.
const MIN_USEFUL_PAGE_WAIT_MS = 1000;
// Congestion control for the one shared browser. On a low-power device
// MAX_CONCURRENT_PAGES is 1, so these two knobs decide what "everyone else is
// waiting" means: MAX_PAGE_QUEUE_WAITERS bounds the wait queue (overflow fails
// fast instead of parking dozens of hung HTTP/MCP requests behind one stuck
// browser), and the anti-bot page linger is skipped while others are queued.
const MAX_PAGE_QUEUE_WAITERS = envInt('MAX_PAGE_QUEUE_WAITERS', Math.max(4, MAX_CONCURRENT_PAGES * 4), 0);
const KEEP_LINGER_UNDER_LOAD = process.env.BROWSER_KEEP_LINGER_UNDER_LOAD === 'true';
// Hard cap on how long *closing* a page may keep holding its slot. storageState(),
// goto('about:blank') and page.close() on a wedged page block for the Playwright
// protocol timeout -- tens of seconds, and in the known close() hangs, forever.
// A cancelled or timed-out request is precisely the case that leaves a wedged page
// behind, so without this bound cancellation does not actually free the slot: on a
// MAX_CONCURRENT_PAGES=1 host every later client queues behind a dead page until
// restart. We wait a bounded moment, release the slot, and let the browser finish
// closing in the background (a brief second page in the browser is far cheaper
// than a pool that is permanently stuck at "queue full").
const PAGE_TEARDOWN_TIMEOUT_MS = envInt('PAGE_TEARDOWN_TIMEOUT_MS', 3000, 100);
// The one step of teardown that must never be starved. PAGE_TEARDOWN_TIMEOUT_MS is a
// single budget shared by the cookie snapshot, the about:blank navigation and the
// close; on a slow host the first two can eat all of it, and boundedTeardown(close, 0)
// abandons the wait the moment it starts. An abandoned close is exactly what puts a tab
// in the user's visible browser -- we have just navigated it to about:blank, so that is
// the tab they then see piling up. The close always keeps this much of the budget.
const PAGE_CLOSE_MIN_TEARDOWN_MS = envInt('PAGE_CLOSE_MIN_TEARDOWN_MS', 1200, 0);
// Last-resort GC for pages nobody closed. A tab outlives its owner two ways: the
// bounded close above timed out and the abandoned page.close() never completed, or the
// tab was spawned by a click (a target=_blank result, or one of the blind coordinate
// clicks in simulateBrowsing) and only ever adopted. Neither shows up in the page-slot
// counter, so without a sweep they stay open for the lifetime of the browser.
const PAGE_REAPER_INTERVAL_MS = envInt('PAGE_REAPER_INTERVAL_MS', LOW_POWER_DEVICE ? 20000 : 30000, 0);
// How long a page must be provably unowned (and, for an unattributable tab, seen by
// the sweep twice) before the reaper touches it. Generous on purpose: the sweep runs
// while real searches are in flight.
const PAGE_ORPHAN_GRACE_MS = envInt('PAGE_ORPHAN_GRACE_MS', 15000, 2000);
// How long after we *asked* a page to close before the pool stops waiting for it. A
// close we stopped waiting for can never be asked again: Playwright remembers the
// first call and answers every later one immediately without touching the tab, so a
// page whose close hung stays open forever as far as the page object is concerned.
// That is the tab the user then sees, navigated to about:blank, for the rest of the
// day. What still reaches it is the DevTools target behind it: _closeTargetByCdp.
const PAGE_CLOSE_WEDGE_MS = envInt('PAGE_CLOSE_WEDGE_MS', 5000, 500);
// A teardown step we cannot wait for is worse than no step at all: starting
// goto('about:blank') with a degenerate budget leaves a navigation in flight for the
// close to hang on. With less than this left the step is skipped, not started.
const MIN_AWAITABLE_STEP_MS = envInt('MIN_AWAITABLE_STEP_MS', 250, 0);
// Cap on the protocol round trips the sweep makes on a wedged page's behalf. A
// browser that cannot answer these is a browser we are about to lose anyway.
const PAGE_PROTOCOL_TIMEOUT_MS = envInt('PAGE_PROTOCOL_TIMEOUT_MS', 2000, 100);
// An entry the sweep cannot retire at all (no protocol session, or the tab happens to
// be the last one in the browser) leaves the ledger after this long.
const PAGE_LEDGER_MAX_MS = envInt('PAGE_LEDGER_MAX_MS', 120000, 5000);
// In CDP mode the search context *is* the user's browser profile, so a tab a human
// opened through noVNC is indistinguishable from a leak. Pages are therefore foreign
// until proven ours (present when we attached), and the only URL reclaimed on
// attribution alone is exactly about:blank: a pool leak is blank because we navigate
// there right before closing, a tab a human is reading never is.
const REAP_STRAY_BLANK_PAGES = process.env.BROWSER_REAP_STRAY_BLANK_PAGES !== 'false';
// Blank tabs that were already open when we attached stay somebody else's, because in a
// visible browser a tab a human has just opened is indistinguishable from one we
// abandoned. BROWSER_REAP_FOREIGN_BLANK_PAGES=true hands those to the sweep as well,
// which is what a browser that only this pool ever drives wants.
const REAP_FOREIGN_BLANK_PAGES = process.env.BROWSER_REAP_FOREIGN_BLANK_PAGES === 'true';
// How many tabs we opened are remembered across a dropped CDP connection, and how many
// already-open tabs a re-attach interrogates to prove ownership of them.
const PAGE_OWNERSHIP_MAX = envInt('PAGE_OWNERSHIP_MAX', 256, 16);
const FOREIGN_PROBE_MAX_PAGES = 32;
const BROWSER_SIMULATE_BROWSING = process.env.BROWSER_SIMULATE_BROWSING !== 'false';
const BROWSER_SCROLL_DELAY_MIN_MS = envInt('BROWSER_SCROLL_DELAY_MIN_MS', LOW_POWER_DEVICE ? 120 : 200, 20);
const BROWSER_SCROLL_DELAY_MAX_MS = envInt('BROWSER_SCROLL_DELAY_MAX_MS', LOW_POWER_DEVICE ? 350 : 700, 50);
// Restoring a saved session's localStorage opens one page per stored origin and
// navigates to that site (a real profile can hold dozens of unrelated origins —
// github, medium, etc.), causing rapid tab churn + heavy CPU on low-memory ARM.
// Default OFF: only cookies (the actual login state) are restored. Turn on only
// if a specific site needs its localStorage restored; RESTORE_MAX_ORIGINS bounds it.
const RESTORE_LOCALSTORAGE = process.env.BROWSER_RESTORE_LOCALSTORAGE === 'true';
const RESTORE_MAX_ORIGINS = envInt('BROWSER_RESTORE_MAX_ORIGINS', 3, 0);

// Fingerprint policy.
// Personal use attaches to a long-lived, manually-verified Chromium (CDP). For
// that profile, custom JS stealth spoofing can actually *hurt* identity consistency
// (fake chrome.runtime, frozen hardwareConcurrency, fixed platform, random UA/locale
// that disagree with the real browser/network). BROWSER_STEALTH_ON_CDP defaults to
// false so we leave the real browser untouched; ephemeral (non-CDP) contexts may keep
// the old stealth to guard launched incognito contexts.
const ENABLE_STEALTH = process.env.BROWSER_STEALTH !== 'false';
const ENABLE_STEALTH_ON_CDP = process.env.BROWSER_STEALTH_ON_CDP === 'true';

const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];

const LOCALES = ['en-US', 'zh-CN', 'zh-TW', 'en-GB'];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height:  768 },
  { width: 1440, height:  900 },
  { width: 1536, height:  864 },
  { width: 1280, height:  720 }
];

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--start-maximized',
  '--blink-settings=imagesEnabled=false'
];

function randomUserAgent() {
  const idx = Math.floor(Math.random() * BROWSER_USER_AGENTS.length);
  return BROWSER_USER_AGENTS[idx];
}

function randomLocale() {
  const idx = Math.floor(Math.random() * LOCALES.length);
  return LOCALES[idx];
}

function randomViewport() {
  const idx = Math.floor(Math.random() * VIEWPORTS.length);
  return VIEWPORTS[idx];
}

function envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CDP mode shares one Chromium profile across every session, so "the state of
// session X" only means something if we know which hosts X actually visited.
// SESSION_DOMAIN_CAP is a safety bound on that bookkeeping, not a policy: sessions
// come from the four-entry browser-session catalog, so the cap only ever bites if a
// human roams the whole web through one interactive page.
const SESSION_DOMAIN_CAP = envInt('BROWSER_SESSION_DOMAIN_CAP', 64, 1);
const EMPTY_DOMAIN_SCOPE = new Set();

function hostOf(urlLike) {
  if (!urlLike || typeof urlLike !== 'string') return null;
  try {
    return new URL(urlLike).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// Suffix match in both directions: a cookie scoped to ".bing.com" belongs to a
// session that visited "www.bing.com", and a cookie scoped to "login.bing.com"
// belongs to a session that visited "bing.com". Exact eTLD+1 would need a public
// suffix list; being permissive only *inside* a host the session really visited is
// what keeps another session's login cookies out of the snapshot.
function domainInScope(domain, scope) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!d.includes('.')) return false;
  for (const host of scope) {
    if (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) return true;
  }
  return false;
}

function cookieKey(cookie) {
  return `${cookie?.name}|${String(cookie?.domain || '').toLowerCase()}|${cookie?.path || '/'}`;
}

// Cookies the live jar already has are left alone. In CDP mode the shared profile is
// newer than any snapshot on disk -- the user may just have re-logged in through
// noVNC -- and addCookies() overwrites, so a stale file must never win.
async function filterLiveCookies(context, cookies) {
  const live = new Set();
  try {
    for (const cookie of await context.cookies()) {
      live.add(cookieKey(cookie));
    }
  } catch {
    // A jar we cannot read is better seeded from the file than left empty.
    return cookies;
  }
  return cookies.filter((cookie) => !live.has(cookieKey(cookie)));
}

// Await a teardown step for at most `ms` -- the caller's share of the single
// PAGE_TEARDOWN_TIMEOUT_MS teardown budget. Timeout and failure both resolve: the
// caller is on its way out of the page slot and there is nothing useful left to do
// with a close() that will not answer. The step itself keeps running detached (a
// late storageState() still writes its file), so nothing is lost -- only the slot
// is released on time.
function boundedTeardown(step, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(step).then(() => undefined, () => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
}

// Same bound as boundedTeardown, but it answers whether the step finished. That answer
// is the difference between a page that is gone and a tab that only the sweep can
// retire, and the pool has to know which one it is holding.
async function boundedStep(step, ms) {
  const pending = Symbol('pending');
  let timer;
  const outcome = await Promise.race([
    Promise.resolve(step).then(() => 'done', () => 'done'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(pending), ms);
      if (timer.unref) timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
  return outcome === pending ? 'pending' : 'done';
}

// boundedTeardown for a step whose answer matters: fall back to `fallback` if the step
// does not reply in time. As elsewhere the step itself is not cancelled -- only this
// caller gives up on it.
async function boundedValue(step, ms, fallback = null) {
  if (!step) return fallback;
  let timer;
  const value = await Promise.race([
    Promise.resolve(step).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (timer.unref) timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
  return value === undefined ? fallback : value;
}

// Simulate human browsing before closing a page: multi-step scrolling (with the
// occasional small scroll-back as a reader re-reads), mouse trails, hovering
// over links, and clicking neutral page margins. Makes open/close cadence look
// organic and helps avoid bot detection. Duration bounded by caller's
// closeDelayMs; actions are randomized and scaled down on low-power (ARM) devices.
async function simulateBrowsing(page, durationMs) {
  if (!BROWSER_SIMULATE_BROWSING || !durationMs || !page || page.isClosed()) return;
  const start = Date.now();
  let y = 0;
  const maxY = 5000;
  try {
    while (Date.now() - start < durationMs) {
      if (page.isClosed()) break;
      const roll = Math.random();
      try {
        if (roll < 0.35) {
          // scroll down
          const delta = 200 + Math.floor(Math.random() * 500);
          y = Math.min(maxY, y + delta);
          await page.mouse.wheel(0, delta);
        } else if (roll < 0.45) {
          // scroll back up a bit (re-reading)
          const delta = -(100 + Math.floor(Math.random() * 250));
          y = Math.max(0, y + delta);
          await page.mouse.wheel(0, delta);
        } else if (roll < 0.6) {
          // mouse trail
          await page.mouse.move(150 + Math.random() * 400, 100 + Math.random() * 300, { steps: 3 + Math.floor(Math.random() * 4) });
        } else if (roll < 0.8) {
          // hover a link (no navigation, but very human-looking)
          const links = page.locator('a[href]');
          const n = await links.count();
          if (n > 0) {
            await links.nth(Math.floor(Math.random() * Math.min(n, 20))).hover().catch(() => {});
          }
        } else {
          // click a neutral page-margin area (avoid link hotspots / popups)
          const cx = 30 + Math.random() * 110;
          const cy = 70 + Math.random() * 180;
          await page.mouse.click(cx, cy, { clickCount: Math.random() < 0.2 ? 2 : 1 });
        }
      } catch {
        // any per-action failure is fine; keep the loop alive
      }
      const pause = BROWSER_SCROLL_DELAY_MIN_MS +
        Math.floor(Math.random() * (BROWSER_SCROLL_DELAY_MAX_MS - BROWSER_SCROLL_DELAY_MIN_MS));
      await page.waitForTimeout(pause);
    }
  } catch {
    // page may have closed mid-simulation; ignore
  }
}

function browserIsConnected(browser) {
  return Boolean(browser && (typeof browser.isConnected !== 'function' || browser.isConnected()));
}

async function stealthPlugin(page) {
  // The body below only ever executes inside a real browser page context; it is
  // exercised manually against a live Chromium (see logs in manual smoke tests).
  await page.addInitScript(() => {
    /* c8 ignore start */
    if (window.navigator.webdriver) {
      delete window.navigator.webdriver;
    }
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });

    /* ---- Chrome Runtime API ---- */
    const makeEvent = () => {
      const listeners = [];
      const on = (cb) => listeners.push(cb);
      const off = (cb) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      const dispatch = (a, b, c) => { listeners.forEach(cb => { try { cb(a, b, c); } catch (_e) {} }); };
      Object.assign(on, { off, dispatch });
      return on;
    };

    const chromeObj = {
      runtime: {
        OnMessageEvent: makeEvent(),
        onMessage: makeEvent(),
        onConnect: makeEvent(),
        sendMessage: () => {},
        connect: () => ({ onMessage: makeEvent(), onDisconnect: makeEvent(), postMessage: () => {} }),
        getPlatformInfo: () => Promise.resolve({ os: 'mac' }),
        Id: String,
        LastError: null,
        PlatformOs: { MAC: 'mac', WIN: 'win', LINUX: 'linux', ANDROID: 'android', CROS: 'cros' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' },
        UpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' }
      },
      webstore: {
        OnInstallReason: { CHROME_UPDATE: 'chrome_update', USER: 'user', ADMINISTATOR: 'administator', SHARED_MODULE: 'shared_module' },
        OnUpdateAvailableEvent: makeEvent(),
        onInstallStageChanged: makeEvent(),
        onDownloadProgress: makeEvent(),
        onInstallReason: makeEvent(),
        onUpdateAvailable: makeEvent()
      },
      app: {
        isInstalled: false,
        GetInstallStateReturnType: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        getIsInstalled: () => false,
        getInstallState: () => 'not_installed'
      }
    };

    try {
      Object.defineProperty(navigator, 'chrome', {
        get: () => chromeObj,
        configurable: true,
        writable: true
      });
    } catch (_e) {}
    window.chrome = chromeObj;

    /* ---- chrome.loadTimes / chrome.csi (deprecated but still detected) ---- */
    const fakeLoadTimes = () => ({
      connectionInfo: { type: 'unknown' },
      npnNegotiatedProtocol: 'h2',
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      wasAlternateProtocolAvailable: false,
      requestTime: Date.now() / 1000,
      finishTime: Date.now() / 1000,
      endTime: () => Date.now() / 1000
    });
    try { window.chrome.loadTimes = fakeLoadTimes; } catch (_e) {}
    try {
      window.chrome.csi = () => ({
        onloadT: Math.floor(Date.now() / 1000) - 1,
        pageT: Math.floor(Math.random() * 500),
        tran: Math.floor(Math.random() * 10) + 1
      });
    } catch (_e) {}

    /* ---- chrome.csi for timing (no-op, kept for compatibility) ---- */

    /* ---- navigator.plugins ---- */
    const pluginList = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format, version 1.4', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Plugin', filename: 'pdf.dll', description: 'Portable Document Format', length: 1 },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 }
    ];
    pluginList.forEach(p => { p.enabled = true; });
    Object.defineProperty(navigator, 'plugins', {
      get: () => pluginList,
      configurable: true
    });

    /* ---- navigator.mimeTypes ---- */
    const mimeList = [
      { type: 'application/pdf', suffixes: 'pdf', description: '', _enabledPlugin: pluginList[0] },
      { type: 'text/html', suffixes: 'html,hmt,htm', description: '', _enabledPlugin: pluginList[0] }
    ];
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => mimeList,
      configurable: true
    });

    /* ---- navigator.languages ---- */
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true
    });

    /* ---- navigator.hardwareConcurrency ---- */
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true
    });

    /* ---- navigator.deviceMemory ---- */
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
      configurable: true
    });

    /* ---- navigator.maxTouchPoints ---- */
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
      configurable: true
    });

    /* ---- cdc_ markers ---- */
    window.cdc_adoQnsasSS = void 0;
    window.$cdc_asdjflasutopfhvcZLmcif_ = void 0;

    /* ---- indexedDB (no-op passthrough, prevents detection of override) ---- */
    try {
      const origOpen = window.indexedDB.open;
      window.indexedDB.open = function () {
        return origOpen.apply(this, arguments);
      };
    } catch (_e) {}
  });
  /* c8 ignore stop */
}

// Apply the custom JS fingerprint-spoofing stealth only when permitted. In CDP mode we
// attach to a real, manually-verified persistent Chromium: injecting a fake
// navigator/chrome fingerprint there can make the identity *inconsistent* with the real
// browser (Client Hints, TLS, OS, profile history). BROWSER_STEALTH_ON_CDP=false
// (default) means we leave the real browser untouched. Ephemeral launched contexts may
// still use stealth when BROWSER_STEALTH=true.
async function applyStealthIfNeeded(page, { isCdpMode }) {
  if (!ENABLE_STEALTH) return;
  if (isCdpMode && !ENABLE_STEALTH_ON_CDP) return;
  await stealthPlugin(page);
}

// Session pages double as manual-recovery surfaces (login / CAPTCHA / Robot
// Verification via noVNC). Blocking images there can break image-based verification, so we
// only block heavy media on ephemeral launched contexts, never on the CDP persistent
// Chromium.
function applySessionResourcePolicy(page, { isCdpMode }) {
  if (isCdpMode) return;
  page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i, route => route.abort().catch(() => {}));
}

export class PlaywrightPool {
  constructor(proxyRouter) {
    console.log(`[browser] mode=${USE_EXISTING_CHROME ? 'cdp' : 'playwright-launch'} persistent-profile=${VISIBLE_BROWSER_PROFILE_DIR || 'none'} stealth=${ENABLE_STEALTH_ON_CDP ? 'enabled-for-cdp' : (USE_EXISTING_CHROME ? 'disabled-for-cdp' : (ENABLE_STEALTH ? 'enabled' : 'disabled'))}`);
    this.proxyRouter = proxyRouter;
    this.browser = null;
    this.connectedBrowser = null;
    this.sharedContext = null;
    this.searchContext = null;
    this.sessionContexts = new Map();
    this.sessionPages = new Map();
    // sessionKey -> how many domains of that session have already been restored into
    // the context. A shared CDP jar has to be revisited when the session starts
    // touching a new site, so the cache counts domains instead of being a flag.
    this.hydratedSharedSessions = new Map();
    // sessionKey -> hosts that session actually visited. In CDP mode this is the
    // only thing that separates one session's cookies from another's.
    this._sessionDomains = new Map();
    this._activePageCount = 0;
    this._pageWaiters = [];
    // sessionKey -> number of in-flight page tasks using that session context.
    this._contextHeld = new Map();
    this._lastCapWarnAt = 0;
    this._keptPages = new Map();
    // page -> ownership record for every page the pool opened (see _trackPage).
    this._ownedPages = new Map();
    // Pages that were already open when we attached to a context: somebody else's.
    this._foreignPages = new WeakSet();
    // targetId -> when we opened it. Target ids survive a dropped CDP connection, Page
    // objects do not, and only the ids let a re-attach tell our leftovers from a human's.
    this._ourTargetIds = new Map();
    // Unattributable blank tabs waiting to be proven abandoned.
    this._strayPages = new Map();
    this._reapedPages = 0;
    this._reapedTargets = 0;
    // Unattributable blank tabs whose polite close did not take. Attempt bookkeeping so
    // the sweep can escalate to a protocol close, then stop hammering a stubborn tab.
    this._strayAttempts = new Map();
    this._reapRunning = false;
    this._reapTimer = null;
    this._reapDelayMs = 0;
    // Cached browser-level DevTools session, only ever used to retire a wedged tab.
    this._browserCdp = null;
    this._pageReaperTimer = PAGE_REAPER_INTERVAL_MS > 0
      ? setInterval(() => { this._reapOrphanPages().catch(() => {}); }, PAGE_REAPER_INTERVAL_MS)
      : null;
    if (this._pageReaperTimer?.unref) this._pageReaperTimer.unref();
    this._keptPagesCleanupTimer = setInterval(() => this._cleanupKeptPages(), KEPT_PAGE_CLEANUP_INTERVAL_MS);
    this._keptPagesCleanupTimer.unref();
    this._sessionPagesCleanupTimer = setInterval(() => this._cleanupSessionPages(), SESSION_PAGE_CLEANUP_INTERVAL_MS);
    this._sessionPagesCleanupTimer.unref();
  }

  async getBrowser() {
    if (USE_EXISTING_CHROME) {
      if (this.connectedBrowser && !browserIsConnected(this.connectedBrowser)) {
        this.resetConnectedBrowser('CDP connection is no longer active');
      }
      if (!this.connectedBrowser) {
        await this.connectToExistingChrome();
      }
      return this.connectedBrowser;
    }

    if (this.browser && !browserIsConnected(this.browser)) {
      this.browser = null;
    }
    if (!this.browser) {
      const browser = await chromium.launch(this.launchOptions());
      browser.on('disconnected', () => {
        if (this.browser === browser) {
          this.browser = null;
        }
      });
      this.browser = browser;
    }
    return this.browser;
  }

  resetConnectedBrowser(reason) {
    if (reason) {
      console.log(`[browser] existing Chrome disconnected: ${reason}`);
    }
    this.connectedBrowser = null;
    this.sharedContext = null;
    this.searchContext = null;
    this.sessionPages.clear();
    this.hydratedSharedSessions.clear();
    // The browser is gone, so every page we tracked went with it.
    this._ownedPages.clear();
    this._strayPages.clear();
    this._strayAttempts.clear();
    // The protocol session belongs to the connection that is gone.
    this._browserCdp = null;
    this._resetKeptPages();
  }

  async _resetKeptPages() {
    const promises = [];
    for (const entry of this._keptPages.values()) {
      promises.push(entry.page.close().catch(() => {}));
      if (entry.ownsContext) {
        promises.push(entry.context.close().catch(() => {}));
      }
    }
    await Promise.all(promises);
    this._keptPages.clear();
  }

  async resolveCdpEndpoint() {
    if (!CDP_URL.startsWith('http') || CDP_URL.includes('/json') || CDP_URL.includes('/devtools/')) {
      return CDP_URL;
    }
    const resp = await fetch(`${CDP_URL}/json/version`);
    if (!resp.ok) {
      throw new Error(`CDP version endpoint returned HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.webSocketDebuggerUrl || CDP_URL;
  }

  async connectToExistingChrome() {
    const deadline = Date.now() + EXISTING_CHROME_CONNECT_TIMEOUT_MS;
    let lastError = null;
    console.log(`[browser] connecting to existing Chrome via CDP at ${CDP_URL}...`);

    while (Date.now() <= deadline) {
      try {
        const cdpEndpoint = await this.resolveCdpEndpoint();
        const browser = await chromium.connectOverCDP(cdpEndpoint);
        this.connectedBrowser = browser;
        browser.on('disconnected', () => {
          if (this.connectedBrowser === browser) {
            this.resetConnectedBrowser('CDP connection closed');
          }
        });
        if (!browserIsConnected(browser)) {
          this.resetConnectedBrowser('CDP connection closed immediately after connect');
          throw new Error('CDP connection closed immediately after connect');
        }
        console.log('[browser] connected to existing Chrome');
        return browser;
      } catch (err) {
        lastError = err;
        await sleep(EXISTING_CHROME_CONNECT_RETRY_MS);
      }
    }

    const err = new Error(`existing Chrome CDP is unavailable at ${CDP_URL} after ${EXISTING_CHROME_CONNECT_TIMEOUT_MS}ms: ${lastError?.message || 'unknown error'}`);
    err.code = 'BROWSER_UNAVAILABLE';
    err.details = {
      browser_mode: 'existing-cdp',
      cdp_url: CDP_URL,
      connect_timeout_ms: EXISTING_CHROME_CONNECT_TIMEOUT_MS,
      last_error: lastError?.message || null,
      visible_browser_profile_dir: VISIBLE_BROWSER_PROFILE_DIR
    };
    throw err;
  }

  launchOptions() {
    const args = [...LAUNCH_ARGS];
    const ublockDir = path.resolve(process.cwd(), 'extensions/ublock-origin');
    if (fs.existsSync(ublockDir)) {
      args.push(`--disable-extensions-except=${ublockDir}`);
      args.push(`--load-extension=${ublockDir}`);
    }
    return {
      headless: CONFIG.headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args
    };
  }

  getSessionStatePath(sessionKey) {
    if (!sessionKey) return null;
    return safeJoin(CONFIG.browserStateDir, `${sessionKey}.json`);
  }

  buildContextOptions(proxy, sessionKey) {
    const viewport = randomViewport();
    const options = {
      proxy,
      userAgent: randomUserAgent(),
      locale: randomLocale(),
      viewport,
      deviceScaleFactor: Math.random() > 0.5 ? 1 : 2,
      hasTouch: Math.random() > 0.8
    };
    const storageStatePath = this.getSessionStatePath(sessionKey);
    if (storageStatePath && fs.existsSync(storageStatePath)) {
      options.storageState = storageStatePath;
    }
    return options;
  }

  async getSharedContext() {
    const browser = await this.getBrowser();
    if (this.sharedContext) {
      try {
        this.sharedContext.pages();
        return this.sharedContext;
      } catch {
        this.sharedContext = null;
      }
    }
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      this.sharedContext = contexts[0];
      // Whatever is already open in somebody's browser is theirs, not ours, and the
      // stray-tab sweep must never touch it.
      this._markForeignPages(this.sharedContext);
      return this.sharedContext;
    }
    this.sharedContext = await browser.newContext();
    return this.sharedContext;
  }

  async getSearchContext() {
    const browser = await this.getBrowser();
    if (this.connectedBrowser) {
      return this.getSharedContext();
    }
    if (this.searchContext) {
      try {
        this.searchContext.pages();
        return this.searchContext;
      } catch {
        this.searchContext = null;
      }
    }
    this.searchContext = await browser.newContext();
    return this.searchContext;
  }

  // The owner is done with the page but is closing it itself: mark it so the sweep
  // can take over if that close never completes.
  _markReleased(page) {
    const entry = this._ownedPages.get(page);
    if (entry && !entry.releasedAt) entry.releasedAt = Date.now();
  }

  // Remember that a session touched the host of `urlLike`. Everything about CDP
  // session isolation hangs off this: a session may only read/write the cookies of
  // the hosts it has actually been to.
  recordSessionHost(sessionKey, urlLike) {
    if (!sessionKey) return;
    const host = hostOf(urlLike);
    if (!host) return;
    let scope = this._sessionDomains.get(sessionKey);
    if (!scope) {
      scope = new Set();
      this._sessionDomains.set(sessionKey, scope);
    }
    if (scope.size < SESSION_DOMAIN_CAP) scope.add(host);
  }

  // Restore a saved session into a context. A private (launch-mode) context owns its
  // file, so the file is applied wholesale, once. The shared CDP context is one
  // cookie jar for every session and the persistent Chromium profile is its source of
  // truth (see docs/local-search-mcp-google-session-hardening.md section 4.2), so
  // there a file may only seed the domains this session actually visited and may
  // never overwrite a cookie the live profile already has. That used to re-inject
  // google's cookies from bing.json into the shared jar and roll a logged-in session
  // back to somebody else's stale snapshot.
  async hydrateSessionContext(context, sessionKey, { shared = false } = {}) {
    if (!sessionKey) return;
    const scope = shared ? (this._sessionDomains.get(sessionKey) || EMPTY_DOMAIN_SCOPE) : null;
    const scopeSize = scope ? scope.size : Number.POSITIVE_INFINITY;
    const restored = this.hydratedSharedSessions.get(sessionKey);
    if (restored !== undefined && restored >= scopeSize) {
      return;
    }
    const statePath = this.getSessionStatePath(sessionKey);
    if (!statePath || !fs.existsSync(statePath)) {
      this.hydratedSharedSessions.set(sessionKey, scopeSize);
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      let cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
      let origins = Array.isArray(raw.origins) ? raw.origins : [];
      if (scope) {
        cookies = cookies.filter((entry) => domainInScope(entry?.domain, scope));
        origins = origins.filter((entry) => domainInScope(hostOf(entry?.origin), scope));
        if (cookies.length > 0) {
          cookies = await filterLiveCookies(context, cookies);
        }
      }
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
      // localStorage restore is OFF by default (see RESTORE_LOCALSTORAGE note):
      // opening a page per origin churns dozens of tabs. Bound to MAX_ORIGINS.
      if (RESTORE_LOCALSTORAGE && origins.length > 0) {
        for (const originEntry of origins.slice(0, RESTORE_MAX_ORIGINS)) {
          if (!originEntry?.origin || !Array.isArray(originEntry.localStorage) || originEntry.localStorage.length === 0) {
            continue;
          }
          const page = await context.newPage();
          this._trackPage(page, context, { kind: 'restore' });
          try {
            await page.goto(originEntry.origin, { waitUntil: 'domcontentloaded', timeout: CONFIG.browserTimeoutMs });
            /* c8 ignore start -- body only executes inside the real Chromium page context */
            await page.evaluate((entries) => {
              for (const entry of entries) {
                window.localStorage.setItem(entry.name, entry.value);
              }
            }, originEntry.localStorage);
            /* c8 ignore stop */
          } catch (err) {
            console.log(`[browser] failed to restore localStorage for ${originEntry.origin}:`, err.message);
          } finally {
            this._markReleased(page);
            await page.close().catch(() => {});
          }
        }
      }
      console.log(`[browser] restored session state for ${sessionKey}${shared ? ` (scope: ${scope.size} hosts)` : ''}`);
    } catch (err) {
      console.log(`[browser] failed to restore shared session ${sessionKey}:`, err.message);
    } finally {
      this.hydratedSharedSessions.set(sessionKey, scopeSize);
    }
  }

  // ── Page ownership ───────────────────────────────────────────────────────────
  //
  // Every page the pool opens is registered, so a page always has an owner to ask:
  // the close that completed (the close listener unregisters it), or the sweep below.
  // The registry is also the only record of tabs that a *click* produced: Playwright
  // closes the page it created and nothing else, so a tab spawned by a click used to
  // be nobody's business and stayed in the browser for good.
  _trackPage(page, context, { kind = 'task', task = null } = {}) {
    if (!page) return null;
    const entry = {
      page,
      context,
      kind,
      task,
      createdAt: Date.now(),
      releasedAt: 0,
      // When we last told this page to close. Two released pages look identical; only
      // one of them has an owner that already gave up waiting for its close, and that
      // is the one the sweep is allowed to escalate early.
      closeAttemptedAt: 0,
      // DevTools target behind the page, looked up only when it is actually needed.
      targetId: null,
      targetAttemptedAt: 0
    };
    this._ownedPages.set(page, entry);
    this._rememberPageTarget(page);
    if (typeof page.on === 'function') {
      page.on('close', () => {
        const gone = this._ownedPages.get(page);
        if (gone && gone.targetId) this._ourTargetIds.delete(gone.targetId);
        this._ownedPages.delete(page);
        this._strayPages.delete(page);
        this._strayAttempts.delete(page);
      });
    }
    return entry;
  }

  // A click on a result, or one of simulateBrowsing's blind coordinate clicks, opens a
  // tab. Adopt it -- and anything it opens -- so it cannot outlive the task that
  // provoked it. Popups are usually still on about:blank when we get them, which is
  // why a leak of this class looks like a wall of blank tabs.
  _adoptPopups(page, context, task) {
    if (!page || typeof page.on !== 'function') return;
    page.on('popup', (child) => {
      this._trackPage(child, context, { kind: 'popup', task });
      this._adoptPopups(child, context, task);
    });
  }

  // Remember which DevTools target stands behind this page, so that losing the
  // connection cannot turn the tab into somebody else's. Best effort and off the critical
  // path: nothing waits for it, a page whose id we never learned is treated the way it
  // always was (not ours), and a launched browser dies with us, so only CDP mode asks.
  _rememberPageTarget(page) {
    if (!this.connectedBrowser) return;
    const entry = this._ownedPages.get(page);
    if (!entry) return;
    this._resolvePageTarget(page, entry)
      .then((targetId) => {
        if (!targetId) return;
        // Insertion order is age order: the oldest id goes first.
        if (this._ourTargetIds.size >= PAGE_OWNERSHIP_MAX) {
          this._ourTargetIds.delete(this._ourTargetIds.keys().next().value);
        }
        this._ourTargetIds.set(targetId, Date.now());
      })
      .catch(() => {});
  }

  // The owner is finished with the page: close it now, and leave it registered so the
  // sweep can retry if that close wedges.
  _releasePage(page) {
    const entry = this._ownedPages.get(page);
    if (!entry) return;
    if (!entry.releasedAt) entry.releasedAt = Date.now();
    entry.closeAttemptedAt = Date.now();
    page.close().catch(() => {});
  }

  _closeTaskPopups(task) {
    for (const [page, entry] of [...this._ownedPages]) {
      if (entry.kind !== 'popup' || entry.task !== task) continue;
      this._releasePage(page);
    }
  }

  // Tabs that were already open when we attached belong to whoever operates this browser
  // (a human through noVNC), never to us -- foreign first, always, because that is the
  // safe answer. The exception is a tab we can prove is ours: the DevTools target behind
  // it is one we opened before this connection dropped. Without that revisit a reconnect
  // turns every wedged tab of ours into permanent baseline, which is how a long-lived
  // visible browser ends up with a wall of about:blank that the sweep is not allowed to
  // touch.
  _markForeignPages(context) {
    if (!context) return;
    let pages = [];
    try {
      pages = context.pages();
    } catch {
      return;
    }
    for (const page of pages) this._foreignPages.add(page);
    if (!this.connectedBrowser || this._ourTargetIds.size === 0 || pages.length === 0) return;
    this._reclaimReattachedPages(context, pages.slice(0, FOREIGN_PROBE_MAX_PAGES)).catch(() => {});
  }

  // Second look at the attach-time baseline, off the critical path. A page stops being
  // foreign only on positive evidence that we opened it, and it is still the sweep, not
  // this function, that closes it: blank url, two sightings, never the last tab.
  async _reclaimReattachedPages(context, pages) {
    const probe = { context, targetId: null, targetAttemptedAt: 0 };
    for (const page of pages) {
      probe.targetId = null;
      const targetId = await this._resolvePageTarget(page, probe);
      if (!targetId || !this._ourTargetIds.has(targetId)) continue;
      this._foreignPages.delete(page);
      console.log('[browser] a tab left behind before the reconnect is ours again; the sweep will retire it');
    }
  }

  _isPinnedPage(page) {
    for (const entry of this.sessionPages.values()) {
      if (entry.page === page) return true;
    }
    for (const entry of this._keptPages.values()) {
      if (entry.page === page) return true;
    }
    return false;
  }

  _reapableContexts() {
    const contexts = [];
    if (this.sharedContext) contexts.push(this.sharedContext);
    if (this.searchContext && this.searchContext !== this.sharedContext) contexts.push(this.searchContext);
    for (const entry of this.sessionContexts.values()) contexts.push(entry.context);
    return contexts;
  }

  // Periodic reclamation -- the backstop for every page whose close did not complete.
  // Two classes:
  //   1. pages we registered whose owner is gone: the bounded close gave up waiting,
  //      or the abandoned close never completed. Retried until Chromium confirms it.
  //      A close that is still pending after PAGE_CLOSE_WEDGE_MS will never complete
  //      (Playwright will not send a second one), so those are retired by target id.
  //   2. about:blank tabs in a context we use that we did not open and cannot blame on
  //      the attach-time baseline. That is what cleans up after a browser restart, or
  //      after a popup whose parent died before it could be adopted, and it is
  //      deliberately restricted to the one URL the pool navigates to itself, so a
  //      human tab in the visible browser is never a candidate.
  async _reapOrphanPages() {
    if (this._reapRunning) return { closed: 0, reason: 'already running' };
    this._reapRunning = true;
    let closed = 0;
    try {
      closed += await this._reapTrackedPages();
      closed += await this._reapStrayBlankPages();
    } finally {
      this._reapRunning = false;
    }
    if (closed > 0) {
      this._reapedPages += closed;
      console.log(`[browser] reclaimed ${closed} abandoned page(s); ${this._ownedPages.size} still tracked`);
    }
    return { closed };
  }

  _forgetPage(page) {
    this._ownedPages.delete(page);
    this._strayPages.delete(page);
  }

  // Registered pages whose owner is gone. A page that answers close() is finished; a
  // page that was *told* to close and is still open is wedged, and Playwright cannot
  // be asked twice -- that is the case the protocol close exists for. An entry is
  // counted once, when it leaves the ledger, so reaped_pages cannot double count.
  async _reapTrackedPages() {
    const now = Date.now();
    let retired = 0;
    for (const [page, entry] of [...this._ownedPages]) {
      if (this._isPinnedPage(page)) continue;
      let isClosed = false;
      try {
        isClosed = page.isClosed();
      } catch {
        isClosed = true; // the context went away underneath us: the page is gone too
      }
      if (isClosed) {
        this._forgetPage(page);
        retired += 1;
        continue;
      }
      const orphaned = entry.releasedAt && now - entry.releasedAt >= PAGE_ORPHAN_GRACE_MS;
      // A page we already asked to close has had PAGE_CLOSE_WEDGE_MS to do it. Waiting
      // longer than that is waiting for something that has already stopped happening.
      const wedged = entry.closeAttemptedAt && now - entry.closeAttemptedAt >= PAGE_CLOSE_WEDGE_MS;
      if (!orphaned && !wedged) continue;
      if (!entry.closeAttemptedAt) {
        // First sight: ask politely and stay on the ledger, so the next sweep can tell
        // a close that is merely slow from one that is never going to answer.
        entry.closeAttemptedAt = now;
        page.close().catch(() => {});
        continue;
      }
      if (!wedged) continue;
      if (!entry.targetId) await this._resolvePageTarget(page, entry);
      const outcome = entry.targetId ? await this._closeTargetByCdp(entry.targetId) : 'unsupported';
      if (outcome === 'closed') {
        this._reapedTargets += 1;
        this._forgetPage(page);
        retired += 1;
        console.log('[browser] retired a wedged tab through the DevTools protocol');
      } else if (outcome === 'gone') {
        this._forgetPage(page);
        retired += 1;
      } else if (outcome !== 'last-page' && now - entry.createdAt > PAGE_LEDGER_MAX_MS) {
        // Out of options (no protocol session at all, or a tab that will not answer
        // any more). Forget it rather than grow the ledger without end.
        this._forgetPage(page);
      }
    }
    return retired;
  }

  // Which DevTools target is this page? Asked of the page itself through a
  // page-scoped session, so two pages opened at once cannot be mixed up -- and a page
  // whose close() has wedged still answers. Only the sweep calls this, never a task.
  async _resolvePageTarget(page, entry) {
    if (entry.targetId) return entry.targetId;
    const context = entry.context || (typeof page.context === 'function' ? page.context() : null);
    if (!context || typeof context.newCDPSession !== 'function') return null;
    let session = null;
    try {
      session = await boundedValue(context.newCDPSession(page), PAGE_PROTOCOL_TIMEOUT_MS);
      if (!session || typeof session.send !== 'function') return null;
      const info = await boundedValue(session.send('Target.getTargetInfo'), PAGE_PROTOCOL_TIMEOUT_MS);
      const target = info && info.targetInfo;
      // Anything but a page target is refused: a session bound to the browser would
      // hand us the ability to close the browser itself.
      if (target && target.type === 'page' && target.targetId) entry.targetId = target.targetId;
    } catch {
      return null;
    } finally {
      try {
        if (session && typeof session.detach === 'function') {
          await boundedValue(session.detach(), PAGE_PROTOCOL_TIMEOUT_MS);
        }
      } catch {
        // a session that will not detach dies with the connection
      }
    }
    return entry.targetId;
  }

  async _browserCdpSession() {
    const browser = this.connectedBrowser || this.browser;
    if (!browser || typeof browser.newBrowserCDPSession !== 'function') return null;
    if (this._browserCdp) return this._browserCdp;
    const session = await boundedValue(browser.newBrowserCDPSession(), PAGE_PROTOCOL_TIMEOUT_MS);
    if (session) this._browserCdp = session;
    return session;
  }

  // The last resort: close a tab by its DevTools target id. Returns 'closed', 'gone'
  // (the browser does not have it any more), 'last-page' (closing it would empty the
  // browser) or 'failed'/'unsupported'. Only ids we recorded for pages we opened are
  // ever passed here, which is what keeps a human tab untouchable.
  async _closeTargetByCdp(targetId) {
    const session = await this._browserCdpSession();
    if (!session || typeof session.send !== 'function') return 'unsupported';
    try {
      const listing = await boundedValue(session.send('Target.getTargets'), PAGE_PROTOCOL_TIMEOUT_MS);
      const targetInfos = listing && listing.targetInfos;
      if (!Array.isArray(targetInfos)) {
        // A listing we could not get is not a listing that says the tab is gone, and a
        // session that cannot answer is not a session to keep caching.
        this._browserCdp = null;
        return 'failed';
      }
      const pages = targetInfos.filter((t) => t.type === 'page');
      if (!pages.some((t) => t.targetId === targetId)) return 'gone';
      // Never take a browser down to zero tabs: in a visible browser the last tab is
      // the window, and the last window is the Chrome this pool is attached to.
      if (pages.length <= 1) return 'last-page';
      const result = await boundedValue(session.send('Target.closeTarget', { targetId }), PAGE_PROTOCOL_TIMEOUT_MS);
      if (!result || result.success === false) {
        this._browserCdp = null;
        return 'failed';
      }
      return 'closed';
    } catch {
      // Assume the cached session died with the connection; the next sweep opens one.
      this._browserCdp = null;
      return 'failed';
    }
  }

  async _reapStrayBlankPages() {
    if (!REAP_STRAY_BLANK_PAGES) return 0;
    const now = Date.now();
    let closed = 0;
    for (const [page, entry] of [...this._strayPages]) {
      let isClosed = false;
      try {
        isClosed = page.isClosed();
      } catch {
        isClosed = true;
      }
      if (isClosed || this._ownedPages.has(page)) {
        this._strayPages.delete(page);
        // We asked for this tab to go away and it did: that counts as reclaimed even
        // though the close promise never answered.
        if (isClosed && this._strayAttempts.delete(page)) closed += 1;
      }
    }
    for (const context of this._reapableContexts()) {
      let pages = [];
      try {
        pages = context.pages();
      } catch {
        continue; // context torn down between the reapable snapshot and now
      }
      for (const page of pages) {
        if (this._ownedPages.has(page) || this._isPinnedPage(page)) continue;
        // Foreign means somebody else's, unless the operator said this browser belongs to
        // the pool alone. Either way only about:blank is a candidate below, so a human
        // reading a page is still never a candidate.
        if (this._foreignPages.has(page) && !REAP_FOREIGN_BLANK_PAGES) continue;
        let url = '';
        try {
          url = page.url();
        } catch {
          continue;
        }
        if (url !== 'about:blank') continue;
        const seen = this._strayPages.get(page);
        // Two sweeps and a grace period: a page that is mid-creation, or that a human
        // has just opened to type an address into, is never a candidate on first sight.
        if (!seen) {
          // Bounded like the attempt counter: candidates are candidates only while the
          // sweep is actually watching them, never a permanent registry.
          if (this._strayPages.size > 128) this._strayPages.clear();
          this._strayPages.set(page, { firstSeenAt: now, sweeps: 1 });
          continue;
        }
        seen.sweeps += 1;
        if (seen.sweeps < 2 || now - seen.firstSeenAt < PAGE_ORPHAN_GRACE_MS) continue;
        // In CDP mode this context is the user's own browser window, so its last page is
        // the window itself -- leave that one alone. In launched mode the context belongs
        // to the pool and that last blank page is exactly the leak to clean up.
        if (USE_EXISTING_CHROME && pages.length <= 1) continue;
        closed += await this._retireStrayPage(page, context);
      }
    }
    return closed;
  }

  // Retire one unattributable blank tab. The first try is the polite close; if the tab
  // is still here on a later sweep that close never took, which is the same wedge a
  // tracked page gets, so it gets the same way out -- close the DevTools target behind
  // it. Three tries on one tab, then we stop hammering it. Returns what to count.
  async _retireStrayPage(page, context) {
    const attempts = this._strayAttempts.get(page) || 0;
    if (attempts >= 3) {
      // Three tries and it is still here: stop hammering one tab, and say so once.
      console.log('[browser] giving up on an abandoned blank tab that will not close');
      this._strayAttempts.delete(page);
      this._strayPages.delete(page);
      return 0;
    }
    if (this._strayAttempts.size > 64) this._strayAttempts.clear();
    this._strayAttempts.set(page, attempts + 1);
    if (attempts === 0) {
      page.close().catch(() => {});
      // Nothing proven yet, so nothing counted, and the candidate stays registered: that
      // is how the next sweep learns the polite close was never going to answer.
      return 0;
    }
    const probe = { context, targetId: null };
    await this._resolvePageTarget(page, probe);
    const outcome = probe.targetId ? await this._closeTargetByCdp(probe.targetId) : 'unsupported';
    if (outcome === 'closed') {
      this._reapedTargets += 1;
      console.log('[browser] retired an abandoned blank tab through the DevTools protocol');
      return 1;
    }
    return outcome === 'gone' ? 1 : 0;
  }

  // One pending sweep is enough, and it is deferred by exactly the grace period so the
  // grace has actually elapsed when it runs. That is what makes the tabs left by a
  // finished query go away shortly after the query, instead of at some later tick of
  // the interval -- or never, on a browser that goes idle right after.
  _scheduleReap(delayMs = PAGE_ORPHAN_GRACE_MS) {
    // The shorter wait wins: a task that just abandoned a close wants the sweep in a
    // few seconds, not after the full grace a merely unadopted popup would wait for.
    if (this._reapTimer) {
      if (this._reapDelayMs <= delayMs) return;
      clearTimeout(this._reapTimer);
    }
    this._reapDelayMs = delayMs;
    this._reapTimer = setTimeout(() => {
      this._reapTimer = null;
      this._reapDelayMs = 0;
      this._reapOrphanPages().catch(() => {});
    }, delayMs);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  _cleanupKeptPages() {
    const now = Date.now();
    const promises = [];
    for (const [key, entry] of this._keptPages) {
      if (now - entry.createdAt > KEPT_PAGE_TTL_MS) {
        this._keptPages.delete(key);
        promises.push(entry.page.close().catch(() => {}));
        if (entry.ownsContext) {
          promises.push(entry.context.close().catch(() => {}));
        }
      }
    }
    if (promises.length > 0) {
      Promise.all(promises).catch(() => {});
    }
  }

  // Hard cap for parked pages, on top of the TTL sweep above. Oldest first, and a
  // throwaway (non-session) key goes before a session key: the session ones are the
  // captcha pages a human may still be finishing through noVNC, the ephemeral ones
  // are a bot check on some random page nobody is looking at. Closes are
  // fire-and-forget because this runs while the caller still holds its page slot.
  _evictKeptPages() {
    while (this._keptPages.size > MAX_KEPT_PAGES) {
      const keys = [...this._keptPages.keys()];
      const victimKey = keys.find((key) => !key.startsWith('session:')) ?? keys[0];
      const victim = this._keptPages.get(victimKey);
      this._keptPages.delete(victimKey);
      victim.page.close().catch(() => {});
      if (victim.ownsContext) victim.context.close().catch(() => {});
    }
  }

  _evictSessionContext() {
    if (this.sessionContexts.size < MAX_SESSION_CONTEXTS) return;
    // LRU, but the cap is deliberately soft: closing a context that another
    // in-flight task is navigating in (the shipped compose file sets
    // MAX_SESSION_CONTEXTS=1, so a bing and a google run alternate) used to kill
    // the other client's search with "target closed". Busy contexts are skipped
    // and the cap is exceeded briefly instead.
    let victimKey = null;
    let victimUsedAt = Infinity;
    for (const [key, entry] of this.sessionContexts) {
      if ((this._contextHeld.get(key) || 0) > 0) continue;
      if (this._sessionPageIsLive(key)) continue;
      if (entry.lastUsedAt < victimUsedAt) {
        victimKey = key;
        victimUsedAt = entry.lastUsedAt;
      }
    }
    if (!victimKey) {
      if (Date.now() - this._lastCapWarnAt > 30000) {
        this._lastCapWarnAt = Date.now();
        console.log(`[browser] session-context cap (${MAX_SESSION_CONTEXTS}) reached while every context is busy; running one extra context instead of closing a running task`);
      }
      return;
    }
    const victim = this.sessionContexts.get(victimKey);
    victim.context.close().catch(() => {});
    this.sessionContexts.delete(victimKey);
    this._contextHeld.delete(victimKey);
  }

  // A pinned interactive page (noVNC session page) also counts as "in use".
  _sessionPageIsLive(sessionKey) {
    const entry = this.sessionPages.get(sessionKey);
    if (!entry) return false;
    try {
      return !entry.page.isClosed();
    } catch {
      return false;
    }
  }

  async getSessionContext(sessionKey, { proxyProfile = 'auto', url = '' } = {}) {
    const browser = await this.getBrowser();

    if (this.connectedBrowser) {
      const context = await this.getSharedContext();
      this.recordSessionHost(sessionKey, url);
      await this.hydrateSessionContext(context, sessionKey, { shared: true });
      return { context, reusable: true, ownsContext: false, mode: 'shared-cdp' };
    }

    const existing = this.sessionContexts.get(sessionKey);
    if (existing) {
      try {
        existing.context.pages();
        existing.lastUsedAt = Date.now();
        return { context: existing.context, reusable: true, ownsContext: false, mode: 'persistent-context' };
      } catch {
        this.sessionContexts.delete(sessionKey);
      }
    }

    this._evictSessionContext();
    const proxy = this.proxyRouter?.resolve(proxyProfile, url)?.playwrightProxy;
    const context = await browser.newContext(this.buildContextOptions(proxy, sessionKey));
    await this.hydrateSessionContext(context, sessionKey);
    this.sessionContexts.set(sessionKey, { context, createdAt: Date.now(), lastUsedAt: Date.now() });
    return { context, reusable: true, ownsContext: false, mode: 'persistent-context' };
  }

  async createEphemeralContext({ proxyProfile = 'auto', url = '', sessionKey = null } = {}) {
    const browser = await this.getBrowser();
    const proxy = this.proxyRouter?.resolve(proxyProfile, url)?.playwrightProxy;
    return await browser.newContext(this.buildContextOptions(proxy, sessionKey));
  }

  async persistContextState(context, sessionKey) {
    const statePath = this.getSessionStatePath(sessionKey);
    if (!statePath || !context) return null;
    if (context === this.sharedContext) {
      return this.persistSharedContextState(context, sessionKey, statePath);
    }
    try {
      await context.storageState({ path: statePath });
      return statePath;
    } catch (err) {
      console.log(`[browser] failed to save session ${sessionKey}:`, err.message);
      return null;
    }
  }

  // A shared CDP context is the whole browser profile, not "session X". Writing
  // storageState() into <sessionKey>.json used to copy google's cookies into
  // bing.json (and every other session file), which the next hydrate then pushed back
  // into the shared jar. A session may only snapshot the hosts it visited itself; the
  // persistent profile stays the source of truth.
  async persistSharedContextState(context, sessionKey, statePath) {
    const scope = this._sessionDomains.get(sessionKey);
    if (!scope || scope.size === 0) {
      console.log(`[browser] skipped shared snapshot for ${sessionKey}: no visited host to scope it to`);
      return null;
    }
    try {
      const state = await context.storageState();
      const cookies = (state.cookies || []).filter((cookie) => domainInScope(cookie?.domain, scope));
      const origins = (state.origins || []).filter((entry) => domainInScope(hostOf(entry?.origin), scope));
      // Nothing attributable to this session: keep the previous file rather than
      // replacing a usable snapshot with an empty one.
      if (cookies.length === 0 && origins.length === 0) return null;
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      // Every search of the session rewrites this file and, on a shared profile, two
      // clients can do it at once -- publish atomically so a reader never sees half.
      const tmpPath = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ cookies, origins }));
      fs.renameSync(tmpPath, statePath);
      return statePath;
    } catch (err) {
      console.log(`[browser] failed to save session ${sessionKey}:`, err.message);
      return null;
    }
  }

  // Page-slot semaphore: strict FIFO, bounded queue, cancellable.
  //
  // The hand-off transfers the slot (the winner never re-counts), so a freed slot
  // always goes to the oldest waiter and never to a late arrival that happens to
  // check while the count dips. That overshoot used to run more pages than
  // MAX_CONCURRENT_PAGES on purpose-built low-power setups (cap = 1), which is
  // exactly what the cap exists to prevent. Hand-offs are only consumed by
  // waiters that are still alive, so a queue timeout racing a release can no
  // longer strand a slot forever (that leak made "page queue full" permanent
  // until restart). Overflow is rejected up front instead of queueing forever.
  _acquirePageSlot(signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this._activePageCount < MAX_CONCURRENT_PAGES && this._pageWaiters.length === 0) {
      this._activePageCount++;
      return Promise.resolve();
    }
    if (this._pageWaiters.length >= MAX_PAGE_QUEUE_WAITERS) {
      return Promise.reject(Object.assign(
        new Error(`page queue is full (${this._pageWaiters.length} waiting for ${MAX_CONCURRENT_PAGES} page slots); retry later`),
        { code: 'PAGE_QUEUE_FULL', details: this.pageQueueStatus() }
      ));
    }
    // A caller that carries a budget (one engine attempt, one tool call) must not
    // queue past it: its own deadline would fire while it still holds a queue
    // position, which surfaces as a bogus ENGINE_TIMEOUT and starves the next
    // client of queue capacity -- exactly the cascade a 1-slot host produces.
    const remainingMs = signalRemainingMs(signal);
    const waitMs = remainingMs === null
      ? PAGE_QUEUE_TIMEOUT_MS
      : Math.min(PAGE_QUEUE_TIMEOUT_MS, remainingMs);
    if (remainingMs !== null && waitMs < MIN_USEFUL_PAGE_WAIT_MS) {
      return Promise.reject(Object.assign(
        new Error(`no page slot free within the remaining ${Math.round(remainingMs)}ms budget`),
        {
          code: 'PAGE_BUSY',
          details: {
            ...this.pageQueueStatus(),
            waited_ms: 0,
            budget_ms: Math.round(remainingMs),
            retry_hint: 'All browser page slots were busy and this request had no time left to wait. Retry later, raise MAX_CONCURRENT_PAGES on a host that can afford it, or reduce parallel clients.'
          }
        }
      ));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false, timer: null, signal: signal || null, onAbort: null };
      const drop = () => {
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        const idx = this._pageWaiters.indexOf(waiter);
        if (idx !== -1) this._pageWaiters.splice(idx, 1);
      };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        drop();
        reject(abortError(signal));
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        drop();
        reject(Object.assign(new Error(`page queue full after ${waitMs}ms`), {
          code: 'PAGE_BUSY',
          details: {
            ...this.pageQueueStatus(),
            waited_ms: waitMs,
            retry_hint: 'All browser page slots were busy. Retry later, raise MAX_CONCURRENT_PAGES / PAGE_QUEUE_TIMEOUT_MS, or reduce parallel clients.'
          }
        }));
      }, waitMs);
      if (waiter.timer?.unref) waiter.timer.unref();
      if (waiter.signal) waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this._pageWaiters.push(waiter);
    });
  }

  _releasePageSlot() {
    if (this._activePageCount > 0) this._activePageCount--;
    while (this._activePageCount < MAX_CONCURRENT_PAGES && this._pageWaiters.length > 0) {
      const waiter = this._pageWaiters.shift();
      if (waiter.settled) continue; // already timed out / aborted; hand the slot on
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this._activePageCount++; // the slot travels with this hand-off
      waiter.resolve();
    }
    // The pool just went idle: anything this task could not close is now provably
    // unowned, so queue the sweep that retires it (deferred by the grace period).
    if (this._activePageCount === 0) this._scheduleReap();
  }

  // Cheap saturation snapshot for engine_status / failure details.
  pageQueueStatus() {
    return {
      active_pages: this._activePageCount,
      max_pages: MAX_CONCURRENT_PAGES,
      queued_pages: this._pageWaiters.length,
      max_queued_pages: MAX_PAGE_QUEUE_WAITERS,
      page_queue_timeout_ms: PAGE_QUEUE_TIMEOUT_MS,
      session_contexts: this.sessionContexts.size,
      max_session_contexts: MAX_SESSION_CONTEXTS,
      // Parked (keepPageOpen) pages are live Chromium that no slot counter sees, so
      // without these two numbers engine_status cannot explain why a 1-slot host is
      // out of memory.
      kept_pages: this._keptPages.size,
      max_kept_pages: MAX_KEPT_PAGES,
      // The interactive pages session engines pin in the visible browser. The sweep skips
      // them on purpose, so without this number "who owns that tab?" has no answer.
      session_pages: this.sessionPages.size,
      // Pages the pool opened and nobody has confirmed closed, plus what the sweep has
      // already retired. Without these the pool cannot explain a browser full of tabs
      // while every slot counter above reads zero.
      tracked_pages: this._ownedPages.size,
      // Tracked pages we have already asked to close that are still open: a number that
      // stays above zero is a page.close() that is never going to answer.
      wedged_pages: [...this._ownedPages.values()].filter((entry) => entry.closeAttemptedAt > 0).length,
      // of reaped_pages, how many needed the DevTools protocol to actually go away
      reaped_targets: this._reapedTargets,
      reaped_pages: this._reapedPages,
      page_reaper_interval_ms: PAGE_REAPER_INTERVAL_MS,
      low_power_device: LOW_POWER_DEVICE
    };
  }

  // True while somebody is queuing for a page: engines use it to drop optional
  // human-like waiting instead of burning CPU/latency the next client needs.
  isContended() {
    return this._pageWaiters.length > 0;
  }

  async withPage({ proxyProfile = 'auto', url = '', sessionKey = null, reuseSession = false, closeDelayMs = 0, timeoutMs = 0, signal = null } = {}, fn) {
    await this._acquirePageSlot(signal);
    let context;
    let ownsContext = false;
    let page = null;
    let heldSessionKey = null;
    // This task's pages: the page it opened plus every tab a click on it spawned.
    let task = null;
    const isCdpMode = Boolean(this.connectedBrowser);

    try {
      if (sessionKey && reuseSession) {
        ({ context } = await this.getSessionContext(sessionKey, { proxyProfile, url }));
        heldSessionKey = sessionKey;
        this._contextHeld.set(sessionKey, (this._contextHeld.get(sessionKey) || 0) + 1);
      } else if (isCdpMode) {
        context = await this.getSearchContext();
        // The teardown below may snapshot this session out of the shared jar, so the
        // target host has to be inside the session scope before that happens.
        this.recordSessionHost(sessionKey, url);
      } else {
        context = await this.createEphemeralContext({ proxyProfile, url, sessionKey });
        ownsContext = true;
      }

      page = await context.newPage();
      task = { startedAt: Date.now() };
      this._trackPage(page, context, { kind: 'task', task });
      this._adoptPopups(page, context, task);
      page.setDefaultTimeout(CONFIG.browserTimeoutMs);
      await applyStealthIfNeeded(page, { isCdpMode });

      let keepPageOpen = false;
      let aborted = false;
      let fnTimer;
      let onFnAbort = null;
      try {
        // Wrap fn so a hung browser task can be aborted: on timeout the page is
        // closed below, releasing the page slot for queued waiters (prevents
        // the pool from being starved by a stuck engine).
        const fnPromise = Promise.resolve().then(() => fn(page, context));
        fnPromise.catch(() => {}); // swallow late rejection after timeout path
        const racers = [fnPromise];
        if (timeoutMs > 0) {
          racers.push(new Promise((_, reject) => {
            fnTimer = setTimeout(() => {
              aborted = true;
              reject(Object.assign(new Error(`page task timed out after ${timeoutMs}ms`), { code: 'PAGE_TASK_TIMEOUT' }));
            }, timeoutMs);
            if (fnTimer?.unref) fnTimer.unref();
          }));
        }
        if (signal) {
          // The caller gave up (engine timeout / client gone). Close the page
          // now instead of finishing work nobody waits for while the only page
          // slot of a low-power device stays occupied.
          racers.push(new Promise((_, reject) => {
            onFnAbort = () => {
              aborted = true;
              reject(abortError(signal));
            };
            signal.addEventListener('abort', onFnAbort, { once: true });
          }));
        }
        const result = racers.length === 1 ? await fnPromise : await Promise.race(racers);
        if (result && result.keepPageOpen) {
          keepPageOpen = true;
        }
        return result;
      } catch (err) {
        if (!aborted && err && err.keepPageOpen) {
          keepPageOpen = true;
        }
        throw err;
      } finally {
        clearTimeout(fnTimer);
        if (signal && onFnAbort) signal.removeEventListener('abort', onFnAbort);
        // One budget for the entire teardown instead of one per step, so the worst
        // case a cancelled request costs the next client is PAGE_TEARDOWN_TIMEOUT_MS
        // -- plus the close's own reserve, which is what stops a slow cookie snapshot
        // from abandoning page.close() the moment it starts.
        const teardownDeadline = Date.now() + PAGE_TEARDOWN_TIMEOUT_MS;
        const closeFloorMs = Math.min(PAGE_CLOSE_MIN_TEARDOWN_MS, Math.floor(PAGE_TEARDOWN_TIMEOUT_MS / 2));
        // The steps before the close may spend the budget, but never all of it.
        const stepMs = () => Math.max(0, teardownDeadline - Date.now() - closeFloorMs);
        const teardownMs = () => Math.max(0, teardownDeadline - Date.now());
        if (sessionKey) {
          // Cookie persistence is worth waiting for, but not worth stalling the
          // whole pool for: it runs on the same context we are about to close.
          const persistMs = stepMs();
          if (persistMs >= MIN_AWAITABLE_STEP_MS) {
            await boundedTeardown(this.persistContextState(context, sessionKey), persistMs);
          }
        }
        if (keepPageOpen) {
          // Parking keeps this page for the human; the tabs it spawned are still ours
          // to close and nothing else will close them.
          this._closeTaskPopups(task);
          const key = sessionKey ? `session:${sessionKey}` : `_ephemeral_${Date.now()}`;
          const existing = this._keptPages.get(key);
          if (existing) {
            existing.page.close().catch(() => {});
            if (existing.ownsContext) existing.context.close().catch(() => {});
          }
          this._keptPages.set(key, { page, context, ownsContext, createdAt: Date.now() });
          // The TTL sweep is not a bound (an entry is only ever dropped after
          // KEPT_PAGE_TTL_MS), so enforce the resident-page cap on every park.
          if (this._keptPages.size > MAX_KEPT_PAGES) this._evictKeptPages();
        } else {
          // Let the visitor "linger" before closing (randomized, slows down
          // page open/close cadence and looks more human). closeDelayMs may be
          // a single ms value (jittered +/-40%) or a [min, max] range.
          // Skipped while other requests are queued: 1.5-12s of fake reading per
          // visit is the largest controllable share of a page slot on a busy
          // device. BROWSER_KEEP_LINGER_UNDER_LOAD=true restores the old timing.
          if (!aborted && closeDelayMs && (KEEP_LINGER_UNDER_LOAD || this._pageWaiters.length === 0)) {
            let minMs, maxMs;
            if (Array.isArray(closeDelayMs)) {
              minMs = Math.max(0, closeDelayMs[0]);
              maxMs = Math.max(minMs, closeDelayMs[1] ?? minMs);
            } else {
              minMs = Math.max(0, Math.floor(closeDelayMs * 0.6));
              maxMs = Math.max(minMs, Math.floor(closeDelayMs * 1.4));
            }
            const lingerMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
            await simulateBrowsing(page, lingerMs);
          }
          // Navigate to about:blank to stop all JS execution and abort any
          // in-flight requests before closing. This prevents hangs from
          // beforeunload dialogs (Playwright #11581), stalled route handlers
          // (#6317), and pages with websockets/long-polling/SSE that keep
          // the browser spinner active (network never reaches "idle").
          this._closeTaskPopups(task);
          // A step we cannot wait for is worse than no step at all: a navigation started
          // with a degenerate budget is still in flight when the close runs, and that is
          // exactly the close that then hangs and gets abandoned. Skip it instead.
          const gotoMs = stepMs();
          if (gotoMs >= MIN_AWAITABLE_STEP_MS) {
            await boundedTeardown(page.goto('about:blank', { waitUntil: 'domcontentloaded' }), gotoMs);
          }
          this._markReleased(page);
          // From here the ledger knows we have asked for this tab to go away, which is
          // what lets the sweep escalate to a protocol close instead of politely asking
          // a page that is never going to answer again.
          const taskEntry = this._ownedPages.get(page);
          if (taskEntry) taskEntry.closeAttemptedAt = Date.now();
          // The close gets all the remaining budget and at least closeFloorMs even
          // once the deadline has passed: holding a slot a little longer is cheap, a
          // tab that nobody ever closes is not.
          const closeOutcome = await boundedStep(page.close(), Math.max(teardownMs(), closeFloorMs));
          if (closeOutcome === 'done') {
            this._ownedPages.delete(page);
          } else {
            // Still live and now unowned. Forgetting it here is how the browser ends up
            // with a wall of about:blank tabs after a busy hour; the sweep retries it.
            this._scheduleReap(PAGE_CLOSE_WEDGE_MS + 250);
          }
          if (ownsContext) {
            await boundedTeardown(context.close(), teardownMs());
          }
        }
      }
    } finally {
      if (heldSessionKey) {
        const held = (this._contextHeld.get(heldSessionKey) || 1) - 1;
        if (held > 0) this._contextHeld.set(heldSessionKey, held);
        else this._contextHeld.delete(heldSessionKey);
      }
      this._releasePageSlot();
    }
  }

  async openSessionPage({ sessionKey, url, proxyProfile = 'auto' } = {}) {
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }

    let context;
    let mode = 'persistent-context';
    await this.getBrowser();
    // Asked after the connect: on a cold pool connectedBrowser is only set by
    // getBrowser(), and reading it earlier made a CDP-mode interactive page try
    // browser.newContext() -- which a CDP-connected browser refuses.
    const isCdpMode = Boolean(this.connectedBrowser);
    if (isCdpMode) {
      context = await this.getSharedContext();
      this.recordSessionHost(sessionKey, url);
      await this.hydrateSessionContext(context, sessionKey, { shared: true });
      mode = 'shared-cdp';
    } else {
      ({ context } = await this.getSessionContext(sessionKey, { proxyProfile, url }));
    }

    let pageEntry = this.sessionPages.get(sessionKey);
    let page;
    if (!pageEntry || pageEntry.page.isClosed()) {
      if (this.sessionPages.size >= MAX_SESSION_CONTEXTS) {
        const oldestKey = this.sessionPages.keys().next().value;
        if (oldestKey) {
          const oldEntry = this.sessionPages.get(oldestKey);
          this._retireSessionPage(oldEntry);
          this.sessionPages.delete(oldestKey);
        }
      }
      page = await context.newPage();
      // A pinned page is still a page we opened. It goes on the ledger, or a close that
      // never answers there leaks a tab nothing is allowed to retire afterwards.
      this._trackPage(page, context, { kind: 'session' });
      page.setDefaultTimeout(CONFIG.browserTimeoutMs);
      await applyStealthIfNeeded(page, { isCdpMode });
      applySessionResourcePolicy(page, { isCdpMode });
      if (isCdpMode) {
        // The interactive page exists so a human can log in / solve a captcha, and
        // those flows bounce across hosts. Whatever the human lands on becomes part of
        // this session's scope, otherwise the cookies that login just set are not its
        // own to save.
        page.on('framenavigated', (frame) => this.recordSessionHost(sessionKey, frame?.url?.()));
      }
      pageEntry = { page, lastAccessedAt: Date.now() };
      this.sessionPages.set(sessionKey, pageEntry);
    } else {
      page = pageEntry.page;
      pageEntry.lastAccessedAt = Date.now();
    }
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.browserTimeoutMs });
    }
    return {
      session: sessionKey,
      mode,
      current_url: page.url(),
      state_path: this.getSessionStatePath(sessionKey)
    };
  }

  async saveSessionState(sessionKey) {
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }
    let context;
    await this.getBrowser();
    if (this.connectedBrowser) {
      context = await this.getSharedContext();
    } else {
      ({ context } = await this.getSessionContext(sessionKey));
    }
    const statePath = await this.persistContextState(context, sessionKey);
    return {
      session: sessionKey,
      saved: Boolean(statePath),
      state_path: statePath
    };
  }

  _cleanupSessionPages() {
    const now = Date.now();
    for (const [key, entry] of this.sessionPages) {
      if (now - entry.lastAccessedAt > SESSION_PAGE_TTL_MS || entry.page.isClosed()) {
        this.sessionPages.delete(key);
        if (!entry.page.isClosed()) this._retireSessionPage(entry);
      }
    }
  }

  // Ask a session's interactive page to go away. Asking through the ledger is the point:
  // if this close is the one that never answers, the sweep can escalate to the target
  // behind the tab instead of leaving a blank tab in the browser for good.
  _retireSessionPage(entry) {
    const tracked = this._ownedPages.get(entry.page);
    if (tracked) {
      tracked.closeAttemptedAt = Date.now();
      this._scheduleReap(PAGE_CLOSE_WEDGE_MS + 250);
    }
    entry.page.close().catch(() => {});
  }

  sessionStatus(sessionKey, { redact } = {}) {
    const statePath = this.getSessionStatePath(sessionKey);
    const entry = this.sessionPages.get(sessionKey);
    const pinnedPage = entry ? entry.page : null;
    const status = {
      session: sessionKey,
      saved_state_exists: Boolean(statePath && fs.existsSync(statePath)),
      interactive_page_url: pinnedPage && !pinnedPage.isClosed() ? pinnedPage.url() : null,
      browser_mode: USE_EXISTING_CHROME ? 'existing-cdp' : 'playwright-launch',
      attached_to_existing_browser: browserIsConnected(this.connectedBrowser),
      launched_browser_connected: browserIsConnected(this.browser),
      search_headless: CONFIG.headless
    };
    if (!redact) {
      status.state_path = statePath;
      status.cdp_url = USE_EXISTING_CHROME ? CDP_URL : null;
      status.visible_browser_profile_dir = VISIBLE_BROWSER_PROFILE_DIR;
    }
    return status;
  }

  listSessionStatuses(sessionIds = [], opts) {
    return sessionIds.map(sessionId => this.sessionStatus(sessionId, opts));
  }

  async releaseSearchResources() {
    if (this._activePageCount > 0 || this._pageWaiters.length > 0) {
      return { released: false, reason: 'busy' };
    }
    for (const [key, entry] of [...this._keptPages]) {
      if (!key.startsWith('session:')) {
        this._keptPages.delete(key);
        entry.page.close().catch(() => {});
        if (entry.ownsContext) entry.context.close().catch(() => {});
      }
    }
    if (!this.connectedBrowser && this.searchContext) {
      const pages = this.searchContext.pages().filter(p => !p.isClosed());
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      await this.searchContext.close().catch(() => {});
      this.searchContext = null;
    }
    if (!this.connectedBrowser && this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => {});
    }
    return { released: true };
  }

  async close() {
    clearInterval(this._keptPagesCleanupTimer);
    clearInterval(this._sessionPagesCleanupTimer);
    clearInterval(this._pageReaperTimer);
    if (this._reapTimer) clearTimeout(this._reapTimer);
    this._reapTimer = null;
    this._reapDelayMs = 0;
    this._strayAttempts.clear();
    this._ourTargetIds.clear();
    if (this._browserCdp) {
      // The pool keeps an externally-managed Chrome alive, so let go of the protocol
      // session it borrowed instead of leaving it attached to someone else's browser.
      const session = this._browserCdp;
      this._browserCdp = null;
      await boundedValue(typeof session.detach === 'function' ? session.detach() : null, PAGE_PROTOCOL_TIMEOUT_MS);
    }
    for (const waiter of this._pageWaiters.splice(0, this._pageWaiters.length)) {
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(Object.assign(new Error('browser pool shutting down'), { code: 'SHUTDOWN' }));
    }
    this._contextHeld.clear();
    await this._resetKeptPages();
    for (const entry of this.sessionPages.values()) {
      await entry.page.close().catch(() => {});
    }
    this.sessionPages.clear();
    for (const { context } of this.sessionContexts.values()) {
      await context.close().catch(() => {});
    }
    this.sessionContexts.clear();
    if (this.searchContext) {
      const pages = this.searchContext.pages().filter(p => !p.isClosed());
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      await this.searchContext.close().catch(() => {});
      this.searchContext = null;
    }
    if (this.sharedContext) {
      const pages = this.sharedContext.pages().filter(p => !p.isClosed());
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      if (!this.connectedBrowser) {
        await this.sharedContext.close().catch(() => {});
      }
    }
    this.sharedContext = null;
    if (this.connectedBrowser) {
      // connectedBrowser is externally-managed (CDP-visible Chromium), don't kill it
      this.connectedBrowser = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
