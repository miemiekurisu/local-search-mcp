import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

export async function searchWikipedia(query, opts = {}) {
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  const proxy = opts.proxyRouter?.resolve(opts.proxyProfile || 'auto', WIKIPEDIA_API)?.proxyUrl;
  try {
    const url = `${WIKIPEDIA_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
    const resp = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs || CONFIG.defaultTimeoutMs, proxyUrl: proxy });
    if (!resp.ok) throw new SearchEngineError('ENGINE_HTTP_ERROR', `Wikipedia HTTP ${resp.status}`, { status: resp.status });
    const data = await resp.json();
    const results = (data.query?.search || []).map((r, i) => makeResult({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      snippet: normalizeWhitespace(r.snippet?.replace(/<[^>]+>/g, '') || ''),
      engine: 'wikipedia',
      rank: i + 1
    }));
    return uniqueByUrl(results, limit);
  } catch (err) {
    if (!opts.browserPool) throw new SearchEngineError('SEARCH_FAILED', err.message);
    return [];
  }
}