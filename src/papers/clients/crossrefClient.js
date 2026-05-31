import { fetch } from 'undici';
import { normalizeCrossrefWork } from '../paperNormalizer.js';
import { normalizeDoi } from '../paperSchemas.js';

const BASE_URL = 'https://api.crossref.org/works';

function getMailto() {
  return process.env.CROSSREF_MAILTO || '';
}

function buildHeaders() {
  const mailto = getMailto();
  const userAgent = mailto
    ? `local-search-mcp/0.1 (mailto:${mailto})`
    : 'local-search-mcp/0.1';
  return {
    'accept': 'application/json',
    'user-agent': userAgent
  };
}

async function apiGet(url) {
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

export async function searchWorks({ query, limit = 20, yearFrom, yearTo, sort } = {}) {
  if (!query) {
    return { papers: [], meta: { total: 0 } };
  }

  const params = new URLSearchParams();
  params.set('query', query);
  params.set('rows', String(Math.min(limit, 100)));

  if (yearFrom) params.set('filter', `from-pub-date:${yearFrom}-01-01`);
  if (yearTo) {
    const existingFilter = params.get('filter') || '';
    const additional = `until-pub-date:${yearTo}-12-31`;
    params.set('filter', existingFilter ? `${existingFilter},${additional}` : additional);
  }

  if (sort) {
    const sortMap = {
      relevance: 'relevance',
      published: 'published',
      cited: 'is-referenced-by-count'
    };
    params.set('sort', sortMap[sort] || sort);
  }

  const mailto = getMailto();
  if (mailto) params.set('mailto', mailto);

  const url = `${BASE_URL}?${params.toString()}`;
  const body = await apiGet(url);

  const items = body.message?.items || [];

  const papers = items.map(normalizeCrossrefWork);

  return {
    papers,
    meta: {
      total: body.message?.['total-results'] || papers.length,
      items_per_page: body.message?.['items-per-page'] || limit
    }
  };
}

export async function lookupByDoi({ doi } = {}) {
  if (!doi) return null;

  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  const mailto = getMailto();
  const params = new URLSearchParams();
  if (mailto) params.set('mailto', mailto);
  const qs = params.toString() ? `?${params.toString()}` : '';

  const url = `${BASE_URL}/${encodeURIComponent(normalized)}${qs}`;

  try {
    const body = await apiGet(url);
    if (!body?.message) return null;
    return normalizeCrossrefWork(body.message);
  } catch {
    return null;
  }
}
