# OpenAPI Tool Server 实施方案

> 审核状态：✅ 已核对代码，修正后定稿
> 本文档不入库，供实施参考

---

## 目标

在**不修改现有 MCP 层**的前提下，新增一套 OpenAPI Tool 接口，使 Open WebUI 能以 OpenAPI 方式集成本服务的 7 个工具。

```text
Open WebUI
  ├─ 模型后端：llama.cpp /v1
  │    http://<LLAMA_IP>:11144/v1
  │
  └─ 工具后端：local-search-mcp OpenAPI Tool
       http://<SEARCH_IP>:8765/openapi.json
       POST /tools/search_web
       POST /tools/fetch_page
       POST /tools/search_and_fetch
       POST /tools/research_problem
       POST /tools/get_weather
       POST /tools/get_time
       POST /tools/engine_status
```

---

## 审核发现的问题（已修正）

### 问题 1：`searchWeb` schema 缺少 `fetch_top_k` / `fetch_mode`

原方案 schema 只列了 `query` / `limit` / `engines` / `proxy_profile`。但 `kernel.searchWeb()` 实际还接受：

- `fetch_top_k` — 控制搜索结果中抓取多少页（默认 10，设为 0 跳过抓取）
- `max_chars_total` — 所有抓取页面的总字符预算
- `fetch_mode` — 抓取模式 `auto` / `http` / `browser`
- `timeout_ms` — 搜索和抓取的超时

这些参数直接影响返回结果（`searchWeb` 返回中会包含 `fetched` 数组），不暴露的话 Open WebUI 用户无法控制搜索行为。

**修正：** `/tools/search_web` schema 补上 `fetch_top_k`、`max_chars_total`、`fetch_mode`。

### 问题 2：两个 `/openapi.json` 端点冗余

原方案提议 `GET /openapi.json` 和 `GET /docs/openapi.json` 两个端点。Open WebUI 只需要一个。多了反而可能让用户困惑。

**修正：** 只保留 `GET /openapi.json`。

### 问题 3：`searchAndFetch` 描述不够清晰

原方案描述为"Search and fetch top pages"，但 `searchAndFetch` 本质上是 `searchWeb(fetch_top_k=...)` 的包装，返回结构化 evidence bundle。Open WebUI 用户选了 `searchAndFetch` 可能不知道和 `searchWeb` 的区别。

**修正：** 描述加一句 "Combines searchWeb + fetchPage into a single evidence bundle. If you already use searchWeb with fetch_top_k, this is redundant."

### 问题 4：`get_artifact` 未包含

原方案只列了 7 个工具，没有 `get_artifact`。经核对，`get_artifact` 是 MCP 工具之一，但 OpenAPI 场景下 artifact ref 由服务端管理，Open WebUI 一般不需要读原始 artifact。**可以不加，属于有意省略。** 如果后续有需求再加。

---

## 一、代码结构

新增两个文件：

```
src/openapi/schema.js    — OpenAPI 3.1 spec 生成
src/openapi/routes.js    — /openapi.json + /tools/* 路由注册
```

已有 `src/http_server.js` 只加两行：

```js
import { registerOpenApiRoutes } from './openapi/routes.js';
registerOpenApiRoutes(app, kernel);
```

---

## 二、`src/openapi/routes.js`

```js
import { buildOpenApiSpec } from './schema.js';

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

function normalizeToolError(err) {
  const errorObject = err && typeof err === 'object' ? err : {};
  return {
    ok: false,
    error: {
      code: errorObject.code || 'TOOL_ERROR',
      message: errorObject.message || String(err),
      engine: errorObject.engine,
      details: redactErrorDetails(errorObject.details),
      stack: process.env.NODE_ENV === 'production' ? undefined : errorObject.stack,
    },
  };
}

function openApiRoute(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || {});
      res.json({ ok: true, result });
    } catch (err) {
      console.error('[openapi-tool] error:', err);
      res.status(500).json(normalizeToolError(err));
    }
  };
}

export function registerOpenApiRoutes(app, kernel) {
  app.get('/openapi.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApiSpec(baseUrl));
  });

  app.post('/tools/search_web', openApiRoute(args => kernel.searchWeb(args)));
  app.post('/tools/fetch_page', openApiRoute(args => kernel.fetchPage(args)));
  app.post('/tools/search_and_fetch', openApiRoute(args => kernel.searchAndFetch(args)));
  app.post('/tools/research_problem', openApiRoute(args => kernel.researchProblem(args)));
  app.post('/tools/engine_status', openApiRoute(async () => kernel.engineStatus()));
  app.post('/tools/get_time', openApiRoute(async (args) => {
    const { getCurrentTime } = await import('../tools/time.js');
    return getCurrentTime(args?.query);
  }));
  app.post('/tools/get_weather', openApiRoute(async (args) => {
    const { searchWeather } = await import('../tools/weather.js');
    return searchWeather(args?.location);
  }));
}
```

### 路由注册位置

在 `src/http_server.js` 的 `createApp()` 内部，放在现有 REST 路由之后、MCP 路由之前：

```js
app.post('/search', asyncRoute(args => kernel.searchWeb(args)));
app.post('/fetch_page', asyncRoute(args => kernel.fetchPage(args)));
app.post('/search_and_fetch', asyncRoute(args => kernel.searchAndFetch(args)));
app.post('/research_problem', asyncRoute(args => kernel.researchProblem(args)));
app.post('/artifact', asyncRoute(args => kernel.getArtifact(args)));

registerOpenApiRoutes(app, kernel);    // ← 新增

// MCP over HTTP — custom JSON-RPC endpoint
app.post('/mcp', async (req, res) => { ... });
```

这样 OpenAPI 路由继承已有的 `rateLimiter`（`app.use(rateLimiter)`）和 `authMiddleware`（`app.use(authMiddleware)`）。

---

## 三、`src/openapi/schema.js`

```js
export function buildOpenApiSpec(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Local Search Tools',
      version: '0.1.0',
      description:
        'Local web search, page fetching, research, weather, time, and engine status tools for Open WebUI.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/tools/search_web': {
        post: {
          operationId: 'search_web',
          summary: 'Search the web and optionally fetch pages',
          description:
            'Search DuckDuckGo, Wikipedia, or browser engines (Google/Bing/ChatGPT). ' +
            'Returns search results with snippets. ' +
            'When fetch_top_k > 0, automatically fetches full text from top results.',
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
                    engines: {
                      type: 'array', items: { type: 'string' },
                      description: 'Engine list: duckduckgo, wikipedia, google, bing, chatgpt. Default: duckduckgo+wikipedia.',
                    },
                    fetch_top_k: { type: 'integer', minimum: 0, maximum: 20, default: 10, description: 'Number of top results to fetch full text (0 = skip fetching).' },
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
          summary: 'Fetch a web page',
          description:
            'Fetch a URL and return extracted readable text. HTTP mode is tried first; ' +
            'falls back to browser rendering if HTTP fails (mode=auto). Returns text_preview and artifact_ref.',
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
          description:
            'Combines searchWeb + fetchPage into a single evidence bundle. ' +
            'Returns structured items with title, url, snippet, text_preview per result. ' +
            'If you already use searchWeb with fetch_top_k, this is redundant.',
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
          description:
            'Generate query families from a problem signature, search multiple engines, ' +
            'fetch evidence pages, return structured evidence candidates with confidence scores.',
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
          description:
            'Get current weather and 7-day forecast for a city or location. Uses Open-Meteo API (free, no key needed). ' +
            'Supports Chinese city names (auto pinyin conversion) and international cities.',
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
          description:
            'Get current date and time for a timezone. Supports queries like "UTC", "Beijing", "Tokyo", "New York", "London". ' +
            'Defaults to server timezone if no query is provided.',
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
          description:
            'Return available search engines, proxy profiles, browser session status, and rate limit configuration.',
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
```

---

## 四、`src/http_server.js` 修改

顶部 import：

```js
import { registerOpenApiRoutes } from './openapi/routes.js';
```

在现有 REST 路由之后（约第 127 行）、MCP 路由之前：

```js
registerOpenApiRoutes(app, kernel);
```

---

## 五、鉴权

沿用 `MCP_BEARER_TOKEN`，不另起 token。

现有 authMiddleware 在 `app.use(authMiddleware)`（第 82 行），位于 `/health` 之后、所有业务路由之前。新增的 `registerOpenApiRoutes` 调用在 `authMiddleware` 之后，所以 OpenAPI 路由自动继承鉴权：

- `MCP_BEARER_TOKEN=`（空）→ 无鉴权，Open WebUI 选 Auth: None
- `MCP_BEARER_TOKEN=sk-xxx` → 需 Bearer Token，Open WebUI 选 Auth: Bearer / Key: sk-xxx

---

## 六、Open WebUI 配置

```
Admin Settings → External Tools → Add Server
  Type: OpenAPI
  URL:  http://<SEARCH_IP>:8765/openapi.json
  Auth: None 或 Bearer（与 MCP_BEARER_TOKEN 一致）
```

保存后在聊天框 `+ → Tools / Integrations` 启用工具。

---

## 七、本地测试

```bash
# 1. Schema
curl -s http://127.0.0.1:8765/openapi.json | jq '.openapi, .info.title, (.paths | keys)'

# 2. Search
curl -s -X POST http://127.0.0.1:8765/tools/search_web \
  -H 'Content-Type: application/json' \
  -d '{"query":"Qwen3.6 llama.cpp","limit":3,"fetch_top_k":0}' | jq

# 3. Fetch page
curl -s -X POST http://127.0.0.1:8765/tools/fetch_page \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"http","max_chars":3000}' | jq

# 4. Weather
curl -s -X POST http://127.0.0.1:8765/tools/get_weather \
  -H 'Content-Type: application/json' \
  -d '{"location":"Beijing"}' | jq

# 5. Time
curl -s -X POST http://127.0.0.1:8765/tools/get_time \
  -H 'Content-Type: application/json' \
  -d '{"query":"UTC"}' | jq

# 6. Engine status
curl -s -X POST http://127.0.0.1:8765/tools/engine_status \
  -H 'Content-Type: application/json' \
  -d '{}' | jq

# 7. Auth
curl -i http://127.0.0.1:8765/openapi.json  # 401 if MCP_BEARER_TOKEN set
curl -s -H 'Authorization: Bearer sk-xxx' http://127.0.0.1:8765/openapi.json | jq '.info.title'
```

---

## 八、建议实施顺序

| # | 内容 | 文件 |
|---|------|------|
| 1 | schema.js + routes.js | 新建 `src/openapi/` |
| 2 | http_server.js 接两行 | 修改 `src/http_server.js` |
| 3 | 本地测试 7 个 curl | 手动 |
| 4 | 测试文件 | 新建 `tests/openapi_routes.test.js` |
| 5 | 更新 README | Open WebUI 配置一节 |

---

## 九、风险备忘

| 风险 | 缓解 |
|------|------|
| Open WebUI 解析复杂 schema 失败 | v1 只用 `object/string/integer/array`，不用 `oneOf/anyOf/allOf` |
| 工具返回过长（search_and_fetch/research_problem） | 已有 `max_chars_total` / `fetch_top_k` 控制，description 写清楚限制 |
| 浏览器引擎需要登录才能用 | description 里注明：google/bing/chatgpt 需 noVNC 先登录，默认用 duckduckgo+wikipedia |
| Open WebUI 不流式返回 | OpenAPI Tool 结果是完整响应，非流式。长任务需内部控制超时 |
| MCP 现有端点被破坏 | 不改任何现有路由，新增 `/tools/*` + `/openapi.json`，无冲突 |
