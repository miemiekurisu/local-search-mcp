import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildOpenApiSpec } from '../src/openapi/schema.js';
import { registerOpenApiRoutes, openApiRoute } from '../src/openapi/routes.js';
import { createApp } from '../src/http_server.js';
import { createKernel } from '../src/app.js';

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec('http://test:8765');

  it('should be OpenAPI 3.1.0', () => {
    assert.equal(spec.openapi, '3.1.0');
  });

  it('should have info.title and info.version', () => {
    assert.equal(spec.info.title, 'Local Search Tools');
    assert.equal(spec.info.version, '0.1.0');
  });

  it('should have server URL from argument', () => {
    assert.equal(spec.servers[0].url, 'http://test:8765');
  });

  it('should have 7 tool paths', () => {
    const pathKeys = Object.keys(spec.paths).sort();
    assert.deepEqual(pathKeys, [
      '/tools/engine_status',
      '/tools/fetch_page',
      '/tools/get_time',
      '/tools/get_weather',
      '/tools/research_problem',
      '/tools/search_and_fetch',
      '/tools/search_web',
    ]);
  });

  it('should have unique operationIds across all paths', () => {
    const opIds = Object.values(spec.paths).map(p => p.post.operationId);
    assert.equal(new Set(opIds).size, opIds.length, 'operationIds must be unique');
  });

  it('each tool path should have post.operationId, summary, description, responses', () => {
    for (const [path, def] of Object.entries(spec.paths)) {
      assert.ok(def.post, `${path} should have post method`);
      assert.ok(def.post.operationId, `${path} should have operationId`);
      assert.ok(typeof def.post.summary === 'string', `${path} should have summary`);
      assert.ok(typeof def.post.description === 'string', `${path} should have description`);
      assert.ok(def.post.responses?.['200'], `${path} should have 200 response`);
    }
  });

  it('search_web should have fetch_top_k, fetch_mode, max_chars_total, timeout_ms', () => {
    const props = spec.paths['/tools/search_web'].post.requestBody.content['application/json'].schema.properties;
    assert.ok(props.fetch_top_k);
    assert.ok(props.fetch_mode);
    assert.ok(props.max_chars_total);
    assert.ok(props.timeout_ms);
    assert.ok(props.query);
    assert.equal(props.fetch_mode.enum[0], 'auto');
  });

  it('fetch_page should have url required', () => {
    const schema = spec.paths['/tools/fetch_page'].post.requestBody.content['application/json'].schema;
    assert.ok(schema.required.includes('url'));
  });

  it('get_weather should have location required', () => {
    const schema = spec.paths['/tools/get_weather'].post.requestBody.content['application/json'].schema;
    assert.ok(schema.required.includes('location'));
  });

  it('get_time should not be required', () => {
    const schema = spec.paths['/tools/get_time'].post.requestBody.content['application/json'].schema;
    assert.equal(schema.required, undefined);
  });

  it('engine_status should have no requestBody', () => {
    const def = spec.paths['/tools/engine_status'].post;
    assert.equal(def.requestBody, undefined);
  });

  it('research_problem should require problem_signature.task', () => {
    const schema = spec.paths['/tools/research_problem'].post.requestBody.content['application/json'].schema;
    const required = schema.properties.problem_signature.required;
    assert.ok(required.includes('task'));
  });
});

describe('registerOpenApiRoutes', () => {
  let app;
  let server;
  let baseUrl;
  let kernelCalls;

  function createTestApp() {
    const a = express();
    a.use(express.json({ limit: '2mb' }));
    const calls = [];
    const mockKernel = {
      searchWeb: (args) => { calls.push('searchWeb'); return { results: [{ title: 'r1' }] }; },
      fetchPage: (args) => { calls.push('fetchPage'); return { status: 'success', url: args.url, text_preview: 'test' }; },
      searchAndFetch: (args) => { calls.push('searchAndFetch'); return { items: [] }; },
      researchProblem: (args) => { calls.push('researchProblem'); return { candidates: [] }; },
      engineStatus: () => { calls.push('engineStatus'); return { engines: ['duckduckgo'] }; },
    };
    registerOpenApiRoutes(a, mockKernel);
    return { app: a, calls };
  }

  before(async () => {
    const { app: a, calls } = createTestApp();
    app = a;
    kernelCalls = calls;
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
  });

  it('GET /openapi.json should serve OpenAPI spec', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.openapi, '3.1.0');
    assert.equal(body.info.title, 'Local Search Tools');
  });

  it('GET /openapi.json should include server host in URL', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    const body = await res.json();
    assert.ok(body.servers[0].url.startsWith('http://127.0.0.1'));
  });

  it('POST /tools/search_web should call kernel.searchWeb', async () => {
    const res = await fetch(`${baseUrl}/tools/search_web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.results);
    assert.ok(kernelCalls.includes('searchWeb'));
  });

  it('POST /tools/fetch_page should call kernel.fetchPage', async () => {
    const res = await fetch(`${baseUrl}/tools/fetch_page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'success');
    assert.ok(kernelCalls.includes('fetchPage'));
  });

  it('POST /tools/search_and_fetch should call kernel.searchAndFetch', async () => {
    const res = await fetch(`${baseUrl}/tools/search_and_fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(kernelCalls.includes('searchAndFetch'));
  });

  it('POST /tools/research_problem should call kernel.researchProblem', async () => {
    const res = await fetch(`${baseUrl}/tools/research_problem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem_signature: { task: 'test' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(kernelCalls.includes('researchProblem'));
  });

  it('POST /tools/engine_status should call kernel.engineStatus', async () => {
    const res = await fetch(`${baseUrl}/tools/engine_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.engines);
    assert.ok(kernelCalls.includes('engineStatus'));
  });

  it('POST /tools/get_time should return time data', async () => {
    const res = await fetch(`${baseUrl}/tools/get_time`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'UTC' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.content);
    assert.ok(body.result.utc);
    assert.ok(body.result.epoch);
  });

  it('POST /tools/get_weather should return error for invalid location', async () => {
    const res = await fetch(`${baseUrl}/tools/get_weather`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: 'NONEXISTENT_LOCATION_12345' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.error, 'should return error for nonexistent location');
  });

  it('POST /tools/get_time without body should still return time', async () => {
    const res = await fetch(`${baseUrl}/tools/get_time`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.content);
  });
});

describe('openApiRoute error handling', () => {
  it('should return {ok:false, error:{code,message}} when fn throws', async () => {
    const app = express();
    app.use(express.json());
    app.post('/test', openApiRoute(() => {
      const err = new Error('something broke');
      err.code = 'TEST_ERR';
      throw err;
    }));
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'TEST_ERR');
    assert.equal(body.error.message, 'something broke');
    server.close();
  });

  it('should handle non-object throw (string)', async () => {
    const app = express();
    app.use(express.json());
    app.post('/test', openApiRoute(() => { throw 'raw string error'; }));
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'TOOL_ERROR');
    assert.equal(body.error.message, 'raw string error');
    server.close();
  });
});

describe('openapi routes with real kernel (integration)', () => {
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

  it('GET /openapi.json serves valid spec with real server', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.openapi, '3.1.0');
    assert.equal(body.info.title, 'Local Search Tools');
    assert.ok(body.servers[0].url.startsWith('http://'));
  });

  it('POST /tools/engine_status returns engine list', async () => {
    const res = await fetch(`${baseUrl}/tools/engine_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.result.engines));
  });

  it('POST /tools/search_web returns search results with query param', async () => {
    const res = await fetch(`${baseUrl}/tools/search_web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 3, fetch_top_k: 0 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.query_id);
    assert.ok(Array.isArray(body.result.results));
  });

  it('POST /tools/search_web without query returns error', async () => {
    const res = await fetch(`${baseUrl}/tools/search_web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.code);
  });
});

describe('MCP endpoints unaffected by OpenAPI routes', () => {
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

  it('GET /health still works', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('POST /mcp still works (tools/list)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(Array.isArray(body.result.tools));
  });

  it('POST /search existing REST endpoint still works', async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 3 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});
