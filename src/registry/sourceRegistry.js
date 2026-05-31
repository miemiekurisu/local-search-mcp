export const ACADEMIC_SOURCE_POLICIES = {
  openalex: {
    minIntervalMs: 120,
    maxConcurrency: 2,
    requiresKey: true
  },
  semantic_scholar: {
    minIntervalMs: 1100,
    maxConcurrency: 1,
    requiresKey: true
  },
  arxiv: {
    minIntervalMs: 3200,
    maxConcurrency: 1,
    requiresKey: false
  },
  crossref: {
    minIntervalMs: 250,
    maxConcurrency: 1,
    requiresKey: false,
    recommendsMailto: true
  },
  unpaywall: {
    minIntervalMs: 150,
    maxConcurrency: 2,
    requiresEmail: true
  },
  opencitations: {
    minIntervalMs: 400,
    maxConcurrency: 1
  },
  ncbi: {
    minIntervalMs: 350,
    maxConcurrency: 1
  }
};

export class SourceRegistry {
  constructor() {
    this.sources = new Map();
    this._registerDefaults();
  }

  _registerDefaults() {
    const defaults = {
      openalex: {
        type: 'academic_metadata',
        enabled: true,
        capabilities: ['paper_search', 'paper_lookup', 'citation_graph'],
        rateLimit: { minIntervalMs: 120, maxConcurrency: 2 },
        requiresKey: true
      },
      semantic_scholar: {
        type: 'academic_metadata',
        enabled: true,
        capabilities: ['paper_search', 'paper_lookup', 'citation_graph'],
        rateLimit: { minIntervalMs: 1100, maxConcurrency: 1 },
        requiresKey: true
      },
      arxiv: {
        type: 'academic_preprint',
        enabled: true,
        capabilities: ['paper_search', 'paper_lookup'],
        rateLimit: { minIntervalMs: 3200, maxConcurrency: 1 },
        requiresKey: false
      },
      crossref: {
        type: 'academic_metadata',
        enabled: true,
        capabilities: ['paper_lookup', 'metadata_validation'],
        rateLimit: { minIntervalMs: 250, maxConcurrency: 1 },
        requiresKey: false,
        recommendsMailto: true
      },
      unpaywall: {
        type: 'open_access',
        enabled: true,
        capabilities: ['open_access_lookup'],
        rateLimit: { minIntervalMs: 150, maxConcurrency: 2 },
        requiresEmail: true
      },
      opencitations: {
        type: 'citation_graph',
        enabled: true,
        capabilities: ['citation_graph'],
        rateLimit: { minIntervalMs: 400, maxConcurrency: 1 },
        requiresKey: false
      },
      ncbi: {
        type: 'academic_metadata',
        enabled: true,
        capabilities: ['paper_search', 'paper_lookup'],
        rateLimit: { minIntervalMs: 350, maxConcurrency: 1 },
        requiresKey: false
      }
    };

    for (const [id, config] of Object.entries(defaults)) {
      this.register({ id, ...config });
    }
  }

  register({ id, type, enabled, capabilities, rateLimit, requiresKey, requiresEmail, recommendsMailto }) {
    this.sources.set(id, {
      id,
      type: type || 'unknown',
      enabled: enabled !== undefined ? enabled : true,
      capabilities: capabilities || [],
      rateLimit: rateLimit || { minIntervalMs: 1000, maxConcurrency: 1 },
      requiresKey: requiresKey || false,
      requiresEmail: requiresEmail || false,
      recommendsMailto: recommendsMailto || false
    });
  }

  getSource(id) {
    return this.sources.get(id) || null;
  }

  getEnabledSources() {
    const result = [];
    for (const source of this.sources.values()) {
      if (source.enabled) {
        result.push(source);
      }
    }
    return result;
  }

  getSourcesByCapability(capability) {
    const result = [];
    for (const source of this.sources.values()) {
      if (source.enabled && source.capabilities.includes(capability)) {
        result.push(source);
      }
    }
    return result;
  }

  getSourceRateLimit(id) {
    const source = this.sources.get(id);
    if (!source) return null;
    return { ...source.rateLimit };
  }

  isSourceEnabled(id) {
    const source = this.sources.get(id);
    return source ? source.enabled : false;
  }
}
