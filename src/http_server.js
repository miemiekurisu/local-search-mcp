import express from 'express';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config/index.js';
import { createKernel } from './app.js';
import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';
import { createMcpServer } from './mcp/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerOpenApiRoutes } from './openapi/routes.js';

export function createApp(kernelOverride, browserPoolOverride) {
  const kernel = kernelOverride || createKernel().kernel;
  const browserPool = kernelOverride ? null : (browserPoolOverride || null);
  const actualBrowserPool = browserPoolOverride || kernel.browserPool;
  const mcpServer = createMcpServer(kernel, actualBrowserPool);

  const rateLimitMap = new Map();
  const RATE_LIMIT_MAX_ENTRIES = 10000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > CONFIG.rateLimitWindowMs * 2) {
        rateLimitMap.delete(key);
      }
    }
    if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
      const entries = [...rateLimitMap.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      rateLimitMap.clear();
      for (const e of entries.slice(-Math.floor(RATE_LIMIT_MAX_ENTRIES / 2))) {
        rateLimitMap.set(e[0], e[1]);
      }
    }
  }, 60000).unref();

  function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now - entry.windowStart > CONFIG.rateLimitWindowMs) {
      entry = { windowStart: now, count: 0 };
      rateLimitMap.set(ip, entry);
    }
    entry.count++;
    const remaining = Math.max(0, CONFIG.rateLimitMaxRequests - entry.count);
    res.set('X-RateLimit-Limit', String(CONFIG.rateLimitMaxRequests));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (entry.count > CONFIG.rateLimitMaxRequests) {
      const elapsed = now - entry.windowStart;
      const retryAfter = Math.ceil((CONFIG.rateLimitWindowMs - elapsed) / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Retry after ${Math.max(1, retryAfter)}s.`
        }
      });
    }
    next();
  }

  function authMiddleware(req, res, next) {
    if (!CONFIG.mcpBearerToken) {
      return next();
    }
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== CONFIG.mcpBearerToken) {
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing Bearer token' }
      });
    }
    next();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimiter);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use(authMiddleware);

  function redactBrowserSession(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const { cdp_url, state_path, visible_browser_profile_dir, ...rest } = obj;
    return rest;
  }

  function redactErrorDetails(details) {
    if (!details || typeof details !== 'object') return details;
    const redacted = { ...details };
    if (redacted.browser_session) {
      redacted.browser_session = redactBrowserSession(redacted.browser_session);
    }
    return redacted;
  }

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
            details: redactErrorDetails(errorObject.details),
            stack: process.env.NODE_ENV === 'production' ? undefined : errorObject.stack
          }
        });
      }
    };
  }

  app.get('/engine_status', asyncRoute(async () => kernel.engineStatus()));
  app.get('/browser_sessions', asyncRoute(async () => kernel.browserSessions()));
  app.post('/browser_sessions/open', asyncRoute(args => kernel.openBrowserSession(args)));
  app.post('/browser_sessions/save', asyncRoute(args => kernel.saveBrowserSession(args)));
  app.post('/search', asyncRoute(args => kernel.searchWeb(args)));
  app.post('/fetch_page', asyncRoute(args => kernel.fetchPage(args)));
  app.post('/search_and_fetch', asyncRoute(args => kernel.searchAndFetch(args)));
  app.post('/research_problem', asyncRoute(args => kernel.researchProblem(args)));
  app.post('/artifact', asyncRoute(args => kernel.getArtifact(args)));

  registerOpenApiRoutes(app, kernel);

  // MCP over HTTP — custom JSON-RPC endpoint
  app.post('/mcp', async (req, res) => {
    try {
      const message = req.body;
      if (!message || !message.jsonrpc || !message.method) {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
      }

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
              'This server provides 8 tools for web search, weather, time, and evidence gathering.',
              'Quick start: use search_web to search DuckDuckGo + Wikipedia (no login needed).',
              'Add "google", "bing", or "chatgpt" to engines[] for browser-based search.',
              'Use get_weather to get weather forecast for any location.',
              'Use get_time to get current time with timezone support.'
            ].join('\n')
          }
        });
      }

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
                    max_chars_total: { type: 'integer', minimum: 2000, maximum: 200000 }
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
            name: 'get_time',
            description: 'Get current time and date. Supports timezone queries like "Beijing", "Tokyo", "UTC", "New York", "London". Default timezone from TIMEZONE env var.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Timezone hint: "UTC", "Beijing", "Tokyo", "New York", "London", etc.' }
              }
            }
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

      if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params || {};
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

      if (message.method === 'resources/list') {
        return res.json({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
      }

      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` }
      });
    } catch (err) {
      console.error('[mcp-http] error:', err);
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32603, message: err.message || 'Internal error' }
      });
    }
  });

  // Streamable HTTP transport (MCP spec 2025-11-25)
  // Each session gets its own transport + McpServer, registered by onsessioninitialized.
  // This follows the SDK's simpleStreamableHttp.js pattern to support multiple clients
  // (e.g. ChatBox uses StreamableHTTPClientTransport with SSE fallback).
  const MAX_STREAMABLE_SESSIONS = 500;
  const SESSION_TTL_MS = 3600000;
  const streamableSessions = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of streamableSessions) {
      if (now - entry.createdAt > SESSION_TTL_MS) {
        console.log(`[mcp-stream] evicting stale session: ${sid}`);
        streamableSessions.delete(sid);
        entry.transport.close().catch(() => {});
      }
    }
  }, 60000).unref();
  app.all('/mcp-stream', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport;
      if (sessionId && streamableSessions.has(sessionId)) {
        transport = streamableSessions.get(sessionId).transport;
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        if (streamableSessions.size >= MAX_STREAMABLE_SESSIONS) {
          const oldest = streamableSessions.entries().next().value;
          if (oldest) {
            console.log(`[mcp-stream] evicting oldest session: ${oldest[0]}`);
            streamableSessions.delete(oldest[0]);
            oldest[1].transport.close().catch(() => {});
          }
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.log(`[mcp-stream] session initialized: ${sid}`);
            streamableSessions.set(sid, { transport, createdAt: Date.now() });
          }
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && streamableSessions.has(sid)) {
            console.log(`[mcp-stream] session closed: ${sid}`);
            streamableSessions.delete(sid);
          }
        };
        const server = createMcpServer(kernel, actualBrowserPool);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp-stream] error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // SSE transport for remote MCP clients (opencode uses SSE for "type": "remote")
  // Each SSE connection needs its own McpServer (SDK Protocol only supports one transport per instance)
  // plus a serialized send() to prevent SSE write interleaving under concurrency.
  const MAX_SSE_TRANSPORTS = 500;
  const sseTransports = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sseTransports) {
      if (now - entry.createdAt > SESSION_TTL_MS) {
        console.log(`[sse] evicting stale session: ${sid}`);
        sseTransports.delete(sid);
        entry.server.close().catch(() => {});
      }
    }
  }, 60000).unref();

  app.get('/sse', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      if (sseTransports.size >= MAX_SSE_TRANSPORTS) {
        const oldest = sseTransports.entries().next().value;
        if (oldest) {
          console.log(`[sse] evicting oldest transport: ${oldest[0]}`);
          sseTransports.delete(oldest[0]);
          oldest[1].server.close().catch(() => {});
        }
      }

      // Serialize send() to prevent SSE write interleaving from concurrent tool handlers
      let sendQueue = Promise.resolve();
      const origSend = transport.send.bind(transport);
      transport.send = (message) => {
        const task = sendQueue.then(() => origSend(message));
        sendQueue = task.catch(() => {});
        return task;
      };

      const server = createMcpServer(kernel, actualBrowserPool);
      await server.connect(transport);

      sseTransports.set(transport.sessionId, { transport, server, createdAt: Date.now() });

      res.on('close', () => {
        sseTransports.delete(transport.sessionId);
        server.close().catch(() => {});
      });
    } catch (err) {
      console.error('[sse] connection error:', err);
      if (!res.headersSent) {
        res.status(500).end('Internal error');
      }
    }
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      return res.status(404).end('Session not found');
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  return { app, kernel, browserPool: actualBrowserPool, mcpServer, sseTransports };
}

// ── Top-level entry point (when run directly, not imported) ──
if (process.argv[1] && (
  process.argv[1] === import.meta.filename ||
  process.argv[1].replace(/\\/g, '/').endsWith('/src/http_server.js')
)) {
  const { kernel, browserPool } = createKernel();
  const { app } = createApp(kernel);
  const server = app.listen(CONFIG.port, '0.0.0.0', () => {
    server.maxConnections = 50;
    console.log(`[local-search-mcp] HTTP server listening on :${CONFIG.port}`);
    console.log(`[local-search-mcp] MCP JSON-RPC endpoint: http://localhost:${CONFIG.port}/mcp`);
    console.log(`[local-search-mcp] MCP Streamable HTTP endpoint: http://localhost:${CONFIG.port}/mcp-stream`);
    console.log(`[local-search-mcp] MCP SSE transport endpoint: http://localhost:${CONFIG.port}/sse`);
  });

  async function shutdown() {
    console.log('[local-search-mcp] shutting down');
    await closeChromeDevtoolsMcpClient().catch(() => {});
    await browserPool.close();
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
