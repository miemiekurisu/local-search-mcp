import { normalizeDoi, normalizeArxivId } from './paperSchemas.js';

export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\cite\{[^}]*\}/g, '')
    .replace(/\\text\{[^}]*\}/g, '')
    .replace(/\\label\{[^}]*\}/g, '')
    .trim();
}

function extractYear(paper) {
  if (paper.year) return paper.year;
  if (paper.published_date) {
    const d = new Date(paper.published_date);
    if (!isNaN(d.getTime())) return d.getFullYear();
  }
  return null;
}

export function mergePaperRecords(existing, incoming) {
  const merged = { ...existing };
  const sourceKeys = ['doi', 'arxiv_id', 'openalex_id', 'semantic_scholar_id', 'pubmed_id',
    'title', 'year', 'published_date', 'venue', 'publication_type', 'abstract',
    'citation_count', 'reference_count', 'is_open_access', 'open_access_status',
    'landing_page_url', 'pdf_url', 'license'];

  for (const key of sourceKeys) {
    if (incoming[key] != null && incoming[key] !== '' && incoming[key] !== 'unknown') {
      if (merged[key] == null || merged[key] === '' || merged[key] === 'unknown') {
        merged[key] = incoming[key];
      }
    }
  }

  if (incoming.authors && incoming.authors.length > 0) {
    const existingNames = new Set((merged.authors || []).map(a => a.name));
    for (const author of incoming.authors) {
      if (!existingNames.has(author.name)) {
        merged.authors = merged.authors || [];
        merged.authors.push(author);
        existingNames.add(author.name);
      }
    }
  }

  if (incoming.fields_of_study && incoming.fields_of_study.length > 0) {
    const existingFields = new Set(merged.fields_of_study || []);
    for (const f of incoming.fields_of_study) {
      if (!existingFields.has(f)) {
        merged.fields_of_study = merged.fields_of_study || [];
        merged.fields_of_study.push(f);
        existingFields.add(f);
      }
    }
  }

  if (incoming.topics && incoming.topics.length > 0) {
    const existingTopics = new Set(merged.topics || []);
    for (const t of incoming.topics) {
      if (!existingTopics.has(t)) {
        merged.topics = merged.topics || [];
        merged.topics.push(t);
        existingTopics.add(t);
      }
    }
  }

  merged.source_records = [...(merged.source_records || [])];
  if (incoming.source_records) {
    const existingRecords = new Set(merged.source_records.map(r => `${r.source}:${r.id}`));
    for (const rec of incoming.source_records) {
      const key = `${rec.source}:${rec.id}`;
      if (!existingRecords.has(key)) {
        merged.source_records.push(rec);
        existingRecords.add(key);
      }
    }
  }

  return merged;
}

function getDeduplicationKey(paper) {
  const doi = normalizeDoi(paper.doi);
  if (doi) return `doi:${doi}`;

  const arxivId = normalizeArxivId(paper.arxiv_id);
  if (arxivId) return `arxiv:${arxivId}`;

  if (paper.openalex_id) return `openalex:${paper.openalex_id}`;
  if (paper.semantic_scholar_id) return `s2:${paper.semantic_scholar_id}`;

  const normalized = normalizeTitle(paper.title);
  const year = extractYear(paper);
  if (normalized && year) return `title_year:${normalized}|${year}`;

  if (normalized) return `title:${normalized}`;

  return null;
}

export function deduplicatePapers(papers) {
  const groups = new Map();

  for (const paper of papers) {
    const key = getDeduplicationKey(paper);
    if (!key) {
      const fallbackKey = `no_key_${groups.size}`;
      groups.set(fallbackKey, { ...paper, source_records: [...(paper.source_records || [])] });
      continue;
    }

    if (groups.has(key)) {
      groups.set(key, mergePaperRecords(groups.get(key), paper));
    } else {
      groups.set(key, { ...paper, source_records: [...(paper.source_records || [])] });
    }
  }

  return Array.from(groups.values());
}
