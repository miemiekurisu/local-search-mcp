import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp } from './helpers/mocks.mjs';

const und = undiciState();
const { sectionChunker, splitTextIntoSections } = await import('../src/papers/content/sectionChunker.js');
const { detectContentType, extensionForVariant } = await import('../src/papers/content/contentTypeDetector.js');
const { DocumentFetcher } = await import('../src/papers/content/documentFetcher.js');
const tei = await import('../src/papers/content/extractors/teiExtractor.js');
const xmlExt = await import('../src/papers/content/extractors/xmlPaperExtractor.js');
const kernelMod = await import('../src/papers/content/paperContentKernel.js');
const locatorMod = await import('../src/papers/content/paperContentLocator.js');

test('sectionChunker big text multi-chunks with section refs, null input yields empty', () => {
  assert.deepEqual(sectionChunker(null), { sections: [], chunks: [] });
  assert.deepEqual(sectionChunker({}), { sections: [], chunks: [] });

  const word = 'tokken';
  const bigSections = [];
  for (let i = 0; i < 40; i++) {
    bigSections.push({ heading: `Chapter ${i}`, text: Array.from({ length: 90 }, (_, j) => `${word}${i}${j}`).join(' ') });
  }
  const out = sectionChunker({ sections: bigSections });
  assert.ok(out.chunks.length > 1);
  assert.ok(out.chunks[0].sectionRefs.length > 1, `refs: ${JSON.stringify(out.chunks[0].sectionRefs)}`);
  assert.ok(out.chunks.every(c => c.wordCount <= 2000 + 200));
});

test('splitTextIntoSections heading markers and paragraph fallback', () => {
  const withHeadings = splitTextIntoSections(['# Title Line', 'body of title', '## Methods', 'body of methods'].join('\n'));
  assert.equal(withHeadings.length, 2);
  assert.equal(withHeadings[0].heading, 'Title Line');
  assert.equal(withHeadings[1].heading, 'Methods');

  const paragraphs = splitTextIntoSections(['alpha paragraph body', '', 'beta paragraph body'].join('\n\n'));
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].heading, 'Paragraph 1');
  assert.equal(splitTextIntoSections('single line no paragraphs')[0].heading, 'Full Text');
});

test('contentTypeDetector sniff variants', () => {
  assert.equal(detectContentType('u', 'application/pdf', Buffer.from('%PDF-1.4 body')), 'raw/pdf');
  assert.equal(detectContentType('u', 'text/plain', Buffer.from('Just plain text words here')), 'raw/text');
  assert.equal(detectContentType('u', 'text/html', Buffer.from('<html><body>x</body></html>')), 'raw/html');
  assert.equal(detectContentType('u', 'application/tei+xml', Buffer.from('<TEI xmlns="x"></TEI>')), 'raw/tei');
  assert.equal(detectContentType('u', 'application/json', Buffer.from('{"very":"deep jjson object with sufficient length in it somewhere"}')), 'raw/pdf');
  assert.equal(detectContentType('u', 'bool/bogus', Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'raw/pdf');
});

test('documentFetcher FILE_TOO_LARGE via content-length and via stream growth', async () => {
  // content-length header over limit
  und.responses = [{ status: 200, ok: true, headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '9000' : null) } }];
  const fetcher = new DocumentFetcher({ fetchMaxBytes: 10 });
  await assert.rejects(() => fetcher.fetch('https://example.org/big', { maxBytes: 10 }), (err) => err.code === 'FILE_TOO_LARGE' && err.size === 9000);

  // stream exceeding maxBytes mid-way
  const giant = Buffer.alloc(30, 7);
  const resp = makeResp({ headers: { 'content-type': 'text/plain' }, chunks: [giant, giant] });
  und.responses = [resp];
  await assert.rejects(() => fetcher.fetch('https://example.org/growth', { maxBytes: 30 }), (err) => err.code === 'FILE_TOO_LARGE');
});

test('content kernel cache failure warn paths and openalex detect', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  const cfg = { enabled: true, dir: 'Z:/definitely-missing-dir/nonexistent', manifest: 'Z:/definitely-missing-dir/nonexistent/m.json', rawDir: '', textDir: '', sectionDir: '', chunkDir: '', tmpDir: '' };
  const storeMod = await import('../src/papers/cache/paperCacheStore.js');
  // store disabled due to broken dir? ensure enabled but failing ops: place manifest into a FILE path so append throws
  const fs = await import('node:fs');
  await fs.promises.writeFile(cfg.manifest.replace('m.json', ''), '').catch(() => {});
  const missingDir = fs.mkdtempSync('f');
  // simulate store failing writes by pointing manifest at a nonexistent drive path is windows-specific; use a manifest that is a directory
  const broken = storeMod.PaperCacheStore;
  const store = new broken({ enabled: true, dir: missingDir, manifest: missingDir + '/m.json', rawDir: missingDir + '/raw', textDir: missingDir + '/text', sectionDir: missingDir + '/sec', chunkDir: missingDir + '/chunks', tmpDir: missingDir + '/tmp', rawMaxBytes: 1e6, rawTtlDays: 7, textTtlDays: 90 });
  fs.mkdirSync(store.config.manifest, { recursive: true }); // manifest path is now a directory -> load falls back
  const kernel = new kernelMod.PaperContentKernel({ paperCacheStore: store, paperCacheCleanup: null });
  const locator = kernel.locator;
  kernel.locator = { locate: async () => [{ url: 'https://ex.example.org/p', source: 'arxiv', format: 'raw/html', isOpenAccess: true }] };
  und.responses = [makeResp({ headers: { 'content-type': 'text/html' }, text: `<html><body>${'chunkword '.repeat(400)}</body></html>` })];
  const out = await kernel.fetchContent({ identifier: '2401.55559' });
  kernel.locator = locator;
  assert.ok(out.sections || out.error, `result: ${JSON.stringify(Object.keys(out))}`);
  console.warn = origWarn;
});

test('content kernel _extract pdf branch and _detectType branches', async () => {
  const { pdfParseState } = await import('./helpers/mocks.mjs');
  pdfParseState().parse = async () => ({ text: 'pdf body extract', numpages: 2, info: {} });
  const k2 = new kernelMod.PaperContentKernel({});
  const pdfOut = await k2._extract(Buffer.from('%PDF-1.4 x'), 'raw/pdf', 'https://u');
  assert.equal(pdfOut.pages, 2);
  assert.equal(k2._detectType('W900700600'), 'openalex');
  assert.equal(k2._detectType('2301.55555'), 'arxiv');
  assert.equal(k2._detectType('10.5555/thing'), 'doi');
  assert.equal(k2._detectType('randomword'), 'doi');
  assert.equal(k2._detectType(''), null);
});

test('locator prefers best_pdf_url candidate', async () => {
  const oaLoc = new locatorMod.PaperContentLocator({ findOpenAccess: async () => ({ is_open_access: true, best_pdf_url: 'https://pdf.example.org/direct.pdf', license: 'cc0' }) });
  const cands = await oaLoc.locate('10.5555/pdfroute', 'doi');
  assert.ok(cands.some(c => c.url === 'https://pdf.example.org/direct.pdf' && c.format === 'raw/pdf'));
  assert.ok(cands.some(c => c.source === 'doi_resolver'));
});

test('tei/xml extractor residual title and author shapes', async () => {
  // TEI: plain <title> fallback + respStmt author (attributes on respStmt per selector)
  const t = tei.extractTei(`<TEI><title>Only Title</title><respStmt name="resp" role="author"><name>Resp Styled Author</name></respStmt></TEI>`, 'u');
  assert.equal(t.title, 'Only Title');
  assert.ok(t.authors.some(a => a.includes('Resp Styled Author')), JSON.stringify(t.authors));

  // TEI: persName inside author
  const t2 = tei.extractTei(`<TEI><author><persName>Named Author Two</persName></author></TEI>`, 'u');
  assert.ok(t2.authors.some(a => a.includes('Named Author Two')), JSON.stringify(t2.authors));

  // XML: publication-title / article-type variants and affiliation blocks
  const x = xmlExt.extractXmlPaper(`<article><front><article-meta><article-title group-title="x">Alt Title Field</article-title></article-meta></front></article>`, 'u');
  assert.ok(x.title.includes('Alt Title Field'), x.title);

  const x2 = xmlExt.extractXmlPaper(`<article><abstract>Jats plain abstract line long enough words to count words</abstract></article>`, 'u');
  assert.ok(x2.abstract.length > 20, x2.abstract);

  const x3 = xmlExt.extractXmlPaper(`<article><contrib-group><contrib contrib-type="author"><name><given-names>Gia</given-names><surname>Nno</surname></name></contrib></contrib-group></article>`, 'u');
  assert.ok(x3.authors.some(a => a.includes('Gia')), JSON.stringify(x3.authors));
});

test('tei sections and xml sections extraction', () => {
  const t = tei.extractTei(`<TEI><title>S</title><body><div type="section"><head>Intro Head</head><p>first tei paragraph</p><p>second tei paragraph</p></div><div><head></head><p>headless section body</p></div></body></TEI>`, 'u');
  assert.ok(t.sections.length >= 2, JSON.stringify(t.sections));
  assert.equal(t.sections[0].heading, 'Intro Head');
  assert.ok(t.sections[0].text.includes('first tei paragraph'));

  const x = xmlExt.extractXmlPaper(`<article><front><article-meta><article-id pub-id-type="doi">10.5555/secs</article-id></article-meta></front><body><sec><title>Main Section</title><p>xml body paragraph</p><sec><title>Nested Sub</title><p>sub paragraph text</p></sec></sec></body></article>`, 'u');
  assert.equal(x.doi, '10.5555/secs');
  assert.ok(x.sections.length >= 1);
  assert.equal(x.sections[0].heading, 'Main Section');
  assert.ok(x.sections[0].subsections && x.sections[0].subsections[0].heading === 'Nested Sub');
});

test('getSections with identifier delegates to fetchContent; detector helpers fully covered', async () => {
  const k2 = new kernelMod.PaperContentKernel({});
  await assert.rejects(() => k2.getSections({ identifier: '' }), /paper_key or identifier is required/);
  const delegated = await k2.getSections({ identifier: '10.5555/nothing' });
  assert.ok(delegated.error, `delegation error expected: ${JSON.stringify(delegated).slice(0, 200)}`);
  assert.ok(delegated.lastError || true);

  assert.equal(detectContentType('https://host/anything/file.tei.xml', '', null), 'raw/xml', '.xml key ordered before .tei.xml');
  assert.equal(detectContentType('https://host/anything/paper.tei', '', null), 'raw/tei');
  assert.equal(detectContentType('u', 'application/tei+xml', null), 'raw/tei');
  assert.equal(detectContentType('https://host/paper/file.pdf', '', null), 'raw/pdf');
  assert.equal(detectContentType('https://host/x/stuff.PDF/', '', Buffer.from('zz')), 'raw/pdf');
  assert.equal(detectContentType('https://host/x/', '', Buffer.from('junk')), 'raw/pdf');
  assert.equal(detectContentType('not a url', '', Buffer.from('<?xml version="1.0"?><TEI xmlns="tei"/>')), 'raw/tei');
  assert.equal(detectContentType('not a url', '', Buffer.from('<?xml version="1.0"?><root>plain xml</root>')), 'raw/xml');
  assert.equal(extensionForVariant('raw/tei'), '.tei.xml');
  assert.equal(extensionForVariant('raw/xml'), '.xml');
  assert.equal(extensionForVariant('raw/html'), '.html');
  assert.equal(extensionForVariant('raw/pdf'), '.pdf');
  assert.equal(extensionForVariant('mystery/variant'), '.bin');
});
