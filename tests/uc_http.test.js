import { test } from 'node:test';
import assert from 'node:assert';
import { undiciState, dnsState, makeResp, sleep } from './helpers/mocks.mjs';

const st = undiciState();
const dns = dnsState();
const { fetchWithTimeout, contentTypeOf, readBodyBounded, createHeaders, DEFAULT_HEADERS } = await import('../src/utils/http.js');

test('createHeaders forGoogle', () => {
  const h = createHeaders({ 'x-a': '1' }, true);
  assert.strictEqual(h['x-a'], '1');
  assert.strictEqual(h['sec-fetch-dest'], 'document');
  assert.ok(h['user-agent'].startsWith('Mozilla'));
  assert.strictEqual(DEFAULT_HEADERS.accept.includes('text/html'), true);
  const h2 = createHeaders();
  assert.strictEqual(h2['sec-fetch-dest'], undefined);
  assert.ok(h2['accept-language']);
});

test('contentTypeOf', () => {
  assert.strictEqual(contentTypeOf({ headers: { get: k => (k === 'content-type' ? 'text/html; charset=utf8' : null) } }), 'text/html');
  assert.strictEqual(contentTypeOf({ headers: { get: () => null } }), '');
});

test('readBodyBounded ok text', async () => {
  const resp = makeResp({ text: 'abc' , chunks: [Buffer.from('ab'), Buffer.from('c')] });
  assert.strictEqual(await readBodyBounded(resp, { maxBytes: 100, timeoutMs: 500 }), 'abc');
});

test('readBodyBounded no body', async () => {
  assert.strictEqual(await readBodyBounded({ body: null }), '');
  assert.strictEqual(await readBodyBounded({}), '');
});

test('readBodyBounded too large cancels body', async () => {
  const resp = makeResp({ chunks: [Buffer.alloc(50), Buffer.alloc(50)] });
  await assert.rejects(readBodyBounded(resp, { maxBytes: 60, timeoutMs: 500 }), { code: 'BODY_TOO_LARGE' });
  assert.strictEqual(resp.body.cancelled, true);
});

test('readBodyBounded timeout cancels body', async () => {
  const resp = makeResp({ hang: true });
  const started = Date.now();
  await assert.rejects(readBodyBounded(resp, { maxBytes: 100, timeoutMs: 120 }), { code: 'BODY_TIMEOUT' });
  assert.ok(Date.now() - started < 3000);
  assert.strictEqual(resp.body.cancelled, true);
});

test('fetchWithTimeout basic POST body + proxy branch', async () => {
  st.responses.push(makeResp({ status: 200, text: 'ok1' }));
  const resp = await fetchWithTimeout('http://93.184.216.34/x', { method: 'POST', body: '{"a":1}', headers: { 'x-t': 'y' }, proxyUrl: 'http://203.0.113.5:8080' });
  assert.strictEqual(await resp.text(), 'ok1');
  assert.strictEqual(st.calls[0].init.method, 'POST');
  assert.strictEqual(st.calls[0].init.headers['content-type'], 'application/json');
  assert.strictEqual(st.calls[0].init.dispatcher.proxyUrl, 'http://203.0.113.5:8080');
  // non-http proxy string: dispatcher not set
  st.responses.push(makeResp({ status: 200, text: 'ok2' }));
  await fetchWithTimeout('http://93.184.216.34/y', { proxyUrl: 'socks5://9.9.9.9:1080' });
  assert.strictEqual(st.calls[1].init.dispatcher, undefined);
  // binary body: no content-type injection
  st.responses.push(makeResp({ status: 200, text: 'ok3' }));
  await fetchWithTimeout('http://93.184.216.34/z', { body: Buffer.from('raw') });
  assert.strictEqual(st.calls[2].init.headers['content-type'], undefined);
});

test('fetchWithTimeout SSRF blocks private IP url before fetch', async () => {
  st.responses.length = 0;
  const before = st.calls.length;
  await assert.rejects(fetchWithTimeout('http://127.0.0.1:9/x'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(fetchWithTimeout('not a url at all'), { code: 'SSRF_BAD_URL' });
  // DNS resolving to private address → blocked
  dns.impl = () => [{ address: '192.168.0.44', family: 4 }];
  await assert.rejects(fetchWithTimeout('http://rebind.example.net/x'), { code: 'SSRF_BLOCKED' });
  dns.impl = null;
  // DNS failure → fail closed
  dns.impl = () => { throw new Error('NXDOMAIN'); };
  await assert.rejects(fetchWithTimeout('http://nx.example.net/x'), { code: 'SSRF_DNS_ERROR' });
  dns.impl = null;
  assert.strictEqual(st.calls.length, before);
});

test('fetchWithTimeout redirect chain follows public hops', async () => {
  st.responses.length = 0;
  const mark = st.calls.length;
  st.responses.push(
    makeResp({ status: 302, headers: { location: 'http://93.184.216.35/next' } }),
    makeResp({ status: 307, headers: { location: '/relative' } }),
    makeResp({ status: 200, text: 'final' })
  );
  const resp = await fetchWithTimeout('http://93.184.216.34/start');
  assert.strictEqual(await resp.text(), 'final');
  assert.strictEqual(st.calls.length - mark, 3);
  assert.strictEqual(st.calls[mark + 2].init.method, 'GET');
  assert.strictEqual(st.calls[mark + 2].init.body, undefined);
});

test('fetchWithTimeout redirect to internal blocked', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 302, headers: { location: 'http://10.0.0.9/steal' } }));
  await assert.rejects(fetchWithTimeout('http://93.184.216.34/x'), { code: 'SSRF_REDIRECT_BLOCKED' });
});

test('fetchWithTimeout redirect missing location', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 301, headers: {} }));
  const resp = await fetchWithTimeout('http://93.184.216.34/x');
  assert.strictEqual(resp.status, 301);
});

test('fetchWithTimeout invalid redirect location throws', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 302, headers: { location: 'http://' + '\u0000' } }));
  await assert.rejects(fetchWithTimeout('http://93.184.216.34/x'), /Invalid redirect location/);
});

test('fetchWithTimeout too many redirects', async () => {
  st.responses.length = 0;
  for (let i = 0; i < 12; i++) {
    st.responses.push(makeResp({ status: 302, headers: { location: `http://93.184.216.3${i % 10}/hop${i}` } }));
  }
  await assert.rejects(fetchWithTimeout('http://93.184.216.34/x'), /Too many redirects/);
});

test('fetchWithTimeout non-redirect body passthrough (text/plain json body)', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 500, text: 'err-body' }));
  const resp = await fetchWithTimeout('http://93.184.216.34/x', { method: 'POST', body: 'text-body' });
  assert.strictEqual(resp.status, 500);
  assert.strictEqual(await resp.text(), 'err-body');
});

test('fetchWithTimeout proprietary abort timeout', async () => {
  st.responses.length = 0;
  st.fetchOverride = true;
  const slowFetch = async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
  };
  const prev = st.fetch;
  st.fetch = slowFetch;
  await assert.rejects(fetchWithTimeout('http://93.184.216.34/x', { timeoutMs: 100 }), /aborted/);
  st.fetch = prev;
});

// ── engines/wikipedia.js ────────────────────────────────────
test('wikipedia happy + http error + parse error', async () => {
  const { searchWikipedia } = await import('../src/engines/wikipedia.js');
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { query: { search: [
    { title: 'A <b>Tag</b> Page', snippet: 'snippet <i>one</i>' },
    { title: 'Second', snippet: 'two' }
  ] } } }));
  const results = await searchWikipedia('query', { proxyRouter: { resolve: () => ({ proxyUrl: null }) }, limit: 5 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].url.startsWith('https://en.wikipedia.org/wiki/'), true);
  assert.strictEqual(results[0].title, 'A <b>Tag</b> Page');
  assert.strictEqual(results[0].snippet, 'snippet one');

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 503 }));
  await assert.rejects(searchWikipedia('q', {}), { code: 'ENGINE_HTTP_ERROR' });

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: '{}' }));
  // data.query undefined → results = [] → then uniqueByUrl → [] (no throw)
  const empty = await searchWikipedia('q', {});
  assert.deepStrictEqual(empty, []);

  st.responses.length = 0;
  st.responses.push({ notAResponse: true });
  await assert.rejects(searchWikipedia('q', {}), { code: 'ENGINE_HTTP_ERROR' });
});

// ── engines/custom_html.js ──────────────────────────────────
test('custom_html full matrix', async () => {
  const { searchCustomHtml } = await import('../src/engines/custom_html.js');
  const cfg = {
    id: 'cest',
    url_template: 'https://api.example.test/search?q={{query}}',
    selectors: { result: 'div.r', title: 'h3', url: 'a', snippet: 'p.s' },
    headers: { 'x-custom': 'yes' },
    method: 'GET'
  };

  st.responses.length = 0;
  st.responses.push(makeResp({ text: '<div class="r"><h3>T1</h3><a href="https://a.com/1?utm_source=x">l</a><p class="s">snip</p></div><div class="r"><h3>T2</h3><a href="https://a.com/1">l</a></div>', headers: { 'content-type': 'text/html' } }));
  const results = await searchCustomHtml(cfg, 'q', { limit: 10, proxyRouter: { resolve: () => ({ proxyUrl: null }) } });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].url, 'https://a.com/1');
  assert.strictEqual(results[0].snippet, 'snip');

  // no {{query}} placeholder
  await assert.rejects(searchCustomHtml({ id: 'bad', url_template: 'https://x.test/' }, 'q', {}), { code: 'INVALID_CONFIG' });

  // body too large
  st.responses.length = 0;
  st.responses.push(makeResp({ chunks: [Buffer.alloc(9 * 1024 * 1024 + 10)] }));
  await assert.rejects(searchCustomHtml(cfg, 'q', {}), { code: 'BODY_TOO_LARGE' });

  // body generic error
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: 'will fail on iter' }));
  // craft a response whose body iteration throws
  st.responses.pop();
  st.responses.push({
    ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => 'x',
    body: { [Symbol.asyncIterator]() { return { next: async () => { throw new Error('stream kaput'); } }; }, cancel: async () => {} }
  });
  await assert.rejects(searchCustomHtml(cfg, 'q', {}), { code: 'cest_BODY_ERROR' });

  // HTTP error status
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 403, text: '<html></html>' }));
  await assert.rejects(searchCustomHtml(cfg, 'q', {}), { code: 'ENGINE_HTTP_ERROR' });

  // blocked text
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: '<html>verify you are human</html>' }));
  await assert.rejects(searchCustomHtml(cfg, 'q', {}), { code: 'ENGINE_BLOCKED' });

  // no parseable results
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: '<div class="r">no links</div>' }));
  await assert.rejects(searchCustomHtml(cfg, 'q', {}), { code: 'SERP_PARSE_FAILED' });

  // relative links resolved + data-href fallback + plain title element
  st.responses.length = 0;
  const cfg2 = { id: 'cest2', url_template: 'https://api.example.test/s?q={{query}}', selectors: { result: 'div.r' } };
  st.responses.push(makeResp({ text: '<div class="r" data-href="#">\n  <a href="/rel/1?gclid=a">Rel Title</a>\n  snippet only\n</div>', headers: {} }));
  const rel = await searchCustomHtml(cfg2, 'q', { limit: 10 });
  assert.strictEqual(rel.length, 1);
  assert.strictEqual(rel[0].url, 'https://api.example.test/s?q=q');

  // custom_html fetchWithTimeout rejects (proxy router throws)
  st.responses.length = 0;
  await assert.rejects(searchCustomHtml(cfg, 'q', { proxyRouter: { resolve: () => { throw new Error('cfgerr'); } } }), /cfgerr/);
});

// ── engines/api_fallback.js (no keys at import) ─────────────
test('api_fallback without keys', async () => {
  const { searchViaApi, searchWithFallbacks } = await import('../src/engines/api_fallback.js');
  st.responses.length = 0;
  const mark = st.calls.length;
  assert.deepStrictEqual(await searchViaApi('brave', 'q', 5), []);
  assert.deepStrictEqual(await searchViaApi('tavily', 'q', 5), []);
  assert.deepStrictEqual(await searchViaApi('exa', 'q', 5), []);
  assert.deepStrictEqual(await searchViaApi('unknown-api', 'q', 5), []);
  // google api fallback not enabled without env → empty
  assert.deepStrictEqual(await searchViaApi('google', 'q', 5), []);
  assert.strictEqual(await searchWithFallbacks('q', 10, []), null);
  assert.strictEqual(await searchWithFallbacks('q', 10, ['brave', 'tavily', 'exa']), null);
  assert.strictEqual(st.calls.length, mark);
});
