export function buildOpenApiSpec(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Local Search Tools',
      version: '0.1.0',
      description: 'Local web search, page fetching, research, weather, time, and engine status tools for Open WebUI.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/tools/search_web': {
        post: {
          operationId: 'search_web',
          summary: 'Search the web and optionally fetch pages',
          description: 'Search DuckDuckGo, Wikipedia, or browser engines (Google/Bing/ChatGPT). Returns search results with snippets. By default auto-fetches full text from top results (fetch_top_k=5). For additional pages beyond the default, call fetch_page on specific URLs from the results, or increase fetch_top_k.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    query: { type: 'string', description: 'Search query.' },
                    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Max search results.' },
                    engines: { type: 'array', items: { type: 'string' }, description: 'Engine list: duckduckgo, wikipedia, google, bing, chatgpt.' },
                    fetch_top_k: { type: 'integer', minimum: 0, maximum: 20, default: 5, description: 'Number of top results to fetch full text (0 = skip fetching). Default 5 fetches ~5 top pages.' },
                    fetch_mode: { type: 'string', enum: ['auto', 'http', 'browser'], default: 'auto', description: 'Fetch mode for full text extraction.' },
                    max_chars_total: { type: 'integer', minimum: 2000, maximum: 100000, default: 30000, description: 'Total character budget across all fetched pages.' },
                    proxy_profile: { type: 'string', description: 'Optional proxy profile name.' },
                    timeout_ms: { type: 'integer', minimum: 5000, maximum: 180000, description: 'Timeout in ms for search and fetch.' },
                  },
                  required: ['query'],
                },
              },
            },
          },
          responses: jsonResponse('Search results with optional fetched page content.'),
        },
      },
      '/tools/fetch_page': {
        post: {
          operationId: 'fetch_page',
          summary: 'Fetch a web page by URL',
          description: 'Fetch a URL and return extracted readable text. Supports HTML pages (HTTP mode, with browser fallback for JS-rendered sites like mp.weixin.qq.com) and PDF files (automatic text extraction). Use this AFTER search_web to get the full content of specific result URLs.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', description: 'URL to fetch.' },
                    mode: { type: 'string', enum: ['auto', 'http', 'browser'], default: 'auto', description: 'Fetch mode.' },
                    max_chars: { type: 'integer', minimum: 1000, maximum: 100000, default: 12000, description: 'Max characters to extract.' },
                    proxy_profile: { type: 'string', description: 'Optional proxy profile name.' },
                    timeout_ms: { type: 'integer', minimum: 5000, maximum: 120000, description: 'Timeout in ms.' },
                  },
                  required: ['url'],
                },
              },
            },
          },
          responses: jsonResponse('Fetched page content with text_preview and artifact_ref.'),
        },
      },
      '/tools/search_and_fetch': {
        post: {
          operationId: 'search_and_fetch',
          summary: 'Search and bundle fetched pages as evidence',
          description: 'Combines search + fetch into a single evidence bundle. Returns structured items with title, url, snippet, text_preview per result. Unlike search_web, always fetches pages and returns structured evidence.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    query: { type: 'string', description: 'Search query.' },
                    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Max search results.' },
                    fetch_top_k: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: 'Number of top results to fetch.' },
                    max_chars_total: { type: 'integer', minimum: 2000, maximum: 200000, default: 30000, description: 'Total character budget for fetched pages.' },
                    proxy_profile: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            },
          },
          responses: jsonResponse('Evidence bundle with fetched pages.'),
        },
      },
      '/tools/research_problem': {
        post: {
          operationId: 'research_problem',
          summary: 'Research a technical problem',
          description: 'Generate query families from a problem signature, search multiple engines, fetch evidence pages, return structured evidence candidates with confidence scores.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    problem_signature: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        task: { type: 'string', description: 'What you were trying to do.' },
                        symptom: { type: 'string', description: 'What went wrong.' },
                        error_message: { type: 'string', description: 'Exact error text if available.' },
                        environment: { type: 'object', additionalProperties: true, description: 'OS, versions, etc.' },
                        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints like must-use, must-avoid.' },
                      },
                      required: ['task'],
                    },
                    budget: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        max_queries: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
                        max_results_per_query: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                        max_pages: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                        max_chars_total: { type: 'integer', minimum: 5000, maximum: 200000, default: 50000 },
                        timeout_ms: { type: 'integer', minimum: 60000, maximum: 600000, default: 300000, description: 'Total research timeout in ms (default 300000 = 5 min).' },
                      },
                    },
                    source_policy: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        prefer: { type: 'array', items: { type: 'string' }, description: 'Preferred domains or engines.' },
                        proxy_profile: { type: 'string' },
                      },
                    },
                  },
                  required: ['problem_signature'],
                },
              },
            },
          },
          responses: jsonResponse('Structured research evidence candidates.'),
        },
      },
      '/tools/get_weather': {
        post: {
          operationId: 'get_weather',
          summary: 'Get weather forecast',
          description: 'Get current weather and 7-day forecast for a city or location. Uses Open-Meteo API (free, no key needed). Supports Chinese city names (auto pinyin conversion) and international cities.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    location: { type: 'string', description: 'City or location name, e.g. "Beijing", "Tokyo", "上海".' },
                  },
                  required: ['location'],
                },
              },
            },
          },
          responses: jsonResponse('Weather result with current conditions and 7-day forecast.'),
        },
      },
      '/tools/get_time': {
        post: {
          operationId: 'get_time',
          summary: 'Get current time',
          description: 'Get current date and time for a timezone. Supports queries like "UTC", "Beijing", "Tokyo", "New York", "London". Defaults to server timezone if no query is provided.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    query: { type: 'string', description: 'Timezone hint, e.g. "UTC", "Beijing", "Tokyo".' },
                  },
                },
              },
            },
          },
          responses: jsonResponse('Current time with timezone, UTC, and Unix epoch.'),
        },
      },
      '/tools/engine_status': {
        post: {
          operationId: 'engine_status',
          summary: 'Get search engine and proxy status',
          description: 'Return available search engines, proxy profiles, browser session status, and rate limit configuration.',
          responses: jsonResponse('Engine and service status.'),
        },
      },
    },
  };
}

function jsonResponse(description) {
  return {
    200: {
      description,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              ok: { type: 'boolean' },
              result: { description: 'Tool result payload.' },
              error: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  };
}
