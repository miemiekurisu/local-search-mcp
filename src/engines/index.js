import { CONFIG, readJsonIfExists } from '../config/index.js';
import { getBrowserSessionByEngine } from '../browser/sessionCatalog.js';
import { uniqueByUrl } from '../utils/normalize.js';
import { searchDuckDuckGo } from './duckduckgo_http.js';
import { searchBing } from './bing.js';
import { searchGoogle } from './google.js';
import { searchWikipedia } from './wikipedia.js';
import { searchChatGPT } from './chatgpt.js';
import { searchDeepSeek } from './deepseek.js';
import { searchCustomHtml } from './custom_html.js';
import { searchWithFallbacks } from './api_fallback.js';

const CHROMIUM_ONLY_ENGINES = new Set(['google', 'chatgpt', 'deepseek']);
let engineTimeoutOverride = null;
if (Number.isFinite(Number(process.env.ENGINE_TIMEOUT_MS)) && Number(process.env.ENGINE_TIMEOUT_MS) > 0) {
  engineTimeoutOverride = Number(process.env.ENGINE_TIMEOUT_MS);
}

export class EngineRegistry {
  constructor({ proxyRouter, browserPool }) {
    this.proxyRouter = proxyRouter;
    this.browserPool = browserPool;
    this.customEngines = readJsonIfExists(CONFIG.customEnginesFile, []);
  }

  list() {
    return [
      { id: 'duckduckgo', builtin: true, primary: true },
      { id: 'bing', builtin: true, session: 'bing' },
      { id: 'wikipedia', builtin: true },
      { id: 'google', builtin: true, chromium_only: true, session: 'google', note: 'via visible Chromium + reusable browser session' },
      { id: 'chatgpt', builtin: true, chromium_only: true, session: 'chatgpt', note: 'via Chrome DevTools MCP + reusable browser session' },
      { id: 'deepseek', builtin: true, chromium_only: true, session: 'deepseek', note: 'via visible Chromium + reusable browser session' },
      ...this.customEngines.map(e => ({ id: e.id, builtin: false, type: e.type || 'html' }))
    ];
  }

  defaultSearchEngines() {
    return ['duckduckgo', 'wikipedia', ...this.customEngines.map(e => e.id)];
  }

  engineStatus() {
    const status = this.proxyRouter.status();
    return { engines: this.list(), proxy_profiles: status.profiles, engine_proxies: status.engine_proxies };
  }

  async searchOne(engine, query, opts = {}) {
    const proxy = this.proxyRouter.resolveForEngine(engine);
    const baseOpts = { ...opts, proxyRouter: this.proxyRouter, proxyProfile: proxy.profile, browserPool: this.browserPool };
    if (engine === 'duckduckgo') return await searchDuckDuckGo(query, baseOpts);
    if (engine === 'bing') return await searchBing(query, baseOpts);
    if (engine === 'wikipedia') return await searchWikipedia(query, baseOpts);
    if (engine === 'google') return await searchGoogle(query, baseOpts);
    if (engine === 'chatgpt') return await searchChatGPT(query, baseOpts);
    if (engine === 'deepseek') return await searchDeepSeek(query, baseOpts);
    const custom = this.customEngines.find(e => e.id === engine);
    if (custom) return await searchCustomHtml(custom, query, baseOpts);
    throw new Error(`unknown engine: ${engine}`);
  }

  async searchMany(query, opts = {}) {
    const limit = Math.min(opts.limit || CONFIG.defaultSearchLimit, CONFIG.maxSearchLimit);
    const poolLimit = Math.max(limit, Math.min(limit * 2, CONFIG.maxSearchLimit * 2));
    const engines = normalizeEngines(opts.engines, this.customEngines);
    const failures = [];
    const perEngine = [];
    const failedEngines = [];

    for (const engine of engines) {
      try {
        const timeout = engineTimeoutOverride ?? (engine === 'chatgpt' ? 180000 : engine === 'google' ? 150000 : engine === 'deepseek' ? 360000 : engine === 'bing' ? 60000 : 20000);
        const results = await withTimeout(this.searchOne(engine, query, { ...opts, limit: poolLimit }), timeout);
        if (results.length > 0) perEngine.push(results);
      } catch (err) {
        failures.push(this.buildFailure(engine, err));
        failedEngines.push(engine);
      }
    }

    // Interleave engine result lists round-robin so one fast/dominant engine
    // cannot exhaust poolLimit before the later engines contribute anything.
    const all = [];
    for (let i = 0; all.length < poolLimit; i++) {
      let added = false;
      for (const list of perEngine) {
        if (i < list.length) {
          all.push(list[i]);
          added = true;
          if (all.length >= poolLimit) break;
        }
      }
      if (!added) break;
    }
    
    let fallbackWarning = null;
    const fallbackSkipped = failures
      .filter(failure => CHROMIUM_ONLY_ENGINES.has(failure.engine))
      .map(failure => ({
        engine: failure.engine,
        reason: 'chromium_session_required',
        session: failure.session || null
      }));
    const fallbackEligibleEngines = failedEngines.filter(engine => !CHROMIUM_ONLY_ENGINES.has(engine));
    if (fallbackEligibleEngines.length > 0) {
      try {
        const fallbackData = await searchWithFallbacks(query, limit, fallbackEligibleEngines);
        if (fallbackData) {
          all.push(...fallbackData.results);
          fallbackWarning = `页面搜索不可用，已通过 ${fallbackData.via} API 获取结果。注意：${fallbackData.via} 有免费额度限制，超出后可能产生费用。建议配置自己的API Key。`;
        }
      } catch (err) {
        console.error(`[search] fallback API failed: ${err?.message || err}`);
      }
    }
    
    return {
      results: uniqueByUrl(all, poolLimit).slice(0, poolLimit),
      failures,
      engines_tried: engines,
      fallback: fallbackWarning,
      fallback_attempted_for: fallbackEligibleEngines,
      fallback_skipped: fallbackSkipped
    };
  }

  buildFailure(engine, err) {
    const session = getBrowserSessionByEngine(engine);
    const errorObject = err && typeof err === 'object' ? err : {};
    const details = { ...(errorObject.details || {}) };
    let retryHint = details.retry_hint;

    if (session) {
      details.browser_session = {
        id: session.id,
        label: session.label,
        login_url: session.loginUrl,
        home_url: session.homeUrl,
        ...(this.browserPool?.sessionStatus(session.id) || {})
      };
    }

    if (!retryHint && CHROMIUM_ONLY_ENGINES.has(engine)) {
      retryHint = `Open the ${session?.id || engine} session in noVNC, complete login/verification in the visible Chromium, then retry.`;
    }

    return {
      engine,
      code: errorObject.code || 'ENGINE_ERROR',
      message: errorObject.message || String(err),
      chromium_only: CHROMIUM_ONLY_ENGINES.has(engine),
      session: session?.id || null,
      retry_hint: retryHint || null,
      details
    };
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.catch(err => {
      console.error(`[search] late engine failure: ${err?.message || err}`);
      throw err;
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Engine timed out after ${ms}ms`);
        err.code = 'ENGINE_TIMEOUT';
        reject(err);
      }, ms);
      if (typeof timer?.unref === 'function') timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
}

function normalizeEngines(engines, customEngines) {
  if (!engines || engines.length === 0 || engines.includes('auto')) {
    return ['duckduckgo', 'wikipedia', ...customEngines.map(e => e.id)];
  }
  if (engines.includes('default')) {
    const defaults = ['duckduckgo', 'wikipedia', ...customEngines.map(e => e.id)];
    const others = engines.filter(e => e !== 'default' && e !== 'auto');
    return [...new Set([...defaults, ...others])];
  }
  return engines;
}
