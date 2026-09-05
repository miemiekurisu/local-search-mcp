import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG, clampInt, readJsonIfExists, ensureDir, safeJoin } from '../src/config/index.js';
import { ProxyRouter } from '../src/config/proxy.js';
import * as normalize from '../src/utils/normalize.js';
import { mapLimit } from '../src/utils/limit.js';
import * as ssrf from '../src/utils/ssrf.js';
import { makeResult, SearchEngineError } from '../src/engines/base.js';
import { buildOpenApiSpec } from '../src/openapi/schema.js';
import { ToolRegistry } from '../src/registry/toolRegistry.js';
import { SourceRegistry, ACADEMIC_SOURCE_POLICIES } from '../src/registry/sourceRegistry.js';
import { EvidenceBundleBuilder } from '../src/evidence/evidenceBundleBuilder.js';
import * as evTypes from '../src/evidence/evidenceTypes.js';
import { CircuitBreaker, CircuitState } from '../src/common/circuitBreaker.js';
import { RateLimiter } from '../src/common/rateLimiter.js';
import { retry, RetryPolicy } from '../src/common/retryPolicy.js';
import { z } from 'zod';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-pure-'));

// ── config/index.js ─────────────────────────────────────────
test('clampInt all branches', () => {
  assert.strictEqual(clampInt('5', 1, 0, 10), 5);
  assert.strictEqual(clampInt('abc', 7, 0, 10), 7);
  assert.strictEqual(clampInt('100', 7, 0, 10), 10);
  assert.strictEqual(clampInt('-5', 7, 0, 10), 0);
  assert.strictEqual(clampInt('3.9', 7, 0, 10), 3);
  assert.ok(CONFIG.port >= 0);
});

test('readJsonIfExists branches', () => {
  const good = path.join(TMP, 'good.json');
  fs.writeFileSync(good, '{"a":1}');
  assert.deepStrictEqual(readJsonIfExists(good, []), { a: 1 });
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  assert.strictEqual(readJsonIfExists(bad, '[fallback]'), '[fallback]');
  assert.strictEqual(readJsonIfExists(path.join(TMP, 'missing.json'), 'fb'), 'fb');
  assert.strictEqual(readJsonIfExists('', 'fb'), 'fb');
});

test('ensureDir + safeJoin traversal guard', () => {
  const dir = path.join(TMP, 'ensured/deeper');
  ensureDir(dir);
  assert.ok(fs.existsSync(dir));
  assert.throws(() => safeJoin(TMP, '..', 'escape.txt'), /unsafe path traversal/);
  assert.throws(() => safeJoin(TMP, 'a', '..', '..', 'b'), /unsafe path traversal/);
  assert.strictEqual(safeJoin(path.join(TMP, 'ensured'), 'deeper'), dir);
});

// ── config/proxy.js ─────────────────────────────────────────
test('ProxyRouter resolve branches', () => {
  const router = new ProxyRouter();
  assert.strictEqual(router.resolve('auto', 'http://example.com').proxyUrl, null);
  assert.strictEqual(router.resolve('', '').profile, 'auto');
  assert.strictEqual(router.resolve('nonexistent', '').profile, 'nonexistent');
  const withProxy = new ProxyRouter();
  withProxy.profiles.corp = { type: 'http', server: 'http://proxy:8080', no_proxy: ['example.com', 'localhost', '127.0.0.1', '10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12', ''] };
  assert.strictEqual(withProxy.resolve('corp', 'http://other.com/x').playwrightProxy.server, 'http://proxy:8080');
  assert.strictEqual(withProxy.resolve('corp', 'https://sub.example.com/x').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'http://localhost:1').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'http://127.0.0.1:1').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'http://10.1.2.3').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'http://192.168.5.5').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'http://172.31.1.1').proxyUrl, null);
  assert.strictEqual(withProxy.resolve('corp', 'not a url').proxyUrl, 'http://proxy:8080');
  const star = new ProxyRouter();
  star.profiles.star = { type: 'http', server: 'http://p:9', no_proxy: ['*'] };
  assert.strictEqual(star.resolve('star', 'http://anything.com').proxyUrl, null);
  const noServer = new ProxyRouter();
  noServer.profiles.broken = { type: 'http' };
  assert.strictEqual(noServer.resolve('broken', 'http://x.com').proxyUrl, null);

  const engineRouter = new ProxyRouter();
  engineRouter.engineProxies.google = 'corp';
  engineRouter.profiles.corp = { type: 'http', server: 'http://p:1' };
  assert.strictEqual(engineRouter.resolveForEngine('google').proxyUrl, 'http://p:1');
  assert.strictEqual(engineRouter.resolveForEngine('bing').profile, 'auto');
  const status = engineRouter.status();
  assert.ok(status.profiles.some(p => p.name === 'corp'));
  assert.deepStrictEqual(status.engine_proxies, { google: 'corp' });
});

// ── utils/normalize.js ──────────────────────────────────────
test('normalizeWhitespace + truncateText', () => {
  assert.strictEqual(normalize.normalizeWhitespace('  a\u00a0 \t b \n\n\n c \n \n d '), 'a b \n c \nd');
  assert.strictEqual(normalize.normalizeWhitespace(null), '');
  const long = 'x'.repeat(30);
  assert.strictEqual(normalize.truncateText(long, 10).includes('[TRUNCATED 20 chars]'), true);
  assert.strictEqual(normalize.truncateText('short', 10), 'short');
  assert.strictEqual(normalize.truncateText(null, 5), '');
});

test('stripTrackingUrl branches', () => {
  assert.strictEqual(normalize.stripTrackingUrl('/url?q=https://a.com'), 'https://a.com');
  assert.strictEqual(normalize.stripTrackingUrl('https://www.google.com/url?q=https://b.com'), 'https://b.com');
  assert.strictEqual(normalize.stripTrackingUrl('https://c.com/x'), 'https://c.com/x');
  assert.strictEqual(normalize.stripTrackingUrl(null), null);
  assert.strictEqual(normalize.stripTrackingUrl('/url?'), '/url?');
  const bad = 'https://exa\u0007mple.com/url?q=x';
  assert.strictEqual(normalize.stripTrackingUrl(bad), bad, 'URL parse failure returns original');
});

test('canonicalUrl branches', () => {
  assert.strictEqual(normalize.canonicalUrl('https://www.a.com/?utm_source=x&id=2#frag'), 'https://a.com/?id=2');
  assert.strictEqual(normalize.canonicalUrl('not a url'), 'not a url');
  assert.strictEqual(normalize.canonicalUrl('http://a.com/'), 'http://a.com/');
});

test('isLikelyBlockedText', () => {
  assert.strictEqual(normalize.isLikelyBlockedText('Please complete the CAPTCHA'), true);
  assert.strictEqual(normalize.isLikelyBlockedText('normal text'), false);
  assert.strictEqual(normalize.isLikelyBlockedText(''), false);
  // Google SERPs embed the token "captcha" in their own <script> payloads
  assert.strictEqual(normalize.isLikelyBlockedText(
    '<html><body><div>search results are fine</div><script>var hasCaptchaSupport=true;</script></body></html>'), false,
    'script-embedded captcha token is not a challenge page');
  assert.strictEqual(normalize.isLikelyBlockedText(
    '<html><body><div>unusual traffic from your computer network</div></body></html>'), true,
    'visible challenge text still detected');
});

test('uniqueByUrl + filterBlockedDomains + hostOf', () => {
  const items = [
    { url: 'https://www.a.com/x' },
    { url: 'https://a.com/x' },
    { url: 'https://csdn.net/y' },
    { url: 'https://blog.csdn.net/y' },
    { url: '' },
    { url: 'https://b.com/' },
    { url: 'https://b.com/' }
  ];
  const out = normalize.uniqueByUrl(items, 20);
  // www 前缀已归一化 → 两条约为同一 URL，仅保留首条
  assert.deepStrictEqual(out.map(i => i.url), ['https://www.a.com/x', 'https://b.com/']);
  assert.strictEqual(normalize.hostOf('https://www.z.com/p?q=1'), 'z.com');
  assert.strictEqual(normalize.hostOf('bad url'), '');
});

test('hostOf/stripTracking/canonical with nulls', () => {
  assert.strictEqual(normalize.canonicalUrl(undefined), undefined);
  assert.strictEqual(normalize.stripTrackingUrl(''), '');
});

// ── utils/limit.js ──────────────────────────────────────────
test('mapLimit all branches incl timeout & error collection', async () => {
  const items = [1, 2, 3, 4, 5];
  const out = await mapLimit(items, 2, async v => v * 10, { timeoutMs: 2000 });
  assert.deepStrictEqual(out, [10, 20, 30, 40, 50], 'success clears timer');
  await assert.rejects(mapLimit([1, 2], 4, async v => { if (v === 2) throw new Error('boom2'); return v; }), /boom2/);
  const started = Date.now();
  await assert.rejects(
    mapLimit([1], 1, () => new Promise(() => {}), { timeoutMs: 80 }),
    { code: 'MAP_LIMIT_TIMEOUT' }
  );
  assert.ok(Date.now() - started < 3000);
  // empty array with fn
  assert.deepStrictEqual(await mapLimit([], 3, async v => v), []);
  // concurrency clamping to item count
  let concurrentPeak = 0, active = 0;
  await mapLimit([1, 2, 3], 100, async () => {
    active++; concurrentPeak = Math.max(concurrentPeak, active);
    await new Promise(r => setTimeout(r, 20));
    active--;
  });
  assert.ok(concurrentPeak <= 3);
});

// ── utils/ssrf.js ───────────────────────────────────────────
test('hostIsPrivate all classes', () => {
  const priv = ['localhost', 'a.localhost', 'x.local', 'y.internal', 'host.docker.internal', '10.0.0.1', '192.168.1.2', '172.16.0.1', '172.31.255.255', '127.0.0.1', '0.0.0.0', '169.254.1.1', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'fe9f::1', 'ff02::1', '224.0.0.1', '240.0.0.1', '::ffff:127.0.0.1', '::ffff:2130706433', '2130706433', '0x7f000001', '0177.0.0.1', '0177.0.0.0x1', '0177.1.1.1'];
  for (const h of priv) assert.strictEqual(ssrf.hostIsPrivate(h), true, h);
  const pub = ['example.com', '93.184.216.34', '1.2.3.4', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.internal.org'];
  for (const h of pub) assert.strictEqual(ssrf.hostIsPrivate(h), false, h);
  assert.strictEqual(ssrf.hostIsPrivate(''), true);
  assert.strictEqual(ssrf.hostIsPrivate('[::1]'), true);
  assert.strictEqual(ssrf.hostIsPrivate(null), true);
  assert.strictEqual(ssrf.normalizeHostForCheck('[2606:2800::1]'), '2606:2800::1');
});

test('normalizeHostForCheck encoded ips', () => {
  assert.strictEqual(ssrf.normalizeHostForCheck('::ffff:3232235777'), '192.168.1.1');
  assert.strictEqual(ssrf.normalizeHostForCheck('::ffff:300.1'), '::ffff:300.1');
  assert.strictEqual(ssrf.normalizeHostForCheck('0x0badc0de'), '11.173.192.222');
  assert.strictEqual(ssrf.normalizeHostForCheck('999'), '0.0.3.231');
  assert.strictEqual(ssrf.normalizeHostForCheck('09999999999'), '0.0.0.0');
  assert.strictEqual(ssrf.normalizeHostForCheck('0xzz'), '0xzz');
  assert.strictEqual(ssrf.normalizeHostForCheck('1.2.3.999'), '1.2.3.999');
  assert.strictEqual(ssrf.normalizeHostForCheck('1.2.3.4.5'), '1.2.3.4.5');
  assert.strictEqual(ssrf.normalizeHostForCheck('0177.0.0.0x1'), '127.0.0.1');
  assert.strictEqual(ssrf.normalizeHostForCheck('::ffff:999.1.1.1'), '::ffff:999.1.1.1', 'mapped-malformed octets rejected');
  assert.strictEqual(ssrf.normalizeHostForCheck('4294967296'), '4294967296', 'decimal beyond v32 rejected');
  assert.strictEqual(ssrf.normalizeHostForCheck('0x1ffffffff'), '0x1ffffffff', 'hex beyond v32 rejected');
});

// ── engines/base.js ─────────────────────────────────────────
test('makeResult + SearchEngineError', () => {
  const r = makeResult({ title: ' a  ', url: ' b ', snippet: ' c ', engine: 'x', rank: 1 });
  assert.deepStrictEqual(r, { title: 'a', url: 'b', snippet: 'c', engine: 'x', rank: 1 });
  const e = new SearchEngineError('CODE', 'msg', { a: 1 });
  assert.strictEqual(e.name, 'SearchEngineError');
  assert.strictEqual(e.code, 'CODE');
  assert.deepStrictEqual(e.details, { a: 1 });
});

// ── registry/* ──────────────────────────────────────────────
test('ToolRegistry full', async () => {
  const reg = new ToolRegistry();
  reg.registerTool({ name: 't1', title: 'T1', description: 'D1', inputSchema: { type: 'object' }, zodSchema: z.object({}), handler: async () => ({ ok: 1 }) });
  assert.throws(() => reg.registerTool({ name: 't1', handler: async () => {} }), /already registered/);
  assert.strictEqual(reg.getTool('t1').description, 'D1');
  assert.strictEqual(reg.getTool('nope'), null);
  assert.throws(() => reg.callTool('nope', {}), /Unknown tool/);
  assert.strictEqual((await reg.callTool('t1', {})).ok, 1);
  assert.strictEqual(reg.listTools().length, 1);
  assert.strictEqual(reg.getMcpToolSchemas().length, 1);
  const fakeServer = { registerTool: (name, schema, handler) => fakeServer.registered.push({ name, schema, handler }), registered: [] };
  reg.registerTool({ name: 't2', title: 'T2', description: 'D2', inputSchema: {}, handler: async () => { throw new Error('kaboom'); } });
  reg.registerTool({ name: 't3', title: 'T3', description: 'D3', inputSchema: {}, handler: async () => { const e = new Error('withcode'); e.code = 'C1'; throw e; } });
  reg.toMcpSdk(fakeServer);
  assert.strictEqual(fakeServer.registered.length, 3);
  const good = await fakeServer.registered[0].handler({}, {});
  assert.strictEqual(good.content[0].type, 'text');
  assert.deepStrictEqual(JSON.parse(good.content[0].text), { ok: 1 });
  const bad = await fakeServer.registered[1].handler({}, {});
  assert.strictEqual(bad.isError, true);
  assert.ok(bad.content[0].text.includes('kaboom'));
  const bad2 = await fakeServer.registered[2].handler({}, {});
  assert.ok(bad2.content[0].text.includes('C1'));
});

test('SourceRegistry full', () => {
  const reg = new SourceRegistry();
  assert.ok(reg.getSource('openalex') !== null);
  assert.strictEqual(reg.getSource('nope'), null);
  assert.ok(reg.getEnabledSources().length >= 7);
  assert.ok(reg.getSourcesByCapability('citation_graph').length >= 1);
  assert.deepStrictEqual(reg.getSourceRateLimit('openalex'), { minIntervalMs: 120, maxConcurrency: 2 });
  assert.strictEqual(reg.getSourceRateLimit('nope'), null);
  assert.strictEqual(reg.isSourceEnabled('openalex'), true);
  assert.strictEqual(reg.isSourceEnabled('nope'), false);
  reg.register({ id: 'custom_x', type: 'test', capabilities: ['paper_search'], rateLimit: null });
  assert.strictEqual(reg.getSource('custom_x').type, 'test');
  assert.strictEqual(reg.getSource('custom_x').requiresKey, false);
  reg.register({ id: 'disabled1', enabled: false });
  assert.strictEqual(reg.isSourceEnabled('disabled1'), false);
  assert.ok(Object.keys(ACADEMIC_SOURCE_POLICIES).length >= 7);
});

// ── evidence/* ──────────────────────────────────────────────
test('EvidenceBundleBuilder + evidenceTypes', () => {
  const b = new EvidenceBundleBuilder({ bundleId: 'eb_x', query: 'q', sourcePolicy: { a: 1 } });
  b.addWebResult({}).addFetchedPage({}).addPaper({ title: 'p' }).addCitationEdge({}).addFailure({});
  const built = b.build();
  assert.strictEqual(built.item_count, 4);
  assert.strictEqual(built.failure_count, 1);
  assert.strictEqual(built.bundle_id, 'eb_x');
  const empty = new EvidenceBundleBuilder({}).addPaper({ x: 1 }).build();
  assert.ok(empty.bundle_id.startsWith('eb_'));
  assert.ok(Object.values(evTypes.EVIDENCE_TYPES).length >= 5);
  assert.strictEqual(evTypes.gradeFromSource(true, true, true, 60), 'S');
  assert.strictEqual(evTypes.gradeFromSource(true, false, false, 25), 'A+');
  assert.strictEqual(evTypes.gradeFromSource(false, true, true, 6), 'A');
  assert.strictEqual(evTypes.gradeFromSource(false, true, false, 1), 'B');
  assert.strictEqual(evTypes.gradeFromSource(false, false, false, 0), 'C');
  assert.strictEqual(evTypes.confidenceLevelFromScore(0.95), 'high');
  assert.strictEqual(evTypes.confidenceLevelFromScore(0.7), 'medium');
  assert.strictEqual(evTypes.confidenceLevelFromScore(0.4), 'low');
  assert.strictEqual(evTypes.confidenceLevelFromScore(0.1), 'unverified');
});

// ── common/circuitBreaker.js ────────────────────────────────
test('CircuitBreaker all transitions', async () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 40, halfOpenMaxRequests: 1 });
  assert.strictEqual(cb.state, CircuitState.CLOSED);
  await cb.call(async () => 1);
  await assert.rejects(cb.call(async () => { throw new Error('e1'); }));
  await assert.rejects(cb.call(async () => { throw new Error('e2'); }));
  assert.strictEqual(cb.state, CircuitState.OPEN);
  await assert.rejects(cb.call(async () => 1), { code: 'CIRCUIT_OPEN' });
  assert.strictEqual(cb.state, CircuitState.OPEN);
  await new Promise(r => setTimeout(r, 50));
  let releaseHalfOpen;
  const halfOpenGate = new Promise(r => { releaseHalfOpen = r; });
  const slow = cb.call(async () => halfOpenGate.then(() => 2));
  assert.strictEqual(cb.state, CircuitState.HALF_OPEN);
  await assert.rejects(cb.call(async () => 3), { code: 'CIRCUIT_HALF_OPEN_BUSY' });
  releaseHalfOpen();
  assert.strictEqual(await slow, 2);
  assert.strictEqual(cb.state, CircuitState.CLOSED);
  cb.reset();
  assert.strictEqual(cb.state, CircuitState.CLOSED);
  assert.strictEqual(cb._successCount, 0);
  // half-open direct success closes circuit
  const cb2 = new CircuitBreaker({ threshold: 1, cooldownMs: 10 });
  await assert.rejects(cb2.call(async () => { throw new Error('x'); }));
  assert.strictEqual(cb2.state, CircuitState.OPEN);
  await new Promise(r => setTimeout(r, 15));
  await cb2.call(async () => 5);
  assert.strictEqual(cb2.state, CircuitState.CLOSED);
  // half-open failure re-opens
  const cb3 = new CircuitBreaker({ threshold: 1, cooldownMs: 10 });
  await assert.rejects(cb3.call(async () => { throw new Error('x'); }));
  await new Promise(r => setTimeout(r, 15));
  await assert.rejects(cb3.call(async () => { throw new Error('y'); }));
  assert.strictEqual(cb3.state, CircuitState.OPEN);
});

// ── common/rateLimiter.js ───────────────────────────────────
test('RateLimiter queue limit + spacing', async () => {
  // queue-full when 1 active + 2 queued
  const rl = new RateLimiter({ minIntervalMs: 60, maxConcurrency: 1, maxQueueSize: 2 });
  const tasks = [rl.acquire('k'), rl.acquire('k'), rl.acquire('k')];
  await assert.rejects(rl.acquire('k'), /queue full/);
  const t0 = Date.now();
  rl.release('k'); await tasks[0];
  rl.release('k'); await tasks[1];
  rl.release('k'); await tasks[2];
  assert.ok(Date.now() - t0 >= 0);
  // spacing: a second acquire waits for minInterval
  const rl2 = new RateLimiter({ minIntervalMs: 80, maxConcurrency: 1, maxQueueSize: 10 });
  const started = Date.now();
  const a1 = rl2.acquire('q');
  rl2.release('q');
  await a1;
  const a2 = rl2.acquire('q');
  rl2.release('q');
  await a2;
  assert.ok(Date.now() - started >= 60, 'second acquire must be spaced by minInterval');
  // maxConcurrency batch: two dispatch; third stays queued until release
  const rl3 = new RateLimiter({ minIntervalMs: 0, maxConcurrency: 2, maxQueueSize: 10 });
  const b1 = rl3.acquire('b'); const b2 = rl3.acquire('b'); const b3 = rl3.acquire('b');
  await Promise.race([Promise.all([b1, b2]), new Promise((_, rej) => setTimeout(() => rej(new Error('batch dispatch failed')), 1000))]);
  assert.ok(true);
  rl3.release('b');
  await Promise.race([b3, new Promise((_, rej) => setTimeout(() => rej(new Error('queued acquire stuck')), 1000))]);
  rl3.release('b');
  // release on unknown bucket is a no-op
  const rl4 = new RateLimiter();
  rl4.release('nope');
  // drain when queued items exist but active slots free up
  const rl5 = new RateLimiter({ minIntervalMs: 20, maxConcurrency: 1, maxQueueSize: 5 });
  const w1 = rl5.acquire('w');
  const w2 = rl5.acquire('w');
  rl5.release('w'); await w1;
  rl5.release('w'); await w2;
  // batch path: queue non-empty with free slots after dispatch (setImmediate drain)
  const rl6 = new RateLimiter({ minIntervalMs: 0, maxConcurrency: 1, maxQueueSize: 5 });
  const c1 = rl6.acquire('c');
  const c2 = rl6.acquire('c');
  rl6.release('c');
  await c1;
  rl6.release('c');
  await c2;
});

// ── common/retryPolicy.js ───────────────────────────────────
test('retry policy branches', async () => {
  let n = 0;
  const ok = await retry(async () => { n++; if (n < 3) { const e = new Error('flaky'); e.status = 503; throw e; } return 'done'; }, { baseDelayMs: 5, maxRetries: 3, jitter: false });
  assert.strictEqual(ok, 'done');
  let m = 0;
  await assert.rejects(retry(async () => { m++; const e = new Error('status'); e.status = 429; return { status: 429 }; }, { baseDelayMs: 5, maxRetries: 2 }), e => e.status === 429);
  await assert.rejects(retry(async () => { throw Object.assign(new Error('abort'), { name: 'AbortError' }); }, { maxRetries: 3 }), { name: 'AbortError' });
  await assert.rejects(retry(async () => { throw Object.assign(new Error('nested'), { cause: { code: 'ABORT_ERR' } }); }), e => e.message === 'nested');
  await assert.rejects(retry(async () => { throw Object.assign(new Error('deep'), { cause: { cause: { name: 'AbortError' } } }); }), { message: 'deep' });
  await assert.rejects(retry(async () => { const e = new Error('nope'); e.code = 'ABORT_ERR'; throw e; }), { code: 'ABORT_ERR' });
  let k = 0;
  await assert.rejects(retry(async () => { k++; throw new Error('perm'); }, { maxRetries: 0 }), e => e.attempts === 1);
  let s = 0;
  await assert.rejects(retry(async () => { s++; throw new Error('noretry'); }, { maxRetries: 5, shouldRetry: () => false }), e => e.attempts === 1);
  let j = 0;
  await assert.rejects(retry(async () => { j++; throw new Error('stop'); }, { maxRetries: 5, shouldRetry: (err, attempt) => attempt < 1 }), e => e.attempts === 2);
  const rp = new RetryPolicy({ baseDelayMs: 5, maxRetries: 1 });
  let z = 0;
  assert.strictEqual(await rp.execute(async () => { z++; if (z < 2) throw new Error('again'); return 9; }), 9);
});

// ── misc: engines/zod presence ──────────────────────────────
test('buildOpenApiSpec shape', () => {
  const spec = buildOpenApiSpec('http://test:9000');
  assert.strictEqual(spec.openapi, '3.1.0');
  assert.strictEqual(Object.keys(spec.paths).length, 7);
});
