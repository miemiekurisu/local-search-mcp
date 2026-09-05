import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undiciState, makeResp, pdfParseState } from './helpers/mocks.mjs';

const st = undiciState();

const [schemas, routerM, dedupM, rankerM, normM, keyM, policyM, detM, chunkM,
  contentK, exPdf, exHtml, exXml, exTei] = await Promise.all([
  import('../src/papers/paperSchemas.js'),
  import('../src/papers/paperRouter.js'),
  import('../src/papers/paperDeduplicator.js'),
  import('../src/papers/paperRanker.js'),
  import('../src/papers/paperNormalizer.js'),
  import('../src/papers/cache/paperKey.js'),
  import('../src/papers/cache/paperCachePolicy.js'),
  import('../src/papers/content/contentTypeDetector.js'),
  import('../src/papers/content/sectionChunker.js'),
  import('../src/papers/content/paperContentKernel.js'),
  import('../src/papers/content/extractors/pdfTextExtractor.js'),
  import('../src/papers/content/extractors/htmlPaperExtractor.js'),
  import('../src/papers/content/extractors/xmlPaperExtractor.js'),
  import('../src/papers/content/extractors/teiExtractor.js')
]);

function makeRegistry(enabled, sources = [])
{
  return {
    isSourceEnabled: id => !!enabled[id],
    getEnabledSources: () => sources
  };
}

function makeOpenAlexWork(over = {}) {
  return {
    id: 'https://openalex.org/W123456789',
    doi: 'https://doi.org/10.1000/OA',
    title: 'OpenAlex Work Title',
    publication_year: 2024,
    publication_date: '2024-03-01',
    authorships: [{ author: { display_name: 'Jane Doe', id: 'A1' } }],
    primary_location: {
      source: { display_name: 'Nature', type: 'journal-article' },
      landing_page_url: 'https://nature.example/x',
      license: 'cc-by',
      is_oa: false
    },
    cited_by_count: 42,
    referenced_works: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'],
    concepts: [{ display_name: 'Computer Science' }],
    topics: [{ display_name: 'Optimization' }],
    open_access: { is_oa: false, oa_status: 'closed', oa_url: '', license: '' },
    abstract_inverted_index: { attention: [1], models: [0] },
    ids: { arxiv: 'arXiv:2301.00001v2' },
    ...over
  };
}

test('paperSchemas createPaperRecord defaults and overrides', () => {
  const rec = schemas.createPaperRecord();
  assert.equal(rec.type, 'paper');
  assert.equal(rec.year, null);
  assert.deepEqual(rec.authors, []);
  assert.deepEqual(rec.scores, { relevance: 0, freshness: 0, authority: 0, availability: 0, final: 0 });
  const rec2 = schemas.createPaperRecord({ title: 'X', doi: null });
  assert.equal(rec2.title, 'X');
});

test('paperSchemas normalizeDoi forms', () => {
  assert.equal(schemas.normalizeDoi(' 10.1000/A.b '), '10.1000/a.b');
  assert.equal(schemas.normalizeDoi('https://doi.org/10.1/x'), '10.1/x');
  assert.equal(schemas.normalizeDoi('http://doi.org/10.1/x'), '10.1/x');
  assert.equal(schemas.normalizeDoi('doi:10.1/x'), '10.1/x');
  assert.equal(schemas.normalizeDoi(''), null);
  assert.equal(schemas.normalizeDoi('   '), null);
  assert.equal(schemas.normalizeDoi(null), null);
});

test('paperSchemas normalizeArxivId forms', () => {
  assert.equal(schemas.normalizeArxivId('arXiv:2301.12345v2'), '2301.12345');
  assert.equal(schemas.normalizeArxivId('arXiv:2301.12345v2', true), '2301.12345v2');
  assert.equal(schemas.normalizeArxivId('https://arxiv.org/abs/2301.12345'), '2301.12345');
  assert.equal(schemas.normalizeArxivId('http://arxiv.org/abs/2301.12345v3'), '2301.12345');
  assert.equal(schemas.normalizeArxivId('2301.12345'), '2301.12345');
  assert.equal(schemas.normalizeArxivId(''), null);
  assert.equal(schemas.normalizeArxivId(null), null);
});

test('paperRouter explicit sources filtered by registry', () => {
  const reg = makeRegistry({ crossref: true, openalex: false });
  const r = new routerM.PaperRouter(reg);
  assert.deepEqual(r.chooseSources({ sources: ['openalex', 'crossref'] }), ['crossref']);
  assert.deepEqual(r.chooseSources({ sources: ['auto'] }).length >= 1, true);
});

test('paperRouter intent and domain merge order', () => {
  const all = { openalex: 1, semantic_scholar: 1, arxiv: 1, crossref: 1, pubmed: 1, unpaywall: 1 };
  const r = new routerM.PaperRouter(makeRegistry(all));
  assert.deepEqual(
    r.chooseSources({ domain: 'medicine', intent: 'paper_search' }),
    ['pubmed', 'openalex', 'crossref', 'semantic_scholar', 'arxiv']
  );
  assert.deepEqual(
    r.chooseSources({ domain: 'ai_ml', intent: 'citation_graph' }),
    ['semantic_scholar', 'openalex', 'arxiv']
  );
  assert.deepEqual(
    r.chooseSources({ intent: 'open_access' }),
    ['openalex', 'crossref', 'arxiv', 'unpaywall']
  );
  assert.deepEqual(r.chooseSources({ intent: 'metadata_verify' }), ['openalex', 'crossref', 'arxiv']);
});

test('paperRouter unknown intent falls back to paper_search', () => {
  const r = new routerM.PaperRouter(makeRegistry({ crossref: 1 }));
  assert.deepEqual(r.chooseSources({ intent: 'bogus_intent' }), ['crossref']);
});

test('paperRouter empty merge uses enabled paper_search sources', () => {
  const r = new routerM.PaperRouter(makeRegistry({}, [
    { id: 'unpaywall', capabilities: ['open_access'] },
    { id: 'crossref', capabilities: ['paper_search'] }
  ]));
  assert.deepEqual(r.chooseSourcesByIntent('open_access'), []);
  assert.deepEqual(r.chooseSources({ intent: 'open_access' }), ['crossref']);
});

test('paperDeduplicator merges records by doi', () => {
  const a = dedupM.deduplicatePapers([
    { doi: '10.1000/A.b', title: 'T1', year: 2024, citation_count: 5, source_records: [{ source: 'openalex', id: 'w1' }] },
    { doi: 'https://doi.org/10.1000/a.b', abstract: 'abs', source_records: [{ source: 'crossref', id: 'c1' }], authors: [{ name: 'A' }] }
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0].doi, '10.1000/A.b');
  assert.equal(a[0].abstract, 'abs');
  assert.equal(a[0].citation_count, 5);
  assert.deepEqual(a[0].source_records.map(r => r.source), ['openalex', 'crossref']);
  assert.deepEqual(a[0].authors.map(x => x.name), ['A']);
});

test('paperDeduplicator arxiv / title keys and fallbacks', () => {
  const dup = dedupM.deduplicatePapers([
    { arxiv_id: 'https://arxiv.org/abs/2301.0001v2', title: 'A' },
    { arxiv_id: 'arXiv:2301.0001', title: 'A copy', authors: [{ name: 'X' }] }
  ]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].arxiv_id, 'https://arxiv.org/abs/2301.0001v2');
  assert.deepEqual(dup[0].authors.map(x => x.name), ['X']);

  const titleYear = dedupM.deduplicatePapers([
    { title: 'Fancy Paper!', year: 2023 },
    { title: 'fancy   paper', published_date: '2023-05-01' }
  ]);
  assert.equal(titleYear.length, 1);

  const titleOnly = dedupM.deduplicatePapers([
    { title: 'Only Title' },
    { title: 'only title' }
  ]);
  assert.equal(titleOnly.length, 1);

  const noKey = dedupM.deduplicatePapers([{}, { year: 2024 }, { published_date: 'bad-date', title: 'T' }]);
  assert.equal(noKey.length, 3);
});

test('paperDeduplicator title normalization', () => {
  assert.equal(dedupM.normalizeTitle('Good  Title \\cite{x} !!'), 'good title cite x');
  const merged = dedupM.deduplicatePapers([
    { title: 'Good Title cite x text y', year: 2020 },
    { title: 'good title cite x text y', year: 2020 }
  ]);
  assert.equal(merged.length, 1);
  assert.equal('fields_of_study' in merged[0], false);
});

test('paperDeduplicator merge fills lists and fields', () => {
  const base = { title: 'T', year: 2020, fields_of_study: ['cs'], topics: ['t1'], source_records: [] };
  const out = dedupM.mergePaperRecords(base, {
    title: '', year: 2021, fields_of_study: ['cs', 'math'], topics: ['t1', 't2'],
    open_access_status: 'unknown', license: 'cc', publication_type: 'unknown',
    abstract: '', pdf_url: '', venue: '', is_open_access: null, citation_count: null,
    reference_count: null, landing_page_url: '', doi: null, arxiv_id: null,
    openalex_id: null, semantic_scholar_id: null, pubmed_id: null, published_date: null,
    authors: [{ name: 'P' }], source_records: [{ source: 's2', id: 'p1' }]
  });
  assert.equal(out.year, 2020);
  assert.equal(out.license, 'cc');
  assert.deepEqual(out.fields_of_study, ['cs', 'math']);
  assert.deepEqual(out.topics, ['t1', 't2']);
  assert.deepEqual(out.authors.map(a => a.name), ['P']);
  assert.deepEqual(out.source_records, [{ source: 's2', id: 'p1' }]);
});

test('paperRanker sorts by computed final score', () => {
  const strong = { title: 'attention models for vision', abstract: 'great', is_open_access: true, year: 2026, citation_count: 900 };
  const weak = { title: 'unrelated thing', abstract: '', year: 1990 };
  const ranked = rankerM.rankPapers([weak, strong], 'attention models');
  assert.equal(ranked[0].title, 'attention models for vision');
  assert.ok(ranked[0].scores.final > ranked[1].scores.final);
  for (const p of ranked) {
    for (const v of Object.values(p.scores)) assert.ok(v >= 0 && v <= 1);
  }
});

test('paperRanker component scores cover branches', () => {
  const p = {
    title: 'MoE Routing with KV Cache',
    abstract: 'repository with dataset, open source benchmarks on github',
    venue: 'IEEE Transactions on Neural Networks',
    publication_type: 'journal-article',
    year: 2000,
    citation_count: 0,
    open_access_status: 'gold',
    license: 'creative commons',
    source_records: [{ source: 'a' }, { source: 'b' }, { source: 'c' }, { source: 'd' }]
  };
  const [r] = rankerM.rankPapers([p], 'moe kv cache');
  assert.equal(r.scores.relevance, 1);
  assert.equal(r.scores.method_match, 1);
  assert.ok(r.scores.authority >= 0.75);
  assert.equal(r.scores.freshness, 0.1);
  assert.equal(r.scores.availability, 0.7);
  assert.equal(r.scores.reproducibility, 1);
  assert.equal(r.scores.final > 0, true);

  const emptyTerm = rankerM.rankPapers([{ title: 'x' }], 'ab');
  assert.equal(emptyTerm[0].scores.relevance, 0.5);
  assert.equal(emptyTerm[0].scores.method_match, 0.5);
  assert.equal(emptyTerm[0].scores.freshness, 0.3);
  assert.equal(emptyTerm[0].scores.availability, 0);

  const cited = rankerM.rankPapers([{ title: 'x', citation_count: 0 }], 'abc');
  const capped = rankerM.rankPapers([{ title: 'x', citation_count: 100000 }], 'abc');
  const futureYear = rankerM.rankPapers([{ title: 'x', year: 2100 }], 'abc');
  assert.equal(futureYear[0].scores.freshness, 1);
  const domainMath = rankerM.WEIGHTS.default;
  assert.equal(domainMath.source_authority, 0.2);
  const math = rankerM.rankPapers([{ title: 'abc def' }], 'abc', { domain: 'math' });
  assert.ok(math[0].scores.final >= 0);
});

test('paperNormalizer openalex work', () => {
  const empty = normM.normalizeOpenAlexWork(null);
  assert.equal(empty.title, '');
  assert.deepEqual(empty.scores, { relevance: 0, freshness: 0, authority: 0, availability: 0, final: 0 });

  const rec = normM.normalizeOpenAlexWork(makeOpenAlexWork());
  assert.equal(rec.title, 'OpenAlex Work Title');
  assert.deepEqual(rec.authors, [{ name: 'Jane Doe', id: 'A1', source: 'openalex' }]);
  assert.equal(rec.year, 2024);
  assert.equal(rec.venue, 'Nature');
  assert.equal(rec.landing_page_url, 'https://nature.example/x');
  assert.equal(rec.publication_type, 'journal-article');
  assert.equal(rec.doi, '10.1000/oa');
  assert.equal(rec.openalex_id, 'W123456789');
  assert.equal(rec.abstract, 'models attention');
  assert.equal(rec.citation_count, 42);
  assert.equal(rec.reference_count, 7);
  assert.deepEqual(rec.topics, ['Optimization']);
  assert.equal(rec.is_open_access, null);
  assert.equal(rec.open_access_status, 'closed');
  assert.equal(rec.arxiv_id, null);
  assert.equal(rec.arxiv_id_with_version, null);
  assert.deepEqual(rec.source_records[0].source, 'openalex');
});

test('paperNormalizer openalex type mapping and oa url', () => {
  const rec = normM.normalizeOpenAlexWork(makeOpenAlexWork({
    primary_location: { source: { display_name: 'V', type: 'dataset' }, is_oa: true },
    open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://oa/u.pdf', license: 'cc' }
  }));
  assert.equal(rec.publication_type, 'dataset');
  assert.equal(rec.is_open_access, true);
  assert.equal(rec.pdf_url, 'https://oa/u.pdf');

  const unknown = normM.normalizeOpenAlexWork(makeOpenAlexWork({ primary_location: null }));
  assert.equal(unknown.venue, '');
});

test('paperNormalizer semantic scholar paper', () => {
  assert.equal(normM.normalizeSemanticScholarPaper(null).title, '');
  const rec = normM.normalizeSemanticScholarPaper({
    paperId: 'pid1',
    title: 'S2 Paper',
    year: 2023,
    venue: 'NeurIPS',
    abstract: 'abs text',
    authors: [{ name: 'Alice', authorId: 'au1' }, { name: 'Bob' }],
    externalIds: { DOI: '10.1000/s2', ArXiv: '2301.0002v1', PubMed: 'PM1', CorpusId: 777 },
    citationCount: 12,
    referenceCount: 30,
    fieldsOfStudy: ['cs', null],
    isOpenAccess: true,
    openAccessPdf: { url: 'https://s2pdf', status: 'gold' }
  });
  assert.equal(rec.doi, '10.1000/s2');
  assert.equal(rec.arxiv_id, '2301.0002');
  assert.equal(rec.arxiv_id_with_version, '2301.0002v1');
  assert.equal(rec.pubmed_id, 'PM1');
  assert.equal(rec.semantic_scholar_id, 'CorpusId:777');
  assert.deepEqual(rec.fields_of_study, ['cs']);
  assert.equal(rec.is_open_access, true);
  assert.equal(rec.open_access_status, 'gold');
  assert.equal(rec.pdf_url, 'https://s2pdf');
  assert.equal(rec.landing_page_url, '');
  assert.deepEqual(rec.source_records[0].url, 'https://api.semanticscholar.org/pid1');
  assert.deepEqual(rec.authors.map(a => a.name), ['Alice', 'Bob']);

  const plain = normM.normalizeSemanticScholarPaper({ paperId: 'p2', title: 'T' });
  assert.equal(plain.semantic_scholar_id, 'p2');
  assert.equal(plain.source_records[0].url, 'https://api.semanticscholar.org/p2');
});

test('paperNormalizer arxiv entry', () => {
  assert.equal(normM.normalizeArxivEntry(null).publication_type, 'unknown');
  const rec = normM.normalizeArxivEntry({
    id: 'http://arxiv.org/abs/2301.0003v1',
    title: '  Arxiv\n Title  ',
    summary: ' Sum\n mary ',
    published: '2023-01-02T00:00:00Z',
    author: [{ name: 'Ann' }, { name: 'Ben' }],
    link: [
      { href: 'https://arxiv.org/abs/2301.0003v1', rel: 'alternate' },
      { href: 'https://arxiv.org/pdf/2301.0003v1', rel: 'related' }
    ]
  });
  assert.equal(rec.title, 'Arxiv Title');
  assert.equal(rec.abstract, 'Sum mary');
  assert.equal(rec.published_date, '2023-01-02');
  assert.equal(rec.year, 2023);
  assert.equal(rec.arxiv_id, '2301.0003');
  assert.equal(rec.pdf_url, 'https://arxiv.org/pdf/2301.0003v1');
  assert.equal(rec.landing_page_url, 'https://arxiv.org/abs/2301.0003v1');
  assert.equal(rec.publication_type, 'preprint');
  assert.deepEqual(rec.authors.map(a => a.name), ['Ann', 'Ben']);

  const single = normM.normalizeArxivEntry({
    id: 'x',
    author: { name: 'Solo' },
    link: [{ $: { href: 'https://arxiv.org/abs/1', rel: 'alternate' } }]
  });
  assert.deepEqual(single.authors.map(a => a.name), ['Solo']);
  assert.equal(single.landing_page_url, 'https://arxiv.org/abs/1');
});

test('paperNormalizer crossref work', () => {
  assert.equal(normM.normalizeCrossrefWork(null).title, '');
  const rec = normM.normalizeCrossrefWork({
    title: ['Cross Title'],
    author: [{ given: 'Ja', family: 'Ne', ORCID: 'orcid:1' }],
    'published-print': { 'date-parts': [[2030, 2, 3]] },
    type: 'posted-content',
    'container-title': ['Cell', 'Nature'],
    DOI: '10.55/CR',
    abstract: '<jats:p>abstract  body</jats:p>',
    'is-referenced-by-count': 8,
    'references-count': 3
  });
  assert.equal(rec.title, 'Cross Title');
  assert.deepEqual(rec.authors, [{ name: 'Ja Ne', id: 'orcid:1', source: 'crossref' }]);
  assert.equal(rec.year, 2030);
  assert.equal(rec.published_date, '2030-02-03');
  assert.equal(rec.venue, 'Cell, Nature');
  assert.equal(rec.doi, '10.55/cr');
  assert.equal(rec.publication_type, 'preprint');
  assert.equal(rec.abstract, 'abstract body');
  assert.equal(rec.citation_count, 8);
  assert.equal(rec.reference_count, 3);

  const online = normM.normalizeCrossrefWork({ 'published-online': { 'date-parts': [[1999, 5]] }, DOI: '10.1/y' });
  assert.equal(online.year, 1999);
  assert.equal(online.published_date, null);
  const issued = normM.normalizeCrossrefWork({ issued: { 'date-parts': [[1955]] }, DOI: '10.1/z', type: 'weird-type' });
  assert.equal(issued.year, 1955);
  assert.equal(issued.publication_type, 'unknown');
});

test('paperNormalizer unpaywall response', () => {
  assert.equal(normM.normalizeUnpaywallResponse(null).doi, null);
  const rec = normM.normalizeUnpaywallResponse({
    doi: '10.9/up',
    is_oa: true,
    oa_status: 'green',
    best_oa_location: { url_for_pdf: 'https://p', url_for_landing_page: 'https://l', license: 'cc0' },
    genre: 'dataset',
    published_date: '2020-06-01',
    publisher: 'PubCo'
  });
  assert.equal(rec.doi, '10.9/up');
  assert.equal(rec.is_open_access, true);
  assert.equal(rec.pdf_url, 'https://p');
  assert.equal(rec.publication_type, 'dataset');
  assert.equal(rec.year, 2020);
  assert.equal(rec.venue, 'PubCo');

  const minimal = normM.normalizeUnpaywallResponse({ doi: '10.9/x' });
  assert.equal(minimal.open_access_status, 'unknown');
  assert.equal(minimal.publication_type, 'unknown');
});

test('paperKey from identifier and derivation', () => {
  assert.equal(keyM.paperKeyFromIdentifier(' doi:10.1/x ', 'doi'), '10.1/x');
  assert.equal(keyM.paperKeyFromIdentifier('https://arxiv.org/abs/2301.0001v2', 'arxiv'), '2301.0001');
  assert.equal(keyM.paperKeyFromIdentifier('2301.0001v3', 'arxiv'), '2301.0001');
  assert.equal(keyM.paperKeyFromIdentifier('https://openalex.org/W999', 'openalex'), 'W999');
  assert.equal(keyM.paperKeyFromIdentifier('https://api.semanticscholar.org/p1', 'semantic_scholar'), 'p1');
  assert.equal(keyM.paperKeyFromIdentifier('raw value', 'other'), 'raw value');

  assert.equal(keyM.derivePaperKey({ doi: 'DOI:10.2/Y' }), '10.2/y');
  assert.equal(keyM.derivePaperKey({ arxiv_id: 'http://arxiv.org/abs/2302.0001v9' }), '2302.0001');
  assert.equal(keyM.derivePaperKey({ semantic_scholar_id: 'ss1' }), 'ss:ss1');
  assert.equal(keyM.derivePaperKey({ openalex_id: 'W1' }), 'oa:W1');
  assert.match(keyM.derivePaperKey({ title: 'Title Here', year: 2024 }), /^titlehash:[0-9a-f]{12}$/);
  assert.throws(() => keyM.derivePaperKey({}), /Cannot derive paper key/);
});

test('paperCachePolicy expiry and ttl', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  assert.equal(policyM.isExpired({ pinned: 1, expires_at: '2020-01-01T00:00:00Z' }, now), false);
  assert.equal(policyM.isExpired({ expires_at: null }, now), false);
  assert.equal(policyM.isExpired({ expires_at: '2020-01-01T00:00:00Z' }, now), true);
  assert.equal(policyM.isExpired({ expires_at: '2027-01-01T00:00:00Z' }, now), false);
  assert.equal(policyM.isExpired({ expires_at: 'not-a-date' }, now), false);

  const t = new Date(policyM.ttlFromNow(5));
  const days = Math.round((t.getTime() - Date.now()) / 86400000);
  assert.ok(days >= 4 && days <= 6);

  const cfg = { rawTtlDays: 3, textTtlDays: 300 };
  const raw = new Date(policyM.computeExpiresAt('raw/pdf', cfg));
  const text = new Date(policyM.computeExpiresAt('text', cfg));
  assert.ok(Math.round((raw.getTime() - Date.now()) / 86400000) >= 2);
  assert.ok(Math.round((text.getTime() - Date.now()) / 86400000) >= 299);
  assert.equal(policyM.computeExpiresAt('sections', cfg), null);
  assert.equal(policyM.computeExpiresAt('raw/tei', cfg) !== null, true);

  assert.equal(policyM.variantPriority('raw/tei'), 0);
  assert.equal(policyM.variantPriority('raw/pdf'), 3);
  assert.equal(policyM.variantPriority('text'), 4);
  assert.equal(policyM.variantPriority('chunks'), 6);
  assert.equal(policyM.variantPriority('mystery'), 999);
});

test('contentTypeDetector rules', () => {
  assert.equal(detM.detectContentType('http://x/a.pdf', 'application/pdf', null), 'raw/pdf');
  assert.equal(detM.detectContentType('http://x/a.any', 'text/html; charset=utf8', null), 'raw/html');
  assert.equal(detM.detectContentType('http://x/a.any', 'application/tei+xml', null), 'raw/tei');
  assert.equal(detM.detectContentType('http://x/a.any', 'application/zombie', null), 'raw/pdf');
  assert.equal(detM.detectContentType('http://x/page.html', '', null), 'raw/html');
  assert.equal(detM.detectContentType('http://x/pdf/paper', '', null), 'raw/pdf');
  assert.equal(detM.detectContentType('http://x/abs/9876', null, Buffer.from('%PDF-2.0 rest')), 'raw/pdf');
  assert.equal(detM.detectContentType('not a url', null, Buffer.from('<!DOCTYPE html>')), 'raw/html');
  assert.equal(detM.detectContentType('http://x/a', null, Buffer.from('<html></html>')), 'raw/html');
  assert.equal(
    detM.detectContentType('http://x/a', null, Buffer.from('<?xml version="1.0"?></TEI.2>')),
    'raw/tei'
  );
  assert.equal(detM.detectContentType('http://x/a', null, Buffer.from('<?xml version="1.0"?><doc/>')), 'raw/xml');
  assert.equal(detM.detectContentType('http://x/abs/9876', null, Buffer.from('plain')), 'raw/pdf');

  assert.equal(detM.extensionForVariant('raw/pdf'), '.pdf');
  assert.equal(detM.extensionForVariant('raw/html'), '.html');
  assert.equal(detM.extensionForVariant('raw/xml'), '.xml');
  assert.equal(detM.extensionForVariant('raw/tei'), '.tei.xml');
  assert.equal(detM.extensionForVariant('text'), '.bin');
});

test('sectionChunker small text single chunk', () => {
  assert.deepEqual(chunkM.sectionChunker(null), { sections: [], chunks: [] });
  assert.deepEqual(chunkM.sectionChunker({}), { sections: [], chunks: [] });

  const out = chunkM.sectionChunker({
    sections: [
      { heading: 'Intro', text: 'one two three' },
      { text: 'four five' }
    ]
  });
  assert.deepEqual(out.sections.map(s => s.heading), ['Intro', 'Section 2']);
  assert.equal(out.sections[0].wordCount, 3);
  assert.deepEqual(out.sections[0].subsections, []);
  assert.equal(out.chunks.length, 1);
  assert.equal(out.chunks[0].index, 0);
  assert.deepEqual(out.chunks[0].sectionRefs, [0, 1]);
  assert.ok(out.chunks[0].text.includes('## Intro'));
});

const FIVE = 'wwwww';
function bigText(nWords) {
  return Array.from({ length: nWords }, () => FIVE).join(' ');
}

test('sectionChunker large text splits with section refs', () => {
  const out = chunkM.sectionChunker({
    sections: [
      { heading: 'S', text: bigText(1200) },
      { heading: 'T', text: bigText(1200) }
    ]
  });
  assert.equal(out.chunks.length, 2);
  assert.equal(out.chunks[0].wordCount, 2000);
  assert.deepEqual(out.chunks[0].sectionRefs, [0, 1]);
  assert.deepEqual(out.chunks[1].sectionRefs, [1]);
  assert.equal(out.chunks[1].index, 1);
});

test('splitTextIntoSections heading modes', () => {
  const md = chunkM.splitTextIntoSections('# H1\nline one\n## H2\nline two\n#### H4\nline three');
  assert.deepEqual(md.map(s => s.heading), ['H1', 'H2', 'H4']);
  assert.equal(md[1].text, 'line two');

  const plain = chunkM.splitTextIntoSections('para line\nsecond line');
  assert.deepEqual(plain, [{ heading: 'Full Text', text: 'para line\nsecond line' }]);

  const paras = chunkM.splitTextIntoSections('para one\n\npara two\n\npara three');
  assert.deepEqual(paras.map(p => p.heading), ['Paragraph 1', 'Paragraph 2', 'Paragraph 3']);

  const trailing = chunkM.splitTextIntoSections('# H\n');
  assert.deepEqual(trailing, [{ heading: 'H', text: '' }]);
});

test('pdfTextExtractor maps pdf-parse result', async () => {
  const ps = pdfParseState();
  ps.parse = async (buf) => ({ text: `parsed ${buf.length}`, numpages: 7, info: { Title: 'PT', Author: 'PA' }, version: '1.10.100' });
  assert.equal(exPdf.canExtract('raw/pdf'), true);
  assert.equal(exPdf.canExtract('raw/html'), false);
  const out = await exPdf.extractPdfText(Buffer.from('xxxx'));
  assert.equal(out.text, 'parsed 4');
  assert.equal(out.pages, 7);
  assert.equal(out.version, '1.10.100');
  assert.equal(out.metadata.title, 'PT');
  assert.equal(out.metadata.author, 'PA');
  assert.equal(out.metadata.producer, null);
});

test('htmlPaperExtractor extracts sections and meta', () => {
  assert.equal(exHtml.canExtract('raw/html'), true);
  assert.equal(exHtml.canExtract('raw/pdf'), false);
  const html = `<!doctype html><html><head><title>Doc Title</title>
    <meta name="description" content="Meta Abs">
    <script>var leak=1;</script>
    <meta name="citation_author" content="A One">
    <meta name="citation_author" content="B Two">
    <meta name="citation_doi" content="10.1/hx">
    </head><body>
    <h1>Main Heading</h1>
    <h2>Intro</h2><p>intro body text</p>
    <h2>Methods</h2><p>method one</p><p>method two</p>
    <footer>foot junk</footer>
    </body></html>`;
  const out = exHtml.extractHtmlPaper(html, 'http://src');
  assert.equal(out.title, 'Main Heading');
  assert.equal(out.abstract, 'Meta Abs');
  assert.deepEqual(out.authors, ['A One', 'B Two']);
  assert.equal(out.doi, '10.1/hx');
  assert.deepEqual(out.sections.map(s => s.heading), ['Intro', 'Methods']);
  assert.equal(out.sections[1].level, 2);
  assert.equal(out.sections[1].text, 'method one\nmethod two');
  assert.ok(!out.fullText.includes('var leak=1'));
  assert.ok(!out.fullText.includes('foot junk'));
  assert.equal(out.format, 'html');
  assert.equal(out.sourceUrl, 'http://src');

  const simple = exHtml.extractHtmlPaper('<html><body><p>plain body text</p></body></html>', 'u');
  assert.deepEqual(simple.sections, [{ heading: 'Full Text', text: 'plain body text', level: 1 }]);
});

test('xmlPaperExtractor handles JATS with subsections', () => {
  assert.equal(exXml.canExtract('raw/xml'), true);
  assert.equal(exXml.canExtract('raw/tei'), false);
  const xml = `<article><front>
    <title-group><article-title>JATS Title</article-title></title-group>
    <abstract><p>JATS Abstract Text</p></abstract>
    <contrib-group>
      <contrib contrib-type="author"><given-names>Jane</given-names><surname>Doe</surname></contrib>
      <contrib contrib-type="author"><string-name>Solo Name</string-name></contrib>
    </contrib-group>
    <article-id pub-id-type="doi">10.9/jats</article-id>
    </front>
    <body>
      <sec><title>Introduction</title><p>body para one</p></sec>
      <sec><title>Results</title><p>result para</p>
        <sec><title>Sub Results</title><p>sub para</p></sec>
      </sec>
    </body></article>`;
  const out = exXml.extractXmlPaper(xml, 'http://x');
  assert.equal(out.title, 'JATS Title');
  assert.equal(out.abstract, 'JATS Abstract Text');
  assert.deepEqual(out.authors, ['Jane Doe']);
  assert.equal(out.doi, '10.9/jats');
  assert.deepEqual(out.sections.map(s => s.heading), ['Introduction', 'Results', 'Sub Results']);
  const results = out.sections[1];
  assert.deepEqual(results.subsections.map(s => s.heading), ['Sub Results']);
  assert.ok(results.text.includes('sub para'));
  assert.equal(out.format, 'jats-xml');
});

test('xmlPaperExtractor string-name fallback and default section heading', () => {
  const xml = '<article><body><sec><p>only para</p></sec></body></article>';
  const out = exXml.extractXmlPaper(xml, 'u');
  assert.deepEqual(out.sections.map(s => s.heading), ['Section 1']);
  assert.equal(out.sections[0].text, 'only para');
  assert.deepEqual(out.subsections, undefined);
  assert.deepEqual(out.authors, []);
  assert.equal(out.title, '');
});

test('teiExtractor parses TEI xml', () => {
  assert.equal(exTei.canExtract('raw/tei'), true);
  assert.equal(exTei.canExtract('raw/xml'), false);
  const xml = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader><fileDesc>
      <titleStmt><title>TEI Title</title></titleStmt>
      <profileDesc><abstract><p>TEI Abstract</p></abstract></profileDesc>
      <sourceDesc><biblStruct><idno type="DOI">10.7/tei</idno></biblStruct></sourceDesc>
    </fileDesc></teiHeader>
    <text><body>
      <div type="section"><head>Section A</head><p>tei para one</p></div>
      <div type="chapter"><head>Section B</head><p>tei para two</p><p>second p</p></div>
    </body></text></TEI>`;
  const out = exTei.extractTei(xml, 'http://tei');
  assert.equal(out.title, 'TEI Title');
  assert.equal(out.abstract, 'TEI Abstract');
  assert.equal(out.doi, '10.7/tei');
  assert.deepEqual(out.sections.map(s => s.heading), ['Section A', 'Section B']);
  assert.equal(out.sections[1].text, 'tei para two\nsecond p');
  assert.deepEqual(out.authors, []);
  assert.equal(out.format, 'tei-xml');
});

test('documentFetcher happy path via undici mock', async () => {
  const { DocumentFetcher } = await import('../src/papers/content/documentFetcher.js');
  const df = new DocumentFetcher({ fetchMaxBytes: 2048 });
  st.responses.length = 0;
  st.responses.push(makeResp({
    url: 'http://final.local/redir',
    text: '<html><body>hello</body></html>',
    headers: { 'content-type': 'text/html; charset=utf-8' }
  }));
  const res = await df.fetch('http://x/a');
  assert.equal(res.variant, 'raw/html');
  assert.equal(res.mimeType, 'text/html');
  assert.equal(res.size, 31);
  assert.equal(res.url, 'http://final.local/redir');
  assert.match(res.hash, /^[0-9a-f]{64}$/);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
});

test('documentFetcher size and http failures', async () => {
  const { DocumentFetcher } = await import('../src/papers/content/documentFetcher.js');
  const df = new DocumentFetcher({ fetchMaxBytes: 16 });
  st.responses.length = 0;
  st.responses.push(makeResp({ text: 'x', headers: { 'content-length': '9999999' } }));
  await assert.rejects(df.fetch('http://x/big'), err => {
    assert.equal(err.code, 'FILE_TOO_LARGE');
    assert.equal(err.size, 9999999);
    return true;
  });

  st.responses.length = 0;
  st.responses.push(makeResp({ chunks: [Buffer.alloc(100, 1)] }));
  await assert.rejects(df.fetch('http://x/stream'), err => {
    assert.equal(err.code, 'FILE_TOO_LARGE');
    assert.equal(err.size, 100);
    return true;
  });

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 403 }));
  await assert.rejects(df.fetch('http://x/deny'), err => {
    assert.equal(err.code, 'FETCH_FAILED');
    assert.equal(err.status, 403);
    return true;
  });
});

function makeStubCache() {
  const calls = { storeRaw: [], storeText: [], storeSections: [], storeChunks: [], cleanup: [] };
  return {
    calls,
    enabled: true,
    findPaper: () => ({ sections: [], text: [], chunks: [], raws: [] }),
    readJson: async (id) => null,
    readText: async (id) => null,
    storeRaw: async (...a) => { calls.storeRaw.push(a); return { id: 'r1' }; },
    storeText: async (...a) => { calls.storeText.push(a); return { id: 't1' }; },
    storeSections: async (...a) => { calls.storeSections.push(a); return { id: 's1' }; },
    storeChunks: async (...a) => { calls.storeChunks.push(a); return { id: 'c1' }; }
  };
}

test('contentLocator candidates for arxiv and doi', async () => {
  const { PaperContentLocator } = await import('../src/papers/content/paperContentLocator.js');

  st.responses.length = 0;
  st.responses.push(makeResp({ json: { openAccessPdf: { url: 'https://s2pdf.example/a.pdf' } } }));
  const locator = new PaperContentLocator(null);
  const cands = await locator.locate('2301.12345');
  assert.deepEqual(cands.map(c => c.source), ['arxiv', 'arxiv_html', 'semantic_scholar']);
  assert.equal(cands[0].url, 'https://arxiv.org/pdf/2301.12345.pdf');
  assert.equal(cands[2].url, 'https://s2pdf.example/a.pdf');
  assert.equal(cands[0].format, 'raw/pdf');

  const failing = new PaperContentLocator({ findOpenAccess: async () => { throw new Error('up down'); } });
  const c2 = await failing.locate('10.1000/some.doi', 'doi');
  assert.deepEqual(c2.map(c => c.source), ['doi_resolver']);

  const ok = new PaperContentLocator({ findOpenAccess: async () => ({ is_open_access: true, best_pdf_url: 'https://p/x.pdf', license: 'cc' }) });
  const c3 = await ok.locate('10.1/y', 'doi');
  assert.deepEqual(c3.map(c => c.source), ['unpaywall', 'doi_resolver']);
  assert.equal(c3[0].license, 'cc');

  const landing = new PaperContentLocator({ findOpenAccess: async () => ({ is_open_access: true, best_landing_page_url: 'https://l', license: null }) });
  const c4 = await landing.locate('10.1/y', 'doi');
  assert.deepEqual(c4.map(c => c.source), ['unpaywall_landing', 'doi_resolver']);
  assert.equal(c4[0].license, null);
});

test('contentKernel fetchContent happy path stores raw/text/sections', async () => {
  const { PaperContentKernel } = contentK;
  const cache = makeStubCache();
  const cleanupCalls = [];
  const kernel = new PaperContentKernel({
    paperCacheStore: cache,
    paperCacheCleanup: { cleanup: async (dry) => { cleanupCalls.push(dry); return {}; } }
  });
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { openAccessPdf: { url: 'https://s2pdf.example/a.pdf' } } }));
  st.responses.push(makeResp({
    url: 'https://arxiv.org/pdf/2301.12345.pdf',
    text: '%PDF-1.4 dummy body',
    headers: { 'content-type': 'application/pdf' }
  }));
  pdfParseState().parse = async () => ({ text: 'PDF body here', numpages: 3, info: { Title: 'P' } });

  const out = await kernel.fetchContent({ identifier: '2301.12345' });
  assert.equal(out.identifier_type, 'arxiv');
  assert.equal(out.paper_key, '2301.12345');
  assert.equal(out.cached, false);
  assert.equal(out.variant, 'raw/pdf');
  assert.equal(out.mime_type, 'application/pdf');
  assert.equal(out.source, 'arxiv');
  assert.deepEqual(cache.calls.storeRaw[0][0], 'raw/pdf');
  assert.ok(Buffer.isBuffer(cache.calls.storeRaw[0][2]));
  assert.deepEqual(cache.calls.storeText[0][1], 'PDF body here');
  assert.deepEqual(cache.calls.storeSections[0][1], []);
  assert.deepEqual(cache.calls.storeChunks[0][1], []);
  assert.deepEqual(cleanupCalls, [true]);
});

test('contentKernel fetchContent failures aggregate last error', async () => {
  const { PaperContentKernel } = contentK;
  const cache = makeStubCache();
  const kernel = new PaperContentKernel({ paperCacheStore: cache });
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { openAccessPdf: { url: 'https://s2pdf.example/a.pdf' } } }));
  st.responses.push(makeResp({ status: 404 }));
  st.responses.push(makeResp({ status: 500 }));
  st.responses.push(makeResp({ status: 403 }));

  const out = await kernel.fetchContent({ identifier: '2301.12345' });
  assert.equal(cache.calls.storeRaw.length, 0);
  assert.equal(out.error.startsWith('HTTP'), true);
  assert.equal(out.lastError.code, 'FETCH_FAILED');
});

test('contentKernel fetchContent no candidates and cache enabled short-circuit', async () => {
  const { PaperContentKernel } = contentK;
  const cache = makeStubCache();
  cache.findPaper = () => ({
    sections: [{ id: 'se1' }], text: [{ id: 'te1' }], chunks: [{ id: 'ch1' }], raws: []
  });
  cache.readJson = async (id) => id === 'se1' ? { data: [{ heading: 'A', text: 'x' }] } : { data: [{ index: 0 }] };
  const kernel = new PaperContentKernel({ paperCacheStore: cache });
  const out = await kernel.fetchContent({ identifier: 'W123456789' });
  assert.deepEqual(out.sections, [{ heading: 'A', text: 'x' }]);

  assert.equal(out.paper_key, 'W123456789');
  assert.equal(out.identifier_type, 'openalex');
  assert.equal(out.cached, true);

  await assert.rejects(
    new PaperContentKernel({}).fetchContent({ identifier: '   ' }),
    /identifier is required/
  );
});

test('contentKernel getSections variants', async () => {
  const { PaperContentKernel } = contentK;

  await assert.rejects(new PaperContentKernel({}).getSections({}), /paper_key or identifier is required/);
  await assert.rejects(new PaperContentKernel({}).getSections({ paper_key: 'k' }), /Cache not available/);

  const cache = makeStubCache();
  cache.findPaper = () => ({ sections: [], text: [{ id: 'te1' }], chunks: [], raws: [] });
  cache.readText = async () => ({ data: '# Alpha\nbody one\nbody two\n\npara two' });
  const kernel1 = new PaperContentKernel({ paperCacheStore: cache });
  const rebuilt = await kernel1.getSections({ paper_key: '10.1/rebuild' });
  assert.equal(rebuilt.cached, true);
  assert.deepEqual(rebuilt.sections.map(s => s.heading), ['Paragraph 1', 'Paragraph 2']);
  assert.equal(cache.calls.storeSections.length, 1);
  assert.deepEqual(cache.calls.storeChunks[0][1], rebuilt.chunks);

  const cache2 = makeStubCache();
  cache2.findPaper = () => ({ sections: [{ id: 'se1' }], text: [], chunks: [{ id: 'ch1' }], raws: [] });
  cache2.readJson = async (id) => id === 'se1'
    ? { data: [{ heading: 'Cached Sec', text: 'txt' }] }
    : { data: [{ index: 5 }] };
  const kernel2 = new PaperContentKernel({ paperCacheStore: cache2 });
  const cached = await kernel2.getSections({ paper_key: 'k1' });
  assert.deepEqual(cached.sections, [{ heading: 'Cached Sec', text: 'txt' }]);
  assert.deepEqual(cached.chunks, [{ index: 5 }]);

  const cache3 = makeStubCache();
  cache3.findPaper = () => ({ sections: [{ id: 'se1' }], text: [], chunks: [], raws: [] });
  cache3.readJson = async () => null;
  const kernel3 = new PaperContentKernel({ paperCacheStore: cache3 });
  await assert.rejects(kernel3.getSections({ paper_key: 'k1' }), /Failed to read cached sections/);

  const cache4 = makeStubCache();
  cache4.findPaper = () => ({ sections: [], text: [], chunks: [], raws: [] });
  const kernel4 = new PaperContentKernel({ paperCacheStore: cache4 });
  await assert.rejects(kernel4.getSections({ paper_key: 'k1' }), /No content found/);
});

test('contentKernel unknown variant falls back to plain text', async () => {
  const { PaperContentKernel } = contentK;
  const cache = makeStubCache();
  const kernel = new PaperContentKernel({ paperCacheStore: cache });
  const extracted = await kernel._extract(Buffer.from('raw stuff here'), 'raw/weird', 'http://src');
  assert.deepEqual(extracted.sections, [{ heading: 'Full Text', text: 'raw stuff here' }]);
  assert.equal(extracted.format, 'unknown');
  assert.equal(extracted.wordCount, 3);
});
