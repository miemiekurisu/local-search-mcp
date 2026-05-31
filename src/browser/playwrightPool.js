import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { CONFIG, safeJoin } from '../config/index.js';

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const USE_EXISTING_CHROME = process.env.USE_EXISTING_CHROME === 'true';
const EXISTING_CHROME_CONNECT_TIMEOUT_MS = envInt('EXISTING_CHROME_CONNECT_TIMEOUT_MS', 15000, 1000);
const EXISTING_CHROME_CONNECT_RETRY_MS = envInt('EXISTING_CHROME_CONNECT_RETRY_MS', 500, 100);
const VISIBLE_BROWSER_PROFILE_DIR = process.env.VISIBLE_BROWSER_PROFILE_DIR || null;

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

function browserIsConnected(browser) {
  return Boolean(browser && (typeof browser.isConnected !== 'function' || browser.isConnected()));
}

async function stealthPlugin(page) {
  await page.addInitScript(() => {
    if (window.navigator.webdriver) {
      delete window.navigator.webdriver;
    }
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
    
    window.navigator.chrome = {
      runtime: {},
      webstore: {}
    };
    
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true
    });
    
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [],
      configurable: true
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true
    });
    
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => [4, 8, 12, 16][Math.floor(Math.random() * 4)],
      configurable: true
    });
    
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => [4, 8, 16][Math.floor(Math.random() * 3)],
      configurable: true
    });
    
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
      configurable: true
    });
    
    window.cdc_adoQnsasSS = window.chrome = void 0;
    window.$cdc_asdjflasutopfhvcZLmcif_ = void 0;
    
    const originalQuery = window.indexedDB.open;
    window.indexedDB.open = function() {
      return originalQuery.apply(this, arguments);
    };
  });
}

async function humanBehavior(page) {
  await page.mouse.move(Math.random() * 500, Math.random() * 500, { steps: 5 });
  await page.waitForTimeout(Math.random() * 300 + 100);
}

export class PlaywrightPool {
  constructor(proxyRouter) {
    this.proxyRouter = proxyRouter;
    this.browser = null;
    this.connectedBrowser = null;
    this.sharedContext = null;
    this.sessionContexts = new Map();
    this.sessionPages = new Map();
    this.hydratedSharedSessions = new Set();
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
    this.sessionPages.clear();
    this.hydratedSharedSessions.clear();
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
      return this.sharedContext;
    }
    this.sharedContext = await browser.newContext();
    return this.sharedContext;
  }

  async hydrateSessionContext(context, sessionKey) {
    if (!sessionKey || this.hydratedSharedSessions.has(sessionKey)) {
      return;
    }
    const statePath = this.getSessionStatePath(sessionKey);
    if (!statePath || !fs.existsSync(statePath)) {
      this.hydratedSharedSessions.add(sessionKey);
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (Array.isArray(raw.cookies) && raw.cookies.length > 0) {
        await context.addCookies(raw.cookies);
      }
      if (Array.isArray(raw.origins) && raw.origins.length > 0) {
        for (const originEntry of raw.origins) {
          if (!originEntry?.origin || !Array.isArray(originEntry.localStorage) || originEntry.localStorage.length === 0) {
            continue;
          }
          const page = await context.newPage();
          try {
            await page.goto(originEntry.origin, { waitUntil: 'domcontentloaded', timeout: CONFIG.browserTimeoutMs });
            await page.evaluate((entries) => {
              for (const entry of entries) {
                window.localStorage.setItem(entry.name, entry.value);
              }
            }, originEntry.localStorage);
          } catch (err) {
            console.log(`[browser] failed to restore localStorage for ${originEntry.origin}:`, err.message);
          } finally {
            await page.close().catch(() => {});
          }
        }
      }
      console.log(`[browser] restored shared session state for ${sessionKey}`);
    } catch (err) {
      console.log(`[browser] failed to restore shared session ${sessionKey}:`, err.message);
    } finally {
      this.hydratedSharedSessions.add(sessionKey);
    }
  }

  async getSessionContext(sessionKey, { proxyProfile = 'auto', url = '' } = {}) {
    const browser = await this.getBrowser();

    if (this.connectedBrowser) {
      const context = await this.getSharedContext();
      await this.hydrateSessionContext(context, sessionKey);
      return { context, reusable: true, ownsContext: false, mode: 'shared-cdp' };
    }

    const existing = this.sessionContexts.get(sessionKey);
    if (existing) {
      try {
        existing.context.pages();
        return { context: existing.context, reusable: true, ownsContext: false, mode: 'persistent-context' };
      } catch {
        this.sessionContexts.delete(sessionKey);
      }
    }

    const proxy = this.proxyRouter?.resolve(proxyProfile, url)?.playwrightProxy;
    const context = await browser.newContext(this.buildContextOptions(proxy, sessionKey));
    await this.hydrateSessionContext(context, sessionKey);
    this.sessionContexts.set(sessionKey, { context });
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
    try {
      await context.storageState({ path: statePath });
      return statePath;
    } catch (err) {
      console.log(`[browser] failed to save session ${sessionKey}:`, err.message);
      return null;
    }
  }

  async withPage({ proxyProfile = 'auto', url = '', sessionKey = null, reuseSession = false } = {}, fn) {
    let context;
    let ownsContext = false;
    if (sessionKey && reuseSession) {
      ({ context } = await this.getSessionContext(sessionKey, { proxyProfile, url }));
    } else if (this.connectedBrowser) {
      context = await this.getSharedContext();
    } else {
      context = await this.createEphemeralContext({ proxyProfile, url, sessionKey });
      ownsContext = true;
    }

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.browserTimeoutMs);
    await stealthPlugin(page);
    let keepPageOpen = false;
    try {
      const result = await fn(page, context);
      if (result && result.keepPageOpen) {
        keepPageOpen = true;
      }
      return result;
    } finally {
      if (sessionKey) {
        await this.persistContextState(context, sessionKey);
      }
      if (!keepPageOpen) {
        await page.close().catch(() => {});
      }
      if (ownsContext && !keepPageOpen) {
        await context.close().catch(() => {});
      }
    }
  }

  async openSessionPage({ sessionKey, url, proxyProfile = 'auto' } = {}) {
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }

    let context;
    let mode = 'persistent-context';
    await this.getBrowser();
    if (this.connectedBrowser) {
      context = await this.getSharedContext();
      await this.hydrateSessionContext(context, sessionKey);
      mode = 'shared-cdp';
    } else {
      ({ context } = await this.getSessionContext(sessionKey, { proxyProfile, url }));
    }

    let page = this.sessionPages.get(sessionKey);
    if (!page || page.isClosed()) {
      page = await context.newPage();
      page.setDefaultTimeout(CONFIG.browserTimeoutMs);
      await stealthPlugin(page);
      await page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i, route => route.abort());
      this.sessionPages.set(sessionKey, page);
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

  sessionStatus(sessionKey) {
    const statePath = this.getSessionStatePath(sessionKey);
    const pinnedPage = this.sessionPages.get(sessionKey);
    return {
      session: sessionKey,
      saved_state_exists: Boolean(statePath && fs.existsSync(statePath)),
      state_path: statePath,
      interactive_page_url: pinnedPage && !pinnedPage.isClosed() ? pinnedPage.url() : null,
      browser_mode: USE_EXISTING_CHROME ? 'existing-cdp' : 'playwright-launch',
      attached_to_existing_browser: browserIsConnected(this.connectedBrowser),
      launched_browser_connected: browserIsConnected(this.browser),
      cdp_url: USE_EXISTING_CHROME ? CDP_URL : null,
      visible_browser_profile_dir: VISIBLE_BROWSER_PROFILE_DIR,
      search_headless: CONFIG.headless
    };
  }

  listSessionStatuses(sessionIds = []) {
    return sessionIds.map(sessionId => this.sessionStatus(sessionId));
  }

  async close() {
    for (const page of this.sessionPages.values()) {
      await page.close().catch(() => {});
    }
    this.sessionPages.clear();
    for (const { context } of this.sessionContexts.values()) {
      await context.close().catch(() => {});
    }
    this.sessionContexts.clear();
    if (this.sharedContext && !this.connectedBrowser) {
      await this.sharedContext.close().catch(() => {});
    }
    this.sharedContext = null;
    if (this.connectedBrowser) {
      await this.connectedBrowser.close().catch(() => {});
      this.connectedBrowser = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
