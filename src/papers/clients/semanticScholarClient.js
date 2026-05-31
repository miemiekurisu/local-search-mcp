import { fetch } from 'undici';
import { normalizeSemanticScholarPaper } from '../paperNormalizer.js';

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';
const DEFAULT_FIELDS = 'title,authors,year,venue,externalIds,abstract,citationCount,referenceCount,fieldsOfStudy,isOpenAccess,openAccessPdf';

function getApiKey() {
  return process.env.SEMANTIC_SCHOLAR_API_KEY || '';
}

function buildHeaders() {
  const headers = {
    'accept': 'application/json',
    'user-agent': 'local-search-mcp/0.1'
  };
  const key = getApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

async function apiGet(url) {
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    throw new Error(`Semantic Scholar API error: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

export async function searchPapers({ query, limit = 20, yearFrom, yearTo, fields } = {}) {
  if (!query) {
    return { papers: [], meta: { total: 0 } };
  }

  const params = new URLSearchParams();
  params.set('query', query);
  params.set('limit', String(Math.min(limit, 100)));
  params.set('fields', fields || DEFAULT_FIELDS);

  if (yearFrom || yearTo) {
    const yearFilter = [];
    if (yearFrom) yearFilter.push(`year:>=${yearFrom}`);
    if (yearTo) yearFilter.push(`year:<=${yearTo}`);
    params.set('year', yearFilter.join('-'));
  }

  const url = `${BASE_URL}/paper/search?${params.toString()}`;
  const body = await apiGet(url);

  const papers = (body.data || []).map(normalizeSemanticScholarPaper);

  return {
    papers,
    meta: {
      total: body.total || papers.length,
      offset: body.offset || 0,
      next: body.next || null
    }
  };
}

export async function lookupPaper({ id, idType } = {}) {
  if (!id) return null;

  const params = new URLSearchParams();
  params.set('fields', DEFAULT_FIELDS);

  let pathId = id;
  if (idType === 'doi' || (id.startsWith('10.') && !idType)) {
    pathId = `DOI:${id}`;
  } else if (idType === 'arxiv' || idType === 'ArXiv') {
    pathId = `ArXiv:${id}`;
  } else if (idType === 'corpus' || idType === 'CorpusId') {
    const corpus = id.replace(/^CorpusId:/i, '');
    pathId = `CorpusId:${corpus}`;
  }

  const url = `${BASE_URL}/paper/${encodeURIComponent(pathId)}?${params.toString()}`;

  try {
    const body = await apiGet(url);
    if (!body || body.error) return null;
    return normalizeSemanticScholarPaper(body);
  } catch {
    return null;
  }
}

async function fetchPaperRelationship(paperId, endpoint, limit = 50) {
  if (!paperId) return { papers: [], meta: { total: 0 } };

  const params = new URLSearchParams();
  params.set('limit', String(Math.min(limit, 500)));
  params.set('fields', DEFAULT_FIELDS);

  const url = `${BASE_URL}/paper/${encodeURIComponent(paperId)}/${endpoint}?${params.toString()}`;

  try {
    const body = await apiGet(url);
    const papers = (body.data || [])
      .filter(item => item.paper)
      .map(item => normalizeSemanticScholarPaper(item.paper));

    return {
      papers,
      meta: {
        total: body.total || papers.length,
        offset: body.offset || 0,
        next: body.next || null
      }
    };
  } catch {
    return { papers: [], meta: { total: 0 } };
  }
}

export async function getCitations({ paperId, limit = 50 } = {}) {
  return fetchPaperRelationship(paperId, 'citations', limit);
}

export async function getReferences({ paperId, limit = 50 } = {}) {
  return fetchPaperRelationship(paperId, 'references', limit);
}

export async function getRelatedPapers({ paperId, limit = 20 } = {}) {
  return fetchPaperRelationship(paperId, 'related', limit);
}
