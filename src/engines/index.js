import { CONFIG, readJsonIfExists } from '../config/index.js';
import { uniqueByUrl } from '../utils/normalize.js';
import { searchDuckDuckGoHttp } from './duckduckgo_http.js';
import { searchBing } from './bing.js';
import { searchGoogle } from './google.js';
import { searchWikipedia } from './wikipedia.js';
import { searchChatGPT } from './chatgpt.js';
import { searchCustomHtml } from './custom_html.js';
import { searchWithFallbacks } from './api_fallback.js';

export class EngineRegistry {
  constructor({ proxyRouter, browserPool }) {
    this.proxyRouter = proxyRouter;
    this.browserPool = browserPool;
    this.customEngines = readJsonIfExists(CONFIG.customEnginesFile, []);
  }

  list() {
    return [
      { id: 'duckduckgo', builtin: true, primary: true },
      { id: 'bing', builtin: true },
      { id: 'wikipedia', builtin: true },
      { id: 'google', builtin: true, note: 'via visible Chromium + reusable browser session' },
      { id: 'chatgpt', builtin: true, note: 'via Chrome DevTools MCP + reusable browser session' },
      ...this.customEngines.map(e => ({ id: e.id, builtin: false, type: e.type || 'html' }))
    ];
  }

  defaultSearchEngines() {
    return ['duckduckgo', 'bing', 'wikipedia', 'google', ...this.customEngines.map(e => e.id)];
  }

  engineStatus() {
    const status = this.proxyRouter.status();
    return { engines: this.list(), proxy_profiles: status.profiles, engine_proxies: status.engine_proxies };
  }

  async searchOne(engine, query, opts = {}) {
    const proxy = this.proxyRouter.resolveForEngine(engine);
    const baseOpts = { ...opts, proxyRouter: this.proxyRouter, proxyProfile: proxy.profile, browserPool: this.browserPool };
    if (engine === 'duckduckgo') return await searchDuckDuckGoHttp(query, baseOpts);
    if (engine === 'bing') return await searchBing(query, baseOpts);
    if (engine === 'wikipedia') return await searchWikipedia(query, baseOpts);
    if (engine === 'google') return await searchGoogle(query, baseOpts);
    if (engine === 'chatgpt') return await searchChatGPT(query, baseOpts);
    const custom = this.customEngines.find(e => e.id === engine);
    if (custom) return await searchCustomHtml(custom, query, baseOpts);
    throw new Error(`unknown engine: ${engine}`);
  }

  async searchMany(query, opts = {}) {
    const limit = Math.min(opts.limit || CONFIG.defaultSearchLimit, CONFIG.maxSearchLimit);
    const engines = normalizeEngines(opts.engines, this.customEngines);
    const failures = [];
    const all = [];
    const failedEngines = [];
    
    for (const engine of engines) {
      try {
        const results = await this.searchOne(engine, query, { ...opts, limit });
        all.push(...results);
      } catch (err) {
        failures.push({ engine, code: err.code || 'ENGINE_ERROR', message: err.message, details: err.details || {} });
        failedEngines.push(engine);
      }
    }
    
    let fallbackWarning = null;
    if (failedEngines.length > 0) {
      const fallbackData = await searchWithFallbacks(query, limit, failedEngines);
      if (fallbackData) {
        all.push(...fallbackData.results);
        fallbackWarning = `页面搜索不可用，已通过 ${fallbackData.via} API 获取结果。注意：${fallbackData.via} 有免费额度限制，超出后可能产生费用。建议配置自己的API Key。`;
      }
    }
    
    return { results: uniqueByUrl(all, limit).slice(0, limit), failures, engines_tried: engines, fallback: fallbackWarning };
  }
}

function normalizeEngines(engines, customEngines) {
  if (!engines || engines.length === 0 || engines.includes('auto')) {
    return ['duckduckgo', 'bing', 'wikipedia', 'google', ...customEngines.map(e => e.id)];
  }
  return engines;
}
