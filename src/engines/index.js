import { CONFIG, readJsonIfExists } from '../config/index.js';
import { getBrowserSessionByEngine } from '../browser/sessionCatalog.js';
import { uniqueByUrl } from '../utils/normalize.js';
import { abortError, markSignalDeadline } from '../utils/abort.js';
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
    // Only a real AbortSignal reaches the engines: opts often comes straight off
    // an HTTP/MCP body, and anything else must not be dereferenced by the pool.
    const signal = opts.signal instanceof AbortSignal ? opts.signal : null;
    const baseOpts = { ...opts, signal, proxyRouter: this.proxyRouter, proxyProfile: proxy.profile, browserPool: this.browserPool };
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

    // Caller-side cancellation (MCP client gone / tool deadline) stops the whole
    // fan-out. Without it the engines after the abandoned one would each queue a
    // fresh browser task that nobody reads, which is exactly the backlog this
    // registry used to create on a device with one page slot. Non-AbortSignal
    // values (an HTTP body may contain anything) are ignored, not dereferenced.
    const callerSignal = opts.signal instanceof AbortSignal ? opts.signal : null;

    for (const engine of engines) {
      if (callerSignal?.aborted) {
        failures.push(this.buildFailure(engine, abortError(callerSignal, `search cancelled before ${engine}`)));
        failedEngines.push(engine);
        continue;
      }
      // Each engine gets its own AbortController so that a timeout actually
      // stops the work instead of only ignoring it. Without this the abandoned
      // engine keeps its browser page (and on a 1-slot device the whole pool)
      // until Playwright gives up, which is what turned one slow engine into a
      // "page queue full" cascade for every other client.
      const controller = new AbortController();
      // Publish the budget on the signal so the page queue can bound its own wait
      // (see markSignalDeadline): queueing is pointless once the remaining budget
      // cannot cover a navigation, and PAGE_BUSY beats a bogus ENGINE_TIMEOUT.
      const timeout = engineTimeoutOverride ?? (engine === 'chatgpt' ? 180000 : engine === 'google' ? 150000 : engine === 'deepseek' ? 360000 : engine === 'bing' ? 60000 : 20000);
      markSignalDeadline(controller.signal, timeout);
      const relay = () => controller.abort(callerSignal?.reason ?? 'search cancelled by caller');
      if (callerSignal) callerSignal.addEventListener('abort', relay, { once: true });
      try {
        const results = await withTimeout(
          this.searchOne(engine, query, { ...opts, limit: poolLimit, signal: controller.signal }),
          timeout,
          () => controller.abort(`engine timeout: ${engine}`)
        );
        if (results.length > 0) perEngine.push(results);
      } catch (err) {
        failures.push(this.buildFailure(engine, err));
        failedEngines.push(engine);
      } finally {
        if (callerSignal) callerSignal.removeEventListener('abort', relay);
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

function withTimeout(promise, ms, onTimeout = null) {
  let timer;
  let timedOut = false;
  return Promise.race([
    promise.catch(err => {
      // Once the deadline fired the caller already recorded an ENGINE_TIMEOUT
      // failure and the work was aborted, so this rejection is expected fallout.
      // Logging it made every slow engine look like a second, unrelated outage.
      if (!timedOut) console.error(`[search] late engine failure: ${err?.message || err}`);
      throw err;
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // Cancel the loser of the race. Leaving it running is what starves the
        // browser page queue on devices that can only afford one page at a time.
        try {
          onTimeout?.();
        } catch { /* the timeout error below is what the caller sees */ }
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
