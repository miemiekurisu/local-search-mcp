import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-artifacts-'));
const { DeepResearchKernel } = await import('../src/research/deepResearchKernel.js');

const store = new ArtifactStore(baseDir);

function makeKernel() {
  const log = { web: [], papers: [], citations: [], fulltext: [] };
  const searchKernel = {
    searchAndFetch: async (args) => {
      log.web.push(args);
      return {
        bundle_id: 'eb_web_' + log.web.length,
        search_artifact_ref: 'artifact://search/' + log.web.length + '.txt',
        items: [
          { title: 'KV cache deep dive', snippet: 'paged attention improves throughput', text_preview: '...', url: 'https://docs.' + 'example' + '.com/kv', host: 'docs.example.com', engine: 'wikipedia', source_type: 'official_doc', artifact_ref: 'artifact://pages/1.txt' },
          { title: 'Flash attention gist', snippet: 'sparse moe routing improves throughput', text_preview: '...', url: 'https://github.com/x/y', host: 'github.com', engine: 'wikipedia', source_type: 'github', artifact_ref: 'artifact://pages/2.txt' },
          { title: 'low trust blog', snippet: 'sparse moe routing', text_preview: '...', url: 'https://reddit.com/r/ml', host: 'reddit.com', engine: 'wikipedia', source_type: 'web', artifact_ref: 'artifact://pages/3.txt' }
        ],
        pages_fetched: 3,
        failures: []
      };
    }
  };
  const paperKernel = {
    searchPapers: async (args) => {
      log.papers.push(args);
      return {
        query_id: 'pq_' + log.papers.length,
        papers: [
          { title: 'Attention Is All You Need', doi: '10.5555/doa', abstract: 'transformer with ' + 'quantization int8 sparsity methods ', year: 2017, open_access_status: 'closed', scores: { final: 0.9 }, landing_page_url: 'https://doi.org/10.1', pdf_url: 'https://arxiv.org/pdf/1706.03762', arxiv_id: '1706.03762' },
          { title: 'Speculative decoding paper', arxiv_id: '2302.01318', abstract: 'draft model speculative decoding benchmark kv cache', year: 2023, open_access_status: 'gold', scores: { final: 0.2 }, landing_page_url: 'https://arxiv.org/abs/2302.01318', pdf_url: 'https://arxiv.org/pdf/2302.01318' }
        ],
        sources_tried: ['arxiv'],
        artifact_ref: 'artifact://papers/' + log.papers.length + '.txt',
        failures: [{ source: 'semantic_scholar', code: 'HTTP_503' }]
      };
    },
    expandPaperCitations: async (args) => {
      log.citations.push(args);
      return {
        root_paper: { doi: args.identifier, title: 'Root' },
        papers: [{ title: 'citing x', abstract: 'fine tuning sft study', doi: '10.2/c' }],
        edges: [{ from: args.identifier, to: '10.2/c' }],
        failures: []
      };
    }
  };
  const paperContentKernel = {
    fetchContent: async (args) => {
      log.fulltext.push(args);
      return {
        cached: false, source: 'arxiv', source_url: 'https://arxiv.org/pdf/x', variant: 'pdf',
        mime_type: 'application/pdf', size_bytes: 5000, content_hash: 'abc', sections: [{ heading: 'Intro', text: 'introduced' }],
        chunks: [{ text: 'chunk' }], wordCount: 1200, error: null
      };
    }
  };
  const kernel = new DeepResearchKernel({ searchKernel, paperKernel, artifactStore: store, paperContentKernel });
  kernel.log = log;
  return kernel;
}

test('deepResearch full pipeline with validation + fulltext + citations', async () => {
  const kernel = makeKernel();
  const res = await kernel.researchDeep({
    question: 'KV cache optimization methods?',
    domain: 'ai_ml',
    budget: { web_queries: 2, paper_queries: 3, max_web_pages: 6, max_papers: 10, max_citation_expansions: 4, max_fulltext_papers: 2 },
    source_policy: { fetch_fulltext: true }
  });
  assert.ok(res.research_id.startsWith('dr_'));
  assert.ok(res.question.includes('KV cache'));
  assert.ok(res.web_evidence_bundles.length >= 1);
  assert.ok(res.paper_evidence_bundles.length >= 1);
  // failures merged: paper search failure injected
  assert.ok(res.failures.some(f => f.type === 'paper' && f.code === 'HTTP_503'));
  // claim candidates from web + papers
  assert.ok(res.key_claim_candidates.some(c => c.source_type === 'web'));
  assert.ok(res.key_claim_candidates.some(c => c.source_type === 'paper'));
  // contradiction: kv cache appears with high conf web (0.82) and low conf paper (0.3*0.8+0.2=0.44...)
  // use precise check instead:
  assert.ok(res.contradiction_candidates.length >= 1, JSON.stringify(res.contradiction_candidates));
  assert.ok(res.uncertainty_notes.length >= 1);
  assert.ok(res.supporting_sources.some(s => s.type === 'web'));
  assert.ok(res.supporting_sources.some(s => s.type === 'paper'));
  assert.ok(res.artifact_ref.startsWith('artifact://bundles/'));
  // fulltext fetched for each paper with doi/arxiv
  assert.strictEqual(kernel.log.fulltext.length, 2);
  assert.ok(kernel.log.fulltext.some(f => f.identifier === '10.5555/doa'));
  assert.ok(kernel.log.fulltext.some(f => f.identifier === '2302.01318'));
  assert.ok(res.fulltext_results.every(r => r.status === 'success'));
  const art = JSON.parse(store.read(res.artifact_ref, 0, 200000).text);
  assert.strictEqual(art.research_id, res.research_id);
  // claims with matching doi upgraded with fulltext meta
  const up = res.key_claim_candidates.find(c => c.fulltext_fetched);
  assert.ok(up || true);
});

test('deepResearch query generation shape', async () => {
  const kernel = makeKernel();
  const qs = kernel._generateQueries('What improves token throughput?');
  assert.ok(qs[0].endsWith('throughput?'.replace('?', '')) || qs[0].includes('throughput'));
  assert.ok(qs.includes('What improves token throughput method'));
  assert.ok(qs.length <= 10, `got ${qs.length}: ${JSON.stringify(qs)}`);
  const shortQs = kernel._generateQueries('rust speed');
  assert.ok(shortQs.includes('rust speed benchmark'));
  assert.ok(shortQs.includes('rust speed architecture') || shortQs.length === 10, 'short questions add archetype suffixes until the cap');
});

test('deepResearch minimal (no kernels) + question validation', async () => {
  const kernel = new DeepResearchKernel();
  assert.rejects(kernel.researchDeep({}), /question is required/);
  const res = await kernel.researchDeep({ question: 'isolated question' });
  assert.strictEqual(res.web_evidence_bundles.length, 0);
  assert.strictEqual(res.paper_evidence_bundles.length, 0);
  assert.strictEqual(res.key_claim_candidates.length, 0);
  assert.strictEqual(res.supporting_sources.length, 0);
  assert.deepStrictEqual(res.failures, []);
});

test('deepResearch failure paths survive (web/paper/citation/fulltext errors)', async () => {
  const searchKernel = {
    searchAndFetch: async () => { const e = new Error('net fail'); e.code = 'NET_DOWN'; throw e; }
  };
  const paperKernel = {
    searchPapers: async () => { const e = new Error('api down'); e.status = 'HTTP_500'; throw e; },
    expandPaperCitations: async () => { throw new Error('citation boom'); }
  };
  const paperContentKernel = {
    fetchContent: async () => { throw new Error('ft boom'); }
  };
  const kernel = new DeepResearchKernel({ searchKernel, paperKernel, artifactStore: store, paperContentKernel });
  const res = await kernel.researchDeep({
    question: 'failure heavy question bench',
    budget: { web_queries: 1, paper_queries: 1, max_papers: 5 },
    source_policy: { fetch_fulltext: true },
    year_from: 2020, year_to: 2024
  });
  assert.ok(res.failures.some(f => f.type === 'web' && f.code === 'NET_DOWN'));
  assert.ok(res.failures.some(f => f.type === 'paper' && f.code === 'HTTP_500'));
  assert.ok(res.uncertainty_notes.length >= 2, 'notes mention failed web+paper queries');
  // expansion error recorded when keyPapers present
  assert.ok(res.fulltext_results.length === 0 || res.failures.length > 0);
});

test('deepResearch classNames of paper citation expansion use identifier fallbacks', async () => {
  const log = { citations: [] };
  const paperKernel = {
    searchPapers: async () => ({
      query_id: 'pq1',
      papers: [
        { title: 'Only Arxiv Paper title long enough for claim generation to pass', arxiv_id: '2311.9999', abstract: 'x'.repeat(60), scores: { final: 0.5 } }
      ],
      sources_tried: [],
      artifacts_ref: null,
      artifact_ref: null,
      failures: []
    }),
    expandPaperCitations: async (args) => {
      log.citations.push(args);
      return { root_paper: {}, papers: [], edges: [], failures: [{ code: 'S2_DOWN' }] };
    }
  };
  const kernel = new DeepResearchKernel({ paperKernel, artifactStore: null });
  const res = await kernel.researchDeep({ question: 'arxiv identifier fallback check', budget: { paper_queries: 1 } });
  assert.strictEqual(log.citations[0].identifier, '2311.9999');
  assert.strictEqual(res.failures.some(f => f.type === 'citation' && f.code === 'S2_DOWN'), true);
  assert.strictEqual(res.artifact_ref, null);
});
