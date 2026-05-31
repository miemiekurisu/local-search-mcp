import fs from 'fs';
import path from 'path';

export const CONFIG = {
  port: Number(process.env.PORT || 8765),
  artifactDir: process.env.ARTIFACT_DIR || '/data/artifacts',
  browserStateDir: process.env.BROWSER_STATE_DIR || '/data/browser-state',
  defaultSearchLimit: clampInt(process.env.DEFAULT_SEARCH_LIMIT, 20, 1, 20),
  defaultFetchTopK: clampInt(process.env.DEFAULT_FETCH_TOP_K, 20, 1, 20),
  maxSearchLimit: clampInt(process.env.MAX_SEARCH_LIMIT, 20, 1, 20),
  maxFetchConcurrency: clampInt(process.env.MAX_FETCH_CONCURRENCY, 3, 1, 8),
  defaultTimeoutMs: clampInt(process.env.DEFAULT_TIMEOUT_MS, 15000, 2000, 120000),
  browserTimeoutMs: clampInt(process.env.BROWSER_TIMEOUT_MS, 25000, 5000, 180000),
  headless: (process.env.SEARCH_HEADLESS || 'true') !== 'false',
  chromeDevtoolsMcpCommand: process.env.CHROME_DEVTOOLS_MCP_COMMAND || 'node_modules/.bin/chrome-devtools-mcp',
  chromeDevtoolsMcpBrowserUrl: process.env.CHROME_DEVTOOLS_MCP_BROWSER_URL || process.env.CDP_URL || 'http://127.0.0.1:9224',
  customEnginesFile: process.env.CUSTOM_ENGINES_FILE || '/app/config/search_engines.json',
  proxyProfilesFile: process.env.PROXY_PROFILES_FILE || '/app/config/proxy_profiles.json',

  paperCache: {
    enabled: (process.env.PAPER_CACHE_ENABLED || 'true') !== 'false',
    dir: process.env.PAPER_CACHE_DIR || '/data/cache/papers',
    manifest: process.env.PAPER_CACHE_MANIFEST || '/data/cache/papers/manifest.sqlite',
    rawDir: process.env.PAPER_CACHE_RAW_DIR || '/data/cache/papers/raw',
    textDir: process.env.PAPER_CACHE_TEXT_DIR || '/data/cache/papers/text',
    sectionDir: process.env.PAPER_CACHE_SECTION_DIR || '/data/cache/papers/sections',
    chunkDir: process.env.PAPER_CACHE_CHUNK_DIR || '/data/cache/papers/chunks',
    tmpDir: process.env.PAPER_CACHE_TMP_DIR || '/data/cache/papers/tmp',
    maxBytes: clampInt(process.env.PAPER_CACHE_MAX_BYTES, 10 * 1024 * 1024 * 1024, 100 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    rawMaxBytes: clampInt(process.env.PAPER_CACHE_RAW_MAX_BYTES, 4 * 1024 * 1024 * 1024, 50 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    rawTtlDays: clampInt(process.env.PAPER_CACHE_RAW_TTL_DAYS, 7, 1, 365),
    textTtlDays: clampInt(process.env.PAPER_CACHE_TEXT_TTL_DAYS, 90, 1, 3650),
    bundleTtlDays: clampInt(process.env.PAPER_CACHE_BUNDLE_TTL_DAYS, 30, 1, 3650),
    fetchMaxBytes: clampInt(process.env.PAPER_FETCH_MAX_BYTES, 50 * 1024 * 1024, 1024 * 1024, 500 * 1024 * 1024),
    maxFulltextPapers: clampInt(process.env.PAPER_FETCH_MAX_FULLTEXT_PAPERS, 5, 1, 50),
    preserveRaw: (process.env.PAPER_FETCH_PRESERVE_RAW || 'false') === 'true'
  }
};

export function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function readJsonIfExists(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[config] failed to read ${filePath}:`, err.message);
    return fallback;
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function safeJoin(base, ...parts) {
  const target = path.resolve(base, ...parts);
  const resolvedBase = path.resolve(base);
  const relative = path.relative(resolvedBase, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('unsafe path traversal');
  }
  return target;
}
