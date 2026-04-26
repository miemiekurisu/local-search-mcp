import { CONFIG } from '../config/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { makeResult, SearchEngineError } from './base.js';

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const EXA_API_KEY = process.env.EXA_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

const FALLBACK_APIS = ['brave', 'tavily', 'exa', 'google'];

export async function searchViaApi(apiName, query, limit = 10) {
  switch (apiName) {
    case 'brave':
      return await searchBrave(query, limit);
    case 'tavily':
      return await searchTavily(query, limit);
    case 'exa':
      return await searchExa(query, limit);
    case 'google':
      return await searchGoogleApi(query, limit);
    default:
      return [];
  }
}

async function searchBrave(query, limit) {
  if (!BRAVE_API_KEY) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const resp = await fetchWithTimeout(url, {
    timeoutMs: CONFIG.defaultTimeoutMs,
    headers: { 'Accept': 'application/json', 'X-Brave-Key': BRAVE_API_KEY }
  });
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => ({}));
  if (!data.web || !data.web.results) return [];
  return data.web.results.map((item, i) => makeResult({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    engine: 'brave',
    rank: i + 1
  }));
}

async function searchTavily(query, limit) {
  if (!TAVILY_API_KEY) return [];
  const url = 'https://api.tavily.com/search';
  const body = JSON.stringify({
    api_key: TAVILY_API_KEY,
    query,
    max_results: limit,
    include_answer: false,
    include_raw_content: false,
    include_images: false
  });
  const resp = await fetchWithTimeout(url, {
    timeoutMs: CONFIG.defaultTimeoutMs,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => ({}));
  if (!data.results || !Array.isArray(data.results)) return [];
  return data.results.map((item, i) => makeResult({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
    engine: 'tavily',
    rank: i + 1
  }));
}

async function searchExa(query, limit) {
  if (!EXA_API_KEY) return [];
  const url = 'https://api.exa.ai/search';
  const body = JSON.stringify({
    query,
    num_results: limit,
    include_domains: [],
    exclude_domains: []
  });
  const resp = await fetchWithTimeout(url, {
    timeoutMs: CONFIG.defaultTimeoutMs,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY },
    body
  });
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => ({}));
  if (!data.results || !Array.isArray(data.results)) return [];
  return data.results.map((item, i) => makeResult({
    title: item.title || '',
    url: item.url || '',
    snippet: item.text || '',
    engine: 'exa',
    rank: i + 1
  }));
}

async function searchGoogleApi(query, limit) {
  if (!GOOGLE_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) return [];
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${limit}`;
  const resp = await fetchWithTimeout(url, { timeoutMs: CONFIG.defaultTimeoutMs });
  if (!resp.ok) return [];
  const data = await resp.json().catch(() => ({}));
  if (!data.items || !Array.isArray(data.items)) return [];
  return data.items.map((item, i) => makeResult({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    engine: 'google',
    rank: i + 1
  }));
}

export async function searchWithFallbacks(query, limit, failedEngines = []) {
  const apiKeyExists = BRAVE_API_KEY || TAVILY_API_KEY || EXA_API_KEY || GOOGLE_API_KEY;
  if (!apiKeyExists) return null;
  
  const available = FALLBACK_APIS.filter(api => !failedEngines.includes(api));
  
  for (const api of available) {
    const results = await searchViaApi(api, query, limit);
    if (results.length > 0) return { results, via: api };
  }
  
  return null;
}