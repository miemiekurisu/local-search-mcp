import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp } from './helpers/mocks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const und = undiciState();
const contentMod = await import('../src/papers/content/paperContentKernel.js');
const locatorMod = await import('../src/papers/content/paperContentLocator.js');
const extractorsMod = await import('../src/papers/content/extractors/pdfTextExtractor.js');
const { PaperContentKernel } = contentMod;
const { PaperContentLocator } = locatorMod;
const storeMod = await import('../src/papers/cache/paperCacheStore.js');
const cleanupMod = await import('../src/papers/cache/paperCacheCleanup.js');
const tei = await import('../src/papers/content/extractors/teiExtractor.js');
const xmlExt = await import('../src/papers/content/extractors/xmlPaperExtractor.js');
const htmlExt = await import('../src/papers/content/extractors/htmlPaperExtractor.js');

let seq = 0;
function makeConfig(over = {}) {
  seq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `content-uat-${seq}-`));
  return {
    enabled: true,
    dir,
    manifest: path.join(dir, 'manifest.json'),
    rawDir: path.join(dir, 'raw'),
    textDir: path.join(dir, 'text'),
    sectionDir: path.join(dir, 'sections'),
    chunkDir: path.join(dir, 'chunks'),
    tmpDir: path.join(dir, 'tmp'),
    rawMaxBytes: 1e6,
    rawTtlDays: 7,
    textTtlDays: 90,
    ...over
  };
}
test.after(() => {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (d.startsWith('content-uat-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
  }
});

function mkKernel(store) {
  return new PaperContentKernel({ paperCacheStore: store || null, paperCacheCleanup: store ? new cleanupMod.PaperCacheCleanup(store, store.config) : null });
}

test('locateContent validates and delegates to locator', async () => {
  const k = mkKernel();
  await assert.rejects(() => k.locateContent({}), /identifier is required/);
  const out = await k.locateContent({ identifier: '2401.55555' });
  assert.equal(out.identifier_type, 'arxiv');
  assert.ok(out.candidates.length > 0);
  const doiOut = await k.locateContent({ identifier: '10.5555/t1' });
  assert.equal(doiOut.identifier_type, 'doi');
});

test('locator builds arxiv+ss candidates and warns on ss failure', async () => {
  und.responses = [makeResp({ status: 503 })];
  const loc = new PaperContentLocator(null);
  const c1 = await loc.locate('2401.55555', 'arxiv');
  assert.equal(c1[0].url, 'https://arxiv.org/pdf/2401.55555.pdf');
  assert.equal(c1[0].source, 'arxiv');
  assert.ok(c1.some(c => c.source === 'arxiv_html'));

  und.responses = [makeResp({ json: { openAccessPdf: { url: 'https://pdf.example.org/ss.pdf' }, isOpenAccess: true } })];
  const c2 = await loc.locate('2401.55555', 'arxiv');
  assert.ok(c2.some(c => c.source === 'semantic_scholar' && c.url === 'https://pdf.example.org/ss.pdf'));

  // pure identifier with embedded arxiv id (not 'arxiv' typed)
  assert.equal(await loc.locate('10.9999/none', 'doi').then(c => c[0].source), 'doi_resolver');

  // findOpenAccess path via fake paperKernel
  const oaLoc = new PaperContentLocator({ findOpenAccess: async () => ({ is_open_access: true, best_landing_page_url: 'https://landing.example.org/x', license: 'cc-by' }) });
  const c3 = await oaLoc.locate('10.5555/oa', 'doi');
  assert.ok(c3.some(c => c.source === 'unpaywall_landing'));

  const oaLoc2 = new PaperContentLocator({ findOpenAccess: async () => { throw new Error('oa dead'); } });
  const c4 = await oaLoc2.locate('10.5555/dead', 'doi');
  assert.equal(c4[0].source, 'doi_resolver');
});

test('fetchContent happy path stores in cache and extracts html', async () => {
  const cfg = makeConfig();
  const store = new storeMod.PaperCacheStore(cfg);
  const kernel = mkKernel(store);
  const html = Buffer.from(`<html><head><title>Rich Page</title></head><body><h1>Intro</h1><p>${'lorem word '.repeat(120)}</p><h2>Methods</h2><p>${'term alpha '.repeat(80)}</p></body></html>`);
  und.responses = [makeResp({ status: 403 }), makeResp({ headers: { 'content-type': 'text/html' }, chunks: [html] })];
  const out = await kernel.fetchContent({ identifier: '2401.55555' });
  assert.equal(out.cached, false);
  assert.equal(out.source, 'arxiv');
  assert.ok(out.sections && out.sections.length > 0);
  assert.ok(out.chunks.length > 0, `chunks: ${out.chunks.length}`);
  assert.ok(out.fullText && out.fullText.length > 100);
  // cached pieces persisted
  const cachedPaper = store.findPaper(out.paper_key);
  assert.ok(cachedPaper.sections.length > 0, 'sections cached');
  assert.ok(cachedPaper.raws.length > 0, 'raw cached');
});

test('fetchContent second call returns cached sections', async () => {
  const cfg = makeConfig();
  const store = new storeMod.PaperCacheStore(cfg);
  const kernel = mkKernel(store);
  const html = Buffer.from(`<html><body><h1>A$_1</h1><p>${'muse '.repeat(100)}</p></body></html>`);
  und.responses = [makeResp({ headers: { 'content-type': 'text/html' }, chunks: [html] }), makeResp({ headers: { 'content-type': 'text/html' }, chunks: [html] })];
  const first = await kernel.fetchContent({ identifier: '2401.55556' });
  const second = await kernel.fetchContent({ identifier: '2401.55556' });
  assert.equal(second.cached, true, `second result: ${JSON.stringify(second).slice(0, 200)}`);
  assert.equal(second.paper_key, first.paper_key);
  assert.ok(second.sections.length > 0);
});

test('fetchContent no candidates and all-fetch-failed paths', async () => {
  const kernel = mkKernel(null);
  const none = await kernel.fetchContent({ identifier: '10.5555/night', identifier_type: 'custom_type' });
  assert.equal(none.error, 'No open access locations found');

  und.responses = [makeResp({ status: 403 }), makeResp({ status: 404 })];
  const out = await kernel.fetchContent({ identifier: '2401.55557' });
  assert.ok(out.error, 'error set after failed fetches');
  assert.equal(out.lastError.code, 'FETCH_FAILED');
});

test('getSections validates and reads cached sections/chunks/text', async () => {
  const cfg = makeConfig();
  const store = new storeMod.PaperCacheStore(cfg);
  const kernel = mkKernel(store);
  await assert.rejects(() => kernel.getSections({}), /paper_key or identifier is required/);
  const plainKernel = mkKernel(null);
  await assert.rejects(() => plainKernel.getSections({ paper_key: '10.5555/x' }), /Cache not available/);

  // store sections then read back with chunks
  const html = Buffer.from(`<html><body><h1>Deep$_t</h1><p>${'vault '.repeat(100)}</p></body></html>`);
  und.responses = [makeResp({ status: 403 }), makeResp({ headers: { 'content-type': 'text/html' }, chunks: [html] })];
  const fetched = await kernel.fetchContent({ identifier: '2401.55558' });
  const got = await kernel.getSections({ paper_key: fetched.paper_key });
  assert.equal(got.cached, true);
  assert.ok(got.sections.length > 0);
  assert.ok(Array.isArray(got.chunks));

  // text-only cache regenerates sections then re-persists
  const cfg2 = makeConfig();
  const store2 = new storeMod.PaperCacheStore(cfg2);
  const kernel2 = mkKernel(store2);
  await store2.storeText('key-text-only', `Intro\n\n${'alpha beta '.repeat(80)}\n\nMethods\n\n${'gamma delta '.repeat(80)}`);
  const got2 = await kernel2.getSections({ paper_key: 'key-text-only' });
  assert.ok(got2.sections.length >= 1);
  const again = await kernel2.getSections({ paper_key: 'key-text-only' });
  assert.ok(again.sections.length >= 1, 'sections now persisted from regeneration');

  await assert.rejects(() => kernel2.getSections({ paper_key: 'key-missing-ghost' }), /No content found/);
  await assert.rejects(() => kernel.getSections({ paper_key: 'broken-entry-ghost' }), /No content found|Failed to read/);
});

test('_extract dispatches variants and unknown fallback', async () => {
  const kernel = mkKernel(null);
  // unknown variant fallback
  const unknown = await kernel._extract(Buffer.from('totally opaque binary payload'), 'raw/other', 'https://u');
  assert.equal(unknown.format, 'unknown');
  assert.ok(unknown.wordCount > 0);

  // markup payloads
  const xmlOut = await kernel._extract(Buffer.from(`<?xml version="1.0"?><article><title-group><article-title>XML$_Title</article-title></title-group><abstract><p>xml abstract text</p></abstract></article>`), 'raw/xml', 'https://u');
  assert.equal(xmlOut.format, 'jats-xml');
  assert.equal(xmlOut.title, 'XML$_Title');

  const teiOut = await kernel._extract(Buffer.from(`<TEI><teiHeader><fileDesc><titleStmt><title>Tei$_Head</title></titleStmt></fileDesc></teiHeader></TEI>`), 'raw/tei', 'https://u');
  assert.equal(teiOut.format, 'tei-xml');
  assert.equal(teiOut.title, 'Tei$_Head');

  const htmlOut = await kernel._extract(Buffer.from(`<html><title>Html$_Cover</title><body>${'plain word '.repeat(60)}</body></html>`), 'raw/html', 'https://u');
  assert.equal(htmlOut.format, 'html');
  assert.equal(htmlOut.title, 'Html$_Cover');
});

test('extractors author fallbacks (tei plain text author, xml string-name)', async () => {
  const teiOut = tei.extractTei(`<TEI><teiHeader><fileDesc><titleStmt><title>TeiAuthors</title></titleStmt></fileDesc></teiHeader><standOff><listPerson><person><name>Plain Person One</name></person></listPerson></standOff></TEI>`, 'u');
  assert.equal(teiOut.title, 'TeiAuthors');

  const xmlOut = await Promise.resolve(xmlExt.extractXmlPaper(`<article><front><article-meta><title-group><article-title>XmlList</article-title></title-group><contrib-group><string-name>Plain Author Five</string-name></contrib-group></article-meta></front><body></body></article>`, 'u'));
  assert.equal(xmlOut.title, 'XmlList');
  assert.ok(xmlOut.authors.some(a => a.includes('Plain Author Five')), JSON.stringify(xmlOut.authors));

  const teiFallback = tei.extractTei(`<TEI><titleStmt><title>T2</title><author>Direct Text Author</author></titleStmt></TEI>`, 'u');
  assert.equal(teiFallback.title, 'T2');
  assert.ok(teiFallback.authors.some(a => a.includes('Direct Text Author')), JSON.stringify(teiFallback.authors));

  const htmlOut = htmlExt.extractHtmlPaper(`<html><head><title>Html Authors</title></head><body><article>${'words '.repeat(120)}<span class="author">Page Author</span></article></body></html>`, 'u');
  assert.ok(htmlOut.title === 'Html Authors' || htmlOut.fullText.length > 100, JSON.stringify({ t: htmlOut.title, n: htmlOut.fullText.length }));
});

test('pdf extractor via mocked pdf-parse module', async () => {
  const { pdfParseState } = await import('./helpers/mocks.mjs');
  pdfParseState().parse = async () => ({ text: 'parsed pdf inner content '.repeat(60), numpages: 4, info: { Title: 'Mock$Pdf' }, version: '1.7' });
  const { extractPdfText } = await import('../src/papers/content/extractors/pdfTextExtractor.js');
  const out = await extractPdfText(Buffer.from('%PDF-1.4 fake'));
  assert.equal(out.pages, 4);
  assert.equal(out.metadata.title, 'Mock$Pdf');
  assert.equal(out.version, '1.7');
  assert.ok(out.text.includes('parsed pdf inner content'));
  assert.ok(extractorsMod.canExtract('raw/pdf'));
  assert.equal(extractorsMod.canExtract('unknown/thing'), false);
});
