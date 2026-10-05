// Client-side cancellation on the plain HTTP endpoints. A search that keeps
// running after the caller hung up holds an engine and (on a small host) the one
// browser page slot that the next client needs, so /search, /fetch_page,
// /search_and_fetch and /research_problem must propagate an AbortSignal that
// fires on socket close -- and must NOT fire it after a normal response.
process.env.RATE_LIMIT_MAX_REQUESTS = '5000';
process.env.RATE_LIMIT_WINDOW_MS = '600000';

import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PageFetcher } from '../src/fetch/pageFetcher.js';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';
import { SearchKernel } from '../src/kernel/searchKernel.js';
import { DeepResearchKernel } from '../src/research/deepResearchKernel.js';
import { createApp } from '../src/http_server.js';

const artifactStore = new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-artifacts-')));

function makeKernel() {
  return {
    engineStatus: async () => ({ engines: [] }),
    browserSessions: async () => ({ sessions: [] }),
    openBrowserSession: async () => ({}),
    saveBrowserSession: async () => ({}),
    searchWeb: async () => ({ results: [] }),
    fetchPage: async () => ({ status: 'success' }),
    searchAndFetch: async () => ({ items: [] }),
    researchProblem: async () => ({}, {}),
    getArtifact: () => ({ text: 'x' }),
    browserPool: null
  };
}

function listenServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverClose(server) {
  return new Promise(resolve => server.close(resolve));
}

function postRequest(port, pathname, body) {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
  }, () => {});
  const settled = new Promise(resolve => {
    req.on('response', res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', err => resolve({ error: err.code || err.message }));
  });
  req.write(payload);
  req.end();
  return { req, settled };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('search routes receive an AbortSignal that survives a normal response', async () => {
  const kernel = makeKernel();
  const seen = {};
  kernel.searchWeb = async (args) => {
    seen.signal = args.signal;
    return { results: [], query_id: 'q_1' };
  };
  kernel.searchAndFetch = async (args) => {
    seen.bundleSignal = args.signal;
    return { items: [] };
  };
  const { app } = createApp(kernel);
  const server = await listenServer(app);
  try {
    const port = server.address().port;
    const search = await postRequest(port, '/search', { query: 'plain' }).settled;
    assert.equal(search.status, 200);
    assert.equal(seen.signal instanceof AbortSignal, true, 'kernel did not get an AbortSignal');
    assert.equal(seen.signal.aborted, false, 'signal aborted after a completed response');

    const bundle = await postRequest(port, '/search_and_fetch', { query: 'bundle' }).settled;
    assert.equal(bundle.status, 200);
    assert.equal(seen.bundleSignal instanceof AbortSignal, true);
    assert.equal(seen.bundleSignal.aborted, false);
  } finally {
    await serverClose(server);
  }
});

// Regression guard. An IncomingMessage is auto-destroyed as soon as its body has
// been read, so req.destroyed is true in every async handler. The error paths
// used to treat that as "the caller hung up" and swallowed the response, which
// turned every engine failure into a client-side hang until timeout.
test('a failure after an await still answers instead of hanging', async () => {
  const kernel = makeKernel();
  kernel.searchWeb = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const err = new Error('engine exploded');
    err.code = 'ENGINE_TIMEOUT';
    throw err;
  };
  const { app } = createApp(kernel);
  const server = await listenServer(app);
  try {
    const port = server.address().port;
    const search = JSON.parse((await postRequest(port, '/search', { query: 'boom' }).settled).data);
    assert.equal(search.ok, false);
    assert.equal(search.error.code, 'ENGINE_TIMEOUT');

    const mcp = await postRequest(port, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_web', arguments: { query: 'boom' } }
    }).settled;
    assert.equal(mcp.status, 500);
    assert.equal(JSON.parse(mcp.data).error.message, 'engine exploded');
  } finally {
    await serverClose(server);
  }
});

test('a client that hangs up cancels the running engine work', async () => {
  const kernel = makeKernel();
  let seenSignal = null;
  let settled = false;
  kernel.searchWeb = async (args) => {
    seenSignal = args.signal;
    return await new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => {
        settled = true;
        reject(Object.assign(new Error('search cancelled'), { code: 'ABORTED' }));
      }, { once: true });
    });
  };
  const { app } = createApp(kernel);
  const server = await listenServer(app);
  try {
    const port = server.address().port;
    const { req, settled: response } = postRequest(port, '/search', { query: 'never finished' });
    assert.equal(await waitFor(() => seenSignal instanceof AbortSignal), true, 'kernel never started');
    assert.equal(seenSignal.aborted, false, 'cancelled while the client was still connected');

    req.destroy();
    await response;

    assert.equal(await waitFor(() => seenSignal.aborted), true, 'engine kept running after disconnect');
    assert.equal(settled, true, 'the kernel promise was never rejected with the cancellation');
    // The abandoned route must not try to write to a dead socket nor kill the server.
    const healthy = await new Promise(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', () => resolve(0));
    });
    assert.equal(healthy, 200);
  } finally {
    await serverClose(server);
  }
});

function fetchStubPool(text) {
  return {
    seen: [],
    async withPage(opts, fn) {
      this.seen.push(opts);
      if (opts.signal?.aborted) {
        throw Object.assign(new Error('task aborted by caller'), { code: 'ABORTED' });
      }
      return {
        status: 'success', url: opts.url, title: 'Stub', text_preview: text, text_chars: text.length,
        artifact_ref: null, fetch_mode: 'browser', attempt: { mode: 'browser', status: 'success' }
      };
    }
  };
}

const proxyRouter = {
  resolve: () => ({ proxyUrl: null, profile: 'direct' }),
  resolveForEngine: () => ({ proxyUrl: null, profile: 'direct' }),
  status: () => ({ profiles: {}, engine_proxies: {} })
};

test('browser fetch forwards the caller signal to the page slot', async () => {
  const pool = fetchStubPool('f'.repeat(100));
  const fetcher = new PageFetcher({ proxyRouter, browserPool: pool, artifactStore: { writeText: () => 'artifact://x' } });
  const controller = new AbortController();
  const result = await fetcher.fetchPage('https://example.com/slow', { mode: 'browser', signal: controller.signal });
  assert.equal(result.status, 'success');
  assert.equal(pool.seen.length, 1);
  assert.equal(pool.seen[0].signal, controller.signal);
});

test('an already cancelled fetch never touches the browser pool', async () => {
  const pool = fetchStubPool('unused');
  const fetcher = new PageFetcher({ proxyRouter, browserPool: pool, artifactStore: { writeText: () => 'artifact://x' } });
  const controller = new AbortController();
  controller.abort('HTTP client disconnected');
  const result = await fetcher.fetchPage('https://example.com/late', { mode: 'browser', signal: controller.signal });
  assert.equal(result.failure_code, 'ABORTED');
  assert.equal(result.status, 'failed');
  assert.equal(pool.seen.length, 0, 'a cancelled fetch still opened a browser page');
});

test('a non-signal signal field is ignored', async () => {
  const pool = fetchStubPool('ok ok ok');
  const fetcher = new PageFetcher({ proxyRouter, browserPool: pool, artifactStore: { writeText: () => 'artifact://x' } });
  const result = await fetcher.fetchPage('https://example.com/junk', { mode: 'browser', signal: 'not-a-signal' });
  assert.equal(result.status, 'success');
  assert.equal(pool.seen[0].signal, null);
});

test('the legacy /mcp JSON-RPC endpoint cancels a dropped tools/call', async () => {
  const kernel = makeKernel();
  let seenSignal = null;
  kernel.searchWeb = async (args) => {
    seenSignal = args.signal;
    return await new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('search cancelled'), { code: 'ABORTED' }));
      }, { once: true });
    });
  };
  const { app } = createApp(kernel);
  const server = await listenServer(app);
  try {
    const port = server.address().port;
    const { req, settled: response } = postRequest(port, '/mcp', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_web', arguments: { query: 'hang up' } }
    });
    assert.equal(await waitFor(() => seenSignal instanceof AbortSignal), true, 'tools/call never started');
    assert.equal(seenSignal.aborted, false, 'cancelled while the client was connected');
    req.destroy();
    await response;
    assert.equal(await waitFor(() => seenSignal.aborted), true, 'the JSON-RPC search outlived its client');
  } finally {
    await serverClose(server);
  }
});

function researchKernel(searchAndFetch) {
  const kernel = new SearchKernel({
    proxyRouter,
    browserPool: { sessionStatus: () => ({}), listSessions: () => [] },
    artifactStore
  });
  kernel.searchAndFetch = searchAndFetch;
  return kernel;
}

const PROBLEM = { problem_signature: { task: 'fix search', symptom: 'page queue full', error_message: 'PAGE_BUSY' } };

test('multi-query research stops issuing queries once the caller cancels', async () => {
  const controller = new AbortController();
  const seen = [];
  const kernel = researchKernel(async (args) => {
    seen.push(args.query);
    controller.abort('caller went away');
    return { items: [], bundle_id: 'eb_1', pages_fetched: 0, failures: [] };
  });
  const result = await kernel.researchProblem({ ...PROBLEM, budget: { max_queries: 4, max_pages: 8 }, signal: controller.signal });
  assert.equal(seen.length, 1, 'a second query was queued after the cancel');
  assert.ok(result.failures.some(f => f.code === 'ABORTED'), 'cancellation was not reported in failures');
});

test('research with an already cancelled signal does no searches at all', async () => {
  const seen = [];
  const kernel = researchKernel(async (args) => {
    seen.push(args.query);
    return { items: [], bundle_id: 'eb_1', pages_fetched: 0, failures: [] };
  });
  const controller = new AbortController();
  controller.abort('too late');
  const result = await kernel.researchProblem({ ...PROBLEM, budget: { max_queries: 4 }, signal: controller.signal });
  assert.deepStrictEqual(seen, []);
  assert.ok(result.failures.some(f => f.code === 'ABORTED'));
});

test('deep research forwards the signal and stops its web loop', async () => {
  const controller = new AbortController();
  const signals = [];
  const deep = new DeepResearchKernel({
    searchKernel: {
      searchAndFetch: async (args) => {
        signals.push(args.signal);
        controller.abort('client gone');
        return { items: [], pages_fetched: 0 };
      }
    }
  });
  const result = await deep.researchDeep({ question: 'why is the page queue full', signal: controller.signal });
  assert.equal(signals.length, 1, 'deep research kept searching after the cancel');
  assert.equal(signals[0], controller.signal, 'the signal did not reach the search');
  assert.ok(result.failures.some(f => f.code === 'ABORTED'));
});

test('engine_status exposes the page pool and degrades to null without it', () => {
  const base = {
    engines: { list: () => [] },
    proxyRouter: { status: () => ({ profiles: {} }) }
  };
  const withStatus = SearchKernel.prototype.engineStatus.call({
    ...base,
    browserPool: { sessionStatus: () => ({}), pageQueueStatus: () => ({ active_pages: 1, max_pages: 1 }) }
  });
  assert.deepStrictEqual(withStatus.page_pool, { active_pages: 1, max_pages: 1 });

  const legacyPool = SearchKernel.prototype.engineStatus.call({
    ...base,
    browserPool: { sessionStatus: () => ({}) }
  });
  assert.equal(legacyPool.page_pool, null);
});
