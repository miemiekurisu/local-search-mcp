import crypto from 'node:crypto';

export class EvidenceBundleBuilder {
  constructor({ bundleId, query, sourcePolicy }) {
    this.bundleId = bundleId || `eb_${crypto.randomUUID().slice(0, 8)}`;
    this.query = query || '';
    this.sourcePolicy = sourcePolicy || {};
    this.items = [];
    this.failures = [];
    this.createdAt = new Date().toISOString();
  }

  addWebResult({ title, url, snippet, engine, rank }) {
    this.items.push({
      type: 'web_search_result',
      title: title || '',
      url: url || '',
      snippet: snippet || '',
      engine: engine || '',
      rank: rank || 0,
      added_at: new Date().toISOString()
    });
    return this;
  }

  addFetchedPage({ url, text, charsExtracted, artifactRef }) {
    this.items.push({
      type: 'fetched_page',
      url: url || '',
      text: text || '',
      chars_extracted: charsExtracted || 0,
      artifact_ref: artifactRef || '',
      added_at: new Date().toISOString()
    });
    return this;
  }

  addPaper(paperRecord) {
    this.items.push({
      type: 'paper',
      ...paperRecord,
      added_at: new Date().toISOString()
    });
    return this;
  }

  addCitationEdge({ from, to, relation, source }) {
    this.items.push({
      type: 'citation_edge',
      from: from || '',
      to: to || '',
      relation: relation || 'cites',
      source: source || '',
      added_at: new Date().toISOString()
    });
    return this;
  }

  addFailure({ source, identifier, error, stage }) {
    const failure = {
      source: source || '',
      identifier: identifier || '',
      error: error || '',
      stage: stage || '',
      occurred_at: new Date().toISOString()
    };
    this.failures.push(failure);
    return this;
  }

  build() {
    return {
      bundle_id: this.bundleId,
      query: this.query,
      source_policy: this.sourcePolicy,
      items: this.items,
      failures: this.failures,
      item_count: this.items.length,
      failure_count: this.failures.length,
      created_at: this.createdAt
    };
  }
}
