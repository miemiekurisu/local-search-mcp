import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp } from './helpers/mocks.mjs';

const st = undiciState();

const arxiv = await import('../src/papers/clients/arxivClient.js');

const ATOM_ENTRY = `<feed><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">7</opensearch:totalResults>
<entry>
<id>http://arxiv.org/abs/2301.55555v2</id>
<title>Atomized  Titles</title>
<summary>Summatic text</summary>
<published>2023-02-03T00:00:00Z</published>
<author><name>Alpha One</name></author>
<author><name>Beta Two</name></author>
<link href="http://arxiv.org/abs/2301.55555v2" rel="alternate" type="text/html"/>
<link href="http://arxiv.org/pdf/2301.55555v2" rel="related" type="application/pdf"/>
</entry></feed>`;

const EMPTY_ATOM = '<feed><opensearch:totalResults xmlns:os="http://x">0</opensearch:totalResults></feed>';

const RESULT_LI = `<ul><li class="arxiv-result"><p class="title is-5">Search  Result</p>
<a href="https://arxiv.org/abs/2301.4321v3">arXiv:2301.4321v3</a>
<a href="/search/index?q=attention">A. Author</a>
<a href="/search/index?q=attention">arXiv:2301.4321 tag</a>
<a class="abstract-short" href="/abs/2301.4321">abstract teaser</a></li></ul>`;

test('search with empty query short circuits', async () => {
  st.responses.length = 0;
  const out = await arxiv.search({});
  assert.deepEqual(out, { papers: [], meta: { total: 0 } });
});

test('search builds url and parses atom entries', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ text: ATOM_ENTRY, headers: { 'content-type': 'application/atom+xml' } }));
  const out = await arxiv.search({ query: 'kernel methods', maxResults: 3000, sortBy: 'relevance', start: 5 });
  assert.equal(st.calls.length >= 1, true);
  const url = String(st.calls[st.calls.length - 1].url);
  assert.ok(url.startsWith('http://export.arxiv.org/api/query?'));
  assert.ok(url.includes('search_query=kernel+methods'));
  assert.ok(url.includes('max_results=200'));
  assert.ok(url.includes('sortBy=relevance'));
  assert.ok(url.includes('sortOrder=descending'));
  assert.ok(url.includes('start=5'));

  assert.equal(out.meta.total, 7);
  assert.equal(out.papers.length, 1);
  const p = out.papers[0];
  assert.equal(p.title, 'Atomized Titles');
  assert.equal(p.abstract, 'Summatic text');
  assert.equal(p.arxiv_id, '2301.55555');
  assert.equal(p.arxiv_id_with_version, '2301.55555v2');
  assert.equal(p.year, 2023);
  assert.equal(p.published_date, '2023-02-03');
  assert.deepEqual(p.authors.map(a => a.name), ['Alpha One', 'Beta Two']);
  assert.equal(p.pdf_url, 'http://arxiv.org/pdf/2301.55555v2');
  assert.equal(p.landing_page_url, 'http://arxiv.org/abs/2301.55555v2');
  assert.equal(p.publication_type, 'preprint');
  assert.equal(p.source_records[0].source, 'arxiv');
});

test('lookup via atom id_list', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ text: ATOM_ENTRY }));
  const paper = await arxiv.lookup({ id: '2301.55555' });
  const url = String(st.calls[st.calls.length - 1].url);
  assert.ok(url.includes('id_list=2301.55555'));
  assert.ok(url.includes('max_results=1'));
  assert.equal(paper.title, 'Atomized Titles');
  assert.equal(paper.arxiv_id_with_version, '2301.55555v2');
  assert.equal(await arxiv.lookup({}), null);
});

test('lookup falls back to abstract page meta tags', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ text: EMPTY_ATOM }));
  st.responses.push(makeResp({
    url: 'https://arxiv.org/abs/2301.88888',
    text: `<html><head>
      <meta name="citation_title" content="HTML Fallback Title">
      <meta name="citation_date" content="2024-04-05">
      <meta name="citation_arxiv_id" content="2301.88888">
      <meta name="citation_author" content="Http Author">
      <meta name="citation_author" content="Second Author">
      <meta name="citation_abstract" content="html abstract">
      </head><body>irrelevant</body></html>`
  }));
  const paper = await arxiv.lookup({ id: '2301.88888v1' });
  assert.equal(paper.title, 'HTML Fallback Title');
  assert.equal(paper.year, 2024);
  assert.equal(paper.arxiv_id, '2301.88888');
  assert.equal(paper.abstract, 'html abstract');
  assert.deepEqual(paper.authors.map(a => a.name), ['Http Author', 'Second Author']);
  assert.equal(paper.landing_page_url, '');
  assert.equal(paper.pdf_url, '');
});

test('lookup rejects ids without arxiv pattern', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ text: EMPTY_ATOM }));
  assert.equal(await arxiv.lookup({ id: 'just junk' }), null);
});

test('search falls back to html results when api errors', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 503 }));
  st.responses.push(makeResp({ url: 'https://arxiv.org/search/?query=bad', text: RESULT_LI }));
  const out = await arxiv.search({ query: 'attention' });
  assert.equal(out.meta.total, 1);
  assert.equal(out.papers.length, 1);
  const p = out.papers[0];
  assert.equal(p.title, 'Search Result');
  assert.equal(p.arxiv_id, '2301.4321');
  assert.equal(p.arxiv_id_with_version, '2301.4321v3');
  assert.deepEqual(p.authors.map(a => a.name), ['A. Author']);
  assert.equal(p.landing_page_url, 'https://arxiv.org/abs/2301.4321');
  assert.equal(p.pdf_url, '');
});

test('search html fallback without matches returns empty', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 503 }));
  st.responses.push(makeResp({ text: '<html><body><p>no results in the list</p></body></html>' }));
  const out = await arxiv.search({ query: 'nothing here' });
  assert.deepEqual(out, { papers: [], meta: { total: 0 } });
});

test('search title queries use title endpoint path', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 503 }));
  st.responses.push(makeResp({ text: RESULT_LI }));
  const out = await arxiv.search({ query: 'ti:attention' });
  const url = String(st.calls[st.calls.length - 1].url);
  assert.ok(url.includes('searchtype=title'));
  assert.ok(url.includes('query=attention'));
  assert.equal(out.papers[0].title, 'Search Result');
});
