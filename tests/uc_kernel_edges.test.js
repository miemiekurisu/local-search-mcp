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
  // The kernel reads the clock twice per fetch round: once to arm the 60s deadline,
  // once to check it, so the jump has to land between those two reads. Counting
  // *every* Date.now() call (the old trick) puts the jump in the wrong place as soon
  // as an unrelated module reads the clock first -- publishing an engine budget is
  // enough -- so only reads issued directly by the kernel are counted. The direct
  // caller frame matters: the async stack still carries the kernel frame for reads
  // made deep inside an engine call (frame [0] is the Error, [1] this stub).
  let kernelReads = 0;
  Date.now = () => {
    const real = realNow();
    const caller = String(new Error().stack || '').split('\n')[2] || '';
    if (!caller.includes('searchKernel.js')) return real;
    kernelReads += 1;
    return kernelReads > 1 ? real + 70000 : real;
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
