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

// ──── openapi/spec ──────────────────────────────────────────
test('buildOpenApiSpec shape', () => {
  const spec = buildOpenApiSpec('http://test:9000');
  assert.strictEqual(spec.openapi, '3.1.0');
  assert.strictEqual(Object.keys(spec.paths).length, 7);
});
