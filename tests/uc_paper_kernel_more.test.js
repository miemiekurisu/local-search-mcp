import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp, jsonResponse } from './helpers/mocks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const und = undiciState();
const { PaperKernel } = await import('../src/papers/paperKernel.js');
const { ArtifactStore } = await import('../src/artifacts/artifactStore.js');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-pk-'));
const artifactStore = new ArtifactStore(artifactDir);
test.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

const ATOM_ENTRY = `<feed><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
<entry>
<id>http://arxiv.org/abs/2301.55555v2</id>
<title>Atomized  Titles</title>
<summary>Summatic text</summary>
<published>2023-02-03T00:00:00Z</published>
<author><name>Alpha One</name></author>
<link href="http://arxiv.org/abs/2301.55555v2" rel="alternate" type="text/html"/>
</entry></feed>`;

const ENV_KEYS = ['OPENALEX_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY', 'CROSSREF_MAILTO', 'UNPAYWALL_EMAIL'];
function withEnv(env, fn) {
  const before = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of ENV_KEYS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });
}

const ENV_ALL = { OPENALEX_API_KEY: 'oak', SEMANTIC_SCHOLAR_API_KEY: 'ssk', CROSSREF_MAILTO: 'me@example.org', UNPAYWALL_EMAIL: 'me@example.org' };

function resetFetchRoutes(routes = []) {
  und.calls = [];
  und.responses = [];
  if (!routes.length) return;
  const self = (url, init) => {
    und.responses.unshift(self);
    for (const [needle, fn] of routes) {
      if (String(url).includes(needle)) return fn(String(url), init);
    }
    throw new Error('no route for ' + url);
  };
  und.responses.push((url, init) => self(url, init));
}
const urls = () => und.calls.map(c => String(c.url));
const headersOf = (needle) => {
  const hit = und.calls.find(c => String(c.url).includes(needle));
  return hit ? JSON.stringify(hit.init?.headers || {}) : null;
};

const OPENALEX_WORK = {
  id: 'W900700600', title: 'Scaling Attention', publication_year: 2024, publication_date: '2024-02-01',
  type: 'journal-article', doi: 'https://doi.org/10.5555/scale',
  authorships: [{ author: { display_name: 'Ada Lovelace', id: 'A1' } }],
  primary_location: { source: { display_name: 'Nature AI' } },
  open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://pdf.example.org/scale.pdf', license: 'cc-by' }
};
const SS_PAPER = {
  paperId: 'PS42', title: 'Sparse Attention at Scale', year: 2024, venue: 'NeurIPS',
  publicationTypes: ['JournalArticle'], externalIds: { DOI: '10.5555/sparse', ArXiv: '2401.22222' },
  abstract: 'sparse attention rocks', citationCount: 9, referenceCount: 3,
  fieldsOfStudy: ['cs'], isOpenAccess: true, openAccessPdf: { url: 'https://pdf.example.org/sparse' },
  authors: [{ name: 'Grace H', authorId: 'A9' }]
};

const ATOM_ROUTE = ['export.arxiv.org', () => makeResp({ text: ATOM_ENTRY, headers: { 'content-type': 'application/atom+xml' } })];

test('searchPapers openalex retry-after then success', () => withEnv({ OPENALEX_API_KEY: 'oak' }, async () => {
  const kernel = new PaperKernel({ artifactStore });
  let stage = 0;
  resetFetchRoutes([
    ['api.openalex.org/works?', (url) => {
      stage++;
      if (stage === 1) return makeResp({ status: 503, headers: { 'retry-after': '0' } });
      return makeResp({ json: { results: [OPENALEX_WORK] } });
    }],
    ATOM_ROUTE
  ]);
  const out = await kernel.searchPapers({ query: 'attention', sources: ['openalex', 'arxiv'], limit: 3 });
  assert.equal(out.failures.length, 0, JSON.stringify(out.failures));
  assert.ok(out.papers.some(p => p.title === 'Scaling Attention' && p.openalex_id === 'W900700600'));
  assert.ok(out.papers.some(p => p.title.includes('Atomized')), 'arxiv atom result included');
  assert.equal(stage, 2, 'one retry executed');
  assert.ok(await out.artifact_ref);
}));

test('searchPapers 429 retries then reports SEARCH_FAILED', () => withEnv({ OPENALEX_API_KEY: 'oak' }, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([['api.openalex.org', () => makeResp({ status: 429 })]]);
  const out = await kernel.searchPapers({ query: 'attention', sources: ['openalex'] });
  assert.equal(out.sources_tried[0], 'openalex');
  assert.deepEqual(out.papers, []);
  const f = out.failures.find(x => x.source === 'openalex');
  assert.equal(f.code, 429, 'second 429 surfaced as status code');
  assert.equal(f.message, 'HTTP 429');
}));

test('searchPapers happy multi-source incl semantic scholar normalization', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.openalex.org/works?', () => makeResp({ json: { results: [OPENALEX_WORK] } })],
    ['api.semanticscholar.org', () => makeResp({ json: { data: [SS_PAPER] } })],
    ['api.crossref.org/works?', () => makeResp({ json: { message: { items: [{ DOI: '10.5555/crx', title: ['Crossref Ship'], 'is-referenced-by-count': 4, type: 'journal-article', author: [{ given: 'A', family: 'B' }] }] } } })],
    ATOM_ROUTE
  ]);
  const out = await kernel.searchPapers({ query: 'attention', limit: 2, year_from: '2020', year_to: '2025' });
  assert.equal(out.sources_tried.join(','), 'openalex,crossref,arxiv,semantic_scholar', `sources: ${out.sources_tried.join(',')}`);
  assert.ok(out.papers.some(p => p.semantic_scholar_id === 'PS42' && p.doi === '10.5555/sparse' && p.arxiv_id === '2401.22222'));
  assert.ok(urls().some(u => u.includes('/paper/search?')), 'semantic scholar queried');
  assert.ok(headersOf('api.semanticscholar.org')?.includes('ssk'), 'ss api-key header set');
  assert.ok(urls().some(u => u.includes('year=2020-2025')), 'ss year filter');
  assert.ok(urls().some(u => u.includes('mailto=me%40example.org')), 'crossref mailto passed');
  assert.ok(headersOf('api.openalex.org')?.includes('oak'), 'openalex api-key header set');
}));

test('searchPapers generic failure code and empty results', () => withEnv({ OPENALEX_API_KEY: 'oak' }, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([['api.openalex.org', () => makeResp({ status: 500 })]]);
  const out = await kernel.searchPapers({ query: 'attention', sources: ['openalex'] });
  const f = out.failures.find(x => x.source === 'openalex');
  assert.equal(f.code, 500, 'HTTP status kept');
}));

test('lookupPaper merges records from doi lookups across sources', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.openalex.org/works?', () => makeResp({ json: { results: [OPENALEX_WORK] } })],
    ['api.semanticscholar.org', () => makeResp({ json: { data: [SS_PAPER] } })],
    ['api.crossref.org/works/', () => makeResp({ json: { message: { DOI: '10.5555/scale', title: ['Scaling Attention'], 'is-referenced-by-count': 7, published: { dateParts: [[2024, 2]] } } } })],
    ['api.unpaywall.org/v2/', () => makeResp({ json: { doi: '10.5555/scale', title: 'Scaling Attention', year: 2024, is_oa: true, oa_status: 'gold', best_oa_location: { url_for_pdf: 'https://pdf.example.org/scale.pdf', url_for_landing_page: 'https://exp.example.org/scale', license: 'cc-by' }, doi_url: 'https://doi.org/10.5555/scale' } })]
  ]);
  const out = await kernel.lookupPaper({ identifier: '10.5555/scale' });
  assert.equal(out.paper.doi, '10.5555/scale');
  assert.equal(out.paper.openalex_id, 'W900700600');
  assert.equal(out.paper.semantic_scholar_id, 'PS42');
  assert.ok(out.source_records.some(r => r.source === 'unpaywall'));
  assert.ok(out.source_records.some(r => r.source === 'crossref'), 'merged crossref record id present');
  assert.equal(out.failures.length, 0, JSON.stringify(out.failures));
}));

test('lookupPaper ss CorpusId and openalex W identifiers', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.semanticscholar.org', () => makeResp({ json: { ...SS_PAPER, paperId: 'PS-corpus' } })],
    ['api.openalex.org/works/', () => makeResp({ json: OPENALEX_WORK })]
  ]);
  const ssOut = await kernel.lookupPaper({ identifier: 'CorpusId:600700800', sources: ['semantic_scholar'] });
  assert.equal(ssOut.paper.semantic_scholar_id, 'PS-corpus');
  assert.ok(urls().some(u => u.includes('/paper/600700800?fields=')), urls().join('|'));
  assert.ok(headersOf('/paper/600700800')?.includes('ssk'), 'ss api-key set');

  const oaOut = await kernel.lookupPaper({ identifier: 'W900700600', sources: ['openalex'] });
  assert.equal(oaOut.paper.openalex_id, 'W900700600');
  assert.ok(urls().some(u => u.includes('/works/https://openalex.org/W900700600')), urls().join('|'));
  assert.ok(headersOf('api.openalex.org')?.includes('oak'), 'openalex api-key set');

  resetFetchRoutes([
    ['api.openalex.org/works/W123456789', () => makeResp({ json: {} })]
  ]);
  const missing = await kernel.lookupPaper({ identifier: 'W123456789', sources: ['openalex', 'crossref'] });
  assert.equal(missing.paper, null, 'empty results leave null paper');
}));

test('lookupPaper unpaywall-only, non-doi unpaywall skip, lookup failures recorded', () => withEnv({ UNPAYWALL_EMAIL: 'me@example.org' }, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.unpaywall.org/v2/', () => makeResp({ json: { doi: '10.5555/oa', is_oa: true, oa_status: 'bronze', best_oa_location: null, doi_url: 'https://doi.org/10.5555/oa' } })]
  ]);
  const out = await kernel.lookupPaper({ identifier: '10.5555/oa', identifier_type: 'doi', sources: ['unpaywall'] });
  assert.equal(out.paper.doi, '10.5555/oa');
  assert.equal(out.paper.open_access_status, 'bronze');
  assert.equal(out.failures.length, 0);

  resetFetchRoutes([['api.unpaywall.org/v2/', () => makeResp({ status: 404 })]]);
  const arxivType = await kernel.lookupPaper({ identifier: '2401.22222', identifier_type: 'arxiv', sources: ['unpaywall'] });
  assert.equal(arxivType.paper, null, 'unpaywall skips non-doi');

  resetFetchRoutes([['api.unpaywall.org/v2/', () => makeResp({ status: 503 })]]);
  const failing = await kernel.lookupPaper({ identifier: '10.5555/oa', identifier_type: 'doi', sources: ['unpaywall'] });
  assert.equal(failing.failures[0].code, 503);
  assert.equal(failing.failures[0].source, 'unpaywall');
}));

test('expandPaperCitations builds edges both directions and records expand failures', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  const refWork = { ...OPENALEX_WORK, id: 'W777', title: 'Ref Basis', doi: 'https://doi.org/10.5555/refbasis' };
  let ssCount = 0;
  resetFetchRoutes([
    ['api.openalex.org/works?', () => makeResp({ json: { results: [OPENALEX_WORK] } })],
['api.semanticscholar.org', (url) => {
      ssCount++;
      if (url.includes('/citations')) return makeResp({ json: { data: [{ citingPaper: { ...SS_PAPER, paperId: 'PS-citer', externalIds: {}, citationCount: 2, openAccessPdf: null } }] } });
      if (url.includes('/references')) return makeResp({ json: { data: [{ paperCited: { ...SS_PAPER, paperId: 'PS-refX', title: 'Ref Basis', externalIds: {}, citationCount: 1 } }] } });
      return makeResp({ json: { data: [SS_PAPER] } });
    }],
    ATOM_ROUTE
  ]);
  try {
    const out = await kernel.expandPaperCitations({ identifier: '10.5555/scale', direction: 'both', limit: 20 });
    assert.ok(out.root_paper.openalex_id === 'W900700600' || out.root_paper.semantic_scholar_id === 'PS42', JSON.stringify(out.root_paper));
    assert.ok(out.edges.some(e => e.relation === 'cited_by' && e.source === 'semantic_scholar'), `edges: ${JSON.stringify(out.edges)}`);
    assert.ok(out.edges.some(e => e.relation === 'cites' && e.source === 'semantic_scholar' && e.from === 'PS42'), `edges: ${JSON.stringify(out.edges)}`);
    assert.ok(out.papers.some(p => p.semantic_scholar_id === 'PS-refX'), 'reference paper collected');
    assert.ok(ssCount >= 3, 'lookup + citations + references hit semantic scholar');
    assert.ok(await out.artifact_ref);
  } finally {
  }
}));

test('expandPaperCitations openalex references edges and NOT_FOUND path', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  const refWork = { ...OPENALEX_WORK, id: 'W777000111', title: 'Ref Basis', doi: 'https://doi.org/10.5555/refbasis' };
  resetFetchRoutes([
    ['api.openalex.org/works?', () => makeResp({ json: { results: [OPENALEX_WORK] } })],
    ['api.semanticscholar.org', () => makeResp({ status: 403 })],
    ['api.openalex.org/works/W900700600/references', () => makeResp({ json: { results: [refWork] } })]
  ]);
  const out = await kernel.expandPaperCitations({ identifier: '10.5555/scale', direction: 'references' });
  assert.equal(out.edges.length, 1, `edges: ${JSON.stringify(out.edges)}`);
  assert.equal(out.edges[0].relation, 'cites');
  assert.equal(out.edges[0].to, 'W777000111');
  assert.equal(out.papers.length, 1, 'reference paper retained');
  assert.ok(out.failures.some(f => f.code === 403), JSON.stringify(out.failures));

  resetFetchRoutes([
    ['api.openalex.org', () => makeResp({ json: { results: [] } })],
    ['api.semanticscholar.org', () => makeResp({ json: {} })]
  ]);
  const missing = await kernel.expandPaperCitations({ identifier: '10.5555/ghost' });
  assert.equal(missing.root_paper, null);
  assert.deepEqual(missing.edges, []);
  assert.equal(missing.failures[0].code, 'NOT_FOUND');
}));

test('findOpenAccess unpaywall happy, openalex fallback, failures and NO_EMAIL', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.unpaywall.org/v2/10.5555%2Fscale', () => makeResp({ json: { doi: '10.5555/scale', is_oa: true, oa_status: 'gold', best_oa_location: { url_for_pdf: 'https://pdf.example.org/scale.pdf', url_for_landing_page: 'https://exp.example.org/scale', license: 'cc-by' } } })],
    ['api.unpaywall.org/v2/10.5555%2Fclosed', () => makeResp({ json: { doi: '10.5555/closed', is_oa: false, oa_status: 'closed', best_oa_location: null } })],
    ['api.unpaywall.org/v2/10.5555%2Fneterr', () => makeResp({ status: 503 })],
    ['api.openalex.org/works?search=10.5555%2Fclosed', () => makeResp({ json: { results: [{ id: 'W550030200', title: 'Closed Ship', doi: '10.5555/closed', open_access: { is_oa: true, oa_status: 'green', oa_url: 'https://pdf.example.org/closed', license: 'cc0' } }] } })],
    ['api.openalex.org/works?', () => makeResp({ status: 500 })]
  ]);
  const oa = await kernel.findOpenAccess({ identifier: '10.5555/scale' });
  assert.equal(oa.is_open_access, true);
  assert.equal(oa.best_pdf_url, 'https://pdf.example.org/scale.pdf');
  assert.equal(oa.license, 'cc-by');

  const fallback = await kernel.findOpenAccess({ identifier: '10.5555/closed' });
  assert.equal(fallback.is_open_access, true, 'openalex fallback flips oa');
  assert.equal(fallback.oa_status, 'green');
  assert.equal(fallback.best_pdf_url, 'https://pdf.example.org/closed', `fallback pdf: ${fallback.best_pdf_url}`);
  assert.ok(fallback.source_records.some(r => r.source === 'openalex'));

  const failing = await kernel.findOpenAccess({ identifier: '10.5555/neterr' });
  assert.ok(failing.failures.some(f2 => f2.code === 503), JSON.stringify(failing.failures));

  const noOpenalex = await withEnv({ OPENALEX_API_KEY: undefined }, async () => {
    const k2 = new PaperKernel({ artifactStore });
    const r2 = await k2.findOpenAccess({ identifier: '10.5555/closed' });
    return r2;
  });
  assert.equal(noOpenalex.is_open_access, false, 'no fallback without openalex key');
  assert.ok(noOpenalex.failures.some(f2 => f2.code === 'NO_EMAIL'), JSON.stringify(noOpenalex.failures));
}));

test('findOpenAccess resolves non-doi via lookup then recursion, else NO_DOI', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  resetFetchRoutes([
    ['api.semanticscholar.org/graph/v1/paper/2401.22222?', () => makeResp({ json: { ...SS_PAPER, paperId: 'SS2401', externalIds: { DOI: '10.5555/from-arxiv' } } })],
    ['api.openalex.org/works?search=', () => makeResp({ json: { results: [] } })],
    ['api.openalex.org/works/', () => makeResp({ json: {} })],
    ['api.crossref.org/works/', () => makeResp({ json: { message: {} } })],
    ['export.arxiv.org', () => makeResp({ text: '<feed><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>' })],
    ['arxiv.org/abs', () => makeResp({ status: 403 })],
    ['api.unpaywall.org/v2/10.5555%2Ffrom-arxiv', () => makeResp({ json: { doi: '10.5555/from-arxiv', is_oa: true, oa_status: 'gold' } })]
  ]);
  const resolved = await kernel.findOpenAccess({ identifier: '2401.22222' });
  assert.equal(resolved.identifier, '10.5555/from-arxiv', `identifier: ${resolved.identifier}`);
  assert.equal(resolved.is_open_access, true);

  resetFetchRoutes([
    ['api.semanticscholar.org/graph/v1/paper/2401.22223?', () => makeResp({ json: {} })],
    ['api.openalex.org', () => makeResp({ json: {} })]
  ]);
  const unresolved = await kernel.findOpenAccess({ identifier: '2401.22223' });
  assert.equal(unresolved.failures.length > 0 || unresolved.is_open_access === false, true);
  assert.equal(unresolved.is_open_access, false);
  assert.equal(unresolved.failures[0]?.code, 'NO_DOI');
}));

test('researchPapers runs multi-query pipeline with failures and oa links', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  let artifactWrites = 0;
  const realWrite = artifactStore.writeText.bind(artifactStore);
  artifactStore.writeText = (...a) => {
    artifactWrites++;
    if (artifactWrites === 2) throw new Error('disk full');
    return realWrite(...a);
  };
  resetFetchRoutes([
    ['api.openalex.org/works?', () => makeResp({ json: { results: [OPENALEX_WORK] } })],
    ['api.semanticscholar.org', () => makeResp({ json: { data: [SS_PAPER] } })],
    ['api.crossref.org', () => makeResp({ json: { message: null } })]
  ]);
  const out = await kernel.researchPapers({
    research_question: 'Does attention sparsity help?',
    budget: { max_queries: 2, max_papers: 6 }
  });
  assert.ok(out.queries_executed.length === 2, `queries: ${JSON.stringify(out.queries_executed)}`);
  assert.ok(out.key_papers.length > 0, 'key papers collected');
  assert.ok(out.open_access_links.length > 0, 'oa links extracted');
  assert.ok(out.failures.some(f => f.code === 'RESEARCH_PAPER_FAILED'), `query-level failure: ${JSON.stringify(out.failures)}`);
  assert.ok(out.evidence_summary.source_distribution, 'summary built');
  artifactStore.writeText = realWrite;
}));

test('researchPapers citation clusters and expansion failure recorded', () => withEnv(ENV_ALL, async () => {
  const kernel = new PaperKernel({ artifactStore });
  const closedWork = { ...OPENALEX_WORK, id: 'W550030200', title: 'Closed Ship', doi: 'https://doi.org/10.5555/closed', open_access: { is_oa: false, oa_status: 'closed', oa_url: '', license: '' } };
  let citationWrites = 0;
  const realWrite = artifactStore.writeText.bind(artifactStore);
  artifactStore.writeText = (dir, ...a) => {
    if (dir === 'citations') {
      citationWrites++;
      if (citationWrites >= 2) throw new Error('citation store dead');
    }
    return realWrite(dir, ...a);
  };
  resetFetchRoutes([
    ['api.openalex.org/works?search=', () => makeResp({ json: { results: [OPENALEX_WORK, closedWork] } })],
    ['api.semanticscholar.org/graph/v1/paper/search?query=10.5555%2Fscale', () => makeResp({ json: { data: [{ ...SS_PAPER, paperId: 'PS-A', externalIds: { DOI: '10.5555/scale' } }] } })],
    ['api.semanticscholar.org', (url) => {
      if (url.includes('/citations')) return makeResp({ json: { data: [{ citingPaper: { ...SS_PAPER, paperId: 'PS-A2', externalIds: { DOI: '10.5555/extra' } } }] } });
      if (url.includes('/references')) return makeResp({ json: { data: [] } });
      return makeResp({ json: {} });
    }],
    ['api.openalex.org/works/', () => makeResp({ json: { results: [] } })],
    ['api.crossref.org/works/', () => makeResp({ json: { message: {} } })]
  ]);
  const out = await kernel.researchPapers({ research_question: 'Attention sparsity study', budget: { max_queries: 1, max_citation_expansions: 2 } });
  assert.ok(out.citation_clusters.length === 1, `clusters: ${JSON.stringify(out.citation_clusters)}`);
  assert.equal(out.citation_clusters[0].root, '10.5555/scale');
  assert.ok(out.failures.some(f => f.code === 'CITATION_EXPAND_FAILED'), `failures: ${JSON.stringify(out.failures)}`);
  artifactStore.writeText = realWrite;
}));

test('_generateResearchQueries and _extractMethodFamilies branches', () => {
  const kernel = new PaperKernel({});
  const queries = kernel._generateResearchQueries('How does method X work');
  assert.ok(queries.includes('How does method X work survey'), `queries: ${JSON.stringify(queries)}`);
  assert.ok(!queries.some(q => q.endsWith(' method')), 'method word suppresses method suffix');
  assert.ok(kernel._generateResearchQueries('Plain no triggers').length >= 5, 'all suffix groups append');

  const fams = kernel._extractMethodFamilies([
    { title: 'Transformer Sparsity Study', abstract: '' },
    { title: 'Another Transformer', abstract: 'uses kv cache' }
  ], 'q');
  assert.equal(fams.find(f => f.method === 'transformer').paper_count, 2);
  assert.equal(fams.find(f => f.method === 'kv cache').paper_count, 1);
});
