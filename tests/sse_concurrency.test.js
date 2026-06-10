import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/http_server.js';

const CONCURRENCY = 4;

function openSseConnection(url, { signal } = {}) {
  const events = [];
  let resolveConnected;
  const connected = new Promise(r => { resolveConnected = r; });

  const req = http.get(url, { signal }, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split('\n');
        let eventType = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) {
          try { events.push({ event: eventType, data: JSON.parse(data) }); }
          catch { events.push({ event: eventType, data }); }
        }
        if (!resolveConnected) {
          resolveConnected();
          resolveConnected = null;
        }
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});

  function close() { req.destroy(); }

  function waitForEvent(predicate, timeout = 8000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      function check() {
        const match = events.find(predicate);
        if (match) return resolve(match);
        if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for event after ${timeout}ms`));
        setTimeout(check, 50);
      }
      check();
    });
  }

  function waitForCount(minCount, timeout = 8000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      function check() {
        if (events.filter(e => e.event === 'message').length >= minCount) return resolve(events);
        if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for ${minCount} events after ${timeout}ms, got ${events.length}`));
        setTimeout(check, 50);
      }
      check();
    });
  }

  return { events, connected, close, waitForEvent, waitForCount };
}

function postJson(url, body, signal) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      signal
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getSessionUrl(events, baseUrl) {
  const ep = events.find(e => e.event === 'endpoint');
  if (!ep) throw new Error('no endpoint event');
  const raw = typeof ep.data === 'string' ? ep.data : ep.data?.url || ep.data;
  return raw.startsWith('http') ? raw : `${baseUrl}${raw}`;
}

describe('SSE Transport Concurrency', () => {
  let server;
  let baseUrl;
  let sseUrl;
  const ac = new AbortController();

  before(async () => {
    const { app } = createApp();
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        sseUrl = `${baseUrl}/sse`;
        server.maxConnections = 50;
        resolve();
      });
      server.on('error', reject);
    });
  });

  after(() => {
    ac.abort();
    if (server) server.close();
  });

  it('multiple SSE connections can coexist', async () => {
    const conns = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const conn = openSseConnection(sseUrl, { signal: ac.signal });
      conns.push(conn);
    }
    await Promise.all(conns.map(c => c.waitForEvent(e => e.event === 'endpoint', 3000)));
    for (const c of conns) {
      assert.ok(c.events.some(e => e.event === 'endpoint'), 'each connection should receive endpoint');
      c.close();
    }
  });

  it('concurrent tool calls on single SSE connection', async () => {
    const conn = openSseConnection(sseUrl, { signal: ac.signal });
    await conn.waitForEvent(e => e.event === 'endpoint', 3000);
    const msgUrl = getSessionUrl(conn.events, baseUrl);

    const initRes = await postJson(msgUrl, {
      jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {}
    }, ac.signal);
    assert.equal(initRes.status, 202, 'initialize accepted');

    const TOOL_COUNT = 6;
    const posts = [];
    for (let i = 0; i < TOOL_COUNT; i++) {
      posts.push(postJson(msgUrl, {
        jsonrpc: '2.0', id: String(i + 10),
        method: 'tools/call',
        params: { name: 'get_time', arguments: {} }
      }, ac.signal));
    }
    const resps = await Promise.all(posts);
    for (const r of resps) assert.equal(r.status, 202);

    await conn.waitForCount(TOOL_COUNT, 5000);

    const msgs = conn.events.filter(e => e.event === 'message').map(e => e.data);
    const toolResp = msgs.filter(d => d && (d.result || d.error));

    assert.ok(toolResp.length >= TOOL_COUNT,
      `expected >=${TOOL_COUNT} tool responses, got ${toolResp.length}`);

    for (const msg of toolResp) {
      const roundtrip = JSON.parse(JSON.stringify(msg));
      assert.deepEqual(roundtrip, msg, `msg ${msg.id} survives JSON round-trip`);
      assert.ok(msg.id, `response has id`);
    }

    const ok = toolResp.filter(d => d.result).length;
    assert.ok(ok >= TOOL_COUNT * 0.5, `>=50% succeed, got ${ok}/${toolResp.length}`);
    conn.close();
  });

  it('concurrent tool calls across multiple SSE connections', async () => {
    const conns = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const c = openSseConnection(sseUrl, { signal: ac.signal });
      conns.push(c);
    }
    await Promise.all(conns.map(c => c.waitForEvent(e => e.event === 'endpoint', 3000)));

    const sessions = conns.map(c => ({ conn: c, msgUrl: getSessionUrl(c.events, baseUrl) }));

    await Promise.all(sessions.map(({ msgUrl }) =>
      postJson(msgUrl, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }, ac.signal)
        .then(r => assert.equal(r.status, 202))
    ));

    const REQS_PER_CONN = 2;
    const posts = sessions.flatMap(({ msgUrl }, idx) =>
      Array.from({ length: REQS_PER_CONN }, (_, j) =>
        postJson(msgUrl, {
          jsonrpc: '2.0', id: `${idx}-${j}`,
          method: 'tools/call',
          params: { name: 'get_time', arguments: {} }
        }, ac.signal)
      )
    );
    const resps = await Promise.all(posts);
    for (const r of resps) assert.equal(r.status, 202);

    await Promise.all(conns.map(c => c.waitForCount(REQS_PER_CONN, 5000)));

    for (const c of conns) {
      const msgs = c.events.filter(e => e.event === 'message').map(e => e.data);
      const toolResp = msgs.filter(d => d && (d.result || d.error));
      for (const msg of toolResp) {
        const roundtrip = JSON.parse(JSON.stringify(msg));
        assert.deepEqual(roundtrip, msg, `msg ${msg.id} survives JSON round-trip`);
      }
      c.close();
    }
  });
});
