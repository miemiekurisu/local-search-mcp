import fs from 'fs';
import { chromium } from 'playwright';
import { CONFIG, safeJoin } from '../config/index.js';

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const USE_EXISTING_CHROME = process.env.USE_EXISTING_CHROME === 'true';

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
  '--start-maximized'
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
      if (!this.connectedBrowser) {
        try {
          console.log('[browser] connecting to existing Chrome via CDP...');
          let cdpEndpoint = CDP_URL;
          if (!CDP_URL.includes('/json') && !CDP_URL.includes('/devtools/')) {
            const resp = await fetch(`${CDP_URL}/json/version`).catch(() => null);
            if (resp?.ok) {
              const data = await resp.json();
              cdpEndpoint = data.webSocketDebuggerUrl;
            }
          }
          this.connectedBrowser = await chromium.connectOverCDP(cdpEndpoint);
          console.log('[browser] connected to existing Chrome');
        } catch (err) {
          console.log('[browser] could not connect to existing Chrome:', err.message);
          console.log('[browser] falling back to launch new browser');
          this.browser = await chromium.launch(this.launchOptions());
        }
      }
    } else if (!this.browser) {
      this.browser = await chromium.launch(this.launchOptions());
    }
    return this.connectedBrowser || this.browser;
  }

  launchOptions() {
    return {
      headless: CONFIG.headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args: LAUNCH_ARGS
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
    if (this.sharedContext) {
      try {
        this.sharedContext.pages();
        return this.sharedContext;
      } catch {
        this.sharedContext = null;
      }
    }
    const browser = await this.getBrowser();
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      this.sharedContext = contexts[0];
      return this.sharedContext;
    }
    this.sharedContext = await browser.newContext();
    return this.sharedContext;
  }

  async hydrateSharedContext(context, sessionKey) {
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
      await this.hydrateSharedContext(context, sessionKey);
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
    } else {
      context = await this.createEphemeralContext({ proxyProfile, url, sessionKey });
      ownsContext = true;
    }

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.browserTimeoutMs);
    await stealthPlugin(page);
    try {
      return await fn(page, context);
    } finally {
      if (sessionKey) {
        await this.persistContextState(context, sessionKey);
      }
      await page.close().catch(() => {});
      if (ownsContext) {
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
    if (this.connectedBrowser) {
      context = await this.getSharedContext();
      await this.hydrateSharedContext(context, sessionKey);
      mode = 'shared-cdp';
    } else {
      ({ context } = await this.getSessionContext(sessionKey, { proxyProfile, url }));
    }

    let page = this.sessionPages.get(sessionKey);
    if (!page || page.isClosed()) {
      page = await context.newPage();
      page.setDefaultTimeout(CONFIG.browserTimeoutMs);
      await stealthPlugin(page);
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
      attached_to_existing_browser: Boolean(this.connectedBrowser)
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
