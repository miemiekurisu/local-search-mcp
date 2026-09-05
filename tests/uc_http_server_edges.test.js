process.env.RATE_LIMIT_MAX_REQUESTS = '5000';
process.env.RATE_LIMIT_WINDOW_MS = '600000';
process.env.TRUST_PROXY = '1';
process.env.MCP_BEARER_TOKEN = 'secret-token';
process.env.SWEEP_INTERVAL_MS = '150';
process.env.ARTIFACT_DIR = new URL('./uc-server-edge-artifacts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.BROWSER_STATE_DIR = new URL('./uc-server-edge-state/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const d of ['uc-server-edge-artifacts', 'uc-server-edge-state']) {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const { createApp } = await import('../src/http_server.js');

function makeKernel() {
  return {
    engineStatus: async () => ({ engines: [] }),
    browserSessions: async () => ({ sessions: [] }),
    openBrowserSession: async () => ({}),
    saveBrowserSession: async () => ({}),
    searchWeb: async () => ({}),
    fetchPage: async () => ({}),
    searchAndFetch: async () => ({}),
    researchProblem: async () => ({}),
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
  return new Promise(r => server.close(r));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const jsonHeaders = { 'content-type': 'application/json', authorization: 'Bearer secret-token' };

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

test('rate limit size eviction keeps newest half of entries', async () => {
  const { app, rateLimitMap } = createApp(makeKernel());
  for (let i = 0; i < 10005; i++) {
    rateLimitMap.set(`ip-${i}`, { windowStart: Date.now(), count: 1 });
  }
  assert.equal(rateLimitMap.size > 10000, true);
  await sleep(400);
  assert.equal(rateLimitMap.size <= 5003, true, `size after sweep: ${rateLimitMap.size}`);
  await serverClose(await listenServer(app));
});

test('mcp-stream evicts oldest session over cap on new initialize', async () => {
  const { app, streamableSessions } = createApp(makeKernel());
  const closed = [];
  for (let i = 0; i < 500; i++) {
    streamableSessions.set(`oldest-sid-${i}`, { transport: { close: async () => { closed.push(`oldest-sid-${i}`); } }, createdAt: Date.now() });
  }
  const server = await listenServer(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/mcp-stream`, {
      method: 'POST',
      headers: { ...jsonHeaders, accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT)
    });
    assert.equal(res.status, 200, await res.text());
    assert.ok(res.headers.get('mcp-session-id'), 'session assigned');
    assert.equal(closed.length, 1, `closed: ${closed.join(',')}`);
    assert.equal(closed[0], 'oldest-sid-0');

    const bad = await fetch(`${base}/mcp-stream`, { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': 'nope-unknown' }, body: JSON.stringify(INIT) });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null });
  } finally {
    await serverClose(server);
  }
});

test('mcp-stream transport.handleRequest failure returns jsonrpc 500', async () => {
  const { app, streamableSessions } = createApp(makeKernel());
  streamableSessions.set('boom-sid', { transport: { handleRequest: async () => { throw new Error('boom transport'); } }, createdAt: Date.now() });
  const server = await listenServer(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/mcp-stream`, { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': 'boom-sid' }, body: JSON.stringify(INIT) });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  } finally {
    await serverClose(server);
  }
});

test('sse stale session eviction via sweep timer', async () => {
  const { app, sseTransports } = createApp(makeKernel());
  const closedServers = [];
  sseTransports.set('ancient-sid', { transport: { sessionId: 'ancient-sid' }, server: { close: async () => { closedServers.push('ancient-sid'); } }, createdAt: Date.now() - 10 * 3600 * 1000 });
  sseTransports.set('fresh-sid', { transport: { sessionId: 'fresh-sid' }, server: { close: async () => { closedServers.push('fresh-sid'); } }, createdAt: Date.now() });
  await sleep(400);
  assert.deepEqual(closedServers, ['ancient-sid']);
  assert.equal(sseTransports.has('ancient-sid'), false);
  assert.equal(sseTransports.has('fresh-sid'), true);
  await serverClose(await listenServer(app));
});

test('sse connection failure returns 500 text when headers not sent', async () => {
  const { app, sseTransports } = createApp(makeKernel());
  for (let i = 0; i < 500; i++) {
    sseTransports.set(`fake-sid-${i}`, {
      transport: { sessionId: `fake-sid-${i}` },
      server: { close: () => { throw new Error('close detonate'); } },
      createdAt: Date.now()
    });
  }
  const server = await listenServer(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/sse`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'Internal error');
  } finally {
    await serverClose(server);
  }
});

test('sse messages endpoint 404 for unknown session', async () => {
  const { app } = createApp(makeKernel());
  const server = await listenServer(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/messages?sessionId=ghost`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(INIT) });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'Session not found');
  } finally {
    await serverClose(server);
  }
});
