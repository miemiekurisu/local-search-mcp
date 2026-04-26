import { CONFIG, ensureDir } from './config/index.js';
import { ProxyRouter } from './config/proxy.js';
import { PlaywrightPool } from './browser/playwrightPool.js';
import { ArtifactStore } from './artifacts/artifactStore.js';
import { SearchKernel } from './kernel/searchKernel.js';

export function createKernel() {
  ensureDir(CONFIG.artifactDir);
  ensureDir(CONFIG.browserStateDir);
  const proxyRouter = new ProxyRouter();
  const artifactStore = new ArtifactStore(CONFIG.artifactDir);
  const browserPool = new PlaywrightPool(proxyRouter);
  const kernel = new SearchKernel({ proxyRouter, browserPool, artifactStore });
  return { kernel, browserPool };
}
