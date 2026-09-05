import './helpers/mocks.mjs';

process.env.SWEEP_INTERVAL_MS = '100';
process.env.RATE_LIMIT_WINDOW_MS = '1000';
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, jsonResponse, sleep } from './helpers/mocks.mjs';

const undici = undiciState();
const { createApp } = await import('../src/http_server.js');

function makeKernel(over = {}) {
  const calls = {};
  const defaults = {
    engineStatus: async () => ({ engines: [{ id: 'wikipedia', ok: true }] }),
    browserSessions: async () => ({ sessions: [] }),
    openBrowserSession: async (a) => ({ session_id: 's1' }),
    saveBrowserSession: async (a) => ({ saved: true }),
    searchWeb: async (a) => { calls.searchWeb = a; return { items: [] }; },
    fetchPage: async (a) => { calls.fetchPage = a; return { url: a.url, text: 'page text' }; },
    searchAndFetch: async (a) => ({ bundle_id: 'eb_x', query: a.query }),
    researchProblem: async (a) => ({ task: a.problem_signature.task }),
    getArtifact: (a) => ({ artifact_ref: a.artifact_ref, text: 'chunk', offset: 0 }),
    browserPool: null
  };
  for (const [k, fn] of Object.entries(over)) defaults[k] = fn;
  return { stub: defaults, calls };
}

function hdrs() {
  return { 'content-type': 'application/json', 'x-forwarded-for': `10.7.0.${Math.floor(Math.random() * 200000)}:1`, accept: 'application/json, text/event-stream' };
}

async function start(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
async function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const MCP_BODY = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('mcp tools/call dispatches every kernel tool over POST /mcp', async () => {
  const realFetch = globalThis.fetch;
  const { stub, calls } = makeKernel();
  let geocodeResults = [{ name: 'X', latitude: 1, longitude: 2, country: 'Y' }];
  let weatherOk = true;
  globalThis.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, ...rest);
    if (u.includes('geocoding-api')) {
      return new Response(JSON.stringify({ results: geocodeResults }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('open-meteo') && weatherOk) {
      return new Response(JSON.stringify({
        latitude: 1, longitude: 2,
        current: { temperature_2m: 21, time: '2026-09-04T12:00' },
        daily: { time: ['2026-09-04'], temperature_2m_max: [25], temperature_2m_min: [14], weathercode: [0] },
        timezone: 'UTC'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('geocode down');
  };
  const { app } = createApp(stub, {});
  const server = await start(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}/mcp`;
    const call = async (name, args = {}) => {
      const r = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return (await r.json()).result;
    };
    const fp = await call('fetch_page', { url: 'https://e.com/a' });
    assert.ok(JSON.parse(fp.content[0].text).text === 'page text');
    assert.equal(calls.fetchPage.url, 'https://e.com/a');

    const sf = await call('search_and_fetch', { query: 'q' });
    assert.equal(JSON.parse(sf.content[0].text).bundle_id, 'eb_x');

    const rp = await call('research_problem', { problem_signature: { task: 't' } });
    assert.equal(JSON.parse(rp.content[0].text).task, 't');

    const es = await call('engine_status');
    assert.equal(JSON.parse(es.content[0].text).engines[0].id, 'wikipedia');

    const wt = await call('get_weather', { location: 'X' });
    assert.ok(wt.content[0].text.includes('X'));

    const dupRes = [
      { name: 'Z', latitude: 3, longitude: 4, country: 'C1' },
      { name: 'Z', latitude: 5, longitude: 6, country: 'C2' }
    ];
    geocodeResults = dupRes;
    const opts = await call('get_weather', { location: 'Z' });
    assert.ok(opts.content[0].text.includes('C1'), JSON.stringify(opts).slice(0, 200));

    geocodeResults = [{ name: 'X', latitude: 1, longitude: 2, country: 'Y' }];
    weatherOk = false;
    const wb = await call('get_weather', { location: 'X' });
    assert.equal(wb.isError, true);
    assert.ok(wb.content[0].text.length > 0);
  } finally {
    globalThis.fetch = realFetch;
    await close(server);
  }
});

test('mcp-stream session eviction via sweep and DELETE close', async () => {
  const { stub } = makeKernel();
  const { app } = createApp(stub, {});
  const server = await start(app);
  const base = `http://127.0.0.1:${server.address().port}/mcp-stream`;
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const initRes = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify(init) });
    await initRes.text();
    const sid = initRes.headers.get('mcp-session-id');
    assert.ok(sid, 'session id header present');

    const init2 = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify(init) });
    await init2.text();
    const sid2 = init2.headers.get('mcp-session-id');

    // age both sessions past TTL for the 100ms sweep
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 3600 * 1000;
    try {
      await sleep(350);
    } finally {
      Date.now = realNow;
    }

    const after = await fetch(base, { method: 'POST', headers: { ...hdrs(), 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
    assert.equal(after.status, 400, 'evicted session rejected');

    const noSession = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
    assert.equal(noSession.status, 400);

    // DELETE on live session closes transport -> onclose removes it
    const init3 = await fetch(base, { method: 'POST', headers: hdrs(), body: JSON.stringify(init) });
    await init3.text();
    const sid3 = init3.headers.get('mcp-session-id');
    const del = await fetch(base, { method: 'DELETE', headers: { ...hdrs(), 'mcp-session-id': sid3 } });
    await del.text();
    await sleep(150);
    const afterDel = await fetch(base, { method: 'POST', headers: { ...hdrs(), 'mcp-session-id': sid3 }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) });
    assert.equal(afterDel.status, 400);
  } finally {
    await close(server);
  }
});

test('sse transport lifecycle: connect, messages post, 404, cleanup, eviction', async () => {
  const { stub } = makeKernel();
  const { app, sseTransports } = createApp(stub, {});
  const server = await start(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ac = new AbortController();
    const sse = await fetch(`${base}/sse`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let chunk = '';
    const deadline = Date.now() + 5000;
    while (!chunk.includes('sessionId=') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      chunk += dec.decode(value);
    }
    const m = chunk.match(/sessionId=([A-Za-z0-9-]+)/);
    assert.ok(m, 'endpoint event carries sessionId');
    const sid = m[1];
    assert.ok(sseTransports.has(sid));

    const missing = await fetch(`${base}/messages?sessionId=zzz`, { method: 'POST', headers: hdrs(), body: MCP_BODY(1, 'ping') });
    assert.equal(missing.status, 404);

    const posted = await fetch(`${base}/messages?sessionId=${sid}`, { method: 'POST', headers: hdrs(), body: MCP_BODY(2, 'ping') });
    assert.ok([200, 202].includes(posted.status));

    // force handlePostMessage throw -> catch path
    const entry = sseTransports.get(sid);
    entry.transport = {
      handlePostMessage: async () => { throw new Error('sse boom'); }
    };
    const broken = await fetch(`${base}/messages?sessionId=${sid}`, { method: 'POST', headers: hdrs(), body: MCP_BODY(3, 'ping') });
    assert.equal(broken.status, 500);

    await ac.abort();
    await sleep(150);
    assert.equal(sseTransports.has(sid), false, 'res close removes transport');

    // eviction: fill map to capacity then open one more
    for (let i = 0; i < 510; i++) {
      sseTransports.set(`fake-${i}`, { transport: { close: async () => {} }, server: { close: async () => {} }, createdAt: Date.now() });
    }
    const ac2 = new AbortController();
    const sse2 = await fetch(`${base}/sse`, { signal: ac2.signal, headers: { accept: 'text/event-stream' } });
    assert.equal(sse2.status, 200);
    await ac2.abort();
    await sleep(150);
    assert.ok(!sseTransports.has('fake-0'), 'oldest fake evicted');
    assert.ok(sseTransports.size < 510, 'map drained to room for new entry');
  } finally {
    await close(server);
  }
});

test('rate limit prune sweep and oversized map eviction', async () => {
  const http = await import('node:http');
  const { stub } = makeKernel();
  const { app } = createApp(stub, {});
  const server = await start(app);
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const spray = (ip) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/health', agent,
      headers: { 'x-forwarded-for': ip }
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await spray('10.9.0.1');
    // window 1000ms -> entries older than 2000ms pruned at next sweep (100ms)
    await sleep(2400);

    // oversize: RATE_LIMIT_MAX_ENTRIES is a hard 10000; spray 10010 distinct XFFs
    const BATCH = 128;
    for (let i = 0; i < 10010; i += BATCH) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH, 10010); j++) {
        batch.push(spray(`10.10.${(j >> 8) & 255}.${j & 255}`));
      }
      await Promise.all(batch);
      if (i % 1024 === 0) console.log('spray at', i);
    }
    console.log('spray done');
    await sleep(400);
    assert.equal(await spray('10.10.99.98'), undefined, 'post-eviction request still 200');
  } finally {
    agent.destroy();
    await close(server);
  }
});
