import { createPaperRecord, normalizeDoi, normalizeArxivId } from './paperSchemas.js';

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const words = [];
  for (const [term, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = term;
    }
  }
  return words.filter(w => w !== undefined).join(' ');
}

export function normalizeOpenAlexWork(work) {
  if (!work) return createPaperRecord();
  const record = createPaperRecord();

  record.title = work.title || '';

  if (work.authorships) {
    record.authors = work.authorships.map(a => ({
      name: a.author?.display_name || '',
      id: a.author?.id || '',
      source: 'openalex'
    }));
  }

  record.year = work.publication_year || null;

  if (work.primary_location) {
    const loc = work.primary_location;
    record.venue = loc.source?.display_name || '';
    record.landing_page_url = loc.landing_page_url || '';
    record.license = loc.license || '';
    if (loc.is_oa !== undefined) record.is_open_access = loc.is_oa;
    record.publication_type = mapOpenAlexType(loc.source?.type);
  }

  record.doi = normalizeDoi(work.doi);

  if (work.id) {
    const m = work.id.match(/\/W(\d+)$/i);
    if (m) record.openalex_id = 'W' + m[1];
  }

  record.abstract = reconstructAbstract(work.abstract_inverted_index);
  record.citation_count = work.cited_by_count || null;
  record.reference_count = work.referenced_works?.length || null;

  if (work.topics) {
    record.topics = work.topics.map(t => t.display_name || t.name || '').filter(Boolean);
  }

  if (work.open_access) {
    record.is_open_access = work.open_access.is_oa || null;
    record.open_access_status = work.open_access.oa_status || 'unknown';
    if (work.open_access.oa_url) record.pdf_url = work.open_access.oa_url;
  }

  record.source_records.push({
    source: 'openalex',
    id: work.id || '',
    url: work.id || ''
  });

  return record;
}

function mapOpenAlexType(type) {
  if (!type) return 'unknown';
  const map = {
    'journal-article': 'journal-article',
    'proceedings-article': 'proceedings-article',
    'book-chapter': 'journal-article',
    'book': 'journal-article',
    'dataset': 'dataset',
    'preprint': 'preprint',
    'software': 'software'
  };
  return map[type] || 'unknown';
}

export function normalizeSemanticScholarPaper(paper) {
  if (!paper) return createPaperRecord();
  const record = createPaperRecord();

  record.title = paper.title || '';
  record.year = paper.year || null;
  record.venue = paper.venue || '';
  record.abstract = paper.abstract || '';

  if (paper.authors) {
    record.authors = paper.authors.map(a => ({
      name: a.name || '',
      id: a.authorId || '',
      source: 'semantic_scholar'
    }));
  }

  if (paper.externalIds) {
    const ids = paper.externalIds;
    record.doi = normalizeDoi(ids.DOI);
    const arxiv = ids.ArXiv;
    if (arxiv) {
      const normalized = normalizeArxivId(arxiv);
      record.arxiv_id = normalized;
      record.arxiv_id_with_version = normalizeArxivId(arxiv, true);
    }
    if (ids.PubMed) record.pubmed_id = ids.PubMed;
    if (ids.CorpusId) record.semantic_scholar_id = 'CorpusId:' + ids.CorpusId;
  }

  if (paper.paperId) {
    if (!record.semantic_scholar_id) {
      record.semantic_scholar_id = paper.paperId;
    }
  }

  record.citation_count = paper.citationCount || null;
  record.reference_count = paper.referenceCount || null;

  if (paper.fieldsOfStudy) {
    record.fields_of_study = paper.fieldsOfStudy.filter(Boolean);
  }

  if (paper.isOpenAccess !== undefined) {
    record.is_open_access = paper.isOpenAccess;
  }

  if (paper.openAccessPdf) {
    record.pdf_url = paper.openAccessPdf.url || '';
    if (paper.openAccessPdf.status) {
      record.open_access_status = paper.openAccessPdf.status;
    }
  }

  record.source_records.push({
    source: 'semantic_scholar',
    id: paper.paperId || '',
    url: paper.paperId ? `https://api.semanticscholar.org/${paper.paperId}` : ''
  });

  return record;
}

export function normalizeArxivEntry(entry) {
  if (!entry) return createPaperRecord();
  const record = createPaperRecord();

  record.title = (entry.title || '').replace(/\s+/g, ' ').trim();
  record.abstract = (entry.summary || '').replace(/\s+/g, ' ').trim();

  if (entry.id) {
    const arxivId = normalizeArxivId(entry.id);
    record.arxiv_id = arxivId;
    record.arxiv_id_with_version = normalizeArxivId(entry.id, true);
  }

  if (entry.published) {
    const d = new Date(entry.published);
    if (!isNaN(d.getTime())) {
      record.published_date = d.toISOString().split('T')[0];
      record.year = d.getFullYear();
    }
  }

  if (entry.author) {
    const authors = Array.isArray(entry.author) ? entry.author : [entry.author];
    record.authors = authors.map(a => ({
      name: typeof a === 'string' ? a : (a.name || ''),
      id: '',
      source: 'arxiv'
    }));
  }

  if (entry.link) {
    const links = Array.isArray(entry.link) ? entry.link : [entry.link];
    for (const link of links) {
      const href = link.href || link.$?.href || '';
      const rel = link.rel || link.$?.rel || '';
      if (rel === 'alternate' && !record.landing_page_url) {
        record.landing_page_url = href;
      }
      if ((rel === 'related' || rel === 'pdf') && href.includes('/pdf/')) {
        record.pdf_url = href;
      }
    }
    if (!record.landing_page_url && links.length > 0) {
      record.landing_page_url = links[0].href || links[0].$?.href || '';
    }
  }

  record.publication_type = 'preprint';

  record.source_records.push({
    source: 'arxiv',
    id: entry.id || '',
    url: entry.id || ''
  });

  return record;
}

export function normalizeCrossrefWork(work) {
  if (!work) return createPaperRecord();
  const record = createPaperRecord();

  record.title = (work.title || [])[0] || '';

  if (work.author) {
    record.authors = work.author.map(a => {
      const name = [a.given, a.family].filter(Boolean).join(' ');
      return { name: name || a.name || '', id: a.ORCID || '', source: 'crossref' };
    });
  }

  if (work['published-print']) {
    const parts = work['published-print']['date-parts'] || [];
    if (parts[0]) {
      record.year = parts[0][0] || null;
      const month = parts[0][1] || null;
      const day = parts[0][2] || null;
      if (record.year && month && day) {
        record.published_date = `${record.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  } else if (work['published-online']) {
    const parts = work['published-online']['date-parts'] || [];
    if (parts[0]) {
      record.year = parts[0][0] || null;
    }
  } else if (work['issued']) {
    const parts = work['issued']['date-parts'] || [];
    if (parts[0]) {
      record.year = parts[0][0] || null;
    }
  }

  if (work['container-title']) {
    record.venue = work['container-title'].filter(Boolean).join(', ');
  }

  record.doi = normalizeDoi(work.DOI);

  record.publication_type = mapCrossrefType(work.type);

  if (work.abstract) {
    record.abstract = work.abstract.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  record.citation_count = work['is-referenced-by-count'] || null;
  record.reference_count = work['references-count'] || null;

  record.source_records.push({
    source: 'crossref',
    id: work.DOI || '',
    url: work.DOI ? `https://doi.org/${work.DOI}` : ''
  });

  return record;
}

function mapCrossrefType(type) {
  if (!type) return 'unknown';
  const map = {
    'journal-article': 'journal-article',
    'proceedings-article': 'proceedings-article',
    'book': 'journal-article',
    'book-chapter': 'journal-article',
    'dataset': 'dataset',
    'reference-entry': 'journal-article',
    'posted-content': 'preprint',
    'dissertation': 'journal-article',
    'report': 'journal-article'
  };
  return map[type] || 'unknown';
}

export function normalizeUnpaywallResponse(response) {
  if (!response) return createPaperRecord();
  const record = createPaperRecord();

  record.doi = normalizeDoi(response.doi);

  if (response.is_oa !== undefined) record.is_open_access = response.is_oa;
  record.open_access_status = response.oa_status || 'unknown';

  if (response.best_oa_location) {
    const loc = response.best_oa_location;
    record.pdf_url = loc.url_for_pdf || '';
    record.landing_page_url = loc.url_for_landing_page || '';
    record.license = loc.license || '';
  }

  if (response.genre) {
    record.publication_type = mapUnpaywallGenre(response.genre);
  }

  if (response.published_date) {
    record.published_date = response.published_date;
    const d = new Date(response.published_date);
    if (!isNaN(d.getTime())) record.year = d.getFullYear();
  }

  if (response.publisher) {
    record.venue = response.publisher;
  }

  record.source_records.push({
    source: 'unpaywall',
    id: response.doi || '',
    url: response.doi ? `https://api.unpaywall.org/v2/${response.doi}` : ''
  });

  return record;
}

function mapUnpaywallGenre(genre) {
  if (!genre) return 'unknown';
  const map = {
    'journal-article': 'journal-article',
    'proceedings-article': 'proceedings-article',
    'book-chapter': 'journal-article',
    'book': 'journal-article',
    'dataset': 'dataset',
    'preprint': 'preprint',
    'posted-content': 'preprint'
  };
  return map[genre] || 'unknown';
}
