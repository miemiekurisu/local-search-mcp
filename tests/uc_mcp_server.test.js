import './helpers/mcp_env.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';

function makeKernel(over = {}) {
  const calls = { statuses: [], releases: 0 };
  const stub = {
    searchWeb: async (a) => ({ items: [{ title: 'T1' }], query: a.query }),
    fetchPage: async (a) => ({ url: a.url, text: 'page text', artifact_ref: 'artifact://pages/p.txt' }),
    searchAndFetch: async (a) => ({ bundle_id: 'eb_x', query: a.query }),
    researchProblem: async (a) => ({ task: a.problem_signature.task }),
    getArtifact: (a) => ({ artifact_ref: a.artifact_ref, text: 'artifact chunk' }),
    engineStatus: async () => ({ engines: [{ id: 'wikipedia', ok: true }] })
  };
  for (const [k, fn] of Object.entries(over)) stub[k] = fn;
  const pool = {
    sessionStatus: (e) => { calls.statuses.push(e); return null; },
    releaseSearchResources: async () => { calls.releases += 1; }
  };
  return { kernel: stub, pool, calls };
}

async function connect(kernel, pool) {
  const server = createMcpServer(kernel, pool);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  async function close() {
    await client.close();
    await server.close();
  }
  return { client, close };
}

test('tools list has the 8 documented tools', async () => {
  const { kernel, pool } = makeKernel();
  const { client, close } = await connect(kernel, pool);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'engine_status', 'fetch_page', 'get_artifact', 'get_time', 'get_weather',
      'research_problem', 'search_and_fetch', 'search_web'
    ]);
  } finally {
    await close();
  }
});

test('search_web happy path and browser cleanup variants', async () => {
  const happy = makeKernel();
  {
    const { client, close } = await connect(happy.kernel, happy.pool);
    try {
      const r = await client.callTool({ name: 'search_web', arguments: { query: 'hello' } });
      assert.equal(r.isError, undefined);
      assert.deepEqual(JSON.parse(r.content[0].text), { items: [{ title: 'T1' }], query: 'hello' });
    } finally {
      await close();
    }
    assert.deepEqual(happy.calls.statuses, []);
    assert.equal(happy.calls.releases, 0, 'no browser engines -> no cleanup');
  }

  const interactive = makeKernel({
    searchWeb: async () => ({ items: [] })
  });
  interactive.pool.sessionStatus = (e) => {
    interactive.calls.statuses.push(e);
    return e === 'chatgpt' ? { interactive_page_url: 'https://chat' } : null;
  };
  {
    const { client, close } = await connect(interactive.kernel, interactive.pool);
    try {
      await client.callTool({ name: 'search_web', arguments: { query: 'q', engines: ['chatgpt'] } });
    } finally {
      await close();
    }
    assert.deepEqual(interactive.calls.statuses, ['chatgpt']);
    assert.equal(interactive.calls.releases, 0, 'interactive page kept');
  }

  const idle = makeKernel();
  {
    const { client, close } = await connect(idle.kernel, idle.pool);
    try {
      await client.callTool({ name: 'search_web', arguments: { query: 'q', engines: ['google', 'bing', 'unknown'] } });
    } finally {
      await close();
    }
    assert.equal(idle.calls.releases, 1, 'non-interactive browser engines release resources');
    assert.deepEqual(idle.calls.statuses, ['google', 'bing']);
  }
});

test('kernel errors become isError content with code details', async () => {
  const failing = makeKernel({
    searchWeb: async () => {
      const err = new Error('search blew up');
      err.code = 'X_EXT';
      err.details = { trace: 1 };
      throw err;
    }
  });
  const { client, close } = await connect(failing.kernel, failing.pool);
  try {
    const r = await client.callTool({ name: 'search_web', arguments: { query: 'x' } });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.includes('search blew up'));
    assert.ok(r.content[0].text.includes('"code": "X_EXT"'));
    assert.ok(r.content[0].text.includes('"trace": 1'));
  } finally {
    await close();
  }
});

test('search tool timeout produces error content', async () => {
  const slow = makeKernel({
    searchWeb: async () => new Promise(resolve => setTimeout(() => resolve({ items: [] }), 2000))
  });
  const { client, close } = await connect(slow.kernel, slow.pool);
  try {
    const r = await client.callTool({ name: 'search_web', arguments: { query: 'slow' } });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.includes('Timed out after 500ms'));
  } finally {
    await close();
  }
});

test('fetch_page, get_artifact, research_problem, engine_status passthrough', async () => {
  const k = makeKernel();
  const { client, close } = await connect(k.kernel, k.pool);
  try {
    const fp = await client.callTool({ name: 'fetch_page', arguments: { url: 'https://example.com/a' } });
    assert.ok(JSON.parse(fp.content[0].text).artifact_ref.startsWith('artifact://pages/'));

    const art = await client.callTool({ name: 'get_artifact', arguments: { artifact_ref: 'artifact://pages/p.txt', offset: 2 } });
    const artBody = JSON.parse(art.content[0].text);
    assert.equal(artBody.text, 'artifact chunk');
    assert.equal(artBody.artifact_ref, 'artifact://pages/p.txt');

    const rp = await client.callTool({ name: 'research_problem', arguments: { problem_signature: { task: 'fix' } } });
    assert.equal(JSON.parse(rp.content[0].text).task, 'fix');

    const es = await client.callTool({ name: 'engine_status', arguments: {} });
    assert.deepEqual(JSON.parse(es.content[0].text), { engines: [{ id: 'wikipedia', ok: true }] });

    const sf = await client.callTool({ name: 'search_and_fetch', arguments: { query: 'z', engines: ['google'] } });
    assert.equal(JSON.parse(sf.content[0].text).bundle_id, 'eb_x');
    assert.equal(k.calls.releases, 1, 'bundle path also releases');
  } finally {
    await close();
  }
});

test('tool schema validation rejects bad input', async () => {
  const k = makeKernel();
  const { client, close } = await connect(k.kernel, k.pool);
  const badArgs = async (name, args) => {
    let r;
    try {
      r = await client.callTool({ name, arguments: args });
    } catch (err) {
      assert.ok(err.code === -32602 || /invalid|too_small/i.test(String(err)));
      return;
    }
    assert.equal(r.isError, true, `${name} with bad args must fail`);
  };
  try {
    await badArgs('search_web', { query: '' });
    await badArgs('get_artifact', {});
    await badArgs('fetch_page', { url: 'not a url' });
    await badArgs('search_and_fetch', { query: 'x', fetch_top_k: 99 });
  } finally {
    await close();
  }
});

test('artifact resource and prompts readable', async () => {
  const k = makeKernel();
  const { client, close } = await connect(k.kernel, k.pool);
  try {
    const listed = await client.listResources();
    assert.deepEqual(listed.resources, []);

    const res = await client.readResource({ uri: 'artifact://search/s1.txt' });
    assert.equal(res.contents[0].text, 'artifact chunk');
    assert.equal(res.contents[0].uri, 'artifact://search/s1.txt');

    const prompt = await client.getPrompt({ name: 'search_and_summarize', arguments: { topic: 'wp plugins' } });
    assert.ok(prompt.messages[0].content.text.includes('wp plugins'));

    const dbg = await client.getPrompt({ name: 'debug_error', arguments: { error_message: 'ERR_X', environment: 'win11' } });
    assert.ok(dbg.messages[0].content.text.includes('ERR_X'));
    assert.ok(dbg.messages[0].content.text.includes('win11'));
  } finally {
    await close();
  }
});

test('get_weather surfaces results and errors from underlying weather module', async () => {
  const k = makeKernel();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('geocoding-api')) {
      return new Response(JSON.stringify({ results: [{ name: 'Berlin', latitude: 52.5, longitude: 13.4, country: 'Germany' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      latitude: 52.5, longitude: 13.4,
      current: { temperature_2m: 21, time: '2026-09-04T12:00' },
      daily: { time: ['2026-09-04'], temperature_2m_max: [25], temperature_2m_min: [14], weathercode: [0] },
      timezone: 'Europe/Berlin'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { client, close } = await connect(k.kernel, k.pool);
  try {
    const ok = await client.callTool({ name: 'get_weather', arguments: { location: 'Berlin' } });
    assert.equal(ok.isError, undefined, 'happy weather parse');
    assert.ok(ok.content[0].text.includes('Berlin'), ok.content[0].text.slice(0, 150));

    globalThis.fetch = async () => { throw new Error('net down'); };
    const bad = await client.callTool({ name: 'get_weather', arguments: { location: 'Nowhere' } });
    assert.equal(bad.isError, true);
    assert.ok(bad.content[0].text.length > 0);
  } finally {
    globalThis.fetch = realFetch;
    await close();
  }
  assert.ok(calls.length >= 2, 'weather module fetched geocode then forecast');
});
