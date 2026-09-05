process.env.UNPAYWALL_EMAIL = 'research@example.com';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp } from './helpers/mocks.mjs';

const st = undiciState();

const { PaperKernel } = await import('../src/papers/paperKernel.js');

function reg(enabled) {
  return {
    isSourceEnabled: id => !!enabled[id],
    getEnabledSources: () => []
  };
}

function stubArtifact() {
  const calls = [];
  let n = 0;
  return {
    calls,
    writeText: async (dir, text, meta) => {
      calls.push({ dir, text, meta });
      return `ao://${dir}/${++n}`;
    }
  };
}

function crossrefBody(dois) {
  return {
    message: {
      'total-results': dois.length,
      items: dois.map(d => ({
        DOI: d,
        title: ['Cross Title'],
        author: [{ given: 'Ja', family: 'Ne' }],
        published: { dateParts: [[2001]] },
        type: 'journal-article',
        'container-title': ['Some Venue'],
        abstract: '<jats:p>st "ripped" abstract</jats:p>',
        'is-referenced-by-count': 11
      }))
    }
  };
}

test('searchPapers via crossref only, happy path', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: crossrefBody(['10.1000/aaa']) }));
  const art = stubArtifact();
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }), artifactStore: art });

  const out = await k.searchPapers({ query: 'attention models', limit: 5 });
  assert.deepEqual(out.sources_tried, ['crossref']);
  assert.deepEqual(out.failures, []);
  assert.equal(out.papers.length, 1);
  const p = out.papers[0];
  assert.equal(p.title, 'Cross Title');
  assert.equal(p.doi, '10.1000/aaa');
  assert.equal(p.year, 2001);
  assert.equal(p.venue, 'Some Venue');
  assert.equal(p.abstract, 'st "ripped" abstract');
  assert.equal(p.citation_count, 11);
  assert.equal(p.publication_type, 'journal-article');
  assert.equal(p.source_records[0].source, 'crossref');
  assert.ok(p.scores.final > 0);
  assert.match(out.query_id, /^pq_[0-9a-f]{12}$/);
  assert.ok(typeof out.artifact_ref.then === 'function');
  assert.equal(await out.artifact_ref, 'ao://papers/1');
  assert.equal(art.calls[0].dir, 'papers');
  assert.equal(art.calls[0].meta.kind, 'paper_search_results');
  assert.equal(art.calls[0].meta.query, 'attention models');
});

test('searchPapers failure rows and required query', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 500 }));
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }) });
  const out = await k.searchPapers({ query: 'x' });
  assert.deepEqual(out.papers, []);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].source, 'crossref');
  assert.equal(out.failures[0].code, 500);
  assert.equal(out.artifact_ref, null);
  await assert.rejects(k.searchPapers({}), /query is required/);
});

test('searchPapers openalex with ids and open_access_only filter', async () => {
  const work = id => ({
    id,
    doi: 'https://doi.org/10.1000/OA',
    title: 'OpenAlex Work Title',
    publication_year: 2024,
    publication_date: '2024-03-01',
    authorships: [{ author: { display_name: 'Jane Doe', id: 'A1' } }],
    primary_location: { source: { display_name: 'Nature' }, landing_page_url: 'https://loc/x' },
    cited_by_count: 42,
    referenced_works_count: 7,
    concepts: [{ display_name: 'Computer Science' }],
    open_access: { is_oa: false, oa_status: 'closed', oa_url: '', license: '' },
    abstract_inverted_index: { models: [0], attention: [1] },
    ids: { arxiv: 'arXiv:2301.11111v1' }
  });
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { results: [work('W123456789')], meta: { count: 1 } } }));
  st.responses.push(makeResp({ json: { results: [work('W123456789')], meta: { count: 1 } } }));
  const k = new PaperKernel({ sourceRegistry: reg({ openalex: 1 }) });

  const plain = await k.searchPapers({ query: 'attention models', domain: 'sci' });
  assert.deepEqual(plain.sources_tried, ['openalex']);
  assert.equal(plain.papers.length, 1);
  const p = plain.papers[0];
  assert.equal(p.title, 'OpenAlex Work Title');
  assert.equal(p.openalex_id, 'W123456789');
  assert.equal(p.arxiv_id, '2301.11111');
  assert.equal(p.abstract, 'models attention');
  assert.deepEqual(p.fields_of_study, ['Computer Science']);
  assert.equal(p.venue, 'Nature');
  assert.equal(p.landing_page_url, 'https://loc/x');
  assert.equal(p.is_open_access, null);
  assert.equal(p.open_access_status, 'closed');

  const filtered = await k.searchPapers({ query: 'attention models', domain: 'sci', open_access_only: true });
  assert.deepEqual(filtered.papers, []);
});

test('lookupPaper merges crossref and unpaywall records for doi', async () => {
  process.env.CROSSREF_MAILTO = 'team@example.com';
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { message: { DOI: '10.1000/bbb', title: ['Merged Title'], 'container-title': ['Cell'] } } }));
  st.responses.push(makeResp({
    json: {
      doi: '10.1000/bbb', is_oa: true, oa_status: 'gold',
      best_oa_location: { url_for_pdf: 'https://oa/pdf.pdf', url_for_landing_page: 'https://oa/landing', license: 'cc-by' },
      doi_url: 'https://doi.org/10.1000/bbb', publisher: 'Cell Press'
    }
  }));
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1, unpaywall: 1 }) });
  const out = await k.lookupPaper({ identifier: '10.1000/bbb', identifier_type: 'doi' });

  assert.deepEqual(out.sources_tried, ['crossref', 'unpaywall']);
  assert.deepEqual(out.failures, []);
  const p = out.paper;
  assert.equal(p.title, 'Merged Title');
  assert.equal(p.is_open_access, true);
  assert.equal(p.open_access_status, 'gold');
  assert.equal(p.landing_page_url, 'https://doi.org/10.1000/bbb');
  assert.deepEqual(out.source_records.map(r => r.source), ['crossref', 'unpaywall']);
  const crossrefCall = st.calls.filter(c => c.url.includes('api.crossref.org')).pop();
  assert.ok(crossrefCall.url.includes('mailto='));
  delete process.env.CROSSREF_MAILTO;
});

test('lookupPaper arxiv source returns normalized entry', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({
    text: `<feed><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
    <entry>
      <id>http://arxiv.org/abs/2301.12345v1</id>
      <title>Kernel  Paper</title>
      <summary>A kernel paper.</summary>
      <published>2023-01-10T00:00:00Z</published>
      <author><name>Alice</name></author>
      <link href="https://arxiv.org/abs/2301.12345v1" rel="alternate" type="text/html"/>
      <link href="https://arxiv.org/pdf/2301.12345v1" rel="related" type="application/pdf"/>
    </entry></feed>`,
    headers: { 'content-type': 'application/atom+xml' }
  }));
  const k = new PaperKernel({ sourceRegistry: reg({ arxiv: 1 }) });
  const out = await k.lookupPaper({ identifier: '2301.12345', identifier_type: 'arxiv' });
  assert.deepEqual(out.failures, []);
  const p = out.paper;
  assert.equal(p.title, 'Kernel Paper');
  assert.equal(p.arxiv_id, '2301.12345');
  assert.equal(p.arxiv_id_with_version, '2301.12345v1');
  assert.equal(p.year, 2023);
  assert.equal(p.publication_type, 'preprint');
  assert.deepEqual(p.authors.map(a => a.name), ['Alice']);
  assert.equal(p.pdf_url, 'https://arxiv.org/pdf/2301.12345v1');
});

test('lookupPaper throws for undetectable identifier', async () => {
  const k = new PaperKernel({ sourceRegistry: reg({}) });
  await assert.rejects(k.lookupPaper({ identifier: 'zzz-random' }), /unable to detect identifier type/);
  await assert.rejects(k.lookupPaper({}), /identifier is required/);
});

test('lookupPaper failure rows and merge-free path', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 503 }));
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }) });
  const out = await k.lookupPaper({ identifier: '10.9999/xyz', identifier_type: 'doi' });
  assert.equal(out.paper, null);
  assert.deepEqual(out.failures, [{ source: 'crossref', code: 503, message: out.failures[0].message }]);
});

test('expandPaperCitations builds openalex citation edges', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { id: 'W123456789', title: 'Root Paper', publication_year: 2024 } }));
  st.responses.push(makeResp({ json: {} }));
  st.responses.push(makeResp({
    json: {
      results: [{
        id: 'W999',
        doi: 'https://doi.org/10.1/ref',
        title: 'Ref Paper',
        publication_year: 2023,
        open_access: { is_oa: false, oa_status: 'closed' }
      }]
    }
  }));
  const art = stubArtifact();
  const k = new PaperKernel({ sourceRegistry: reg({ openalex: 1, semantic_scholar: 1 }), artifactStore: art });

  const out = await k.expandPaperCitations({ identifier: 'W123456789', direction: 'references', limit: 10 });
  assert.equal(out.root_paper.title, 'Root Paper');
  assert.equal(out.root_paper.openalex_id, 'W123456789');
  assert.deepEqual(out.edges, [{ from: 'W123456789', to: 'W999', relation: 'cites', source: 'openalex' }]);
  assert.equal(out.papers.length, 1);
  assert.equal(out.papers[0].title, 'Ref Paper');
  assert.deepEqual(out.failures, []);
  assert.equal(art.calls[0].dir, 'citations');
  assert.equal(art.calls[0].meta.kind, 'citation_expansion');
});

test('expandPaperCitations not found path', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: {} }));
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }) });
  const out = await k.expandPaperCitations({ identifier: '10.7777/dne' });
  assert.equal(out.root_paper, null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.failures, [{ code: 'NOT_FOUND', message: 'paper not found: 10.7777/dne' }]);
});

test('findOpenAccess via unpaywall with runtime env', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({
    json: {
      is_oa: true, oa_status: 'gold',
      best_oa_location: { url_for_pdf: 'https://pdf.example/a.pdf', url_for_landing_page: 'https://land.example/a', license: 'cc' },
      doi_url: 'https://doi.org/10.1000/abc'
    }
  }));
  let k = new PaperKernel();
  let out = await k.findOpenAccess({ identifier: '10.1000/abc' });
  assert.equal(out.is_open_access, true);
  assert.equal(out.oa_status, 'gold');
  assert.equal(out.best_pdf_url, 'https://pdf.example/a.pdf');
  assert.equal(out.best_landing_page_url, 'https://land.example/a');
  assert.equal(out.license, 'cc');
  assert.deepEqual(out.failures, []);

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 500 }));
  k = new PaperKernel();
  out = await k.findOpenAccess({ identifier: '10.2000/broken' });
  assert.equal(out.is_open_access, false);
  assert.deepEqual(out.failures, [{ source: 'unpaywall', code: 500, message: out.failures[0].message }]);

  process.env.OPENALEX_API_KEY = 'k-test';
  try {
    st.responses.length = 0;
    st.responses.push(makeResp({ status: 500 }));
    st.responses.push(makeResp({
      json: {
        results: [{ id: 'W555', open_access: { is_oa: true, oa_status: 'green', oa_url: 'https://oa.example/f.pdf', license: 'cc-by' } }]
      }
    }));
    k = new PaperKernel();
    out = await k.findOpenAccess({ identifier: '10.3000/oa-fallback' });
    assert.equal(out.is_open_access, true);
    assert.equal(out.oa_status, 'green');
    assert.equal(out.best_pdf_url, 'https://oa.example/f.pdf');
    assert.equal(out.license, 'cc-by');
    assert.deepEqual(out.source_records.map(r => r.source), ['openalex']);
    assert.deepEqual(out.failures, [{ source: 'unpaywall', code: 500, message: out.failures[0].message }]);
    const oaCall = st.calls.filter(c => c.url.includes('api.openalex.org')).pop();
    assert.equal(oaCall.init.headers['api-key'], 'k-test');
  } finally {
    delete process.env.OPENALEX_API_KEY;
  }
});

test('findOpenAccess NO_DOI and NO_EMAIL paths', async () => {
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }) });
  const out = await k.findOpenAccess({ identifier: 'W123456789' });
  assert.equal(out.is_open_access, false);
  assert.deepEqual(out.failures, [{ code: 'NO_DOI', message: 'could not resolve DOI' }]);

  const prev = process.env.UNPAYWALL_EMAIL;
  delete process.env.UNPAYWALL_EMAIL;
  try {
    const k2 = new PaperKernel();
    const out2 = await k2.findOpenAccess({ identifier: '10.5000/no-email' });
    assert.equal(out2.is_open_access, false);
    assert.deepEqual(out2.failures, [{ source: 'unpaywall', code: 'NO_EMAIL', message: 'UNPAYWALL_EMAIL not configured' }]);
  } finally {
    process.env.UNPAYWALL_EMAIL = prev;
  }
});

test('researchPapers small budget crossref-only pipeline', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: crossrefBody(['10.9000/q1']) }));
  st.responses.push(makeResp({ json: crossrefBody(['10.9000/q2']) }));
  const art = stubArtifact();
  const k = new PaperKernel({ sourceRegistry: reg({ crossref: 1 }), artifactStore: art });

  const out = await k.researchPapers({
    research_question: 'mixture of experts transformers survey',
    budget: { max_queries: 2, max_papers: 5, max_citation_expansions: 0 }
  });
  assert.equal(out.queries_executed.length, 2);
  assert.equal(out.queries_executed[0], 'mixture of experts transformers survey');
  assert.equal(out.key_papers.length, 2);
  assert.deepEqual(out.related_papers, []);
  assert.deepEqual(out.citation_clusters, []);
  assert.ok((await out.artifact_ref).startsWith('ao://papers/'));
  assert.equal(art.calls[0].meta.kind, 'paper_search_results');
  assert.equal(art.calls[2].meta.kind, 'research_papers');
  assert.equal(art.calls[2].meta.kind === 'research_papers' ? art.calls[2].meta.question : false, 'mixture of experts transformers survey');
  assert.deepEqual(out.evidence_summary.method_families, []);
  assert.ok(out.research_id.startsWith('pr_'));
  assert.ok(out.created_at);
});

test('researchPapers query generation and required question', async () => {
  const k = new PaperKernel({ sourceRegistry: reg({}) });
  await assert.rejects(k.researchPapers({ research_question: '   ' }), /research_question is required/);
  await assert.rejects(k.researchPapers({}), /research_question is required/);

  st.responses.length = 0;
  const mark = st.calls.length;
  const out = await k.researchPapers({
    research_question: 'memory hard problems approach comparison application',
    budget: { max_queries: 20, max_papers: 5 }
  });
  assert.equal(out.queries_executed.length, 1);
  assert.deepEqual(out.queries_executed, [
    'memory hard problems approach comparison application'
  ]);
});
