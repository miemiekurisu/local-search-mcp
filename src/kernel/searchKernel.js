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
    const search = await this.engines.searchMany(query, {
      limit,
      engines,
      proxyProfile: args.proxy_profile || args.proxyProfile || 'auto',
      timeoutMs: args.timeout_ms || args.timeoutMs
    });
    const fetchTopK = Math.min(search.results.length, Math.max(0, Number(args.fetch_top_k ?? args.fetchTopK ?? 5)));
    const maxCharsTotal = Number(args.max_chars_total || args.maxCharsTotal || 30000);
    const query_id = 'q_' + crypto.createHash('sha1').update(query + Date.now()).digest('hex').slice(0, 12);
    const payload = {
      query_id,
      query,
      limit,
      results: search.results,
      failures: search.failures,
      engines_tried: search.engines_tried,
      fallback: search.fallback || null,
      fallback_attempted_for: search.fallback_attempted_for || [],
      fallback_skipped: search.fallback_skipped || [],
      created_at: new Date().toISOString()
    };
    if (fetchTopK > 0 && search.results.length > 0) {
      const pool = search.results;
      const deadline = Date.now() + 60000;
      const allFetched = await mapLimit(pool, CONFIG.maxFetchConcurrency, async (result) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { result, page: null, status: 'failed', error: { code: 'FETCH_TIMEOUT', message: 'deadline exceeded before fetch started' } };
        }
        try {
          const proxyProfile = this.proxyRouter.resolveForEngine(result.engine, result.url).profile;
          const page = await this.fetchPage({
            url: result.url,
            mode: args.fetch_mode || args.mode || 'auto',
            proxy_profile: proxyProfile,
            max_chars: Math.max(2000, Math.floor(maxCharsTotal / Math.max(1, fetchTopK))),
            timeout_ms: args.timeout_ms || args.timeoutMs,
            deadline: deadline
          });
          return { result, page, status: 'success' };
        } catch (err) {
          return { result, page: null, status: 'failed', error: { code: err.code || 'FETCH_ERROR', message: err.message } };
        }
      });
      const items = [];
      const fetchFailures = [];
      for (const row of allFetched) {
        if (row.status !== 'success' || !row.page) {
          const code = row.error?.code || 'FETCH_FAILED';
          const msg = row.error?.message || 'fetch failed';
          fetchFailures.push({ url: row.result.url, engine: row.result.engine, code, message: msg });
        } else if (row.page.status === 'success') {
          const text = String(row.page.text_preview || '');
          items.push({
            title: row.result.title,
            url: row.result.url,
            host: hostOf(row.result.url),
            snippet: row.result.snippet,
            engine: row.result.engine,
            rank: row.result.rank,
            fetch_mode: row.page.fetch_mode,
            text_preview: truncateText(text, 1800),
            artifact_ref: row.page.artifact_ref,
            source_type: classifySource(row.result.url)
          });
        } else {
          fetchFailures.push({ url: row.result.url, engine: row.result.engine, code: row.page.failure_code || 'FETCH_FAILED', message: row.page.attempts?.at(-1)?.message || 'fetch failed' });
        }
      }
      payload.fetched = items.slice(0, fetchTopK);
      payload.fetched_count = payload.fetched.length;
      payload.fetch_failures = fetchFailures;
      if (fetchFailures.length > 0) {
        payload.failures = [...(payload.failures || []), ...fetchFailures];
      }
    }
    const artifact_ref = this.artifactStore.writeText('search', JSON.stringify(payload, null, 2), { query, kind: 'search_results' });
    return { ...payload, artifact_ref };
  }

  async fetchPage(args = {}) {
    const url = requiredString(args.url, 'url');
    return await this.fetcher.fetchPage(url, args);
  }

  async searchAndFetch(args = {}) {
    const query = requiredString(args.query, 'query');
    const search = await this.searchWeb({
      ...args,
      fetch_top_k: args.fetch_top_k ?? args.fetchTopK ?? 3,
    });
    const items = (search.fetched || []).map(f => ({
      title: f.title, url: f.url, host: f.host,
      snippet: f.snippet, engine: f.engine, rank: f.rank,
      fetch_mode: f.fetch_mode, text_preview: f.text_preview,
      artifact_ref: f.artifact_ref, source_type: f.source_type
    }));
    const failures = [...(search.failures || [])];
    const bundle_id = 'eb_' + crypto.createHash('sha1').update(query + Date.now()).digest('hex').slice(0, 12);
    const bundle = {
      type: 'evidence_bundle', bundle_id, query,
      searched_results: search.results.length,
      pages_requested: items.length + (search.fetch_failures || []).length,
      pages_fetched: items.length,
      pages_skipped: (search.fetch_failures || []).length,
      items, failures,
      search_artifact_ref: search.artifact_ref,
      search_fallback: search.fallback || null,
      search_fallback_attempted_for: search.fallback_attempted_for || [],
      search_fallback_skipped: search.fallback_skipped || [],
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
    const researchDeadline = Date.now() + Number(budget.timeout_ms || 300000);
    for (const q of queries) {
      if (Date.now() > researchDeadline) {
        failures.push({ query: q, code: 'RESEARCH_TIMEOUT', message: 'Research total time limit exceeded' });
        break;
      }
      let queryTimerId;
      try {
        const remaining = Math.max(15000, researchDeadline - Date.now());
        const timeoutPromise = new Promise((_, reject) => {
          queryTimerId = setTimeout(
            () => reject(Object.assign(new Error('Query timed out'), { code: 'QUERY_TIMEOUT' })),
            Math.min(remaining, 120000)
          );
          if (typeof queryTimerId?.unref === 'function') queryTimerId.unref();
        });
        const b = await Promise.race([
          this.searchAndFetch({
            query: q,
            limit: Math.min(20, Number(budget.max_results_per_query || 8)),
            fetch_top_k: Math.max(1, Math.floor(maxPages / maxQueries)),
            max_chars_total: Math.floor(Number(budget.max_chars_total || 50000) / maxQueries),
            proxy_profile: args.network_policy?.proxy_profile || args.proxy_profile || 'auto'
          }),
          timeoutPromise
        ]);
        clearTimeout(queryTimerId);
        bundles.push(b);
      } catch (err) {
        clearTimeout(queryTimerId);
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
    return {
      status: 'ok',
      engines: this.engines.list(),
      browser_sessions: listBrowserSessions().map(session => ({
        ...session,
        ...this.browserPool.sessionStatus(session.id, { redact: true })
      })),
      proxy_profiles: this.proxyRouter.status(),
      limits: { max_search_limit: CONFIG.maxSearchLimit, max_fetch_concurrency: CONFIG.maxFetchConcurrency }
    };
  }

  browserSessions() {
    return {
      sessions: listBrowserSessions().map(session => ({
        ...session,
        ...this.browserPool.sessionStatus(session.id, { redact: false })
      }))
    };
  }

  async openBrowserSession(args = {}) {
    const sessionId = requiredString(args.session || args.session_id || args.id, 'session');
    const session = getBrowserSession(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const targetUrl = String(args.url || args.target_url || session.loginUrl || session.homeUrl);
    const proxyProfile = args.proxy_profile || args.proxyProfile || this.proxyRouter.resolveForEngine(session.engine, targetUrl).profile;
    let info;
    try {
      info = await this.browserPool.openSessionPage({
        sessionKey: session.id,
        url: targetUrl,
        proxyProfile
      });
    } catch (err) {
      err.details = {
        ...(err.details || {}),
        session: session.id,
        engine: session.engine,
        target_url: targetUrl,
        proxy_profile: proxyProfile,
        browser_session: redactBrowserSession(this.browserPool.sessionStatus(session.id))
      };
      throw err;
    }
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
    try {
      return {
        ...session,
        ...(await this.browserPool.saveSessionState(session.id))
      };
    } catch (err) {
      err.details = {
        ...(err.details || {}),
        session: session.id,
        engine: session.engine,
        browser_session: redactBrowserSession(this.browserPool.sessionStatus(session.id))
      };
      throw err;
    }
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
  if (engines.includes('default')) {
    const defaults = registry.defaultSearchEngines();
    const others = engines.filter(e => e !== 'default' && e !== 'auto');
    return [...new Set([...defaults, ...others])];
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
function redactBrowserSession(session) {
  if (!session) return session;
  const { cdp_url, state_path, visible_browser_profile_dir, ...rest } = session;
  return rest;
}
