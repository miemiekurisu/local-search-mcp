process.env.DEEPSEEK_VALIDATE = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { undiciState, makeResp } from './helpers/mocks.mjs';

const st = undiciState();
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-edges-'));
const { ArtifactStore } = await import('../src/artifacts/artifactStore.js');
const { SearchKernel } = await import('../src/kernel/searchKernel.js');
const { DeepResearchKernel } = await import('../src/research/deepResearchKernel.js');

const store = new ArtifactStore(baseDir);
const proxyRouter = {
  resolve: () => ({ proxyUrl: null, profile: 'direct' }),
  resolveForEngine: () => ({ proxyUrl: null, profile: 'direct' }),
  status: () => ({ profiles: {}, engine_proxies: {} })
};
const kernel = new SearchKernel({
  proxyRouter,
  browserPool: {
    sessionStatus: () => ({}),
    withPage: async (opts, fn) => fn({
      goto: async () => {},
      waitForTimeout: async () => {},
      route: async () => {},
      unroute: async () => {},
      evaluate: async () => 'wiki '.repeat(40) + 'substantial page body text for extraction',
      title: async () => 'Stub Page Title',
      isClosed: () => false,
      close: async () => {},
      content: async () => '<html><div class="result"><a class="result__a" href="https://aa.example.com/1">Ddg Title</a><div class="result__snippet">ddg snippet</div></div></html>'
    })
  },
  artifactStore: store
});

const wikiFeed = (entries) => ({ json: { query: { search: entries } } });

test('searchWeb engines default+other merges defaults with extras and classifies sources', async () => {
  st.responses = [
    makeResp(wikiFeed([{ title: 'Rust lang', snippet: 'systems' }])),
    makeResp({ status: 200, text: '<html><body>plenty of body text for the fetch path ' + 'z'.repeat(120) + '</body></html>', headers: { 'content-type': 'text/html' } })
  ];
  const out = await kernel.searchWeb({ query: 'edge stuff', engines: ['default', 'wikipedia'], fetch_top_k: 2 });
  assert.ok(out.engines_tried.includes('duckduckgo'), `tried: ${out.engines_tried}`);
  assert.ok(out.engines_tried.includes('wikipedia'));
  assert.ok(out.results.length >= 2, `results: ${JSON.stringify(out.results)} failures: ${JSON.stringify(out.failures)}`);
  assert.ok(out.fetched.some(f => f.source_type === 'encyclopedia'), `fetched: ${JSON.stringify(out.fetched)} fetchfail: ${JSON.stringify(out.fetch_failures)}`);
  assert.ok(out.fetched.every(f => f.source_type), 'all fetched classified');
});

test('searchWeb fetch failures are captured when fetchPage throws', async () => {
  st.responses = [makeResp(wikiFeed([{ title: 'Rust lang', snippet: 'systems' }]))];
  const originalFetchPage = kernel.fetchPage;
  kernel.fetchPage = async () => {
    const err = new Error('kaboom while fetching');
    err.code = 'KABOOM';
    throw err;
  };
  try {
    const out = await kernel.searchWeb({ query: 'fetch failing query', engines: ['wikipedia'], fetch_top_k: 1 });
    assert.equal(out.fetch_failures.length, 1, JSON.stringify(out.fetch_failures));
    assert.equal(out.fetch_failures[0].code, 'KABOOM');
    assert.equal(out.fetch_failures[0].engine, 'wikipedia');
    assert.equal(out.fetch_failures[0].message, 'kaboom while fetching');
    assert.equal(out.fetched_count, 0);
  } finally {
    kernel.fetchPage = originalFetchPage;
  }
});

test('searchWeb pre-fetch deadline produces FETCH_TIMEOUT rows', async () => {
  st.responses = [makeResp(wikiFeed([{ title: 'Rust lang', snippet: 'systems' }]))];
  const realNow = Date.now.bind(Date);
  let shifted = false;
  Date.now = () => {
    const real = realNow();
    if (shifted) return real + 70000;
    shifted = true;
    return real;
  };
  try {
    const out = await kernel.searchWeb({ query: 'deadline jump', engines: ['wikipedia'], fetch_top_k: 1 });
    assert.ok(out.fetch_failures.some(f => f.code === 'FETCH_TIMEOUT'), JSON.stringify(out.fetch_failures));
  } finally {
    Date.now = realNow;
  }
});

test('researchProblem budget timeout pushes RESEARCH_TIMEOUT immediately', async () => {
  st.responses = [];
  const out = await kernel.researchProblem({
    problem_signature: { task: 'investigate crash', error_message: 'boom' },
    budget: { max_queries: 3, timeout_ms: -1 }
  });
  assert.deepEqual(out.evidence_bundles, []);
  assert.ok(out.failures.some(f => f.code === 'RESEARCH_TIMEOUT'), JSON.stringify(out.failures));
  assert.equal(out.recommended_next_action, 'refine_query');
});

test('researchProblem queries run and claims get confidence hints + fallback source', async () => {
  st.responses = [
    makeResp(wikiFeed([{ title: 'crash loop worker', snippet: 'fix by config' }])),
    makeResp({ status: 200, text: '<html><body>full page text body ' + 'q'.repeat(150) + '</body></html>', headers: { 'content-type': 'text/html' } })
  ];
  const out = await kernel.researchProblem({
    problem_signature: { task: 'debug crash loop in worker' },
    source_policy: { prefer: ['github issues'] },
    budget: { max_queries: 2, max_pages: 2 }
  });
  assert.ok(out.queries_executed.length <= 2);
  const claim = (out.claim_candidates || [])[0];
  assert.ok(claim, JSON.stringify(out.claim_candidates));
  assert.equal(claim.confidence_hint, 0.48);
});

test('openBrowserSession injects details and saveBrowserSession validates/merges', async () => {
  await assert.rejects(() => kernel.saveBrowserSession({}), /session is required/);
  await assert.rejects(() => kernel.saveBrowserSession({ session: 'ghost-session-id' }), /unknown session/);

  const poolSaveDead = {
    sessionStatus: () => ({ keepalive: true }),
    saveSessionState: async () => { const e = new Error('save dead'); e.code = 'SAVE_DEAD'; throw e; },
    openSessionPage: async () => ({ ok: true })
  };
  const k2 = new SearchKernel({ proxyRouter, browserPool: poolSaveDead, artifactStore: store });

  await assert.rejects(() => k2.saveBrowserSession({ session: 'chatgpt' }), (err) => {
    assert.equal(err.code, 'SAVE_DEAD');
    assert.equal(err.details.session, 'chatgpt');
    assert.equal(err.details.engine, 'chatgpt');
    assert.deepEqual(err.details.browser_session, { keepalive: true });
    return true;
  });

  const k3 = new SearchKernel({
    proxyRouter,
    browserPool: { sessionStatus: (id, o) => ({ id, redact: o?.redact }), openSessionPage: async () => { throw new Error('open dead'); } },
    artifactStore: store
  });
  await assert.rejects(() => k3.openBrowserSession({ session: 'chatgpt', url: 'https://target.example.com/login' }), (err) => {
    assert.equal(err.message, 'open dead');
    assert.equal(err.details.target_url, 'https://target.example.com/login');
    assert.deepEqual(err.details.browser_session, { id: 'chatgpt', redact: undefined });
    return true;
  });

  const openOk = await k2.openBrowserSession({ session: 'chatgpt' });
  assert.equal(openOk.message.includes('remote browser UI'), true);
  assert.equal(openOk.engine, 'chatgpt');

  const poolSaveOk = {
    sessionStatus: () => ({}),
    saveSessionState: async () => ({ saved: true, closed_pages: 2 })
  };
  const k4 = new SearchKernel({ proxyRouter, browserPool: poolSaveOk, artifactStore: store });
  const saveOk = await k4.saveBrowserSession({ session: 'chatgpt' });
  assert.equal(saveOk.saved, true);
});

test('getArtifact requires a string ref', async () => {
  await assert.rejects(async () => kernel.getArtifact({}), /artifact_ref is required/);
  const ref = store.writeText('bundles', 'artifact body padded content', { kind: 'x' });
  const got = await kernel.getArtifact({ artifact_ref: ref, limit: 10 });
  assert.ok(got.text.includes('artifact'));
});

test('deepResearch records fulltext/citation failures and merge stats', async () => {
  let contentCalls = 0;
  const contentKernel = {
    async fetchContent({ identifier }) {
      contentCalls++;
      if (contentCalls === 1) throw new Error('content exploded');
      if (contentCalls === 2) return { error: 'No open access locations found' };
      return {
        cached: false, source: 'arxiv', source_url: 'https://arxiv.org/pdf/1',
        variant: 'raw/xml', mime_type: 'text/xml', size_bytes: 900, content_hash: 'abc',
        fullText: 'word '.repeat(120), wordCount: 240,
        sections: [{ heading: 'Methods', text: 'step one ' + 'x'.repeat(60) }],
        chunks: [{ index: 0, text: 'chunk text here padded ' + 'y'.repeat(40) }]
      };
    }
  };
  const paperKernel = {
    async searchPapers({ query }) {
      return {
        query_id: 'pq_1',
        papers: [
          { doi: '10.1111/alpha-doi', title: 'Sparsity methods for attention', abstract: 'x'.repeat(90), year: 2024, citation_count: 9 },
          { doi: '10.1111/beta-doi', title: 'Prompt compression study', abstract: 'p'.repeat(90), year: 2023, citation_count: 4 },
          { doi: '10.1111/gamma-doi', title: 'Quantization tradeoff analysis', abstract: 'g'.repeat(90), year: 2022, citation_count: 2 }
        ],
        sources_tried: ['openalex'],
        failures: []
      };
    },
    async expandPaperCitations() {
      const err = new Error('expand failed hard');
      err.status = 'SS_TIMEOUT';
      throw err;
    }
  };
  const searchKernel = {
    async searchAndFetch({ query }) {
      return {
        bundle_id: 'eb_1',
        items: [{ title: 'web result title is long enough here', snippet: 'some snippet text that is also long enough', url: 'https://blog.example.com/post/1', host: 'blog.example.com', artifact_ref: null, text_preview: '' }],
        search_artifact_ref: null,
        pages_fetched: 1
      };
    }
  };
  const dr = new DeepResearchKernel({ paperKernel, paperContentKernel: contentKernel, searchKernel });
  const out = await dr.researchDeep({
    question: 'How do sparsity methods impact attention efficiency?',
    budget: { web_queries: 1, paper_queries: 1, max_citation_expansions: 1, max_fulltext_papers: 3 },
    source_policy: { fetch_fulltext: true },
    domain: 'ai_ml'
  });
  assert.ok(out.failures.some(f => f.type === 'citation'), JSON.stringify(out.failures));
  assert.equal(contentCalls, 3, 'three fulltext calls');
  const statuses = out.fulltext_results.map(r => r.status);
  assert.deepEqual(statuses, ['error', 'failed', 'success']);
  assert.equal(out.fulltext_results[0].error, 'content exploded');
  assert.equal(out.fulltext_results[1].error, 'No open access locations found');
  assert.equal(out.fulltext_results[2].sections.length, 1);
  const paperClaim = (out.key_claim_candidates || []).find(c => c.source_type === 'paper' && c.supporting_sources[0].doi === '10.1111/gamma-doi');
  assert.ok(paperClaim, JSON.stringify(out.key_claim_candidates));
  assert.equal(paperClaim.fulltext_fetched, true);
  assert.equal(paperClaim.has_sections, true);
  assert.ok(paperClaim.claim.startsWith('[FULLTEXT]'));
  assert.ok(Array.isArray(out.contradiction_candidates) && Array.isArray(out.uncertainty_notes));
  assert.equal(out.fulltext_results[2].source_url, 'https://arxiv.org/pdf/1');
});

test('deepResearch confidence default branch for unknown hosts', async () => {
  st.responses = [
    makeResp({ status: 200, text: '<html><div class="result"><a class="result__a" href="https://mystery-zone.example.net/x">Mystery page</a></div></html>', headers: { 'content-type': 'text/html' } }),
    makeResp(wikiFeed([{ title: 'wiki entry', snippet: 'wiki text' }])),
    makeResp({ status: 200, text: '<html><body>some page body content ' + 'm'.repeat(120) + '</body></html>', headers: { 'content-type': 'text/html' } })
  ];
  const searchKernel = {
    async searchAndFetch() {
      return {
        bundle_id: 'eb_2',
        items: [{ title: 'some odd web page title long enough', snippet: 'mystery host snippet text also long', url: 'https://mystery-zone.example.net/x', host: 'mystery-zone.example.net', artifact_ref: null, text_preview: '' }],
        search_artifact_ref: null,
        pages_fetched: 1
      };
    }
  };
  const dr = new DeepResearchKernel({ searchKernel });
  const out = await dr.researchDeep({ question: 'unknown host confidence check?' });
  const webClaim = (out.key_claim_candidates || []).find(c => c.source_type === 'web');
  assert.ok(webClaim);
  assert.equal(webClaim.confidence_hint, 0.55);
});
