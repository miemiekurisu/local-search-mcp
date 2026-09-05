process.env.RATE_LIMIT_MAX_REQUESTS = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.TRUST_PROXY = '1';
process.env.MCP_BEARER_TOKEN = 'secret-token';
process.env.ARTIFACT_DIR = new URL('./uc-server-artifacts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.BROWSER_STATE_DIR = new URL('./uc-server-state/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const stFetch = (await import('./helpers/mocks.mjs')).undiciState();

const { createApp } = await import('../src/http_server.js');

function makeKernel(over = {}) {
  const calls = {};
  const defaults = {
    engineStatus: async (a) => { calls.engineStatus = a; return { engines: [{ id: 'wikipedia', ok: true }], browser_status: 'closed' }; },
    browserSessions: async (a) => { calls.browserSessions = a; return { sessions: [] }; },
    openBrowserSession: async (a) => { calls.open = a; return { session_id: 's1' }; },
    saveBrowserSession: async (a) => { calls.save = a; return { saved: true, ...a }; },
    searchWeb: async (a) => { calls.search = a; return { items: [{ title: 'T' }], query: a.query }; },
    fetchPage: async (a) => { calls.fetchPage = a; return { url: a.url, text: 'page text' }; },
    searchAndFetch: async (a) => { calls.searchAndFetch = a; return { bundle_id: 'eb_1', items: [] }; },
    researchProblem: async (a) => { calls.research = a; return { task: a.problem_signature.task, candidates: 0 }; },
    getArtifact: (a) => { calls.artifact = a; return { artifact_ref: a.artifact_ref, text: 'chunk', offset: 0 }; },
    browserPool: null
  };
  for (const [k, fn] of Object.entries(over)) {
    const sync = k === 'getArtifact';
    defaults[k] = async (a) => {
      calls[k] = a;
      return sync ? fn(a) : await fn(a);
    };
  }
  return { stub: defaults, calls };
}

function start(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function close(server) {
  await new Promise(r => server.close(r));
}

const jsonHeaders = { 'content-type': 'application/json', authorization: 'Bearer secret-token' };

let xffCounter = 0;
function hdrs(extra = {}) {
  xffCounter += 1;
  return { ...jsonHeaders, 'x-forwarded-for': `198.51.100.${xffCounter}`, ...extra };
}

test('health + rate limit + trust proxy separation', async () => {
  const { stub, calls } = makeKernel();
  const { app } = createApp(stub, {});
  const server = await start(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r1 = await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });
    assert.equal(r1.headers.get('x-ratelimit-limit'), '2');
    assert.equal(r1.headers.get('x-ratelimit-remaining'), '1');

    const r2 = await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(r2.headers.get('x-ratelimit-remaining'), '0');
    const r3 = await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(r3.status, 429);
    const b3 = await r3.json();
    assert.equal(b3.error.code, 'RATE_LIMITED');
    assert.ok(Number(r3.headers.get('retry-after')) >= 1);

    const r4 = await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '198.51.100.8' } });
    assert.equal(r4.status, 200, 'different forwarded ip has its own bucket');

    const r5 = await fetch(`${base}/engine_status`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(r5.status, 401);
    assert.equal((await r5.json()).error.code, 'UNAUTHORIZED');

    const r6 = await fetch(`${base}/engine_status`, { headers: hdrs() });
    assert.equal(r6.status, 200);
    assert.deepEqual(await r6.json(), { ok: true, result: { engines: [{ id: 'wikipedia', ok: true }], browser_status: 'closed' } });
  } finally {
    await close(server);
  }
});

test('post routes pass body to kernel and wrap errors with redaction', async () => {
  const makeErr = () => {
    const err = new Error('engine exploded');
    err.code = 'ENGINE_HTTP_ERROR';
    err.engine = 'bing';
    err.details = {
      browser_session: { cdp_url: 'http://secret:9222', state_path: 'C:/secret', visible_browser_profile_dir: 'C:/prof', keep_page_open: true },
      attempt: 2
    };
    err.stack = 'STACKTRACE';
    return err;
  };
  const { stub, calls } = makeKernel({
    searchWeb: async (a) => {
      if (a.query === 'boom') throw makeErr();
      return { items: [{ title: 'T' }], query: a.query };
    }
  });
  const { app } = createApp(stub, {});
  const server = await start(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/search`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ query: 'q1', limit: 3 }) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.deepEqual(okBody.result, { items: [{ title: 'T' }], query: 'q1' });
    assert.deepEqual(calls.searchWeb, { query: 'q1', limit: 3 });

    const research = await fetch(`${base}/research_problem`, {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({ problem_signature: { task: 'fix bug' }, budget: { max_queries: 2 } })
    });
    assert.deepEqual((await research.json()).result, { task: 'fix bug', candidates: 0 });

    const artifact = await fetch(`${base}/artifact?x=1`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ artifact_ref: 'artifact://search/s.txt' }) });
    assert.equal((await artifact.json()).result.text, 'chunk');

    let bad = await fetch(`${base}/search`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ query: 'boom' }) });
    assert.equal(bad.status, 500);
    let eb = await bad.json();
    assert.equal(eb.ok, false);
    assert.equal(eb.error.code, 'ENGINE_HTTP_ERROR');
    assert.equal(eb.error.engine, 'bing');
    assert.equal(eb.error.message, 'engine exploded');
    assert.equal(eb.error.stack, 'STACKTRACE');
    assert.equal(eb.error.details.browser_session.cdp_url, undefined);
    assert.equal(eb.error.details.browser_session.state_path, undefined);
    assert.equal(eb.error.details.browser_session.visible_browser_profile_dir, undefined);
    assert.equal(eb.error.details.browser_session.keep_page_open, true);
    assert.equal(eb.error.details.attempt, 2);

    process.env.NODE_ENV = 'production';
    try {
      bad = await fetch(`${base}/search`, { method: 'POST', headers: hdrs(), body: JSON.stringify({ query: 'boom' }) });
      eb = await bad.json();
      assert.equal(eb.error.stack, undefined);
    } finally {
      delete process.env.NODE_ENV;
    }

    const noArgs = await fetch(`${base}/browser_sessions/open`, { method: 'POST', headers: hdrs(), body: '{}' });
    assert.equal(noArgs.status, 200);
    assert.deepEqual((await noArgs.json()).result, { session_id: 's1' });
    assert.deepEqual(calls.open, {});
  } finally {
    await close(server);
  }
});

test('mcp jsonrpc custom endpoint', async () => {
  const { stub } = makeKernel();
  const { app } = createApp(stub, {});
  const server = await start(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}/mcp`;
    const res = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    const init = await res.json();
    assert.equal(init.result.serverInfo.name, 'local-search-mcp');
    assert.equal(init.result.protocolVersion, '2024-11-05');

    const toolsRes = await fetch(base, {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    const tools = (await toolsRes.json()).result.tools;
    assert.equal(tools.length, 8);
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'engine_status', 'fetch_page', 'get_artifact', 'get_time', 'get_weather',
      'research_problem', 'search_and_fetch', 'search_web'
    ]);

    const call = async (name, args) => {
      const r = await fetch(base, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })
      });
      return r;
    };
    const sw = await (await call('search_web', { query: 'x' })).json();
    assert.deepEqual(JSON.parse(sw.result.content[0].text), { items: [{ title: 'T' }], query: 'x' });

    const timeCall = await (await call('get_time', {})).json();
    assert.ok(timeCall.result.content[0].text.length > 10);

    const weather = await (await call('get_weather', { location: '' })).json();
    assert.equal(weather.result.isError, true);

    const artifact = await (await call('get_artifact', { artifact_ref: 'artifact://search/s.txt' })).json();
    assert.deepEqual(JSON.parse(artifact.result.content[0].text), { artifact_ref: 'artifact://search/s.txt', text: 'chunk', offset: 0 });

    const badTool = await (await call('nosuch', {})).json();
    assert.equal(badTool.error.code, -32601);
    assert.ok(badTool.error.message.includes('Method not found: nosuch'));

    const resources = await (await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }) })).json();
    assert.deepEqual(resources.result.resources, []);

    const unknownMethod = await (await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'bogus/method' }) })).json();
    assert.equal(unknownMethod.error.code, -32601);

    const invalid = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ id: 6 }) });
    assert.equal(invalid.status, 400);

    const failing = makeKernel({ searchWeb: async () => { throw new Error('mcp kaboom'); } });
    const { app: app2 } = createApp(failing.stub, {});
    const server2 = await start(app2);
    try {
      const base2 = `http://127.0.0.1:${server2.address().port}/mcp`;
      const errRes = await fetch(base2, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search_web', arguments: {} } })
      });
      assert.equal(errRes.status, 500);
      const eb = await errRes.json();
      assert.equal(eb.error.code, -32603);
      assert.equal(eb.error.message, 'mcp kaboom');
    } finally {
      await close(server2);
    }
  } finally {
    await close(server);
  }
});
