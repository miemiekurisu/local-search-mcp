import { fetch } from 'undici';
import { normalizeArxivEntry } from '../paperNormalizer.js';

const API_BASE = 'http://export.arxiv.org/api/query';
const HTML_BASE = 'https://arxiv.org';
const MIN_INTERVAL_MS = 3200;
const FETCH_TIMEOUT_MS = 15000;

let lastRequestTime = 0;

async function rateLimitedFetch(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'accept': 'application/atom+xml',
        'user-agent': 'local-search-mcp/0.1 (mailto:research@example.com)'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 3000));
        lastRequestTime = Date.now();
        const retryResp = await fetch(url, {
          headers: {
            'accept': 'application/atom+xml',
            'user-agent': 'local-search-mcp/0.1 (mailto:research@example.com)'
          },
          signal: controller.signal
        });
        if (!retryResp.ok) {
          throw new Error(`arXiv API error: ${retryResp.status} ${retryResp.statusText}`);
        }
        return retryResp.text();
      }
      throw new Error(`arXiv API error: ${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArxivHtml(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${HTML_BASE}${path}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; local-search-mcp/0.1)' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function searchEntryFromHtml($) {
  const entry = {};

  const titleMatch = $.match(/<meta\s+name="citation_title"[^>]+content="([^"]+)"/);
  if (titleMatch) entry.title = titleMatch[1];

  const dateMatch = $.match(/<meta\s+name="citation_date"[^>]+content="([^"]+)"/);
  if (dateMatch) entry.published = dateMatch[1];

  const arxivIdMatch = $.match(/<meta\s+name="citation_arxiv_id"[^>]+content="([^"]+)"/);
  if (arxivIdMatch) entry.id = `https://arxiv.org/abs/${arxivIdMatch[1]}`;

  const authors = [];
  const authorRe = /<meta\s+name="citation_author"[^>]+content="([^"]+)"/g;
  let m;
  while ((m = authorRe.exec($)) !== null) {
    authors.push({ name: m[1] });
  }
  if (authors.length > 0) entry.author = authors;

  const abstractMatch = $.match(/<meta\s+name="citation_abstract"[^>]+content="([^"]+)"/);
  if (abstractMatch) entry.summary = abstractMatch[1];

  return Object.keys(entry).length > 0 ? entry : null;
}

function parseAtomXml(xmlText) {
  const entries = [];
  const entryRegex = /<entry[\s>][\s\S]*?<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entryXml = match[0];
    entries.push(parseSingleEntry(entryXml));
  }

  return entries;
}

function parseSingleEntry(xml) {
  const entry = {};

  const idMatch = xml.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
  if (idMatch) entry.id = idMatch[1].trim();

  const titleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) entry.title = titleMatch[1].replace(/\s+/g, ' ').trim();

  const summaryMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) entry.summary = summaryMatch[1].replace(/\s+/g, ' ').trim();

  const publishedMatch = xml.match(/<published[^>]*>([\s\S]*?)<\/published>/i);
  if (publishedMatch) entry.published = publishedMatch[1].trim();

  const authors = [];
  const authorRegex = /<author[\s>][\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(xml)) !== null) {
    const name = authorMatch[1].trim();
    if (name) authors.push({ name });
  }
  if (authors.length > 0) entry.author = authors;

  const links = [];
  const linkRegex = /<link[^>]*\/?>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(xml)) !== null) {
    const hrefMatch = linkMatch[0].match(/href="([^"]*)"/i);
    const relMatch = linkMatch[0].match(/rel="([^"]*)"/i);
    const titleAttrMatch = linkMatch[0].match(/title="([^"]*)"/i);
    if (hrefMatch) {
      links.push({
        href: hrefMatch[1],
        rel: relMatch ? relMatch[1] : '',
        title: titleAttrMatch ? titleAttrMatch[1] : ''
      });
    }
  }
  if (links.length > 0) entry.link = links;

  return entry;
}

function getTotalResults(xmlText) {
  const match = xmlText.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
  return match ? parseInt(match[1], 10) : 0;
}

function buildSearchUrl({ query, start = 0, maxResults = 20, sortBy }) {
  const params = new URLSearchParams();
  params.set('search_query', query);
  params.set('start', String(start));
  params.set('max_results', String(Math.min(maxResults, 200)));

  if (sortBy) {
    const sortMap = {
      relevance: 'relevance',
      submitted_date: 'submittedDate',
      title: 'title'
    };
    params.set('sortBy', sortMap[sortBy] || sortBy);
    params.set('sortOrder', 'descending');
  }

  return `${API_BASE}?${params.toString()}`;
}

function parseHtmlSearchResults(html, maxResults) {
  const entries = [];
  const resultRe = /<li\s+class="arxiv-result"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = resultRe.exec(html)) !== null && entries.length < maxResults) {
    const block = m[1];
    const entry = {};

    const titleMatch = block.match(/<p\s+class="title is-5[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/p>/i);
    if (titleMatch) entry.title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    const idMatch = block.match(/<a[^>]*href="(?:https:\/\/arxiv\.org)?\/abs\/(\d{4}\.\d{4,5}(v\d+)?)"[^>]*>/i);
    if (idMatch) entry.id = `https://arxiv.org/abs/${idMatch[1]}`;

    const authors = [];
    const authorRe = /<a[^>]*href="\/search\/[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let a;
    while ((a = authorRe.exec(block)) !== null) {
      const name = a[1].trim();
      if (name && !name.startsWith('arXiv:')) authors.push({ name });
    }
    if (authors.length > 0) entry.author = authors;

    const abstractLink = block.match(/<a[^>]*class="[^"]*abstract[^"]*"[^>]*href="(\/abs\/[^"]+)"[^>]*>/i);
    if (abstractLink) {
      entry.link = [{ href: `https://arxiv.org${abstractLink[1]}`, rel: 'alternate' }];
    }

    entries.push(entry);
  }
  return entries;
}

function extractArxivId(value) {
  const m = String(value).match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return m ? m[1] : null;
}

export async function search({ query, start = 0, maxResults = 20, sortBy } = {}) {
  if (!query) {
    return { papers: [], meta: { total: 0 } };
  }

  // Try export API first
  let papers = [];
  let total = 0;
  const url = buildSearchUrl({ query, start, maxResults, sortBy });
  try {
    const xmlText = await rateLimitedFetch(url);
    const rawEntries = parseAtomXml(xmlText);
    total = getTotalResults(xmlText);
    papers = rawEntries.map(normalizeArxivEntry);
  } catch {
    // fall through to HTML fallback
  }

  if (papers.length > 0) {
    return { papers, meta: { total } };
  }

  // Fallback: search via arXiv.org HTML search page
  const isTitleSearch = query.startsWith('ti:');
  const searchPath = isTitleSearch
    ? `/search/?searchtype=title&query=${encodeURIComponent(query.replace(/^ti:/, ''))}`
    : `/search/?query=${encodeURIComponent(query.replace(/^(all:|abs:|au:)/, ''))}`;
  const html = await fetchArxivHtml(searchPath);
  if (html) {
    const htmlPapers = parseHtmlSearchResults(html, maxResults);
    if (htmlPapers.length > 0) {
      return { papers: htmlPapers.map(normalizeArxivEntry), meta: { total: htmlPapers.length } };
    }
  }

  return { papers: [], meta: { total: 0 } };
}

export async function lookup({ id } = {}) {
  if (!id) return null;

  // Try export API first
  try {
    const url = buildLookupUrl(id);
    const xmlText = await rateLimitedFetch(url, 10000);
    const rawEntries = parseAtomXml(xmlText);
    if (rawEntries.length > 0) {
      return normalizeArxivEntry(rawEntries[0]);
    }
  } catch {
    // fall through to HTML fallback
  }

  // Fallback: parse HTML abstract page directly
  const arxivId = extractArxivId(id);
  if (!arxivId) return null;
  const html = await fetchArxivHtml(`/abs/${arxivId}`);
  if (!html) return null;

  const entry = searchEntryFromHtml(html);
  if (!entry) return null;

  if (!entry.id) entry.id = `https://arxiv.org/abs/${arxivId}`;

  const paper = normalizeArxivEntry(entry);
  if (!paper.title) return null;

  return paper;
}

function buildLookupUrl(id) {
  const params = new URLSearchParams();
  params.set('id_list', id);
  params.set('max_results', '1');
  return `${API_BASE}?${params.toString()}`;
}
