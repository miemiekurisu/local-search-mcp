import express from 'express';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config/index.js';
import { createKernel } from './app.js';
import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';
import { createMcpServer } from './mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const rateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 60000).unref();

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
  }
  next();
}

const { kernel, browserPool } = createKernel();
const mcpServer = createMcpServer(kernel, browserPool);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(rateLimiter);

function asyncRoute(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || req.query || {});
      res.json({ ok: true, result });
    } catch (err) {
      const errorObject = err && typeof err === 'object' ? err : {};
      res.status(500).json({
        ok: false,
        error: {
          code: errorObject.code || 'ERROR',
          message: errorObject.message || String(err),
          engine: errorObject.engine,
          details: errorObject.details,
          stack: process.env.NODE_ENV === 'production' ? undefined : errorObject.stack
        }
      });
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

// MCP over HTTP — we create a lightweight JSON-RPC endpoint that wraps the MCP server
// using a dedicated stdio-style transport per request.
app.post('/mcp', async (req, res) => {
  try {
    const message = req.body;
    if (!message || !message.jsonrpc || !message.method) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    // For initialize, return server capabilities
    if (message.method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: {}
          },
          serverInfo: { name: 'local-search-mcp', version: '0.1.0' },
          instructions: [
            'This server provides 7 tools for web search, weather, and evidence gathering.',
            'Quick start: use search_web to search DuckDuckGo + Wikipedia (no login needed).',
            'Add "google", "bing", or "chatgpt" to engines[] for browser-based search.',
            'Use get_weather to get weather forecast for any location.'
            'Use get_time to get current time with timezone support.'
          ].join('\n')
        }
      });
    }

    // For tools/list — return registered tools
    if (message.method === 'tools/list') {
      const tools = [
        {
          name: 'search_web',
          description: 'Search DuckDuckGo, Wikipedia, or custom HTML engines. Returns up to 20 search results. To use Google/Bing/ChatGPT, specify them explicitly in engines[] — they require prior login via noVNC (http://localhost:6082).',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default: 10)' },
              engines: { type: 'array', items: { type: 'string' }, description: 'Engines: default uses DuckDuckGo + Wikipedia. Add "google", "bing", or "chatgpt".' },
              proxy_profile: { type: 'string', description: 'Proxy profile name' }
            },
            required: ['query']
          }
        },
        {
          name: 'fetch_page',
          description: 'Fetch a URL and return extracted plain text. Falls back to Playwright browser if HTTP fetch fails.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to fetch' },
              mode: { type: 'string', enum: ['auto', 'http', 'browser'], description: 'Fetch mode' },
              proxy_profile: { type: 'string', description: 'Proxy profile name' },
              max_chars: { type: 'integer', minimum: 1000, maximum: 100000, description: 'Max characters' }
            },
            required: ['url']
          }
        },
        {
          name: 'search_and_fetch',
          description: 'Search the web and fetch the top result pages sequentially.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
              fetch_top_k: { type: 'integer', minimum: 1, maximum: 20 },
              max_chars_total: { type: 'integer', minimum: 2000, maximum: 200000 },
              proxy_profile: { type: 'string' }
            },
            required: ['query']
          }
        },
        {
          name: 'research_problem',
          description: 'Generate query families from a problem signature, search multiple engines, fetch evidence pages, and return structured evidence candidates.',
          inputSchema: {
            type: 'object',
            properties: {
              problem_signature: {
                type: 'object',
                properties: {
                  task: { type: 'string' },
                  symptom: { type: 'string' },
                  error_message: { type: 'string' },
                  environment: {},
                  constraints: { type: 'array', items: { type: 'string' } }
                }
              },
              budget: {
                type: 'object',
                properties: {
                  max_queries: { type: 'integer', minimum: 1, maximum: 6 },
                  max_results_per_query: { type: 'integer', minimum: 1, maximum: 20 },
                  max_pages: { type: 'integer', minimum: 1, maximum: 20 },
                  max_chars_total: { type: 'integer', minimum: 5000, maximum: 200000 }
                }
              },
              source_policy: {
                type: 'object',
                properties: {
                  prefer: { type: 'array', items: { type: 'string' } },
                  proxy_profile: { type: 'string' }
                }
              }
            },
            required: ['problem_signature']
          }
        },
        {
          name: 'get_artifact',
          description: 'Read a stored artifact in bounded chunks.',
          inputSchema: {
            type: 'object',
            properties: {
              artifact_ref: { type: 'string', description: 'Artifact reference (e.g. artifact://search/search_xxx.txt)' },
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 100000 }
            },
            required: ['artifact_ref']
          }
        },
        {
          name: 'engine_status',
          description: 'Return available search engines, proxy profiles, browser session status, and rate limits.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'get_weather',
          description: 'Get current weather and forecast for a location using Open-Meteo API. Free, no API key needed.',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name or location, e.g. "Beijing", "Tokyo"' }
            },
            required: ['location']
          }
        }
      ];
      return res.json({ jsonrpc: '2.0', id: message.id, result: { tools } });
    }

    // For tools/call — execute the tool
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      let result;

      switch (name) {
        case 'search_web': {
          const r = await kernel.searchWeb(args || {});
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'fetch_page': {
          const r = await kernel.fetchPage(args || {});
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'search_and_fetch': {
          const r = await kernel.searchAndFetch(args || {});
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'research_problem': {
          const r = await kernel.researchProblem(args || {});
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'get_artifact': {
          const r = kernel.getArtifact(args || {});
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'engine_status': {
          const r = kernel.engineStatus();
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'get_time': {
          const { getCurrentTime } = await import('./tools/time.js');
          const r = getCurrentTime(args?.query);
          result = { content: [{ type: 'text', text: r.content }] };
          break;
        }
        case 'get_weather': {
          const { searchWeather } = await import('./tools/weather.js');
          const r = await searchWeather(args?.location);
          if (r.error) {
            result = { content: [{ type: 'text', text: r.error }], isError: true };
          } else {
            result = { content: [{ type: 'text', text: r.content }], locationOptions: r.type === 'location_options' ? r.locations : undefined };
          }
          break;
        }
        default:
          return res.json({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${name}` }
          });
      }

      return res.json({ jsonrpc: '2.0', id: message.id, result });
    }

    // For resources/list
    if (message.method === 'resources/list') {
      return res.json({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    }

    // Fallback
    return res.json({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  } catch (err) {
    console.error('[mcp-http] error:', err);
    res.json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message || 'Internal error' }
    });
  }
});

// Also provide the stdio MCP server on a separate endpoint using StreamableHTTP
const mcpTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID()
});
app.all('/mcp-stream', async (req, res) => {
  await mcpTransport.handleRequest(req, res, req.body);
});
mcpServer.connect(mcpTransport).catch(err => {
  console.error('[mcp-http] streamable transport connect error:', err);
});

const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  server.maxConnections = 50;
  console.log(`[local-search-mcp] HTTP server listening on :${CONFIG.port}`);
  console.log(`[local-search-mcp] MCP JSON-RPC endpoint: http://localhost:${CONFIG.port}/mcp`);
  console.log(`[local-search-mcp] MCP Streamable HTTP endpoint: http://localhost:${CONFIG.port}/mcp-stream`);
});

async function shutdown() {
  console.log('[local-search-mcp] shutting down');
  await closeChromeDevtoolsMcpClient().catch(() => {});
  await browserPool.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
