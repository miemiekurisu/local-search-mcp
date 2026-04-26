export class SearchEngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SearchEngineError';
    this.code = code;
    this.details = details;
  }
}

export function makeResult({ title, url, snippet = '', engine, rank }) {
  return {
    title: String(title || '').trim(),
    url: String(url || '').trim(),
    snippet: String(snippet || '').trim(),
    engine,
    rank
  };
}
