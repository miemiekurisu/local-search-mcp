export function createPaperRecord(overrides = {}) {
  return {
    type: 'paper',
    title: '',
    authors: [],
    year: null,
    published_date: null,
    venue: '',
    publication_type: 'unknown',
    doi: null,
    arxiv_id: null,
    arxiv_id_with_version: null,
    openalex_id: null,
    semantic_scholar_id: null,
    pubmed_id: null,
    abstract: '',
    citation_count: null,
    reference_count: null,
    fields_of_study: [],
    topics: [],
    is_open_access: null,
    open_access_status: 'unknown',
    landing_page_url: '',
    pdf_url: '',
    license: '',
    source_records: [],
    scores: { relevance: 0, freshness: 0, authority: 0, availability: 0, final: 0 },
    ...overrides
  };
}

export function normalizeDoi(doi) {
  if (!doi) return null;
  let normalized = doi.trim().toLowerCase();
  if (normalized.startsWith('https://doi.org/')) {
    normalized = normalized.slice(16);
  } else if (normalized.startsWith('http://doi.org/')) {
    normalized = normalized.slice(15);
  } else if (normalized.startsWith('doi:')) {
    normalized = normalized.slice(4);
  }
  return normalized || null;
}

export function normalizeArxivId(id, keepVersion = false) {
  if (!id) return null;
  let normalized = id.trim().toLowerCase();
  if (normalized.startsWith('arxiv:')) {
    normalized = normalized.slice(6);
  }
  if (normalized.startsWith('https://arxiv.org/abs/')) {
    normalized = normalized.slice(22);
  } else if (normalized.startsWith('http://arxiv.org/abs/')) {
    normalized = normalized.slice(21);
  }
  const versionMatch = normalized.match(/^(.*?)(v\d+)$/);
  const withoutVersion = versionMatch ? versionMatch[1] : normalized;
  if (keepVersion) {
    return normalized || null;
  }
  return withoutVersion || null;
}
