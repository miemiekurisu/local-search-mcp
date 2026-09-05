import './helpers/mocks.mjs';

process.env.CROSSREF_MAILTO = 'cr@example.com';
process.env.OPENALEX_API_KEY = 'oa-key-1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, jsonResponse, sleep } from './helpers/mocks.mjs';

const st = undiciState();

const crossref = await import('../src/papers/clients/crossrefClient.js');
const openalex = await import('../src/papers/clients/openalexClient.js');
const s2 = await import('../src/papers/clients/semanticScholarClient.js');
const unpaywall = await import('../src/papers/clients/unpaywallClient.js');

function lastUrl() {
  return st.calls[st.calls.length - 1].url;
}
function lastInit() {
  return st.calls[st.calls.length - 1].init;
}

test.after(() => {
  delete process.env.CROSSREF_MAILTO;
  delete process.env.OPENALEX_API_KEY;
});

function urlParams(u) {
  return new URLSearchParams(new URL(u).search);
}

// ── crossref ──

test('crossref searchWorks: empty query short-circuits', async () => {
  st.responses = [];
  const out = await crossref.searchWorks({});
  assert.deepEqual(out, { papers: [], meta: { total: 0 } });
  assert.equal(st.calls.length, 0);
});

test('crossref searchWorks: builds url with filters, sort, mailto, rows clamp', async () => {
  st.responses = [jsonResponse({
    message: {
      items: [{ DOI: '10.1/x', title: ['P1'], 'is-referenced-by-count': 5 }],
      'total-results': 234,
      'items-per-page': 7
    }
  })];
  const out = await crossref.searchWorks({
    query: 'kernel methods', limit: 150, yearFrom: '2020', yearTo: '2022', sort: 'cited'
  });
  const u = lastUrl();
  assert.ok(u.startsWith('https://api.crossref.org/works?'));
  const p = urlParams(u);
  assert.equal(p.get('query'), 'kernel methods');
  assert.equal(p.get('rows'), '100', 'limit clamped to 100');
  assert.equal(p.get('filter'), 'from-pub-date:2020-01-01,until-pub-date:2022-12-31');
  assert.equal(p.get('sort'), 'is-referenced-by-count');
  assert.equal(p.get('mailto'), 'cr@example.com');
  assert.equal(lastInit().headers['user-agent'], 'local-search-mcp/0.1 (mailto:cr@example.com)');
  assert.equal(lastInit().headers.accept, 'application/json');
  assert.equal(out.papers.length, 1);
  assert.equal(out.papers[0].title, 'P1');
  assert.deepEqual(out.meta, { total: 234, items_per_page: 7 });
});

test('crossref searchWorks: api error surfaces message', async () => {
  st.responses = [jsonResponse({}, 503)];
  await assert.rejects(
    crossref.searchWorks({ query: 'x' }),
    /Crossref API error: 503 ST503/
  );
});

test('crossref searchWorks: sort passthrough of unknown value', async () => {
  st.responses = [jsonResponse({ message: {} })];
  await crossref.searchWorks({ query: 'x', sort: 'score' });
  assert.equal(urlParams(lastUrl()).get('sort'), 'score');
});

test('crossref lookupByDoi: null on missing doi, unknown doi falls through to fetch error -> null', async () => {
  st.responses = [];
  const before = st.calls.length;
  assert.equal(await crossref.lookupByDoi({ }), null);
  assert.equal(st.calls.length, before, 'missing doi does not fetch');

  st.responses = [jsonResponse({}, 500)];
  assert.equal(await crossref.lookupByDoi({ doi: 'not-a-doi' }), null);
  assert.ok(st.calls.length > before);
});

test('crossref lookupByDoi: happy path', async () => {
  st.responses = [jsonResponse({ message: { DOI: '10.22/x', title: ['Found'] } })];
  const out = await crossref.lookupByDoi({ doi: '10.22/x' });
  const u = lastUrl();
  assert.ok(u.startsWith('https://api.crossref.org/works/10.22%2Fx?'), u);
  assert.equal(urlParams(u).get('mailto'), 'cr@example.com');
  assert.equal(out.title, 'Found');
});

test('crossref lookupByDoi: null without message body', async () => {
  st.responses = [jsonResponse({ status: 'ok' })];
  assert.equal(await crossref.lookupByDoi({ doi: '10.3/y' }), null);
});

test('crossref lookupByDoi: null on api error', async () => {
  st.responses = [jsonResponse({}, 500)];
  assert.equal(await crossref.lookupByDoi({ doi: '10.3/y' }), null);
});

// ── openalex ──

test('openalex searchWorks: url building with mailto fallback, api key, filters, sort', async () => {
  delete process.env.OPENALEX_MAILTO;
  st.responses = [jsonResponse({
    results: [{ id: 'https://api.openalex.org/works/W1', title: 'A' }],
    meta: { count: 42, page: 2, per_page: 25 }
  })];
  const out = await openalex.searchWorks({
    query: 'attention', yearFrom: '2019', yearTo: '2021', limit: 500, sort: 'cited_by'
  });
  const u = lastUrl();
  assert.ok(u.startsWith('https://api.openalex.org/works?'));
  const p = urlParams(u);
  assert.equal(p.get('search'), 'attention');
  assert.equal(p.get('per_page'), '200');
  assert.equal(p.get('filter'), 'from_publication_date:2019-01-01,to_publication_date:2021-12-31');
  assert.equal(p.get('sort'), 'cited_by_count:desc');
  assert.equal(p.get('mailto'), 'cr@example.com', 'falls back to CROSSREF_MAILTO');
  assert.equal(p.get('api_key'), 'oa-key-1');
  assert.equal(lastInit().headers['user-agent'], 'local-search-mcp/0.1');
  assert.equal(out.meta.total, 42);
  assert.equal(out.meta.page, 2);
  assert.equal(out.meta.per_page, 25);
  delete process.env.OPENALEX_API_KEY;
});

test('openalex searchWorks: respects OPENALEX_MAILTO over CROSSREF and unknown sort passthrough + meta defaults', async () => {
  process.env.OPENALEX_MAILTO = 'oa@example.org';
  st.responses = [jsonResponse({ results: [] })];
  const out = await openalex.searchWorks({ query: 'q', sort: 'what' });
  const p = urlParams(lastUrl());
  assert.equal(p.get('mailto'), 'oa@example.org');
  assert.equal(p.get('sort'), 'what');
  assert.deepEqual(out.meta, { total: 0, page: 1, per_page: 20 });
  delete process.env.OPENALEX_MAILTO;
});

test('openalex searchWorks: api error surfaces', async () => {
  st.responses = [jsonResponse({}, 500)];
  await assert.rejects(openalex.searchWorks({ query: 'q' }), /OpenAlex API error: 500 ST500/);
});

test('openalex lookupWork: null on missing identifier', async () => {
  st.responses = [];
  const before = st.calls.length;
  assert.equal(await openalex.lookupWork({}), null);
  assert.equal(st.calls.length, before);
});

test('openalex lookupWork builds urls per identifier shape', async () => {
  const cases = [
    [{ identifier: '10.5/z' }, 'https://api.openalex.org/works/doi:10.5/z'],
    [{ identifier: 'doi:10.5/z' }, 'https://api.openalex.org/works/doi:10.5/z'],
    [{ identifier: 'W77' }, 'https://api.openalex.org/works/W77'],
    [{ identifier: '77', identifierType: 'openalex_id' }, 'https://api.openalex.org/works/W77'],
    [{ identifier: 'https://api.openalex.org/works/W9', identifierType: 'openalex_url' }, 'https://api.openalex.org/works/W9'],
    [{ identifier: 'abc/def', identifierType: 'weird' }, 'https://api.openalex.org/works/doi:abc/def']
  ];
  for (const [args, expected] of cases) {
    st.responses = [jsonResponse({ error: 'not found' })]; // body.error -> null
    assert.equal(await openalex.lookupWork(args), null);
    assert.ok(lastUrl().startsWith(expected + '?'), `expected ${expected}, got ${lastUrl()}`);
  }
});

test('openalex lookupWork: happy result + api error -> null', async () => {
  st.responses = [jsonResponse({ id: 'https://api.openalex.org/works/W8', title: 'Hex' })];
  const out = await openalex.lookupWork({ identifier: 'W8' });
  assert.equal(out.openalex_id, 'W8');

  st.responses = [jsonResponse({}, 404)];
  assert.equal(await openalex.lookupWork({ identifier: 'W8' }), null);
});

// ── semantic scholar ──

test('s2 searchPapers: empty query short-circuits', async () => {
  st.responses = [];
  const before = st.calls.length;
  assert.deepEqual(await s2.searchPapers({}), { papers: [], meta: { total: 0 } });
  assert.equal(st.calls.length, before);
});

test('s2 searchPapers: url building, year filter, api key header, limit clamp', async () => {
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'ss-key';
  st.responses = [jsonResponse({
    data: [{ paperId: 'p1', title: 'S1' }],
    total: 10, offset: 0, next: 99
  })];
  const out = await s2.searchPapers({ query: 'graphs', limit: 250, yearFrom: '2018', yearTo: '2020' });
  const u = lastUrl();
  assert.ok(u.startsWith('https://api.semanticscholar.org/graph/v1/paper/search?'));
  const p = urlParams(u);
  assert.equal(p.get('query'), 'graphs');
  assert.equal(p.get('limit'), '100');
  assert.equal(p.get('year'), 'year:>=2018-year:<=2020');
  assert.equal(lastInit().headers['x-api-key'], 'ss-key');
  assert.ok(p.get('fields').includes('citationCount'));
  assert.equal(out.papers[0].title, 'S1');
  assert.deepEqual(out.meta, { total: 10, offset: 0, next: 99 });
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
});

test('s2 searchPapers: custom fields passthrough and api error', async () => {
  st.responses = [jsonResponse({ data: [] })];
  await s2.searchPapers({ query: 'q', fields: 'title' });
  assert.equal(urlParams(lastUrl()).get('fields'), 'title');

  st.responses = [jsonResponse({}, 429)];
  await assert.rejects(s2.searchPapers({ query: 'q' }), /Semantic Scholar API error: 429 ST429/);
});

test('s2 lookupPaper: null on empty id, url shapes per idType', async () => {
  st.responses = [];
  const before = st.calls.length;
  assert.equal(await s2.lookupPaper({}), null);
  assert.equal(st.calls.length, before);

  st.responses = [jsonResponse({ error: 'x' })];
  assert.equal(await s2.lookupPaper({ id: '10.7/q' }), null);
  assert.ok(lastUrl().includes('/paper/DOI%3A10.7%2Fq'));

  st.responses = [jsonResponse({ error: 'x' })];
  assert.equal(await s2.lookupPaper({ id: '2401.1', idType: 'arxiv' }), null);
  assert.ok(lastUrl().includes('/paper/ArXiv%3A2401.1'));

  st.responses = [jsonResponse({ error: 'x' })];
  assert.equal(await s2.lookupPaper({ id: 'CorpusId:9', idType: 'corpus' }), null);
  assert.ok(lastUrl().includes('/paper/CorpusId%3A9'));

  st.responses = [jsonResponse({ error: 'x' })];
  assert.equal(await s2.lookupPaper({ id: 'plain-id' }), null);
  assert.ok(lastUrl().includes('/paper/plain-id'));
});

test('s2 relationship functions', async () => {
  st.responses = [jsonResponse({
    data: [{ paper: { paperId: 'r1', title: 'Ref' } }, { author: 'no paper' }],
    total: 1, offset: 0
  })];
  const refs = await s2.getReferences({ paperId: 'pX', limit: 1000 });
  assert.ok(lastUrl().includes('/paper/pX/references?'));
  assert.equal(urlParams(lastUrl()).get('limit'), '500', 'limit clamped to 500');
  assert.equal(refs.papers.length, 1);
  assert.equal(refs.meta.total, 1);

  st.responses = [jsonResponse({ data: [], error: null })];
  const cites = await s2.getCitations({ paperId: 'pX' });
  assert.ok(lastUrl().includes('/paper/pX/citations?'));
  assert.deepEqual(cites, { papers: [], meta: { total: 0, offset: 0, next: null } });

  st.responses = [jsonResponse({}, 500)];
  assert.deepEqual(await s2.getRelatedPapers({ paperId: 'pX' }), { papers: [], meta: { total: 0 } });

  assert.deepEqual(await s2.getCitations({}), { papers: [], meta: { total: 0 } });
});

// ── unpaywall ──

test('unpaywall: guards and missing email throw', async () => {
  delete process.env.UNPAYWALL_EMAIL;
  st.responses = [];
  const before = st.calls.length;
  assert.equal(await unpaywall.lookupByDoi({}), null);
  assert.equal(st.calls.length, before, 'missing doi does not fetch');
  await assert.rejects(
    unpaywall.lookupByDoi({ doi: '10.9/z', email: '' }),
    /Unpaywall requires an email/
  );
  assert.equal(st.calls.length, before);
});

test('unpaywall: happy mapping with explicit email', async () => {
  st.responses = [jsonResponse({
    doi: '10.9/z',
    is_oa: true,
    oa_status: 'gold',
    best_oa_location: { url_for_pdf: 'https://pdf/x', url_for_landing_page: 'https://l/x', license: 'cc-by' },
    genre: 'journal-article',
    published_date: '2020-02-03',
    publisher: 'ACME Press'
  })];
  const out = await unpaywall.lookupByDoi({ doi: '10.9/z', email: 'pdf@example.com' });
  const u = lastUrl();
  assert.ok(u.startsWith('https://api.unpaywall.org/v2/10.9%2Fz'));
  assert.equal(urlParams(u).get('email'), 'pdf@example.com');
  assert.equal(lastInit().headers['user-agent'], 'local-search-mcp/0.1 (mailto:pdf@example.com)');
  assert.equal(out.isOpenAccess, true);
  assert.equal(out.oaStatus, 'gold');
  assert.equal(out.bestPdfUrl, 'https://pdf/x');
  assert.equal(out.bestLandingPageUrl, 'https://l/x');
  assert.equal(out.license, 'cc-by');
  assert.equal(out.publisher, 'ACME Press');
  assert.equal(out.publishedDate, '2020-02-03');
  assert.ok(Array.isArray(out.source_records) && out.source_records[0].source === 'unpaywall');
});

test('unpaywall: env email fallback + 404 closed record', async () => {
  process.env.UNPAYWALL_EMAIL = 'env@example.com';
  st.responses = [jsonResponse({ status: 'not found' }, 404)];
  const out = await unpaywall.lookupByDoi({ doi: '10.4/none' });
  assert.ok(lastUrl().includes('email=env%40example.com'));
  assert.equal(out.isOpenAccess, false);
  assert.equal(out.oaStatus, 'closed');
  assert.equal(out.bestPdfUrl, null);
  assert.equal(out.license, null);
});

test('unpaywall: non-404 errors throw', async () => {
  process.env.UNPAYWALL_EMAIL = 'env@example.com';
  st.responses = [jsonResponse({}, 502)];
  await assert.rejects(unpaywall.lookupByDoi({ doi: '10.4/e' }), /Unpaywall API error: 502 ST502/);
});
