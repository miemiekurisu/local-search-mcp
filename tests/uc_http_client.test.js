import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, jsonResponse, makeResp } from './helpers/mocks.mjs';

const st = undiciState();
const { HttpClient, HttpClientError } = await import('../src/common/httpClient.js');

function lastCall() {
  return st.calls[st.calls.length - 1];
}

test('request requires url', async () => {
  const c = new HttpClient();
  await assert.rejects(c.request({}), /requires url/);
});

test('get with query building and json parse', async () => {
  st.responses = [jsonResponse({ hello: 'world' })];
  const c = new HttpClient();
  const out = await c.get('https://h/api', { query: { a: 1, skip: null, skip2: undefined, b: 'x' } });
  const { url, init } = lastCall();
  assert.equal(url, 'https://h/api?a=1&b=x');
  assert.equal(init.method, 'GET');
  assert.ok(init.headers['user-agent']);
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { hello: 'world' });
});

test('post string body gets json content-type header', async () => {
  st.responses = [jsonResponse({ ok: 1 })];
  const c = new HttpClient();
  await c.post('https://h/submit', { body: '{"a":2}' });
  const init = lastCall().init;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.body, '{"a":2}');
});

test('custom headers override defaults', async () => {
  st.responses = [jsonResponse({})];
  const c = new HttpClient();
  await c.request({ url: 'https://h/', headers: { 'user-agent': 'cobalt', 'x-tag': 't' } });
  const init = lastCall().init;
  assert.equal(init.headers['user-agent'], 'cobalt');
  assert.equal(init.headers['x-tag'], 't');
});

test('proxy profile resolution attaches dispatcher', async () => {
  st.responses = [jsonResponse({})];
  const c = new HttpClient({
    proxyRouter: { resolve: (profile, url) => (profile === 'vpn' ? { proxyUrl: 'http://127.0.0.1:8080' } : null) }
  });
  await c.get('https://h/', { proxyProfile: 'vpn' });
  const init = lastCall().init;
  assert.equal(init.dispatcher.proxyUrl, 'http://127.0.0.1:8080');

  st.responses = [jsonResponse({})];
  await c.get('https://h/', { proxyProfile: 'none' });
  assert.equal(lastCall().init.dispatcher, undefined);
});

test('follows redirects with relative location', async () => {
  st.responses = [
    makeResp({ status: 302, headers: { location: '/final' } }),
    jsonResponse({ landed: true })
  ];
  const c = new HttpClient();
  const out = await c.get('https://h/start');
  assert.equal(st.calls[st.calls.length - 1].url, 'https://h/final');
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { landed: true });
});

test('blocks redirect to internal host', async () => {
  st.responses = [makeResp({ status: 301, headers: { location: 'http://127.0.0.1:9222/x' } })];
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/'), /Redirect to internal address blocked/);
});

test('too many redirects throws', async () => {
  st.responses = Array.from({ length: 6 }, () => makeResp({ status: 302, headers: { location: 'https://h/next' } }));
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/'), /Too many redirects/);
});

test('redirect without location falls through to parse', async () => {
  st.responses = [makeResp({ status: 302 })];
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/'), err => {
    assert.ok(err instanceof HttpClientError);
    assert.equal(err.status, 302);
    return true;
  });
});

test('invalid redirect location stops chain', async () => {
  st.responses = [makeResp({ status: 308, headers: { location: 'http://' + String.fromCharCode(0) } })];
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/'), err => err.status === 308 && /HTTP 308/.test(err.message));
});

test('internal 172 range and odd hosts blocked', async () => {
  st.responses = [makeResp({ status: 302, headers: { location: 'http://169.254.169.254/meta' } })];
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/'), /169\.254\.169\.254/);
});

test('retry policy wraps fetch', async () => {
  st.responses = [jsonResponse({ v: 1 })];
  let executed = 0;
  const c = new HttpClient();
  const out = await c.get('https://h/', {
    retryPolicy: { execute: async (fn) => { executed += 1; return fn(); } }
  });
  assert.equal(executed, 1);
  assert.deepEqual(out.data, { v: 1 });
});

test('non-ok json response throws error with parsed body', async () => {
  st.responses = [jsonResponse({ message: 'nope' }, 404)];
  const c = new HttpClient();
  await assert.rejects(c.get('https://h/missing'), err => {
    assert.ok(err instanceof HttpClientError);
    assert.equal(err.status, 404);
    assert.deepEqual(err.body, { message: 'nope' });
    assert.ok(err.url.includes('/missing'));
    return true;
  });
});

test('text response type and auto detection', async () => {
  st.responses = [makeResp({ status: 200, text: '<html>hi</html>', headers: { 'content-type': 'text/html; charset=utf-8' } })];
  const c = new HttpClient();
  const out = await c.get('https://h/page', { responseType: 'text' });
  assert.equal(out.data, '<html>hi</html>');

  st.responses = [makeResp({ status: 200, text: '<html>hi</html>', headers: { 'content-type': 'text/html' } })];
  const out2 = await c.get('https://h/page', { responseType: 'auto' });
  assert.equal(out2.data, '<html>hi</html>');

  st.responses = [makeResp({ status: 200, text: '{"n":9}', headers: { 'content-type': 'application/vnd.api+json' } })];
  const out3 = await c.get('https://h/api', { responseType: 'auto' });
  assert.deepEqual(out3.data, { n: 9 });

  st.responses = [makeResp({ status: 200, text: '{"n":9}' })];
  const out4 = await c.get('https://h/api2', { responseType: 'auto' });
  assert.equal(out4.data, '{"n":9}');
});

test('head wrapper uses HEAD', async () => {
  st.responses = [makeResp({ status: 200, text: '' })];
  const c = new HttpClient();
  await assert.rejects(c.head('https://h/', { responseType: 'json' }));
  assert.equal(lastCall().init.method, 'HEAD');
});

test('error class carries optional fields only', () => {
  const e1 = new HttpClientError('plain');
  assert.equal(e1.name, 'HttpClientError');
  assert.equal(e1.status, undefined);
  const e2 = new HttpClientError('full', { status: 418, statusText: 'IM', url: 'u', body: 'b' });
  assert.equal(e2.status, 418);
  assert.equal(e2.statusText, 'IM');
});
