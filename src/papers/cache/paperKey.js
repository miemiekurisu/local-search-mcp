import crypto from 'crypto';

const ARXIV_PATTERN = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const DOI_PATTERN = /^10\.\d{4,}\/.*$/;

export function paperKeyFromIdentifier(identifier, identifierType) {
  if (identifierType === 'doi') return normalizeDoi(identifier);
  if (identifierType === 'arxiv') return normalizeArxivId(identifier);
  if (identifierType === 'openalex') return identifier.replace(/^https?:\/\/openalex\.org\//, '');
  if (identifierType === 'semantic_scholar') return identifier.replace(/^https?:\/\/api\.semanticscholar\.org\//, '');
  return identifier;
}

export function derivePaperKey({ doi, arxiv_id, semantic_scholar_id, openalex_id, title, year } = {}) {
  if (doi) return normalizeDoi(doi);
  if (arxiv_id) return normalizeArxivId(arxiv_id);
  if (semantic_scholar_id) return `ss:${semantic_scholar_id}`;
  if (openalex_id) return `oa:${openalex_id}`;
  if (title && year) {
    const hash = crypto.createHash('sha1').update(`${title.toLowerCase().trim()}|${year}`).digest('hex').slice(0, 12);
    return `titlehash:${hash}`;
  }
  throw new Error('Cannot derive paper key: no identifier or title+year provided');
}

function normalizeDoi(v) {
  const s = String(v).trim().toLowerCase();
  for (const prefix of ['https://doi.org/', 'http://doi.org/', 'doi:']) {
    if (s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return s;
}

function normalizeArxivId(v) {
  const s = String(v).trim();
  const m = s.match(ARXIV_PATTERN);
  if (m) return m[1];
  for (const prefix of ['https://arxiv.org/abs/', 'http://arxiv.org/abs/', 'arxiv:']) {
    if (s.startsWith(prefix)) return s.slice(prefix.length).replace(/v\d+$/, '');
  }
  return s;
}
