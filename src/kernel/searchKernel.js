import crypto from 'crypto';
import { getBrowserSession, listBrowserSessions } from '../browser/sessionCatalog.js';
import { CONFIG } from '../config/index.js';
import { EngineRegistry } from '../engines/index.js';
import { PageFetcher } from '../fetch/pageFetcher.js';
import { mapLimit } from '../utils/limit.js';
import { hostOf, truncateText } from '../utils/normalize.js';

export class SearchKernel {
  constructor({ proxyRouter, browserPool, artifactStore }) {
    this.proxyRouter = proxyRouter;
    this.browserPool = browserPool;
    this.artifactStore = artifactStore;
    this.engines = new EngineRegistry({ proxyRouter, browserPool });
    this.fetcher = new PageFetcher({ proxyRouter, browserPool, artifactStore });
  }

  async searchWeb(args = {}) {
    const query = requiredString(args.query, 'query');
    const limit = limit20(args.limit);
    const engines = normalizeEnginesForSearch(args.engines, this.engines);
    const { results, failures, engines_tried } = await this.engines.searchMany(query, {
      limit,
      engines,
      proxyProfile: args.proxy_profile || args.proxyProfile || 'auto',
      timeoutMs: args.timeout_ms || args.timeoutMs
    });
    const query_id = 'q_' + crypto.createHash('sha1').update(query + Date.now()).digest('hex').slice(0, 12);
    const payload = { query_id, query, limit, results, failures, engines_tried, created_at: new Date().toISOString() };
    const artifact_ref = this.artifactStore.writeText('search', JSON.stringify(payload, null, 2), { query, kind: 'search_results' });
    return { ...payload, artifact_ref };
  }

  async fetchPage(args = {}) {
    const url = requiredString(args.url, 'url');
    return await this.fetcher.fetchPage(url, args);
  }

  async searchAndFetch(args = {}) {
    const query = requiredString(args.query, 'query');
    const limit = limit20(args.limit);
    const engines = normalizeEnginesForSearch(args.engines, this.engines);
    const totalPagesLimit = 30;
    const pagesPerEngine = Math.floor(totalPagesLimit / engines.length);
    const fetchTopK = Math.min(limit, Math.max(1, args.fetch_top_k ?? args.fetchTopK ?? pagesPerEngine));
    const maxCharsTotal = Number(args.max_chars_total || args.maxCharsTotal || 30000);
    const search = await this.searchWeb({ ...args, query, limit, engines });
    const selected = search.results.slice(0, fetchTopK);
    const fetched = await mapLimit(selected, CONFIG.maxFetchConcurrency, async (result, index) => {
      const page = await this.fetchPage({
        url: result.url,
        mode: args.fetch_mode || args.mode || 'auto',
        proxy_profile: args.proxy_profile || args.proxyProfile || 'auto',
        max_chars: Math.max(2000, Math.floor(maxCharsTotal / Math.max(1, fetchTopK))),
        timeout_ms: args.timeout_ms || args.timeoutMs
      });
      return { result, page, index };
    });
    const items = [];
    const failures = [...(search.failures || [])];
    for (const row of fetched) {
      if (row.page.status === 'success') {
        items.push({
          title: row.result.title,
          url: row.result.url,
          host: hostOf(row.result.url),
          snippet: row.result.snippet,
          engine: row.result.engine,
          rank: row.result.rank,
          fetch_mode: row.page.fetch_mode,
          text_preview: truncateText(row.page.text_preview, 1800),
          artifact_ref: row.page.artifact_ref,
          source_type: classifySource(row.result.url)
        });
      } else {
        failures.push({ url: row.result.url, engine: row.result.engine, code: row.page.failure_code || 'FETCH_FAILED', message: row.page.attempts?.at(-1)?.message || 'fetch failed' });
      }
    }
    const bundle_id = 'eb_' + crypto.createHash('sha1').update(query + Date.now()).digest('hex').slice(0, 12);
    const bundle = {
      type: 'evidence_bundle',
      bundle_id,
      query,
      searched_results: search.results.length,
      pages_requested: selected.length,
      pages_fetched: items.length,
      pages_skipped: selected.length - items.length,
      items,
      failures,
      search_artifact_ref: search.artifact_ref,
      created_at: new Date().toISOString()
    };
    const artifact_ref = this.artifactStore.writeText('bundles', JSON.stringify(bundle, null, 2), { query, kind: 'evidence_bundle' });
    return { ...bundle, artifact_ref };
  }

  async researchProblem(args = {}) {
    const ps = args.problem_signature || args.problemSignature || {};
    const base = [ps.task, ps.symptom, ps.error_message, ps.environment ? JSON.stringify(ps.environment) : '', ...(ps.constraints || [])].filter(Boolean).join(' ');
    const sourcePolicy = args.source_policy || args.sourcePolicy || {};
    const prefer = sourcePolicy.prefer || ['official docs', 'github issues', 'stackoverflow'];
    const budget = args.budget || {};
    const maxQueries = Math.min(Number(budget.max_queries || 4), 6);
    const maxPages = Math.min(Number(budget.max_pages || 8), 20);
    const queries = makeQueryFamilies(base, prefer).slice(0, maxQueries);
    const bundles = [];
    const failures = [];
    for (const q of queries) {
      try {
        const b = await this.searchAndFetch({
          query: q,
          limit: Math.min(20, Number(budget.max_results_per_query || 8)),
          fetch_top_k: Math.max(1, Math.floor(maxPages / maxQueries)),
          max_chars_total: Math.floor(Number(budget.max_chars_total || 50000) / maxQueries),
          proxy_profile: args.network_policy?.proxy_profile || args.proxy_profile || 'auto'
        });
        bundles.push(b);
      } catch (err) {
        failures.push({ query: q, code: err.code || 'RESEARCH_QUERY_FAILED', message: err.message });
      }
    }
    const claim_candidates = bundles.flatMap(b => b.items.slice(0, 3).map(item => ({
      claim: `${item.title} — ${item.snippet || item.text_preview.slice(0, 300)}`,
      supporting_sources: [{ title: item.title, url: item.url, artifact_ref: item.artifact_ref }],
      confidence_hint: confidenceHint(item.url)
    })));
    const research_id = 'rs_' + crypto.randomBytes(6).toString('hex');
    return { research_id, queries_executed: queries, evidence_bundles: bundles.map(b => ({ bundle_id: b.bundle_id, artifact_ref: b.artifact_ref, pages_fetched: b.pages_fetched, failures: b.failures?.length || 0 })), claim_candidates, failures, recommended_next_action: claim_candidates.length ? 'use_context_or_run_probe' : 'refine_query' };
  }

  engineStatus() {
    return { status: 'ok', engines: this.engines.list(), proxy_profiles: this.proxyRouter.status(), limits: { max_search_limit: CONFIG.maxSearchLimit, max_fetch_concurrency: CONFIG.maxFetchConcurrency } };
  }

  browserSessions() {
    return {
      sessions: listBrowserSessions().map(session => ({
        ...session,
        ...this.browserPool.sessionStatus(session.id)
      }))
    };
  }

  async openBrowserSession(args = {}) {
    const sessionId = requiredString(args.session || args.session_id || args.id, 'session');
    const session = getBrowserSession(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const targetUrl = String(args.url || args.target_url || session.loginUrl || session.homeUrl);
    const proxyProfile = args.proxy_profile || args.proxyProfile || this.proxyRouter.resolveForEngine(session.engine, targetUrl).profile;
    const info = await this.browserPool.openSessionPage({
      sessionKey: session.id,
      url: targetUrl,
      proxyProfile
    });
    return {
      ...session,
      ...info,
      message: 'Open the remote browser UI and complete the login there.'
    };
  }

  async saveBrowserSession(args = {}) {
    const sessionId = requiredString(args.session || args.session_id || args.id, 'session');
    const session = getBrowserSession(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return {
      ...session,
      ...(await this.browserPool.saveSessionState(session.id))
    };
  }

  getArtifact(args = {}) {
    return this.artifactStore.read(requiredString(args.artifact_ref || args.artifactRef, 'artifact_ref'), args.offset || 0, args.limit || 8000);
  }
}

function requiredString(v, name) {
  if (!v || typeof v !== 'string') throw new Error(`${name} is required`);
  return v;
}
function limit20(v) {
  return Math.max(1, Math.min(CONFIG.maxSearchLimit, Number(v || CONFIG.defaultSearchLimit)));
}
function normalizeEnginesForSearch(engines, registry) {
  if (!engines || engines.length === 0 || engines.includes('auto')) {
    return registry.defaultSearchEngines();
  }
  return engines;
}
function classifySource(url) {
  const h = hostOf(url);
  if (h.includes('github.com')) return 'github';
  if (h.includes('stackoverflow.com') || h.includes('stackexchange.com')) return 'forum';
  if (h.includes('docs.') || h.includes('developer.') || h.includes('learn.microsoft.com')) return 'official_doc';
  if (h.includes('wikipedia.org')) return 'encyclopedia';
  return 'web';
}
function confidenceHint(url) {
  const type = classifySource(url);
  return ({ official_doc: 0.82, github: 0.76, forum: 0.62, encyclopedia: 0.65, web: 0.48 })[type] || 0.5;
}
function makeQueryFamilies(base, prefer) {
  const clean = String(base || '').replace(/\s+/g, ' ').trim();
  return [clean, ...prefer.map(p => `${clean} ${p}`), `${clean} solution`, `${clean} error fix`].filter(Boolean);
}
