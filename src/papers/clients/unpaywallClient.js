import { fetch } from 'undici';
import { normalizeUnpaywallResponse, normalizeDoi } from '../paperNormalizer.js';

const BASE_URL = 'https://api.unpaywall.org/v2';

function getEmail() {
  return process.env.UNPAYWALL_EMAIL || '';
}

export async function lookupByDoi({ doi, email } = {}) {
  if (!doi) return null;

  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  const userEmail = email || getEmail();
  if (!userEmail) {
    throw new Error('Unpaywall requires an email parameter. Set UNPAYWALL_EMAIL environment variable or pass email option.');
  }

  const params = new URLSearchParams();
  params.set('email', userEmail);

  const url = `${BASE_URL}/${encodeURIComponent(normalized)}?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': `local-search-mcp/0.1 (mailto:${userEmail})`
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      return {
        isOpenAccess: false,
        oaStatus: 'closed',
        bestPdfUrl: null,
        bestLandingPageUrl: null,
        license: null,
        doi: normalized
      };
    }
    throw new Error(`Unpaywall API error: ${response.status} ${response.statusText} for ${url}`);
  }

  const data = await response.json();
  const record = normalizeUnpaywallResponse(data);

  return {
    doi: record.doi,
    isOpenAccess: record.is_open_access,
    oaStatus: record.open_access_status,
    bestPdfUrl: record.pdf_url || null,
    bestLandingPageUrl: record.landing_page_url || null,
    license: record.license || null,
    genre: record.publication_type,
    publishedDate: record.published_date,
    publisher: record.venue,
    source_records: record.source_records
  };
}
