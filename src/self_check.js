import { createKernel } from './app.js';
const { kernel, browserPool } = createKernel();
try {
  const q = process.argv.slice(2).join(' ') || 'local search mcp playwright';
  const r = await kernel.searchAndFetch({ query: q, limit: 5, fetch_top_k: 2, max_chars_total: 8000 });
  console.log(JSON.stringify(r, null, 2));
} finally {
  await browserPool.close();
}
