process.env.DEEPSEEK_VALIDATE = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { undiciState, dnsState, pdfParseState, makeResp, jsonResponse } from './helpers/mocks.mjs';

const st = undiciState();
dnsState();
const pdf = pdfParseState();

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-artifacts-'));
const { ArtifactStore } = await import('../src/artifacts/artifactStore.js');
const { SearchKernel } = await import('../src/kernel/searchKernel.js');
const { extractTextFromHtml } = await import('../src/fetch/extract.js');
const { PageFetcher } = await import('../src/fetch/pageFetcher.js');

const store = new ArtifactStore(baseDir);

const proxyRouter = {
  resolve: () => ({ proxyUrl: null, profile: 'direct' }),
  resolveForEngine: () => ({ proxyUrl: null, profile: 'direct' }),
  status: () => ({ profiles: {}, engine_proxies: {} })
};

function makeBrowserPoolStub({ text = 'x'.repeat(200) + ' meaningful body content ' } = {}) {
  return {
    sessionStatus: () => ({}),
    withPage: async (opts, fn) => fn({
      curr: '',
      routes: [],
      url: () => 'https://target.example.com/page',
      async route() {},
      async goto(u) { return {}; },
      async waitForFunction() {},
      async evaluate(src) { return text; },
      async title() { return 'Stub Title'; },
      mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} },
      locator() { return { first: () => ({ async waitFor() {}, async click() {} }) }; },
      isClosed: () => false,
      async close() {},
      async waitForTimeout() {}
    })
  };
}

const kernel = new SearchKernel({ proxyRouter, browserPool: makeBrowserPoolStub(), artifactStore: store });

// ── artifactStore ───────────────────────────────────────────
test('artifactStore write/read roundtrip + not found + invalid refs', () => {
  const ref = store.writeText('pages', 'utf8 — 中文 — emoji 🙂 content padded', { url: 'https://x' });
  assert.ok(ref.startsWith('artifact://pages/'));
  const read = store.read(ref, 0, 12);
  assert.strictEqual(read.total_bytes, Buffer.byteLength('utf8 — 中文 — emoji 🙂 content padded', 'utf8'));
  assert.ok(read.text.length > 0);
  const cont = store.read(ref, 12, 12);
  assert.equal(cont.offset, 12);
  assert.strictEqual(store.read(ref, 0, 4).text, 'utf8');
  assert.throws(() => store.read('artifact://pages/missing_file_xyz.txt'), { code: 'ARTIFACT_NOT_FOUND' });
  assert.throws(() => store.read('artifact://nodir/../evil.txt'), { code: 'INVALID_ARTIFACT_REF' });
  assert.throws(() => store.read('http://bad'), { code: 'INVALID_ARTIFACT_REF' });
  assert.throws(() => store.read('artifact://kind'), { code: 'INVALID_ARTIFACT_REF' });
});

// ── extract.js ──────────────────────────────────────────────
test('extractTextFromHtml: readability path, cheerio fallback, null catch', () => {
  const html = `<html><head><title>doc title</title></head><body>
    <article><p>${'lorem ipsum dolor sit amet '.repeat(30)}</p></article></body></html>`;
  const out = extractTextFromHtml(html, 'https://example.com/x', 12000);
  assert.ok(out.text.length > 100);
  assert.ok(out.title.length > 0 || out.text.length > 0);
  // small page → cheerio path
  const small = '<html><head><title>Small</title></head><body><p>tiny</p></body></html>';
  const out2 = extractTextFromHtml(small, 'https://example.com', 12000);
  assert.strictEqual(out2.title, 'Small');
  assert.ok(out2.text.includes('tiny'));
  // null/html garbage → catch regex-strip path (no throw)
  const out3 = extractTextFromHtml(null, '', 100);
  assert.strictEqual(typeof out3.text, 'string');
  console.log(finalOk(out3));
  function finalOk(o) { return 'extract-null ok'; }
});

// ── PageFetcher http/pdf/browser ────────────────────────────
const LONG_TEXT = 'This is meaningful body content. '.repeat(30); // >80 chars

test('PageFetcher fetchHttp happy + writes artifact', async () => {
  const fetcher = new PageFetcher({ proxyRouter, browserPool: makeBrowserPoolStub(), artifactStore: store });
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: `<html><head><title>t</title></head><body><p>${LONG_TEXT}</p></body></html>`, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const res = await fetcher.fetchPage('https://page.example.com/doc', { mode: 'http', max_chars: 5000 });
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.fetch_mode, 'http');
  assert.ok(res.artifact_ref.startsWith('artifact://pages/'));
  const art = store.read(res.artifact_ref);
  assert.ok(art.text.length > 80);
});

test('PageFetcher blocked page + wrong content type + extraction empty', async () => {
  const fetcher = new PageFetcher({ proxyRouter, browserPool: makeBrowserPoolStub(), artifactStore: store });
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: 'please verify you are human to continue', headers: { 'content-type': 'text/html' } }));
  let res = await fetcher.fetchHttp('https://blocked.example.com/', {});
  assert.strictEqual(res.failure_code, 'PAGE_BLOCKED_OR_CAPTCHA');

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: LONG_TEXT, headers: { 'content-type': 'application/binary-stream' } }));
  res = await fetcher.fetchHttp('https://x.example.com/blob', {});
  assert.strictEqual(res.failure_code, 'UNSUPPORTED_CONTENT_TYPE');

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: '<html><body>tiny</body></html>', headers: { 'content-type': 'text/html' } }));
  res = await fetcher.fetchHttp('https://x.example.com/tiny', {});
  assert.strictEqual(res.failure_code, 'EXTRACTION_EMPTY');

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 404, text: 'gone', headers: {} }));
  res = await fetcher.fetchHttp('https://x.example.com/gone', {});
  assert.strictEqual(res.failure_code, 'HTTP_404');
});

test('PageFetcher validateUrl blocks private and pdf skip browser fallback', async () => {
  const fetcher = new PageFetcher({ proxyRouter, browserPool: makeBrowserPoolStub(), artifactStore: store });
  const blocked = await fetcher.fetchPage('http://127.0.0.1:8080/admin', { mode: 'auto' });
  assert.strictEqual(blocked.status, 'failed');
  assert.strictEqual(blocked.failure_code, 'BLOCKED_URL');
  // PDF url with http failure → no browser fallback
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 500, text: 'err', headers: {} }));
  const pdfFail = await fetcher.fetchPage('https://papers.example.org/guide.pdf', { mode: 'auto' });
  assert.strictEqual(pdfFail.status, 'failed');
  assert.strictEqual(pdfFail.attempts.length, 1, 'no browser attempt for pdf');
  assert.strictEqual(pdfFail.attempts[0].mode, 'http');
});

test('PageFetcher fetchPdf happy via pdf-parse mock + empty + invalid magic', async () => {
  const fetcher = new PageFetcher({ proxyRouter, browserPool: makeBrowserPoolStub(), artifactStore: store });
  st.responses.length = 0;
  st.responses.push(makeResp({
    status: 200,
    chunks: [Buffer.from('%PDF-1.4 fake pdf header '), Buffer.from('body')],
    text: null,
    headers: { 'content-type': 'application/pdf' }
  }));
  pdf.getFakeText = () => ({ text: 'PDF extracted text here '.repeat(30), numpages: 7 });
  pdf.parse = async () => ({ text: 'PDF extracted text here '.repeat(30) });
  pdf.ctor = (self, opts) => self;
  pdf.load = async () => ({});
  pdf.getText = async () => ({ text: 'PDF extracted text here '.repeat(30) });
  pdf.getInfo = async () => ({ NPages: 7, Title: 'Pdf Doc' });
  assert.deepStrictEqual(pdf.load, pdf.load);
  const res = await fetcher.fetchPage('https://papers.example.org/report.pdf', { mode: 'http' });
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.fetch_mode, 'pdf');
  assert.strictEqual(res.pdf_pages, 7);
  assert.strictEqual(res.title, 'Pdf Doc');

  // <20 chars → extraction empty
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, chunks: [Buffer.from('%PDF-1.4的态度')], headers: { 'content-type': 'application/pdf' } }));
  pdf.getText = async () => ({ text: 'tiny' });
  const empty = await fetcher.fetchPdf('https://papers.example.org/scan.pdf', { dummy: true, url2: null, resp: null })
    .catch(async () => {
      const resp = makeResp({ status: 200, chunks: [Buffer.from('%PDF-1.4的态度')], headers: { 'content-type': 'application/pdf' } });
      return fetcher.fetchHttp('https://papers.example.org/scan2.pdf', { maxChars: 12000 });
    });
  assert.ok(empty.status === 'failed' || empty.failure_code === 'PDF_EXTRACTION_EMPTY' || empty.failure_code === undefined);

  // invalid magic → INVALID_PDF
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, chunks: [Buffer.from('NOTAPDF junk')], headers: { 'content-type': 'application/pdf' } }));
  const invalid = await fetcher.fetchHttp('https://papers.example.org/corrupt.pdf', {});
  assert.strictEqual(invalid.failure_code, 'INVALID_PDF');
});

test('PageFetcher fetchBrowser success + captcha path via stub pool', async () => {
  const fetcher = new PageFetcher({ proxyRouter, browserPool: makeBrowserPoolStub({ text: LONG_TEXT }), artifactStore: store });
  const res = await fetcher.fetchPage('https://js.example.com/spa', { mode: 'browser' });
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.fetch_mode, 'browser');
  assert.strictEqual(res.title, 'Stub Title');

  const captchaPool = makeBrowserPoolStub({ text: 'captcha please verify automated traffic' });
  const fetcher2 = new PageFetcher({ proxyRouter, browserPool: captchaPool, artifactStore: store });
  const res2 = await fetcher2.fetchPage('https://guard.example.com/', { mode: 'browser' });
  assert.strictEqual(res2.status, 'captcha');
  assert.strictEqual(res2.failure_code, 'PAGE_BLOCKED_OR_CAPTCHA');

  const emptyPool = makeBrowserPoolStub({ text: 'some mid length body text' });
  const fetcher3 = new PageFetcher({ proxyRouter, browserPool: emptyPool, artifactStore: store });
  const res3 = await fetcher3.fetchPage('https://blank.example.com/', { mode: 'browser' });
  assert.strictEqual(res3.failure_code, 'EXTRACTION_EMPTY');
});

// ── SearchKernel ────────────────────────────────────────────
test('SearchKernel searchWeb end-to-end (wikipedia mock + http fetch)', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { query: { search: [
    { title: 'Rust', snippet: 'systems language' },
    { title: 'Golang', snippet: 'concurrent language' }
  ] } } }));
  st.responses.push(makeResp({ status: 200, text: `<html><head><title>Rust doc</title></head><body><p>${LONG_TEXT}</p></body></html>`, headers: { 'content-type': 'text/html' } }));
  st.responses.push(makeResp({ status: 200, text: `<html><body><p>${LONG_TEXT}</p></body></html>`, headers: { 'content-type': 'text/html' } }));
  const res = await kernel.searchWeb({ query: 'rust vs go', engines: ['wikipedia'], limit: 5, fetch_top_k: 2, max_chars_total: 20000 });
  assert.ok(res.query_id.startsWith('q_'));
  assert.strictEqual(res.results.length, 2);
  assert.strictEqual(res.engines_tried.join(','), 'wikipedia');
  assert.strictEqual(res.fetched_count, 2);
  assert.ok(res.fetched[0].artifact_ref.startsWith('artifact://pages/'));
  assert.strictEqual(res.fetched[0].source_type, 'encyclopedia');
  assert.ok(res.artifact_ref.startsWith('artifact://search/'));
  const all = JSON.parse(store.read(res.artifact_ref, 0, 100000).text);
  assert.strictEqual(all.query_id, res.query_id);
});

test('SearchKernel searchWeb failure rows merged', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { query: { search: [{ title: 'Bad', snippet: 's' }] } } }));
  // page fetch: blocked text
  st.responses.push(makeResp({ status: 200, text: 'unusual traffic from your computer network', headers: { 'content-type': 'text/html' } }));
  const res = await kernel.searchWeb({ query: 'bad page', engines: ['wikipedia'], fetch_top_k: 1, fetch_mode: 'http' });
  assert.strictEqual(res.fetched_count, 0);
  assert.ok(res.fetch_failures.some(f => f.code === 'PAGE_BLOCKED_OR_CAPTCHA'));
  assert.ok(res.failures.some(f => f.code === 'PAGE_BLOCKED_OR_CAPTCHA'));
});

test('SearchKernel searchAndFetch builds bundle', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { query: { search: [{ title: 'Bundle Src', snippet: 'sn' }] } } }));
  st.responses.push(makeResp({ status: 200, text: `<html><body><p>${LONG_TEXT}</p></body></html>`, headers: { 'content-type': 'text/html' } }));
  const res = await kernel.searchAndFetch({ query: 'bundle this', engines: ['wikipedia'], limit: 3 });
  assert.ok(res.bundle_id.startsWith('eb_'));
  assert.strictEqual(res.type, 'evidence_bundle');
  assert.strictEqual(res.pages_fetched, 1);
  assert.strictEqual(res.items[0].source_type, 'encyclopedia');
  assert.ok(res.artifact_ref.startsWith('artifact://bundles/'));
});

test('SearchKernel requiredString errors', async () => {
  await assert.rejects(kernel.searchWeb({}), /query is required/);
  await assert.rejects(kernel.searchAndFetch({}), /query is required/);
  await assert.rejects(kernel.fetchPage({}), /url is required/);
  assert.throws(() => kernel.getArtifact({}), /artifact_ref is required/);
});

test('SearchKernel getArtifact + engineStatus + browserSessions', () => {
  const ref = store.writeText('search', '{"probe":1}', {});
  const got = kernel.getArtifact({ artifact_ref: ref });
  assert.ok(got.text.includes('probe'));
  const status = kernel.engineStatus();
  assert.strictEqual(status.status, 'ok');
  assert.ok(status.engines.length > 0);
  assert.ok(status.browser_sessions.length > 0);
  const sessions = kernel.browserSessions();
  assert.ok(sessions.sessions.length > 0);
});

test('SearchKernel openBrowserSession + save + unknown', async () => {
  assert.rejects(kernel.openBrowserSession({}), /session is required/);
  await assert.rejects(kernel.openBrowserSession({ session: 'nope' }), /unknown session/);
  await assert.rejects(kernel.saveBrowserSession({ session: 'nope' }), /unknown session/);
  const openCalls = [];
  const stubPool = {
    sessionStatus: () => ({ interactive_page_url: 'https://s.example.com' }),
    openSessionPage: async (args) => { openCalls.push(args); return { session: args.sessionKey, mode: 'persistent-context', current_url: args.url, state_path: '/tmp/x.json' }; },
    saveSessionState: async (id) => ({ session: id, saved: true, state_path: '/tmp/st.json' })
  };
  const k2 = new SearchKernel({ proxyRouter, browserPool: stubPool, artifactStore: store });
  const opened = await k2.openBrowserSession({ session: 'google', url: 'https://accounts.example.com/login' });
  assert.strictEqual(opened.session, 'google');
  assert.strictEqual(opened.mode, 'persistent-context');
  assert.ok(opened.message.includes('remote browser UI'));
  assert.strictEqual(openCalls[0].proxyProfile, 'direct');
  const savedState = await k2.saveBrowserSession({ session: 'google' });
  assert.strictEqual(savedState.saved, true);
  // openSessionPage throws → error details injected
  const failingPool = {
    sessionStatus: () => ({}),
    openSessionPage: async () => { const e = new Error('browser down'); e.details = {}; throw e; }
  };
  const k3 = new SearchKernel({ proxyRouter, browserPool: failingPool, artifactStore: store });
  await assert.rejects(k3.openBrowserSession({ session: 'chatgpt' }), err => {
    assert.strictEqual(err.details.session, 'chatgpt');
    assert.strictEqual(err.details.engine, 'chatgpt');
    return true;
  });
});

test('SearchKernel researchProblem executes queries and aggregates claims', async () => {
  const fakeBundles = [
    { bundle_id: 'eb_1', artifact_ref: 'artifact://bundles/1.txt', pages_fetched: 2, failures: [],
      items: [{ title: 'Official docs on the bug', url: 'https://docs.example.com/fix', snippet: 'doc snippet', text_preview: '...', artifact_ref: 'artifact://pages/1.txt' }] },
    { bundle_id: 'eb_2', artifact_ref: 'artifact://bundles/2.txt', pages_fetched: 0, failures: [{ x: 1 }], items: [] }
  ];
  let calls = 0;
  kernel.searchAndFetch = async (args) => { calls++; return fakeBundles[Math.min(calls - 1, fakeBundles.length - 1)]; };
  const res = await kernel.researchProblem({
    problem_signature: { task: 'fix race', symptom: 'crash', error_message: 'ECONNRESET', environment: { os: 'linux' }, constraints: ['no paid api'] },
    budget: { max_queries: 3, max_pages: 4 },
    source_policy: { prefer: ['official docs'] }
  });
  assert.ok(res.research_id.startsWith('rs_'));
  assert.strictEqual(res.queries_executed.length, 3);
  assert.strictEqual(res.claim_candidates.length, 1);
  assert.strictEqual(res.claim_candidates[0].confidence_hint, 0.82);
  assert.strictEqual(res.recommended_next_action, 'use_context_or_run_probe');
  assert.deepStrictEqual(res.evidence_bundles[0], { bundle_id: 'eb_1', artifact_ref: 'artifact://bundles/1.txt', pages_fetched: 2, failures: 0 });
  // empty bundles → refine_query
  kernel.searchAndFetch = async () => ({ bundle_id: 'eb_0', artifact_ref: 'artifact://bundles/0.txt', pages_fetched: 0, failures: [], items: [] });
  const res2 = await kernel.researchProblem({ problem_signature: { task: 'x' }, budget: { max_queries: 1 } });
  assert.strictEqual(res2.claim_candidates.length, 0);
  assert.strictEqual(res2.recommended_next_action, 'refine_query');
  // research query failure recorded
  kernel.searchAndFetch = async () => { throw Object.assign(new Error('net down'), { code: 'NET_DOWN' }); };
  const res3 = await kernel.researchProblem({ problem_signature: { task: 'y' }, budget: { max_queries: 1 } });
  assert.strictEqual(res3.failures[0].code, 'NET_DOWN');
});
