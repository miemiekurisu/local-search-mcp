import { fetch } from 'undici';
import { normalizeOpenAlexWork } from '../paperNormalizer.js';

const BASE_URL = 'https://api.openalex.org';

function getMailto() {
  return process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || '';
}

function getApiKey() {
  return process.env.OPENALEX_API_KEY || '';
}

function buildSearchUrl({ query, yearFrom, yearTo, limit, sort }) {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  params.set('per_page', String(Math.min(limit || 20, 200)));

  const filters = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
  if (filters.length > 0) params.set('filter', filters.join(','));

  if (sort) {
    const sortMap = {
      relevance: 'relevance_score:desc',
      cited_by: 'cited_by_count:desc',
      publication_date: 'publication_date:desc'
    };
    params.set('sort', sortMap[sort] || sort);
  }

  const mailto = getMailto();
  if (mailto) params.set('mailto', mailto);

  const key = getApiKey();
  if (key) params.set('api_key', key);

  return `${BASE_URL}/works?${params.toString()}`;
}

function buildLookupUrl(identifier, identifierType) {
  const mailto = getMailto();
  const key = getApiKey();
  const query = new URLSearchParams();
  if (mailto) query.set('mailto', mailto);
  if (key) query.set('api_key', key);
  const qs = query.toString() ? `?${query.toString()}` : '';

  if (identifierType === 'doi' || identifier.startsWith('10.')) {
    const doi = identifier.startsWith('10.') ? identifier : identifier.replace(/^doi:/i, '');
    return `${BASE_URL}/works/doi:${doi}${qs}`;
  }
  if (identifierType === 'openalex_id' || /^W\d+$/i.test(identifier)) {
    const id = identifier.startsWith('W') ? identifier : `W${identifier}`;
    return `${BASE_URL}/works/${id}${qs}`;
  }
  if (identifierType === 'openalex_url' || identifier.includes('/W')) {
    return `${BASE_URL}/works/${identifier.split('/works/')[1]}${qs}`;
  }
  const doi = identifier.replace(/^doi:/i, '');
  return `${BASE_URL}/works/doi:${doi}${qs}`;
}

async function apiGet(url) {
  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'local-search-mcp/0.1'
    }
  });
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

export async function searchWorks({ query, yearFrom, yearTo, limit = 20, sort } = {}) {
  const url = buildSearchUrl({ query, yearFrom, yearTo, limit, sort });
  const body = await apiGet(url);

  const papers = (body.results || []).map(normalizeOpenAlexWork);

  return {
    papers,
    meta: {
      total: body.meta?.count || body.meta?.total || papers.length,
      page: body.meta?.page || 1,
      per_page: body.meta?.per_page || limit
    }
  };
}

export async function lookupWork({ identifier, identifierType } = {}) {
  if (!identifier) return null;
  const url = buildLookupUrl(identifier, identifierType || 'auto');

  try {
    const body = await apiGet(url);
    if (!body || body.error) return null;
    return normalizeOpenAlexWork(body);
  } catch {
    return null;
  }
}
