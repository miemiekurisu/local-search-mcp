import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl, isLikelyBlockedText } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

export async function searchCustomHtml(engineConfig, query, opts = {}) {
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  const url = String(engineConfig.url_template || '').replace('{{query}}', encodeURIComponent(query));
  const proxy = opts.proxyRouter?.resolve(opts.proxyProfile || 'auto', url)?.proxyUrl;
  const resp = await fetchWithTimeout(url, {
    timeoutMs: opts.timeoutMs || CONFIG.defaultTimeoutMs,
    proxyUrl: proxy,
    headers: engineConfig.headers || {},
    method: engineConfig.method || 'GET'
  });
  const html = await resp.text();
  if (!resp.ok) throw new SearchEngineError('ENGINE_HTTP_ERROR', `${engineConfig.id} HTTP ${resp.status}`, { status: resp.status });
  if (isLikelyBlockedText(html)) throw new SearchEngineError('ENGINE_BLOCKED', `${engineConfig.id} appears blocked/captcha`);
  const $ = cheerio.load(html);
  const sel = engineConfig.selectors || {};
  const results = [];
  $(sel.result).each((i, el) => {
    const titleEl = sel.title ? $(el).find(sel.title).first() : $(el);
    const linkEl = sel.url ? $(el).find(sel.url).first() : titleEl;
    const snippetEl = sel.snippet ? $(el).find(sel.snippet).first() : null;
    const title = normalizeWhitespace(titleEl.text());
    let href = linkEl.attr('href') || linkEl.attr('data-href');
    try { href = new URL(stripTrackingUrl(href), url).toString(); } catch {}
    href = canonicalUrl(href);
    const snippet = normalizeWhitespace(snippetEl ? snippetEl.text() : '');
    if (title && /^https?:\/\//.test(href || '')) {
      results.push(makeResult({ title, url: href, snippet, engine: engineConfig.id, rank: results.length + 1 }));
    }
  });
  if (results.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', `${engineConfig.id} returned no parseable results`);
  return uniqueByUrl(results, limit).slice(0, limit);
}
