import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createMcpServer(kernel, browserPool, { paperKernel, paperContentKernel, paperCacheStore, paperCacheCleanup } = {}) {
  const server = new McpServer(
    {
      name: 'local-search-mcp',
      version: '0.1.0',
      description: 'Local Search & Web Evidence service — search the web and fetch pages without a paid search API.'
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: {}
      },
      instructions: [
        'This server provides 8 tools for web search, weather, time, and evidence gathering.',
        '',
        'Quick start:',
        '  - Use search_web to search DuckDuckGo + Wikipedia via HTTP (no login, no browser needed).',
        '  - To use Google, Bing, or ChatGPT, add them to engines[] explicitly.',
        '  - Browser-dependent engines require prior login via the noVNC browser.',
        '  - The browser is automatically closed after each query. It only stays open when CAPTCHA/manual intervention is needed.',
        '  - Use fetch_page to extract clean text from any URL. Supports HTML pages (mode:"auto" falls back to Playwright for JS-rendered sites like mp.weixin.qq.com) and PDF files (automatic text extraction).',
        '  - Use search_and_fetch to combine search and page fetching in one call.',
        '  - Use research_problem for multi-query deep research.',
        '  - Tools return artifact_ref values (e.g. artifact://pages/xxx.txt). Use get_artifact to read them in chunks with offset/limit.',
        '  - Use engine_status to check which search engines and proxies are available.',
      ].join('\n')
    }
  );

  function textContent(text) {
    return { content: [{ type: 'text', text }] };
  }

  function jsonContent(data) {
    return textContent(JSON.stringify(data, null, 2));
  }

  function errorContent(message, details) {
    return {
      content: [{ type: 'text', text: details ? `${message}\n${JSON.stringify(details, null, 2)}` : message }],
      isError: true
    };
  }

  function withTimeout(promise, ms) {
    const timer = new Promise((_, reject) => {
      const id = setTimeout(() => {
        const err = new Error(`Timed out after ${ms}ms`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms);
      if (typeof id.unref === 'function') id.unref();
      promise.then(() => clearTimeout(id), () => clearTimeout(id)).catch(() => {});
    });
    return Promise.race([promise, timer]);
  }

  function wrapHandler(handler) {
    return async (args, extra) => {
      try {
        return await handler(args, extra);
      } catch (err) {
        const msg = err?.message || String(err);
        const details = err?.details || err?.code ? { code: err.code, ...err.details } : undefined;
        return errorContent(msg, details);
      }
    };
  }

  function browserEngines(args) {
    return args?.engines?.filter?.(e => e === 'google' || e === 'bing' || e === 'chatgpt') || [];
  }

  async function closeBrowserAfterSearch(args) {
    const usedBrowserEngines = browserEngines(args);
    if (usedBrowserEngines.length === 0) return;
    const hasInteractivePage = usedBrowserEngines.some(e => {
      const s = e === 'chatgpt' ? 'chatgpt' : e;
      return browserPool.sessionStatus(s)?.interactive_page_url;
    });
    if (!hasInteractivePage) {
      await browserPool.close().catch(() => {});
    }
  }

  server.registerTool('search_web', {
    title: 'Search the Web',
    description: 'Search DuckDuckGo, Wikipedia, or custom HTML engines. Returns up to 20 search results with snippets. Can optionally auto-fetch full text from top results via fetch_top_k. To use Google/Bing/ChatGPT, specify them explicitly in engines[] — they require prior login via noVNC (http://localhost:6082). No paid API required.',
    inputSchema: {
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default: 10, max: 20)'),
      engines: z.array(z.string()).optional().describe('Engines: default uses DuckDuckGo + Wikipedia (HTTP, no login). Add "google", "bing", or "chatgpt" explicitly if logged in.'),
      fetch_top_k: z.number().int().min(0).max(20).optional().describe('Number of top results to auto-fetch full text (0 = skip fetching). Default 0. Use search_and_fetch for fetching with results.'),
      fetch_mode: z.enum(['auto', 'http', 'browser']).optional().describe('Fetch mode for full text extraction when fetch_top_k > 0. auto=try HTTP then browser fallback.'),
      proxy_profile: z.string().optional().describe('Proxy profile name (default: "auto")')
    }
  }, wrapHandler(async (args) => {
    const result = await withTimeout(kernel.searchWeb(args), 120000);
    await closeBrowserAfterSearch(args);
    return jsonContent(result);
  }));

  server.registerTool('fetch_page', {
    title: 'Fetch a Web Page',
    description: 'Fetch a URL and return extracted plain text. Supports: (1) HTML pages via HTTP or Playwright browser fallback for JS-rendered sites like mp.weixin.qq.com and SPAs; (2) PDF files — automatically extracts text using pdf-parse. Results stored as artifact for chunked reading via get_artifact.',
    inputSchema: {
      url: z.string().url().describe('URL to fetch'),
      mode: z.enum(['auto', 'http', 'browser']).optional().describe('Fetch mode: auto (try http then browser), http, or browser. For PDF files, HTTP mode is used automatically.'),
      proxy_profile: z.string().optional().describe('Proxy profile name'),
      max_chars: z.number().int().min(1000).max(100000).optional().describe('Max characters to extract')
    }
  }, wrapHandler(async (args) => {
    return jsonContent(await kernel.fetchPage(args));
  }));

  server.registerTool('search_and_fetch', {
    title: 'Search and Fetch Pages',
    description: 'Search the web and fetch the top result pages sequentially. Failed pages are skipped automatically. Returns an EvidenceBundle with text previews and artifact references.',
    inputSchema: {
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(20).optional().describe('Max search results per engine'),
      fetch_top_k: z.number().int().min(1).max(20).optional().describe('Number of result pages to fetch'),
      max_chars_total: z.number().int().min(2000).max(200000).optional().describe('Total max chars across all fetched pages'),
      proxy_profile: z.string().optional().describe('Proxy profile name')
    }
  }, wrapHandler(async (args) => {
    const result = await withTimeout(kernel.searchAndFetch(args), 180000);
    await closeBrowserAfterSearch(args);
    return jsonContent(result);
  }));

  server.registerTool('research_problem', {
    title: 'Research a Problem',
    description: 'Generate query families from a problem signature, search multiple engines, fetch evidence pages, and return structured evidence candidates with confidence scores. Ideal for debugging, issue investigation, and technical research.',
    inputSchema: {
      problem_signature: z.object({
        task: z.string().optional(),
        symptom: z.string().optional(),
        error_message: z.string().optional(),
        environment: z.any().optional(),
        constraints: z.array(z.string()).optional()
      }).describe('Problem description with task, symptom, error, environment, and constraints'),
      budget: z.object({
        max_queries: z.number().int().min(1).max(6).optional(),
        max_results_per_query: z.number().int().min(1).max(20).optional(),
        max_pages: z.number().int().min(1).max(20).optional(),
        max_chars_total: z.number().int().min(5000).max(200000).optional(),
        timeout_ms: z.number().int().min(30000).max(300000).optional().describe('Overall research timeout in ms (default: 300000 / 5 min)')
      }).optional().describe('Research budget controls'),
      source_policy: z.object({
        prefer: z.array(z.string()).optional(),
        proxy_profile: z.string().optional()
      }).optional().describe('Source preference and network policy')
    }
  }, wrapHandler(async (args) => {
    return jsonContent(await kernel.researchProblem(args));
  }));

  server.registerTool('get_artifact', {
    title: 'Read Artifact',
    description: 'Read a stored artifact (search results, fetched page, evidence bundle) in bounded chunks. Use the artifact_ref value returned by search_web, fetch_page, search_and_fetch, or research_problem. Read large results incrementally with offset/limit.',
    inputSchema: {
      artifact_ref: z.string().describe('Artifact reference (e.g. artifact://search/search_xxx.txt) — returned in tool output as artifact_ref'),
      offset: z.number().int().min(0).optional().describe('Byte offset to start reading from (default: 0)'),
      limit: z.number().int().min(1).max(100000).optional().describe('Max bytes to read (default: 8000). Increase for longer reads.')
    }
  }, wrapHandler(async (args) => {
    return jsonContent(kernel.getArtifact(args));
  }));

  server.registerTool('get_weather', {
    title: 'Get Weather',
    description: 'Get current weather and forecast for a location using Open-Meteo API (free, no API key). Supports Chinese city names (e.g. 北京). Returns current conditions, 7-day forecast, and hourly forecast.',
    inputSchema: {
      location: z.string().min(1).describe('City name or location, e.g. "Beijing", "北京", "Tokyo", "Shanghai"')
    }
  }, wrapHandler(async (args) => {
    const { searchWeather } = await import('../tools/weather.js');
    const result = await searchWeather(args.location);
    if (result.error) return errorContent(result.error);
    if (result.type === 'location_options') return textContent(result.content);
    return textContent(result.content);
  }));

  server.registerTool('get_time', {
    title: 'Get Current Time',
    description: 'Get current time and date. Supports timezone queries like "Beijing", "Tokyo", "UTC", "New York", "London". Default timezone from TIMEZONE env var.',
    inputSchema: {
      query: z.string().optional().describe('Timezone hint: "UTC", "Beijing", "Tokyo", "New York", "London", etc.')
    }
  }, wrapHandler(async (args) => {
    const { getCurrentTime } = await import('../tools/time.js');
    return textContent(getCurrentTime(args?.query).content);
  }));

  server.registerTool('engine_status', {
    title: 'Engine Status',
    description: 'Return available search engines, proxy profiles, browser session status, and rate limits.',
    inputSchema: {}
  }, wrapHandler(async (_args, _extra) => {
    return jsonContent(kernel.engineStatus());
  }));

  server.registerResource(
    'Artifact',
    new ResourceTemplate('artifact://{kind}/{file}', {
      list: async () => {
        return { resources: [] };
      }
    }),
    {
      description: 'Stored artifact from search or page fetch operations',
      mimeType: 'text/plain'
    },
    async (uri, variables) => {
      const ref = `artifact://${variables.kind}/${variables.file}`;
      const data = kernel.getArtifact({ artifact_ref: ref, offset: 0, limit: 100000 });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/plain',
          text: data.text
        }]
      };
    }
  );

  server.registerPrompt('search_and_summarize', {
    title: 'Search and Summarize',
    description: 'Search for a topic and summarize findings from the top results',
    argsSchema: {
      topic: z.string().describe('Topic to research and summarize')
    }
  }, async (args) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please search the web for information about "${args.topic}" and provide a concise summary. Use search_web and fetch_page tools to gather information from at least 3 different sources.`
      }
    }]
  }));

  server.registerPrompt('debug_error', {
    title: 'Debug an Error',
    description: 'Research an error message or technical problem and find solutions',
    argsSchema: {
      error_message: z.string().describe('The error message or problem description'),
      environment: z.string().optional().describe('Environment details (OS, version, framework, etc.)')
    }
  }, async (args) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `I need help debugging the following error:`,
          ``,
          `${args.error_message}`,
          args.environment ? `\nEnvironment: ${args.environment}\n` : '',
          ``,
          `Please research this error thoroughly. Use research_problem with a detailed problem_signature to search multiple sources. Look for official docs, GitHub issues, and StackOverflow answers. Provide the root cause, reproduction steps, and at least one working solution.`
        ].join('\n')
      }
    }]
  }));

  return server;
}
