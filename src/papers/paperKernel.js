import crypto from 'crypto';
import { fetch } from 'undici';
import { PaperRouter } from './paperRouter.js';
import { deduplicatePapers } from './paperDeduplicator.js';
import { rankPapers } from './paperRanker.js';
import { createPaperRecord, normalizeDoi, normalizeArxivId } from './paperSchemas.js';
import * as arxivClient from './clients/arxivClient.js';

const OPENALEX_BASE = 'https://api.openalex.org';
const SEMANTIC_SCHOLAR_BASE = 'https://api.semanticscholar.org/graph/v1';
const CROSSREF_BASE = 'https://api.crossref.org/works';
const UNPAYWALL_BASE = 'https://api.unpaywall.org/v2';

function getConfig() {
  return {
    openalexKey: process.env.OPENALEX_API_KEY || null,
    semanticScholarKey: process.env.SEMANTIC_SCHOLAR_API_KEY || null,
    crossrefMailto: process.env.CROSSREF_MAILTO || null,
    unpaywallEmail: process.env.UNPAYWALL_EMAIL || null
  };
}

function isSourceEnabled(name) {
  const cfg = getConfig();
  switch (name) {
    case 'openalex': return !!cfg.openalexKey;
    case 'semantic_scholar': return !!cfg.semanticScholarKey;
    case 'arxiv': return true;
    case 'crossref': return true;
    case 'unpaywall': return !!cfg.unpaywallEmail;
    default: return false;
  }
}

async function fetchWithRetry(url, options = {}, bodyReader) {
  const { headers = {}, method = 'GET', body, timeoutMs = 30000 } = options;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': 'local-search-mcp/1.0', ...headers },
        body: body || undefined,
        signal: controller.signal
      });
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter && attempt === 1) {
          clearTimeout(timer);
          const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 3000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (res.status === 429 && attempt === 1) {
          clearTimeout(timer);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: text.slice(0, 500) });
      }
      return await bodyReader(res);
    } finally {
      clearTimeout(timer);
    }
  }
  // Preserve the last actual error instead of always reporting 429
  throw Object.assign(new Error(`fetchWithRetry exhausted after 2 attempts`), { status: 429 });
}

async function fetchJson(url, options = {}) {
  return fetchWithRetry(url, options, (res) => res.json());
}

async function fetchText(url, options = {}) {
  return fetchWithRetry(url, options, (res) => res.text());
}

function openalexSearch(query, options = {}) {
  const { limit = 20, yearFrom, yearTo, apiKey } = options;
  const params = new URLSearchParams();
  params.set('search', query);
  params.set('per_page', String(Math.min(limit, 200)));
  if (yearFrom) params.set('filter', `from_publication_date:${yearFrom}-01-01`);
  if (yearTo) params.set('filter', params.get('filter') ? `${params.get('filter')},to_publication_date:${yearTo}-12-31` : `to_publication_date:${yearTo}-12-31`);
  const headers = { 'accept': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;
  return fetchJson(`${OPENALEX_BASE}/works?${params}`, { headers });
}

function openalexLookup(id, options = {}) {
  const headers = { 'accept': 'application/json' };
  if (options.apiKey) headers['api-key'] = options.apiKey;
  return fetchJson(`${OPENALEX_BASE}/works/${id}`, { headers });
}

function openalexCitations(id, options = {}) {
  const headers = { 'accept': 'application/json' };
  if (options.apiKey) headers['api-key'] = options.apiKey;
  return fetchJson(`${OPENALEX_BASE}/works/${id}/citations`, { headers });
}

function openalexReferences(id, options = {}) {
  const headers = { 'accept': 'application/json' };
  if (options.apiKey) headers['api-key'] = options.apiKey;
  return fetchJson(`${OPENALEX_BASE}/works/${id}/references`, { headers });
}

function semanticScholarSearch(query, options = {}) {
  const { limit = 20, yearFrom, yearTo, apiKey } = options;
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('limit', String(Math.min(limit, 100)));
  params.set('fields', 'title,authors,year,venue,publicationTypes,externalIds,abstract,citationCount,referenceCount,fieldsOfStudy,openAccessPdf,isOpenAccess');
  if (yearFrom) params.set('year', `${yearFrom}-${yearTo || ''}`);
  const headers = { 'accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return fetchJson(`${SEMANTIC_SCHOLAR_BASE}/paper/search?${params}`, { headers });
}

function semanticScholarLookup(id, options = {}) {
  const params = new URLSearchParams();
  params.set('fields', 'title,authors,year,venue,publicationTypes,externalIds,abstract,citationCount,referenceCount,fieldsOfStudy,openAccessPdf,isOpenAccess');
  const headers = { 'accept': 'application/json' };
  if (options.apiKey) headers['x-api-key'] = options.apiKey;
  return fetchJson(`${SEMANTIC_SCHOLAR_BASE}/paper/${id}?${params}`, { headers });
}

function semanticScholarCitations(id, options = {}) {
  const { limit = 20, apiKey } = options;
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(limit, 100)));
  params.set('fields', 'title,authors,year,venue,externalIds,abstract,citationCount');
  const headers = { 'accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return fetchJson(`${SEMANTIC_SCHOLAR_BASE}/paper/${id}/citations?${params}`, { headers });
}

function semanticScholarReferences(id, options = {}) {
  const { limit = 20, apiKey } = options;
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(limit, 100)));
  params.set('fields', 'title,authors,year,venue,externalIds,abstract,citationCount');
  const headers = { 'accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return fetchJson(`${SEMANTIC_SCHOLAR_BASE}/paper/${id}/references?${params}`, { headers });
}

function arxivSearch(query, options = {}) {
  const { limit = 20 } = options;
  return arxivClient.search({ query: `ti:${query}`, maxResults: limit, sortBy: 'relevance' });
}

function crossrefSearch(query, options = {}) {
  const { limit = 20, mailto } = options;
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('rows', String(Math.min(limit, 100)));
  if (mailto) params.set('mailto', mailto);
  return fetchJson(`${CROSSREF_BASE}?${params}`, { headers: { 'accept': 'application/json' } });
}

function crossrefLookup(doi, options = {}) {
  const params = new URLSearchParams();
  if (options.mailto) params.set('mailto', options.mailto);
  const qs = params.toString();
  return fetchJson(`${CROSSREF_BASE}/${encodeURIComponent(doi)}${qs ? '?' + qs : ''}`, { headers: { 'accept': 'application/json' } });
}

function unpaywallLookup(doi, options = {}) {
  const email = options.email || options.unpaywallEmail;
  if (!email) return Promise.resolve(null);
  return fetchJson(`${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, { headers: { 'accept': 'application/json' } });
}

function normalizeOpenalexResult(work) {
  const doi = work.doi ? normalizeDoi(work.doi) : null;
  const arxivId = work.ids && work.ids.arxiv ? normalizeArxivId(work.ids.arxiv) : null;
  const oaStatus = work.open_access && work.open_access.oa_status ? work.open_access.oa_status : 'unknown';

  return createPaperRecord({
    title: work.title || '',
    authors: (work.authorships || []).map(a => ({
      name: a.author?.display_name || '',
      id: a.author?.id || null,
      source: 'openalex'
    })),
    year: work.publication_year || null,
    published_date: work.publication_date || null,
    venue: (work.primary_location?.source?.display_name || work.primary_location?.source?.host_organization_name || ''),
    publication_type: work.type || 'unknown',
    doi,
    arxiv_id: arxivId,
    openalex_id: work.id || null,
    abstract: work.abstract_inverted_index ? reconstructAbstract(work.abstract_inverted_index) : '',
    citation_count: work.cited_by_count || null,
    reference_count: work.referenced_works_count || null,
    fields_of_study: (work.concepts || []).map(c => c.display_name).filter(Boolean),
    is_open_access: work.open_access?.is_oa || null,
    open_access_status: oaStatus,
    landing_page_url: work.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : ''),
    pdf_url: work.open_access?.oa_url || '',
    license: work.open_access?.license || '',
    source_records: [{ source: 'openalex', id: work.id, url: work.id ? `https://openalex.org/${work.id}` : '' }]
  });
}

function reconstructAbstract(invertedIndex, maxLen = 10000) {
  if (!invertedIndex) return '';
  const map = new Map();
  for (const [word, indices] of Object.entries(invertedIndex)) {
    for (const pos of indices) {
      if (pos >= maxLen) continue; // guard against maliciously large position values
      map.set(pos, word);
    }
  }
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([, w]) => w).join(' ');
}

function normalizeSemanticScholarResult(paper) {
  const externalIds = paper.externalIds || {};
  const doi = externalIds.DOI ? normalizeDoi(externalIds.DOI) : null;
  const arxivId = externalIds.ArXiv ? normalizeArxivId(externalIds.ArXiv) : null;

  return createPaperRecord({
    title: paper.title || '',
    authors: (paper.authors || []).map(a => ({ name: a.name || '', id: a.authorId || null, source: 'semantic_scholar' })),
    year: paper.year || null,
    venue: paper.venue || '',
    publication_type: (paper.publicationTypes || []).includes('JournalArticle') ? 'journal-article' : 'proceedings-article',
    doi,
    arxiv_id: arxivId,
    semantic_scholar_id: paper.paperId || null,
    abstract: paper.abstract || '',
    citation_count: paper.citationCount != null ? paper.citationCount : null,
    reference_count: paper.referenceCount != null ? paper.referenceCount : null,
    fields_of_study: paper.fieldsOfStudy || [],
    is_open_access: paper.isOpenAccess || null,
    open_access_status: paper.isOpenAccess ? 'gold' : 'unknown',
    pdf_url: paper.openAccessPdf?.url || '',
    landing_page_url: `https://www.semanticscholar.org/paper/${paper.paperId}`,
    source_records: [{ source: 'semantic_scholar', id: paper.paperId, url: `https://www.semanticscholar.org/paper/${paper.paperId}` }]
  });
}

function normalizeCrossrefResult(work) {
  const doi = work.DOI ? normalizeDoi(work.DOI) : null;
  const title = (work.title || [])[0] || '';
  const authors = (work.author || []).map(a => ({ name: [a.given, a.family].filter(Boolean).join(' '), source: 'crossref' }));

  return createPaperRecord({
    title,
    authors,
    year: work.published?.dateParts?.[0]?.[0] || null,
    published_date: work.created?.dateTime || work.issued?.dateParts ? `${(Array.isArray(work.issued.dateParts[0]) ? work.issued.dateParts[0] : []).join('-')}` : null,
    venue: work['container-title']?.[0] || work['publisher'] || '',
    publication_type: work.type || 'unknown',
    doi,
    abstract: work.abstract ? work.abstract.replace(/<jats:p>|<\/jats:p>/g, '') : '',
    citation_count: work['is-referenced-by-count'] != null ? work['is-referenced-by-count'] : null,
    reference_count: work.references?.length || null,
    landing_page_url: doi ? `https://doi.org/${doi}` : '',
    source_records: [{ source: 'crossref', id: doi, url: `https://doi.org/${doi}` }]
  });
}

function detectIdentifierType(value) {
  if (!value) return null;
  const s = value.trim();

  if (/^10\.\d{4,}/.test(s)) return 'doi';
  if (/^10\.\d{4,}\/.+/.test(s)) return 'doi';
  if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) return 'arxiv';
  if (/^W\d{9,}$/.test(s)) return 'openalex';
  if (/^CorpusId:\d+$/i.test(s) || /^\d{7,}$/.test(s)) return 'semantic_scholar';
  if (/^PMID:\d+$/i.test(s)) return 'pubmed';

  return null;
}

function identifierForSource(value, type) {
  if (type === 'doi') return normalizeDoi(value);
  if (type === 'arxiv') return normalizeArxivId(value);
  if (type === 'openalex') return value.startsWith('https://') ? value : `https://openalex.org/W${value.replace(/^W/, '')}`;
  if (type === 'semantic_scholar') return value.replace(/^CorpusId:/i, '');
  return value;
}

export class PaperKernel {
  constructor({ sourceRegistry, artifactStore, rateLimiter } = {}) {
    this.sourceRegistry = sourceRegistry || null;
    this.artifactStore = artifactStore || null;
    this.rateLimiter = rateLimiter || null;
    this.router = new PaperRouter(sourceRegistry || { isSourceEnabled: isSourceEnabled, getEnabledSources: () => [] });
    this._config = getConfig();
  }

  async searchPapers(args = {}) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');

    const sources = this.router.chooseSources({
      domain: args.domain,
      intent: 'paper_search',
      sources: args.sources
    });

    const limit = Math.max(1, Math.min(args.limit || 20, 100));
    const failures = [];
    const allPapers = [];

    for (const source of sources) {
      try {
        let results = [];
        switch (source) {
          case 'openalex': {
            const data = await openalexSearch(query, { limit, yearFrom: args.year_from || args.yearFrom, yearTo: args.year_to || args.yearTo, apiKey: this._config.openalexKey });
            results = (data.results || []).map(normalizeOpenalexResult);
            break;
          }
          case 'semantic_scholar': {
            const data = await semanticScholarSearch(query, { limit, yearFrom: args.year_from || args.yearFrom, yearTo: args.year_to || args.yearTo, apiKey: this._config.semanticScholarKey });
            results = (data.data || []).map(normalizeSemanticScholarResult);
            break;
          }
          case 'arxiv': {
            const result = await arxivSearch(query, { limit });
            results = result.papers || [];
            break;
          }
          case 'crossref': {
            const data = await crossrefSearch(query, { limit, mailto: this._config.crossrefMailto });
            results = (data.message?.items || []).map(normalizeCrossrefResult);
            break;
          }
          default:
            break;
        }
        allPapers.push(...results);
      } catch (err) {
        failures.push({ source, code: err.status || 'SEARCH_FAILED', message: err.message });
      }
    }

    const deduplicated = deduplicatePapers(allPapers);
    const ranked = rankPapers(deduplicated, query, { domain: args.domain || 'ai_ml' });

    const limited = args.open_access_only
      ? ranked.filter(p => p.is_open_access === true || p.open_access_status !== 'closed').slice(0, limit)
      : ranked.slice(0, limit);

    const query_id = 'pq_' + crypto.createHash('sha1').update(query + Date.now()).digest('hex').slice(0, 12);
    const payload = {
      query_id,
      query,
      sources_tried: sources,
      papers: limited,
      failures,
      created_at: new Date().toISOString()
    };

    const artifact_ref = this.artifactStore
      ? this.artifactStore.writeText('papers', JSON.stringify(payload, null, 2), { query, kind: 'paper_search_results' })
      : null;

    return { ...payload, artifact_ref };
  }

  async lookupPaper(args = {}) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) throw new Error('identifier is required');

    const type = args.identifier_type || args.identifierType || detectIdentifierType(identifier);
    if (!type) throw new Error(`unable to detect identifier type for: ${identifier}`);

    const sources = this.router.chooseSources({
      intent: 'paper_lookup',
      sources: args.sources
    });

    const failures = [];
    let bestPaper = null;

    for (const source of sources) {
      try {
        let paper = null;
        switch (source) {
          case 'openalex': {
            const id = type === 'openalex' ? identifierForSource(identifier, type) : identifierForSource(identifier, 'doi');
            if (type === 'doi') {
              const data = await openalexSearch(identifier, { limit: 1, apiKey: this._config.openalexKey });
              if (data.results && data.results.length > 0) paper = normalizeOpenalexResult(data.results[0]);
            } else {
              const data = await openalexLookup(id, { apiKey: this._config.openalexKey });
              if (data && data.id) paper = normalizeOpenalexResult(data);
            }
            break;
          }
          case 'semantic_scholar': {
            const id = type === 'semantic_scholar' ? identifierForSource(identifier, type) : identifierForSource(identifier, 'doi');
            if (type === 'doi') {
              const data = await semanticScholarSearch(identifier, { limit: 1, apiKey: this._config.semanticScholarKey });
              if (data.data && data.data.length > 0) paper = normalizeSemanticScholarResult(data.data[0]);
            } else {
              const data = await semanticScholarLookup(id, { apiKey: this._config.semanticScholarKey });
              if (data && data.paperId) paper = normalizeSemanticScholarResult(data);
            }
            break;
          }
          case 'arxiv': {
            const id = type === 'arxiv' ? identifierForSource(identifier, type) : identifier;
            const result = await arxivClient.lookup({ id });
            if (result) paper = result;
            break;
          }
          case 'crossref': {
            if (type === 'doi') {
              const data = await crossrefLookup(identifier, { mailto: this._config.crossrefMailto });
              if (data && data.message) paper = normalizeCrossrefResult(data.message);
            }
            break;
          }
          case 'unpaywall': {
            if (type === 'doi' && this._config.unpaywallEmail) {
              const data = await unpaywallLookup(identifier, { email: this._config.unpaywallEmail });
              if (data) {
                paper = createPaperRecord({
                  doi: normalizeDoi(identifier),
                  title: data.title || '',
                  year: data.year || null,
                  is_open_access: data.is_oa || null,
                  open_access_status: data.oa_status || 'unknown',
                  pdf_url: data.best_oa_location?.url_for_pdf || '',
                  landing_page_url: data.best_oa_location?.url_for_landing_page || data.doi_url || '',
                  license: data.best_oa_location?.license || '',
                  source_records: [{ source: 'unpaywall', id: identifier, url: `https://api.unpaywall.org/v2/${identifier}` }]
                });
              }
            }
            break;
          }
          default:
            break;
        }
        if (paper) {
          if (bestPaper) {
            const { mergePaperRecords } = await import('./paperDeduplicator.js');
            bestPaper = mergePaperRecords(bestPaper, paper);
          } else {
            bestPaper = paper;
          }
        }
      } catch (err) {
        failures.push({ source, code: err.status || 'LOOKUP_FAILED', message: err.message });
      }
    }

    return {
      paper: bestPaper || null,
      sources_tried: sources,
      source_records: bestPaper?.source_records || [],
      failures
    };
  }

  async expandPaperCitations(args = {}) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) throw new Error('identifier is required');

    const direction = args.direction || 'both';
    const limit = Math.max(1, Math.min(args.limit || 50, 200));
    const type = detectIdentifierType(identifier);

    const lookup = await this.lookupPaper({ identifier, identifier_type: type });
    const rootPaper = lookup.paper;
    if (!rootPaper) return { root_paper: null, edges: [], papers: [], failures: [{ code: 'NOT_FOUND', message: `paper not found: ${identifier}` }] };

    const failures = [...lookup.failures];
    const edges = [];
    const papers = [];
    const seenPaperKeys = new Set();

    const sources = this.router.chooseSources({ intent: 'citation_graph', sources: args.sources });

    for (const source of sources) {
      try {
        if ((direction === 'references' || direction === 'both') && rootPaper.openalex_id) {
          if (source === 'openalex') {
            const data = await openalexReferences(rootPaper.openalex_id.replace('https://openalex.org/', ''), { apiKey: this._config.openalexKey });
            for (const ref of (data.results || [])) {
              const paper = normalizeOpenalexResult(ref);
              edges.push({ from: rootPaper.openalex_id, to: ref.id, relation: 'cites', source: 'openalex' });
              if (!seenPaperKeys.has(paper.doi || paper.openalex_id)) {
                seenPaperKeys.add(paper.doi || paper.openalex_id);
                papers.push(paper);
              }
            }
          }
        }

        if ((direction === 'cited_by' || direction === 'both') && rootPaper.semantic_scholar_id) {
          if (source === 'semantic_scholar') {
            const data = await semanticScholarCitations(rootPaper.semantic_scholar_id, { limit, apiKey: this._config.semanticScholarKey });
            for (const entry of (data.data || [])) {
              const citingPaper = entry.citingPaper;
              if (!citingPaper) continue;
              const paper = normalizeSemanticScholarResult(citingPaper);
              const toId = rootPaper.semantic_scholar_id;
              edges.push({ from: citingPaper.paperId, to: toId, relation: 'cited_by', source: 'semantic_scholar' });
              if (!seenPaperKeys.has(paper.doi || paper.semantic_scholar_id)) {
                seenPaperKeys.add(paper.doi || paper.semantic_scholar_id);
                papers.push(paper);
              }
            }
          }
        }

        if ((direction === 'references' || direction === 'both') && rootPaper.semantic_scholar_id) {
          if (source === 'semantic_scholar') {
            const data = await semanticScholarReferences(rootPaper.semantic_scholar_id, { limit, apiKey: this._config.semanticScholarKey });
            for (const entry of (data.data || [])) {
              const refPaper = entry.paperCited;
              if (!refPaper) continue;
              const paper = normalizeSemanticScholarResult(refPaper);
              edges.push({ from: rootPaper.semantic_scholar_id, to: refPaper.paperId, relation: 'cites', source: 'semantic_scholar' });
              if (!seenPaperKeys.has(paper.doi || paper.semantic_scholar_id)) {
                seenPaperKeys.add(paper.doi || paper.semantic_scholar_id);
                papers.push(paper);
              }
            }
          }
        }
      } catch (err) {
        failures.push({ source, code: err.status || 'EXPAND_FAILED', message: err.message });
      }
    }

    const deduplicated = deduplicatePapers(papers);
    const research_id = 'ce_' + crypto.createHash('sha1').update(identifier + Date.now()).digest('hex').slice(0, 12);
    const payload = {
      root_paper: rootPaper,
      edges: edges.slice(0, limit),
      papers: deduplicated.slice(0, limit),
      failures
    };

    const artifact_ref = this.artifactStore
      ? this.artifactStore.writeText('citations', JSON.stringify(payload, null, 2), { identifier, direction, kind: 'citation_expansion' })
      : null;

    return { ...payload, root_paper: rootPaper, edges: edges.slice(0, limit), papers: deduplicated.slice(0, limit), artifact_ref };
  }

  async findOpenAccess(args = {}) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) throw new Error('identifier is required');

    const type = detectIdentifierType(identifier);
    const doi = type === 'doi' ? normalizeDoi(identifier) : null;

    if (!doi) {
      const lookup = await this.lookupPaper({ identifier, identifier_type: type, sources: ['crossref'] });
      const resolvedDoi = lookup.paper?.doi;
      if (!resolvedDoi) {
        return { identifier, is_open_access: false, oa_status: 'unknown', best_pdf_url: null, best_landing_page_url: null, license: null, source_records: [], failures: [{ code: 'NO_DOI', message: 'could not resolve DOI' }] };
      }
      return this.findOpenAccess({ ...args, identifier: resolvedDoi });
    }

    const failures = [];
    let result = { identifier: doi, is_open_access: false, oa_status: 'unknown', best_pdf_url: null, best_landing_page_url: null, license: null, source_records: [] };

    if (this._config.unpaywallEmail) {
      try {
        const data = await unpaywallLookup(doi, { email: this._config.unpaywallEmail });
        if (data) {
          const oaLocation = data.best_oa_location || data.oa_locations?.[0] || null;
          result = {
            identifier: doi,
            is_open_access: !!data.is_oa,
            oa_status: data.oa_status || 'unknown',
            best_pdf_url: oaLocation?.url_for_pdf || '',
            best_landing_page_url: oaLocation?.url_for_landing_page || data.doi_url || '',
            license: oaLocation?.license || '',
            source_records: [{ source: 'unpaywall', id: doi, url: `https://api.unpaywall.org/v2/${doi}` }]
          };
        }
      } catch (err) {
        failures.push({ source: 'unpaywall', code: err.status || 'OA_LOOKUP_FAILED', message: err.message });
      }
    } else {
      failures.push({ source: 'unpaywall', code: 'NO_EMAIL', message: 'UNPAYWALL_EMAIL not configured' });
    }

    if (!result.is_open_access && this._config.openalexKey) {
      try {
        const data = await openalexSearch(doi, { limit: 1, apiKey: this._config.openalexKey });
        if (data.results && data.results.length > 0) {
          const work = data.results[0];
          if (work.open_access?.is_oa) {
            result.is_open_access = true;
            result.oa_status = work.open_access.oa_status || 'unknown';
            result.best_pdf_url = result.best_pdf_url || work.open_access.oa_url || '';
            result.license = result.license || work.open_access.license || '';
            result.source_records.push({ source: 'openalex', id: work.id, url: `https://openalex.org/${work.id}` });
          }
        }
      } catch (err) {
        failures.push({ source: 'openalex', code: err.status || 'OA_FALLBACK_FAILED', message: err.message });
      }
    }

    return { ...result, failures };
  }

  async researchPapers(args = {}) {
    const question = String(args.research_question || args.researchQuestion || '').trim();
    if (!question) throw new Error('research_question is required');

    const domain = args.domain || 'ai_ml';
    const budget = args.budget || {};
    const maxQueries = Math.min(budget.max_queries || 5, 10);
    const maxPapers = Math.min(budget.max_papers || 50, 200);
    const maxCitationExpansions = Math.min(budget.max_citation_expansions || 10, 50);

    const queries = this._generateResearchQueries(question).slice(0, maxQueries);
    const failures = [];
    const allPapers = [];

    for (const q of queries) {
      try {
        const result = await this.searchPapers({
          query: q,
          domain,
          limit: Math.ceil(maxPapers / maxQueries),
          year_from: args.year_from || args.yearFrom,
          year_to: args.year_to || args.yearTo,
          include_preprints: args.source_policy?.include_preprints !== false,
          open_access_only: args.source_policy?.open_access_only || false,
          sources: args.sources
        });
        allPapers.push(...result.papers);
        if (result.failures) failures.push(...result.failures.map(f => ({ ...f, query: q })));
      } catch (err) {
        failures.push({ query: q, code: err.status || 'RESEARCH_PAPER_FAILED', message: err.message });
      }
    }

    const deduplicated = deduplicatePapers(allPapers);
    const ranked = rankPapers(deduplicated, question, { domain });

    const keyPapers = ranked.slice(0, Math.min(10, maxPapers));
    const relatedPapers = ranked.slice(Math.min(10, maxPapers), maxPapers);

    const citationClusters = [];
    const topPapersForExpansion = keyPapers.slice(0, Math.min(3, maxCitationExpansions));
    for (const paper of topPapersForExpansion) {
      if (paper.doi || paper.arxiv_id) {
        try {
          const expansion = await this.expandPaperCitations({
            identifier: paper.doi || paper.arxiv_id,
            direction: 'both',
            limit: Math.ceil(maxCitationExpansions / topPapersForExpansion.length)
          });
          if (expansion.papers && expansion.papers.length > 0) {
            citationClusters.push({
              root: paper.doi || paper.arxiv_id,
              root_title: paper.title,
              papers: expansion.papers.slice(0, 5),
              edge_count: expansion.edges.length
            });
          }
        } catch (err) {
          failures.push({ identifier: paper.doi || paper.arxiv_id, code: 'CITATION_EXPAND_FAILED', message: err.message });
        }
      }
    }

    const openAccessLinks = keyPapers.filter(p => p.is_open_access || p.pdf_url).map(p => ({
      title: p.title,
      doi: p.doi,
      pdf_url: p.pdf_url,
      landing_page_url: p.landing_page_url,
      oa_status: p.open_access_status
    }));

    const methodFamilies = this._extractMethodFamilies(keyPapers, question);
    const recencyDist = {};
    for (const p of keyPapers) {
      const y = p.year || 'unknown';
      recencyDist[y] = (recencyDist[y] || 0) + 1;
    }
    const sourceDist = {};
    for (const p of keyPapers) {
      for (const r of (p.source_records || [])) {
        sourceDist[r.source] = (sourceDist[r.source] || 0) + 1;
      }
    }

    const research_id = 'pr_' + crypto.createHash('sha1').update(question + Date.now()).digest('hex').slice(0, 12);
    const payload = {
      research_id,
      queries_executed: queries,
      key_papers: keyPapers,
      related_papers: relatedPapers,
      citation_clusters: citationClusters,
      open_access_links: openAccessLinks,
      evidence_summary: {
        method_families: methodFamilies,
        recency_distribution: recencyDist,
        source_distribution: sourceDist,
        limitations_candidates: [],
        contradiction_candidates: []
      },
      failures,
      created_at: new Date().toISOString()
    };

    const artifact_ref = this.artifactStore
      ? this.artifactStore.writeText('papers', JSON.stringify(payload, null, 2), { question, domain, kind: 'research_papers' })
      : null;

    return { ...payload, artifact_ref };
  }

  _generateResearchQueries(question) {
    const clean = question.replace(/[?]/g, '').trim();
    const queries = [clean];

    const methodIndicators = ['method', 'approach', 'technique', 'algorithm', 'framework', 'model', 'system', 'tool', 'architecture'];
    const hasMethod = methodIndicators.some(m => clean.toLowerCase().includes(m));

    if (!hasMethod) {
      queries.push(`${clean} method`);
      queries.push(`${clean} approach`);
    }

    const comparisonTerms = ['comparison', 'vs', 'versus', 'survey', 'review', 'benchmark', 'evaluation'];
    const hasComparison = comparisonTerms.some(t => clean.toLowerCase().includes(t));
    if (!hasComparison) {
      queries.push(`${clean} survey`);
      queries.push(`${clean} benchmark`);
    }

    const applicationIndicators = ['application', 'case study', 'practical', 'real-world', 'deployment', 'production', 'implementation'];
    const hasApplication = applicationIndicators.some(a => clean.toLowerCase().includes(a));
    if (!hasApplication) {
      queries.push(`${clean} application`);
    }

    const challengeIndicators = ['challenge', 'limitation', 'problem', 'issue', 'difficulty', 'drawback', 'open problem'];
    const hasChallenge = challengeIndicators.some(c => clean.toLowerCase().includes(c));
    if (!hasChallenge) {
      queries.push(`${clean} limitation`);
      queries.push(`${clean} open problem`);
    }

    return queries.filter((q, i, arr) => arr.indexOf(q) === i).slice(0, 8);
  }

  _extractMethodFamilies(papers, query) {
    const methodTerms = ['transformer', 'attention', 'cnn', 'rnn', 'lstm', 'bert', 'gpt',
      'diffusion', 'gan', 'vae', 'reinforcement', 'graph neural',
      'quantization', 'distillation', 'pruning', 'compression', 'sparsity',
      'fine-tuning', 'prompt', 'retrieval augmented', 'contrastive',
      'multi-modal', 'mixture of experts', 'kv cache', 'speculative decoding',
      'prefix caching', 'sliding window', 'paged attention', 'flash attention'];
    const families = [];
    const seen = new Set();
    for (const term of methodTerms) {
      for (const p of papers) {
        const text = ((p.title || '') + ' ' + (p.abstract || '')).toLowerCase();
        if (text.includes(term) && !seen.has(term)) {
          seen.add(term);
          const count = papers.filter(pp => ((pp.title || '') + ' ' + (pp.abstract || '')).toLowerCase().includes(term)).length;
          families.push({ method: term, paper_count: count, example_titles: papers.filter(pp => ((pp.title || '') + ' ' + (pp.abstract || '')).toLowerCase().includes(term)).slice(0, 3).map(pp => pp.title) });
          break;
        }
      }
    }
    return families;
  }
}
