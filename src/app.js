import { CONFIG, ensureDir } from './config/index.js';
import { ProxyRouter } from './config/proxy.js';
import { PlaywrightPool } from './browser/playwrightPool.js';
import { ArtifactStore } from './artifacts/artifactStore.js';
import { SearchKernel } from './kernel/searchKernel.js';
import { ToolRegistry } from './registry/toolRegistry.js';
import { PaperKernel } from './papers/paperKernel.js';
import { PaperCacheStore } from './papers/cache/paperCacheStore.js';
import { PaperCacheCleanup } from './papers/cache/paperCacheCleanup.js';
import { PaperContentKernel } from './papers/content/paperContentKernel.js';

export function createKernel() {
  ensureDir(CONFIG.artifactDir);
  ensureDir(CONFIG.browserStateDir);
  const proxyRouter = new ProxyRouter();
  const artifactStore = new ArtifactStore(CONFIG.artifactDir);
  const browserPool = new PlaywrightPool(proxyRouter);
  const kernel = new SearchKernel({ proxyRouter, browserPool, artifactStore });

  const toolRegistry = new ToolRegistry();
  const paperCacheStore = CONFIG.paperCache.enabled ? new PaperCacheStore() : null;
  const paperCacheCleanup = paperCacheStore ? new PaperCacheCleanup(paperCacheStore) : null;
  let paperKernel = null;
  let paperContentKernel = null;

  if (process.env.ENABLE_PAPER_TOOLS === 'true') {
    paperKernel = new PaperKernel({ artifactStore, paperCacheStore });
    paperContentKernel = new PaperContentKernel({ paperKernel, paperCacheStore, paperCacheCleanup });

    const missing = [];
    if (!process.env.OPENALEX_API_KEY) missing.push('OpenAlex (get key: https://openalex.org/keys)');
    if (!process.env.CROSSREF_MAILTO) missing.push('Crossref (set CROSSREF_MAILTO=your@email for higher rate limits)');
    if (!process.env.UNPAYWALL_EMAIL) missing.push('Unpaywall (set UNPAYWALL_EMAIL=your@email)');
    if (missing.length) {
      console.warn('[local-search-mcp] Paper sources requiring config:');
      for (const msg of missing) console.warn('  ⚠ ' + msg);
      console.warn('  → Unconfigured sources will be skipped at runtime.');
    }
  }

  return { kernel, browserPool, toolRegistry, paperKernel, paperContentKernel, paperCacheStore, paperCacheCleanup };
}
