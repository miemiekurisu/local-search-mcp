import express from 'express';
import { CONFIG } from './config/index.js';
import { createKernel } from './app.js';
import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';

const { kernel, browserPool } = createKernel();
const app = express();
app.use(express.json({ limit: '2mb' }));

function asyncRoute(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || req.query || {});
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: { code: err.code || 'ERROR', message: err.message, stack: process.env.NODE_ENV === 'production' ? undefined : err.stack } });
    }
  };
}

app.get('/health', (req, res) => res.json({ ok: true, name: 'local-search-mcp', version: '0.1.0' }));
app.get('/engine_status', asyncRoute(async () => kernel.engineStatus()));
app.get('/browser_sessions', asyncRoute(async () => kernel.browserSessions()));
app.post('/browser_sessions/open', asyncRoute(args => kernel.openBrowserSession(args)));
app.post('/browser_sessions/save', asyncRoute(args => kernel.saveBrowserSession(args)));
app.post('/search', asyncRoute(args => kernel.searchWeb(args)));
app.post('/fetch_page', asyncRoute(args => kernel.fetchPage(args)));
app.post('/search_and_fetch', asyncRoute(args => kernel.searchAndFetch(args)));
app.post('/research_problem', asyncRoute(args => kernel.researchProblem(args)));
app.post('/artifact', asyncRoute(args => kernel.getArtifact(args)));

const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`[local-search-mcp] HTTP server listening on :${CONFIG.port}`);
});

async function shutdown() {
  console.log('[local-search-mcp] shutting down');
  await closeChromeDevtoolsMcpClient().catch(() => {});
  await browserPool.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
