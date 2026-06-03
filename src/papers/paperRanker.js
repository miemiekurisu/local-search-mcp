export const WEIGHTS = {
  ai_ml: {
    relevance: 0.35,
    source_authority: 0.15,
    recency: 0.20,
    citation_signal: 0.10,
    method_match: 0.10,
    open_access_availability: 0.05,
    reproducibility_signal: 0.05
  },
  default: {
    relevance: 0.35,
    source_authority: 0.20,
    recency: 0.15,
    citation_signal: 0.10,
    method_match: 0.10,
    open_access_availability: 0.05,
    reproducibility_signal: 0.05
  }
};

const RECOGNIZED_VENUES = new Set([
  'nature', 'science', 'cell', 'pnas',
  'neurips', 'icml', 'iclr', 'aaai', 'ijcai', 'acl', 'emnlp', 'naacl', 'eacl', 'coling',
  'cvpr', 'iccv', 'eccv', 'siggraph', 'miccai',
  'acl', 'naacl', 'emnlp', 'eacl', 'coling', 'tacl', 'cl',
  'osdi', 'sosp', 'sigcomm', 'mobicom', 'nsdi',
  'sigmod', 'vldb', 'icde', 'pods',
  'ieee', 'acm', 'springer', 'elsevier', 'mit press',
  'plos', 'bmc', 'frontiers', 'mdpi',
  'jmlr', 'aistats', 'uai', 'cogsci',
  'stoc', 'focs', 'soda', 'icalp',
  'popl', 'pldi', 'cav', 'lics'
]);

const TOP_TIER = new Set([
  'neurips', 'icml', 'iclr', 'cvpr', 'iccv', 'acl', 'emnlp',
  'nature', 'science', 'cell', 'pnas',
  'osdi', 'sosp', 'sigcomm', 'sigmod', 'stoc', 'focs',
  'jmlr', 'tacl', 'ieee'
]);

function computeRelevance(paper, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return 0.5;

  const title = (paper.title || '').toLowerCase();
  const abstract = (paper.abstract || '').toLowerCase();
  const topics = (paper.topics || []).join(' ').toLowerCase();
  const text = `${title} ${abstract} ${topics}`;

  let matches = 0;
  for (const term of terms) {
    if (text.includes(term)) matches++;
  }

  return Math.min(1, matches / terms.length);
}

function computeSourceAuthority(paper) {
  let score = 0.3;

  if (paper.publication_type === 'journal-article' || paper.publication_type === 'proceedings-article') {
    score += 0.2;
  }

  const venue = (paper.venue || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const prefix of TOP_TIER) {
    if (venue.includes(prefix)) {
      score += 0.3;
      break;
    }
  }
  for (const prefix of RECOGNIZED_VENUES) {
    if (venue.includes(prefix)) {
      score += 0.15;
      break;
    }
  }

  const sourceCount = (paper.source_records || []).length;
  score += Math.min(0.1, sourceCount * 0.03);

  return Math.min(1, score);
}

function computeRecency(paper, domain) {
  const now = new Date().getFullYear();
  const year = paper.year;
  if (!year) return 0.3;

  const age = now - year;
  if (age <= 0) return 1;
  if (age >= 20) return 0.1;

  const halfLife = domain === 'ai_ml' ? 3 : 5;
  return 1 / (1 + Math.exp((age - halfLife * 2) / halfLife * 0.5));
}

function computeCitationSignal(paper) {
  const count = paper.citation_count;
  if (count == null || count < 0) return 0;
  if (count === 0) return 0.1;
  return Math.min(1, Math.log10(count + 1) / 3.5);
}

function computeAvailability(paper) {
  if (paper.is_open_access === true) return 1;
  if (paper.open_access_status && paper.open_access_status !== 'unknown' && paper.open_access_status !== 'closed') return 0.7;
  if (paper.pdf_url) return 0.5;
  if (paper.landing_page_url) return 0.3;
  return 0;
}

function computeMethodMatch(paper, query) {
  const methodTerms = ['transformer', 'attention', 'cnn', 'rnn', 'lstm', 'bert', 'gpt',
    'diffusion', 'gan', 'vae', 'reinforcement', 'graph neural', 'kernel',
    'svm', 'random forest', 'gradient', 'optimization', 'embedding',
    'quantization', 'distillation', 'pruning', 'compression', 'sparsity',
    'fine-tuning', 'prompt', 'retrieval', 'generative', 'contrastive',
    'multi-modal', 'fusion', 'encoder', 'decoder', 'attention',
    'kv cache', 'paged', 'flash', 'speculative', 'prefix', 'sliding window',
    'mixture of experts', 'moe', 'routing', 'gating'];

  const queryLower = query.toLowerCase();
  const titleLower = (paper.title || '').toLowerCase();
  const abstractLower = (paper.abstract || '').toLowerCase();

  let queryMethodMatches = 0;
  let paperMethodMatches = 0;

  for (const term of methodTerms) {
    if (queryLower.includes(term)) queryMethodMatches++;
    if (titleLower.includes(term) || abstractLower.includes(term)) paperMethodMatches++;
  }

  if (queryMethodMatches === 0) return 0.5;

  return Math.min(1, paperMethodMatches / queryMethodMatches);
}

function computeReproducibilitySignal(paper) {
  let score = 0;
  const text = ((paper.abstract || '') + ' ' + (paper.title || '')).toLowerCase();

  if (text.includes('github') || text.includes('code') || text.includes('repository')) score += 0.3;
  if (text.includes('dataset') || text.includes('benchmark')) score += 0.2;
  if (text.includes('open source') || text.includes('publicly available')) score += 0.2;
  if (paper.license && paper.license.includes('creative')) score += 0.1;

  const sourceCount = (paper.source_records || []).length;
  score += Math.min(0.2, sourceCount * 0.05);

  return Math.min(1, score);
}

export function rankPapers(papers, query, { domain = 'ai_ml' } = {}) {
  const weights = WEIGHTS[domain] || WEIGHTS.default;

  return papers.map(paper => {
    const relevance = computeRelevance(paper, query);
    const source_authority = computeSourceAuthority(paper);
    const recency = computeRecency(paper, domain);
    const citation_signal = computeCitationSignal(paper);
    const availability = computeAvailability(paper);
    const method_match = computeMethodMatch(paper, query);
    const reproducibility = computeReproducibilitySignal(paper);

    const final =
      weights.relevance * relevance +
      weights.source_authority * source_authority +
      weights.recency * recency +
      weights.citation_signal * citation_signal +
      weights.method_match * method_match +
      weights.open_access_availability * availability +
      weights.reproducibility_signal * reproducibility;

    return {
      ...paper,
      scores: {
        relevance: Math.round(relevance * 100) / 100,
        freshness: Math.round(recency * 100) / 100,
        authority: Math.round(source_authority * 100) / 100,
        availability: Math.round(availability * 100) / 100,
        method_match: Math.round(method_match * 100) / 100,
        reproducibility: Math.round(reproducibility * 100) / 100,
        final: Math.round(final * 100) / 100
      }
    };
  }).sort((a, b) => b.scores.final - a.scores.final);
}
