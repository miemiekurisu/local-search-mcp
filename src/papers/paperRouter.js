export const DOMAIN_ROUTES = {
  ai_ml: ['semantic_scholar', 'openalex', 'arxiv'],
  math: ['arxiv', 'openalex', 'crossref'],
  physics: ['arxiv', 'openalex', 'crossref'],
  medicine: ['pubmed', 'openalex', 'crossref'],
  biology: ['pubmed', 'openalex', 'crossref'],
  default: ['openalex', 'crossref', 'arxiv']
};

export const INTENT_ROUTES = {
  paper_search: ['openalex', 'semantic_scholar', 'arxiv', 'crossref'],
  paper_lookup: ['openalex', 'semantic_scholar', 'arxiv', 'crossref', 'unpaywall'],
  citation_graph: ['openalex', 'semantic_scholar'],
  open_access: ['unpaywall'],
  metadata_verify: ['crossref', 'openalex']
};

export class PaperRouter {
  constructor(sourceRegistry) {
    this.sourceRegistry = sourceRegistry;
  }

  chooseSources({ domain, intent, sources } = {}) {
    if (sources && sources.length > 0 && !sources.includes('auto')) {
      return sources.filter(id => this.sourceRegistry.isSourceEnabled(id));
    }

    const candidates = this.chooseSourcesByIntent(intent || 'paper_search');
    const domainSources = DOMAIN_ROUTES[domain] || DOMAIN_ROUTES.default;

    const merged = [];
    const seen = new Set();
    for (const id of [...domainSources, ...candidates]) {
      if (!seen.has(id) && this.sourceRegistry.isSourceEnabled(id)) {
        seen.add(id);
        merged.push(id);
      }
    }

    if (merged.length === 0) {
      return this.sourceRegistry.getEnabledSources()
        .filter(s => s.capabilities.includes('paper_search'))
        .map(s => s.id);
    }

    return merged;
  }

  chooseSourcesByIntent(intent) {
    const candidates = INTENT_ROUTES[intent] || INTENT_ROUTES.paper_search;
    return candidates.filter(id => this.sourceRegistry.isSourceEnabled(id));
  }
}
