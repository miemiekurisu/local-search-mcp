import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createKernel } from './app.js';
import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';

const { kernel, browserPool } = createKernel();
const server = new McpServer({ name: 'local-search-mcp', version: '0.1.0' });

function jsonContent(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

server.tool('search_web', 'Search Google/Bing/DuckDuckGo/custom engines without paid API. Returns up to 20 search results.', {
  query: z.string(),
  limit: z.number().min(1).max(20).optional(),
  engines: z.array(z.string()).optional(),
  proxy_profile: z.string().optional()
}, async (args) => jsonContent(await kernel.searchWeb(args)));

server.tool('fetch_page', 'Fetch a URL and return extracted plain text with an artifact reference.', {
  url: z.string(),
  mode: z.enum(['auto', 'http', 'browser']).optional(),
  proxy_profile: z.string().optional(),
  max_chars: z.number().optional()
}, async (args) => jsonContent(await kernel.fetchPage(args)));

server.tool('search_and_fetch', 'Search then fetch result pages sequentially with failure skip. Returns EvidenceBundle.', {
  query: z.string(),
  limit: z.number().min(1).max(20).optional(),
  fetch_top_k: z.number().min(1).max(20).optional(),
  max_chars_total: z.number().optional(),
  proxy_profile: z.string().optional()
}, async (args) => jsonContent(await kernel.searchAndFetch(args)));

server.tool('research_problem', 'Generate query families from a problem signature, search/fetch pages, and return evidence candidates.', {
  problem_signature: z.record(z.any()),
  budget: z.record(z.any()).optional(),
  source_policy: z.record(z.any()).optional(),
  network_policy: z.record(z.any()).optional()
}, async (args) => jsonContent(await kernel.researchProblem(args)));

server.tool('get_artifact', 'Read an artifact by reference in bounded chunks.', {
  artifact_ref: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional()
}, async (args) => jsonContent(await kernel.getArtifact(args)));

server.tool('engine_status', 'Return available engines, proxy profiles, and limits.', {}, async () => jsonContent(kernel.engineStatus()));

process.on('SIGTERM', async () => { await closeChromeDevtoolsMcpClient().catch(() => {}); await browserPool.close(); process.exit(0); });
process.on('SIGINT', async () => { await closeChromeDevtoolsMcpClient().catch(() => {}); await browserPool.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
