import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http_server.js';
import { createKernel } from '../src/app.js';

describe('Streamable HTTP Transport', () => {
  let app;
  let server;
  let kernel;
  let browserPool;
  let baseUrl;

  before(async () => {
    const k = createKernel();
    kernel = k.kernel;
    browserPool = k.browserPool;
    const { app: a } = createApp(kernel);
    app = a;
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server?.close();
    await browserPool?.close();
  });

  it('should initialize a session via POST /mcp-stream', async () => {
    const res = await fetch(`${baseUrl}/mcp-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.has('mcp-session-id'), 'should return mcp-session-id header');
    const sessionId = res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'session ID should be non-empty');
  });

  it('should handle tools/list after initialization', async () => {
    // Initialize
    const initRes = await fetch(`${baseUrl}/mcp-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id');

    // tools/list — response is SSE stream (Streamable HTTP default)
    const listRes = await fetch(`${baseUrl}/mcp-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05',
        'MCP-Session-Id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    assert.equal(listRes.status, 200);
    assert.ok(listRes.headers.get('content-type')?.includes('text/event-stream'),
      'should return SSE stream');

    // Read SSE event from the stream
    const text = await listRes.text();
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'should have a data line in SSE response');
    const body = JSON.parse(dataLine.slice(6));
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(body.result?.tools?.length > 0, 'should return tools array');
  });

  it('should support multiple concurrent sessions', async () => {
    const results = await Promise.all([...Array(4)].map(async (_, i) => {
      const initRes = await fetch(`${baseUrl}/mcp-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: i,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: `test-client-${i}`, version: '1.0.0' },
          },
        }),
      });

      return {
        status: initRes.status,
        sessionId: initRes.headers.get('mcp-session-id'),
      };
    }));

    for (const r of results) {
      assert.equal(r.status, 200, 'all sessions should initialize successfully');
      assert.ok(r.sessionId, 'each session should have a unique session ID');
    }

    // Verify unique session IDs
    const ids = results.map(r => r.sessionId);
    assert.equal(new Set(ids).size, ids.length, 'all session IDs should be unique');
  });

  it('should reject non-initialization request without session ID', async () => {
    const res = await fetch(`${baseUrl}/mcp-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });

    assert.equal(res.status, 400);
  });
});
