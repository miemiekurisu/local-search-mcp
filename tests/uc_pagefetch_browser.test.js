import './helpers/mocks.mjs';

process.env.PDF_BODY_TIMEOUT_MS = '150';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp, jsonResponse, sleep, pdfParseState } from './helpers/mocks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const st = undiciState();
const pdfState = pdfParseState();
const { PageFetcher } = await import('../src/fetch/pageFetcher.js');
const { ArtifactStore } = await import('../src/artifacts/artifactStore.js');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-pagefetch-'));
const artifactStore = new ArtifactStore(artifactDir);
test.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

const noopProxyRouter = { resolve: () => ({ proxyUrl: null, profile: 'auto' }) };

function noBrowserPool(log = []) {
  log.withPage = async (opts, fn) => { log.push(opts); return await fn(makeBrowserPage(log)); };
  return log;
}

function makeBrowserPage(over = {}) {
  return {
    route: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},   // override in tests to throw when wanted
    evaluateNames: [],
    evaluate: async (fn, arg) => over.bodyText ?? 'x'.repeat(200),
    title: async () => over.title ?? 'Page Title',
    close: async () => {},
    ...over
  };
}

function makePool(opts) {
  return new PageFetcher({ proxyRouter: noopProxyRouter, browserPool: opts?.browserPool, artifactStore });
}

test('fetchHttp happy page path via mocked undici', async () => {
  st.responses = [makeResp({
    statusText: 'OK',
    headers: { 'content-type': 'text/html; charset=utf-8' },
    text: `<html><title> titolo </title><body>${'word '.repeat(60)}</body></html>`
  })];
  const pf = makePool();
  const out = await pf.fetchPage('https://example.org/page');
  assert.equal(out.status, 'success');
  assert.equal(out.fetch_mode, 'http');
  assert.ok(await out.artifact_ref);
});

test('fetchHttp propagates body read errors and blocked page markers', async () => {
  const bad = jsonResponse({ x: 1 });
  bad.body = { [Symbol.asyncIterator]() { return { next: async () => { throw Object.assign(new Error('read boom'), { code: 'BODY_ERROR' }); } }; } };
  st.responses = [bad];
  const pf = makePool();
  const out1 = await pf.fetchPage('https://example.org/a', { mode: 'http' });
  assert.equal(out1.status, 'failed');
  assert.equal(out1.failure_code, 'BODY_ERROR');

  st.responses = [makeResp({ status: 200, headers: { 'content-type': 'text/html' }, text: `<html>checking Cloudflare ${'w'.repeat(120)}</html>` })];
  const out2 = await pf.fetchPage('https://example.org/b', { mode: 'http' });
  assert.equal(out2.failure_code, 'PAGE_BLOCKED_OR_CAPTCHA');
});

test('fetchHttp rejects unsupported content types and empty extraction', async () => {
  st.responses = [makeResp({ headers: { 'content-type': 'application/zip' }, text: 'binary' })];
  const pf = makePool();
  const out3 = await pf.fetchPage('https://example.org/z', { mode: 'http' });
  assert.equal(out3.failure_code, 'UNSUPPORTED_CONTENT_TYPE');

  st.responses = [makeResp({ headers: { 'content-type': 'text/plain' }, text: 'tiny' })];
  const out = await pf.fetchPage('https://example.org/api', { mode: 'http' });
  assert.equal(out.failure_code, 'EXTRACTION_EMPTY');
});

test('cookie-browser fallback returns browser fetch results', async () => {
  let seenOptions = null;
  const browserPool = {
    withPage: async (opts, fn) => {
      seenOptions = opts;
      const page = { route: async () => {}, goto: async () => {}, waitForFunction: async () => { throw new Error('no text'); }, evaluate: async () => Array.from({ length: 120 }, (_, i) => `w${i}`).join(' '), title: async () => 'TT' };
      await new Promise((res) => setTimeout(res, 0));
      return await fn(page);
    }
  };
  const pf = makePool({ browserPool });
  const out = await pf.fetchPage('https://example.org/JS-page', { mode: 'browser' });
  assert.equal(out.status, 'success');
  assert.equal(out.fetch_mode, 'browser');
  assert.deepEqual(seenOptions.closeDelayMs, [4000, 8000], 'closeDelay default window');
  assert.ok(await out.artifact_ref);
});

test('browser mode reports captcha and empty pages', async () => {
  let smallText = 'captcha please verify';
  const browserPool = {
    withPage: async (opts, fn) => await fn({ route: async () => {}, goto: async () => {}, waitForFunction: async () => {}, evaluate: async () => smallText, title: async () => '' })
  };
  const pf = makePool({ browserPool });
  const captcha = await pf.fetchPage('https://example.org/c', { mode: 'browser' });
  assert.equal(captcha.status, 'captcha');
  assert.equal(captcha.keepPageOpen, true);

  smallText = 'a modest sentence without keywords and under eighty characters long';
  const empty = await pf.fetchPage('https://example.org/d', { mode: 'browser' });
  assert.equal(empty.failure_code, 'EXTRACTION_EMPTY');

  const browserPool2 = { withPage: async (opts, fn) => await fn(Object.assign(makeBrowserPage(), { bodyText: 'word '.repeat(40) })) };
  const pf2 = makePool({ browserPool: browserPool2 });
  const good = await pf2.fetchPage('https://example.org/e', { mode: 'browser' });
  assert.equal(good.status, 'success');
});

test('pdf: early failure path for failed pdf fetch (mode auto no browser)', async () => {
  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, status: 403 })];
  const pf = await makePool();
  const out = await pf.fetchPage('https://example.org/doc.pdf', { mode: 'auto' });
  assert.equal(out.failure_code, 'HTTP_403');
});

test('pdf happy path, title from url, invalid pdf, parse error, too large, timeout', async () => {
  st.responses = [makeResp({
    headers: { 'content-type': 'application/pdf' },
    chunks: [Buffer.from('%PDF-1.4 '), Buffer.from(' padded '.repeat(60))]
  })];
  const pdfStub = (getTextResult, infoResult) => ({
    load: async () => ({}),
    getText: async () => getTextResult,
    getInfo: async () => infoResult
  });
  pdfState.ctor = () => pdfStub({ text: 'extracted pdf body text '.repeat(30) }, { Title: ' Doc Title ', NPages: 5 });
  const pf = makePool();
  const out = await pf.fetchPage('https://example.org/papers/Neural_Net-Benchmark.pdf', { mode: 'http' });
  assert.equal(out.status, 'success');
  assert.equal(out.pdf_pages, 5);
  assert.equal(out.title, 'Doc Title');
  assert.equal(out.fetch_mode, 'pdf');

  pdfState.ctor = () => pdfStub({ text: 'recovered text '.repeat(30) }, null);
  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('%PDF-1.4 '), Buffer.from(' more text '.repeat(80))] })];
  const out2 = await pf.fetchPage('https://example.org/papers/Fallback_Title.pdf', { mode: 'http' });
  assert.equal(out2.status, 'success');
  assert.equal(out2.pdf_pages, 1);

  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('NOTPDFDATA')] })];
  assert.equal((await pf.fetchPage('https://example.org/x.pdf', { mode: 'http' })).failure_code, 'INVALID_PDF');

  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('%PDF-1. ')] })];
  pdfState.ctor = () => pdfStub({ text: '' }, {});
  const shortPdf = await pf.fetchPage('https://example.org/x.pdf', { mode: 'http' });
  assert.equal(shortPdf.failure_code, 'PDF_EXTRACTION_EMPTY', 'valid header but no text');

  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('%PDF-1.4 ')] })];
  pdfState.ctor = () => pdfStub({ text: '' }, {});
  assert.equal((await pf.fetchPage('https://example.org/x.pdf', { mode: 'http' })).failure_code, 'PDF_EXTRACTION_EMPTY');

  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('x'.repeat(50 * 1024 * 1024 + 100))] })];
  assert.equal((await pf.fetchPage('https://example.org/x.pdf', { mode: 'http' })).failure_code, 'PDF_TOO_LARGE');

  const hanging = {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: (k) => (k === 'content-type' ? 'application/pdf' : null) },
    body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }
  };
  st.responses = [hanging];
  const pdfhanger = await pf.fetchPage('https://example.org/y.pdf', { mode: 'http' });
  assert.equal(pdfhanger.failure_code, 'PDF_BODY_TIMEOUT');

  pdfState.ctor = () => { throw new Error('pdf ctor boom'); };
  st.responses = [makeResp({ headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('%PDF-1.4 data')] })];
  assert.equal((await pf.fetchPage('https://example.org/z.pdf', { mode: 'http' })).failure_code, 'PDF_PARSE_ERROR');
});

test('browser error still returns failure result with both attempts', async () => {
  const browserPool = { withPage: async () => { throw Object.assign(new Error('browser rc'), { code: 'BROWSER_GONE' }); } };
  const pf = makePool({ browserPool });
  const out = await pf.fetchPage('https://example.org/f', { mode: 'browser' });
  assert.equal(out.failure_code, 'BROWSER_GONE');
  assert.ok(out.attempts.some(a => a.mode === 'browser' && a.status === 'failed'));

  st.responses = [];
  const pf2 = makePool({});
  const withDeadline = await pf2.fetchPage('https://example.org/g', { mode: 'auto', deadline: Date.now() - 10 });
  assert.ok(withDeadline.attempts.some(a => a.code === 'DEADLINE_EXCEEDED'));
});

test('normalizeUrl rewrites reddit and passes through invalid URLs', async () => {
  const pf = makePool({});
  assert.equal(pf.normalizeUrl('https://www.reddit.com/r/node/comments/1'), 'https://old.reddit.com/r/node/comments/1');
  assert.equal(pf.normalizeUrl('https://not spa ce'), 'https://not spa ce');
  const blocked = await pf.fetchPage('localhost:8080/x', { mode: 'http' });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.failure_code, 'BLOCKED_URL');

  assert.equal(pf.validateUrl('ftp://example.org/x'), false, 'non-http scheme');
  assert.equal(pf.validateUrl('https://:8080/x'), false, 'missing hostname');
  assert.equal(pf.validateUrl('http://[unclosed'), false, 'URL parse error path');
  assert.equal(pf._extractTitleFromUrl('https://example.org/docs/Paper_Neural-Net.pdf'), 'Paper Neural Net');
  assert.equal(pf._extractTitleFromUrl('http://[unclosed'), '', 'URL parse error path');
});

test('undici mock at least queues error flows exercised above', async () => {
  st.responses = [() => { throw new Error('network gone'); }];
  const pf = makePool({});
  const out = await pf.fetchPage('https://example.org/z', { mode: 'http' });
  assert.equal(out.failure_code, 'HTTP_FETCH_ERROR');
});

test('BROWSER_FETCH_CLOSE_DELAY_MS env variants reach closeDelayMs', async () => {
  const mk = () => makePool({ browserPool: { withPage: async (_o, fn) => await fn({ route: async () => {}, goto: async () => {}, waitForFunction: async () => {}, evaluate: async () => 'word '.repeat(30), title: async () => '' }) } });
  let seen = null;
  const cap = mk();
  cap.browserPool.withPage = async (o, fn) => { seen = o; return await fn({ route: async () => {}, goto: async () => {}, waitForFunction: async () => {}, evaluate: async () => 'word '.repeat(30), title: async () => '' }); };

  process.env.BROWSER_FETCH_CLOSE_DELAY_MS = '1234,567';
  await cap.fetchPage('https://example.org/cd1', { mode: 'browser' });
  assert.deepEqual(seen.closeDelayMs, [1234, 1234], 'pair picks max as upper bound');

  process.env.BROWSER_FETCH_CLOSE_DELAY_MS = '900';
  await cap.fetchPage('https://example.org/cd2', { mode: 'browser' });
  assert.deepEqual(seen.closeDelayMs, 900, 'single number');

  process.env.BROWSER_FETCH_CLOSE_DELAY_MS = 'not-a-number';
  await cap.fetchPage('https://example.org/cd3', { mode: 'browser' });
  assert.deepEqual(seen.closeDelayMs, [4000, 8000], 'invalid falls back to default');

  delete process.env.BROWSER_FETCH_CLOSE_DELAY_MS;
});
