# Local Search MCP：当前框架优化与论文查询接口实施方案

> 版本：v0.1  
> 基于代码包：`src.zip`  
> 生成日期：2026-05-30  
> 范围：仅生成实施文档，不修改现有代码。

---

## 0. 目标与边界

### 0.1 目标

本文档面向当前 `local-search-mcp` 代码结构，给出两部分实施方案：

1. **当前代码与框架检查**：识别现有实现中的明显问题、架构风险、可维护性问题，并给出不破坏当前功能的优化路径。
2. **论文查询接口扩展**：在现有本地搜索 MCP 的基础上，增加免费学术检索能力，支撑 deep research 中的论文检索、元数据校验、引用扩展、开放全文定位与证据分级。

### 0.2 非目标

本文档不要求立即重写现有代码，不改变当前 `search_web`、`fetch_page`、`search_and_fetch`、`research_problem` 等工具行为。建议采用**旁路扩展、渐进接入、功能开关**的方式实施。

### 0.3 检查方式说明

本次检查采用静态代码审计和语法检查：

- 已解压并阅读 `src` 目录主要文件。
- 已对所有 `.js` 文件执行 `node --check` 语法检查，未发现语法解析错误。
- 未执行端到端运行测试，因为代码包中未包含 `package.json`、依赖锁文件、Docker 配置与实际运行环境。
- 未修改任何现有代码文件。

---

## 1. 当前代码结构概览

当前代码已经具备较清晰的模块分层：

```text
src/
├── app.js
├── config/
│   ├── index.js
│   └── proxy.js
├── artifacts/
│   └── artifactStore.js
├── browser/
│   ├── playwrightPool.js
│   ├── chromeDevtoolsMcpClient.js
│   └── sessionCatalog.js
├── engines/
│   ├── index.js
│   ├── base.js
│   ├── duckduckgo_http.js
│   ├── bing.js
│   ├── google.js
│   ├── wikipedia.js
│   ├── chatgpt.js
│   ├── custom_html.js
│   └── api_fallback.js
├── fetch/
│   ├── pageFetcher.js
│   └── extract.js
├── kernel/
│   └── searchKernel.js
├── mcp/
│   └── server.js
├── http_server.js
├── mcp_server.js
├── self_check.js
└── utils/
    ├── http.js
    ├── limit.js
    └── normalize.js
```

### 1.1 当前主调用链

当前主链路大致为：

```text
MCP / HTTP endpoint
  ↓
SearchKernel
  ↓
EngineRegistry / PageFetcher / ArtifactStore
  ↓
Search engines / Browser pool / HTTP fetch
  ↓
Evidence bundle / Artifact
```

### 1.2 当前架构优点

1. **入口层与内核层已基本分离**  
   `mcp/server.js`、`http_server.js` 负责协议与接口暴露，`kernel/searchKernel.js` 负责业务编排。

2. **搜索引擎以插件式文件存在**  
   `engines/` 中每个搜索源基本独立，已经接近 Strategy / Adapter 的雏形。

3. **Browser 与 HTTP fetch 分离**  
   `PageFetcher` 先尝试 HTTP，再回退到浏览器，适合网页抓取场景。

4. **Artifact 机制已经存在**  
   搜索结果、页面正文、evidence bundle 都可以落盘，便于后续 chunk 读取。

5. **ProxyRouter 已单独抽象**  
   已支持按 engine 解析代理配置，为后续学术接口设置不同代理策略提供基础。

---

## 2. 当前代码存在的问题与风险

本节按优先级分为 P0、P1、P2。

### 2.1 P0：`fetchWithTimeout` 未传递请求体，导致部分 API fallback 实际不可用

位置：

```text
src/utils/http.js
src/engines/api_fallback.js
```

当前 `fetchWithTimeout` 参数解构如下：

```js
const { timeoutMs = 15000, proxyUrl = null, headers = {}, method = 'GET' } = opts;
```

但没有接收和传递 `body`。因此 `api_fallback.js` 中的 Tavily / Exa POST 请求虽然构造了 body：

```js
const body = JSON.stringify(...)
```

但实际 `undici.fetch` 调用不会发送请求体。

影响：

- Tavily fallback 实际不可用或请求参数缺失。
- Exa fallback 实际不可用或请求参数缺失。
- 后续论文接口如果复用 `fetchWithTimeout` 发送 POST 请求，也会踩同一问题。

建议：

- 将 `fetchWithTimeout` 升级为统一 `HttpClient`，支持 `body`、`query`、`responseType`、`retryPolicy`、`rateLimitKey`。
- 短期修复时，应至少将 `body` 透传到 `fetch` init。
- 新论文接口不要直接复制当前 `fetchWithTimeout`，应先补齐 HTTP 抽象。

---

### 2.2 P0：MCP 工具定义存在双重维护风险

位置：

```text
src/mcp/server.js
src/http_server.js
```

当前同时存在：

1. `mcp/server.js` 中基于 SDK 的 `server.registerTool(...)`。
2. `http_server.js` 中手写的 `/mcp` JSON-RPC `tools/list` 与 `tools/call`。
3. `/mcp-stream` 中又接入了 `StreamableHTTPServerTransport`。

这意味着新增工具时必须维护至少两处定义：

```text
mcp/server.js          # 标准 MCP server
http_server.js /mcp    # 手写 JSON-RPC wrapper
```

风险：

- 新增论文工具后，stdio MCP 可见，但手写 `/mcp` 不可见。
- 工具 schema 不一致。
- 工具行为不一致。
- 文档和实际能力漂移。

建议：

- 建立单一工具注册表 `ToolRegistry`。
- `mcp/server.js`、`http_server.js` 均从 `ToolRegistry` 读取工具 schema 和 handler。
- 或者废弃手写 `/mcp`，只保留标准 MCP transport。
- 如果为了兼容性保留 `/mcp`，则必须让它从同一个 registry 自动生成 `tools/list` 与 `tools/call`。

设计模式：**Registry + Adapter + Single Source of Truth**。

---

### 2.3 P1：`safeJoin` 的路径边界检查不够严格

位置：

```text
src/config/index.js
```

当前实现：

```js
if (!target.startsWith(resolvedBase)) throw new Error('unsafe path traversal');
```

问题：

如果 base 是 `/data/artifacts`，目标路径 `/data/artifacts_evil/x` 也会通过 `startsWith('/data/artifacts')` 检查。

建议：

采用 `path.relative` 做边界判断：

```text
relative = path.relative(resolvedBase, target)
合法条件：relative === '' 或者既不以 '..' 开头，也不是绝对路径
```

影响范围：

- Artifact 读取与写入。
- Browser state path。

这是低概率但基础层面的安全与正确性问题，应在框架优化第一阶段修复。

---

### 2.4 P1：`research_problem` 名称大于当前能力

位置：

```text
src/kernel/searchKernel.js
```

当前 `researchProblem` 实际做的是：

1. 将 task、symptom、error、environment 拼成 base query。
2. 根据 `source_policy.prefer` 追加若干关键词。
3. 调用 `searchAndFetch`。
4. 从每个 bundle 前 3 个 item 生成 `claim_candidates`。

问题：

- 没有真正的证据抽取。
- 没有 contradiction detection。
- 没有 source reliability model。
- 没有论文/正式文档/代码仓库/论坛的分层策略。
- `source_policy.prefer` 目前只是影响 query 拼接，不是严格的 source routing。
- 返回的 `claim_candidates` 主要来自 title、snippet、text preview 的拼接，不能作为严肃 deep research 的 claim evidence。

建议：

短期：将当前工具定位为 `research_web_problem` 或在说明中明确“web evidence gathering only”。

中期：新增真正的 `research_deep` 编排器：

```text
ProblemSignature
  ↓
QueryPlanner
  ↓
SourceRouter
  ↓
EvidenceCollector
  ↓
EvidenceExtractor
  ↓
Deduplicator
  ↓
EvidenceRanker
  ↓
SynthesisPack
```

论文查询接口应接入这个新编排器，而不是直接塞入当前 `researchProblem`。

---

### 2.5 P1：搜索源调度缺少统一 RateLimiter / Retry / CircuitBreaker

位置：

```text
src/engines/index.js
src/engines/duckduckgo_http.js
src/engines/google.js
```

当前情况：

- DuckDuckGo 有局部 `lastRequestTime`。
- Google 有局部 `lastRequestTime`。
- EngineRegistry 串行执行 engines。
- fallback 逻辑集中在 `searchMany` 中，但并不区分 source capability、rate limit、失败类型。

问题：

- 限速逻辑分散。
- 失败熔断缺失。
- 对免费接口不友好。
- 无法为学术接口精确配置：OpenAlex、Semantic Scholar、arXiv、Crossref、Unpaywall 各自限速不同。

建议新增：

```text
src/common/rateLimiter.js
src/common/retryPolicy.js
src/common/circuitBreaker.js
src/common/sourceScheduler.js
```

基本策略：

```text
每个 source 有独立配置：
  - minIntervalMs
  - maxConcurrency
  - dailyBudget
  - timeoutMs
  - retryableStatusCodes
  - circuitOpenThreshold
  - circuitCooldownMs
```

设计模式：**Circuit Breaker + Token Bucket / Leaky Bucket + Policy Object**。

---

### 2.6 P1：ArtifactStore 缺少 manifest 与资源列表

位置：

```text
src/artifacts/artifactStore.js
src/mcp/server.js
```

当前 ArtifactStore 能写入 `.txt` 与 `.json` metadata，但没有统一 manifest，也没有查询列表能力。`resources/list` 返回空数组。

影响：

- MCP 客户端无法枚举历史 artifact。
- Deep research 多轮任务中无法稳定追踪 evidence bundle。
- 后续论文检索会产生 paper bundle、citation bundle、fulltext metadata，如果仍无 manifest，会降低可复查性。

建议：

新增：

```text
ArtifactStore.appendManifest(record)
ArtifactStore.list({ kind, query, created_after, limit })
ArtifactStore.readMetadata(ref)
```

资源类型建议：

```text
artifact://search/...
artifact://pages/...
artifact://bundles/...
artifact://papers/...
artifact://citations/...
artifact://fulltext/...
```

设计模式：**Repository + Manifest Index**。

---

### 2.7 P1：搜索结果模型过窄，不适合论文对象

当前 `makeResult` 模型为：

```js
{
  title,
  url,
  snippet,
  engine,
  rank
}
```

这个模型适合网页结果，但不适合论文结果。论文至少需要：

```text
title
authors
year
venue
doi
arxiv_id
openalex_id
semantic_scholar_id
abstract
citation_count
reference_count
is_open_access
pdf_url
landing_page_url
source_ids
source_names
license
publication_type
```

建议：

- 保留现有 `SearchResult`。
- 新增 `PaperRecord` DTO。
- Evidence bundle 支持多种 item type。

```text
WebSearchResult
PaperRecord
FetchedPage
EvidenceItem
CitationEdge
```

设计模式：**DTO + Normalizer + Anti-Corruption Layer**。

---

### 2.8 P2：Google API fallback 配置校验不完整

位置：

```text
src/engines/google.js
src/engines/api_fallback.js
```

问题：

- `google.js` 中 `searchGoogleApi` 只检查 `GOOGLE_API_KEY`，但没有检查 `GOOGLE_SEARCH_ENGINE_ID`。
- Google Custom Search 的 `num` 参数通常不能任意超过 10，而当前 `limit` 最大可到 20。
- 该 fallback 可能产生费用，与“免费优先”的本地搜索定位不完全一致。

建议：

- 将所有可能收费的 fallback 默认关闭。
- 明确命名为 `paid_or_quota_api_fallback`，避免和免费 HTTP 搜索混淆。
- 对参数做 source-specific clamp。

---

### 2.9 P2：Blocked domain policy 硬编码，且大小写处理不一致

位置：

```text
src/utils/normalize.js
```

当前 `BLOCKED_DOMAINS` 内含 `SegmentFault`，但 `hostOf` 返回小写域名时不会匹配该大写字符串。另一些域名如 `aliyun.com`、`tencent.com` 被全局过滤，可能误伤官方文档或云产品文档。

建议：

- 改为配置文件策略。
- 区分 `exclude_by_default` 与 `low_confidence`。
- 对 host 和规则统一小写。
- 在 research 场景中不要直接删除，而是降权。

---

### 2.10 P2：缺少测试与契约验证

当前只有 `self_check.js`，未见系统化测试。

建议新增：

```text
tests/unit/normalize.test.js
tests/unit/artifactStore.test.js
tests/unit/httpClient.test.js
tests/unit/paperNormalizer.test.js
tests/integration/searchKernel.test.js
tests/integration/paperSearch.test.js
```

最低验收：

- `node --check` 全部通过。
- `search_web` 基本可用。
- `fetch_page` 可抽取纯文本。
- `search_and_fetch` 能生成 artifact。
- 新增论文接口在无 API key 时可优雅降级。
- 新增论文接口不影响现有 MCP tools。

---

## 3. 当前框架优化实施方案

### 3.1 优化原则

1. **先补基础设施，再加论文接口**  
   论文接口会大量复用 HTTP、限速、重试、归一化、artifact。如果基础设施不补齐，后续会形成重复代码。

2. **新增模块优先，不直接重写现有功能**  
   现有搜索功能已经可用，应避免大改。新增公共模块后，先让论文接口使用，再逐步迁移现有 web engines。

3. **单一事实源**  
   工具 schema、source 配置、rate limit、artifact 类型都应集中定义。

4. **清晰区分“检索”和“结论生成”**  
   MCP 工具应返回结构化证据包，不应直接生成最终研究结论。

5. **免费接口优先，任何可能付费接口默认关闭**  
   论文查询接口默认仅使用免费 API 或免费额度 API。

---

### 3.2 建议新增目录结构

```text
src/
├── common/
│   ├── httpClient.js
│   ├── rateLimiter.js
│   ├── retryPolicy.js
│   ├── circuitBreaker.js
│   ├── sourceScheduler.js
│   ├── errors.js
│   └── schemas.js
├── registry/
│   ├── toolRegistry.js
│   └── sourceRegistry.js
├── evidence/
│   ├── evidenceTypes.js
│   ├── evidenceBundleBuilder.js
│   ├── evidenceRanker.js
│   └── sourceReliability.js
├── papers/
│   ├── paperKernel.js
│   ├── paperRouter.js
│   ├── paperSchemas.js
│   ├── paperNormalizer.js
│   ├── paperDeduplicator.js
│   ├── paperRanker.js
│   ├── paperEvidenceBuilder.js
│   └── clients/
│       ├── academicClientBase.js
│       ├── openalexClient.js
│       ├── semanticScholarClient.js
│       ├── arxivClient.js
│       ├── crossrefClient.js
│       ├── unpaywallClient.js
│       ├── coreClient.js
│       ├── pubmedClient.js
│       └── opencitationsClient.js
└── tests/
    ├── unit/
    └── integration/
```

---

### 3.3 核心抽象设计

#### 3.3.1 HttpClient：统一 HTTP 访问门面

职责：

- GET / POST / HEAD。
- 支持 query 参数构造。
- 支持 JSON、XML、text 响应解析。
- 支持 body 透传。
- 支持 proxy。
- 支持 timeout。
- 支持 retry。
- 支持 rate limit key。
- 支持 user-agent / mailto / API key header。

接口示意：

```js
await httpClient.request({
  method: 'GET',
  url,
  query: {},
  headers: {},
  body: undefined,
  responseType: 'json',
  timeoutMs: 15000,
  proxyProfile: 'auto',
  rateLimitKey: 'openalex',
  retryPolicy: 'metadata_api'
})
```

设计模式：**Facade + Policy Object**。

#### 3.3.2 SourceAdapter：统一检索源接口

Web search 与 paper search 不应强行使用同一个窄模型，但可以共享 SourceAdapter 思想。

```js
class SourceAdapter {
  id
  type
  capabilities
  async search(query, options)
  async lookup(identifier, options)
  async fetchRelated(identifier, options)
}
```

论文源 adapter 示例：

```text
OpenAlexClient
SemanticScholarClient
ArxivClient
CrossrefClient
UnpaywallClient
```

设计模式：**Adapter + Strategy**。

#### 3.3.3 SourceRegistry：统一 source 注册

职责：

- 管理 source id。
- 管理 capability。
- 管理限速配置。
- 管理是否启用。
- 管理是否需要 API key / email。

示例：

```js
sourceRegistry.register({
  id: 'openalex',
  type: 'academic_metadata',
  enabled: Boolean(process.env.OPENALEX_API_KEY),
  capabilities: ['paper_search', 'paper_lookup', 'citation_graph'],
  rateLimit: { minIntervalMs: 100, maxConcurrency: 2 }
})
```

设计模式：**Registry + Factory**。

#### 3.3.4 EvidenceBundleBuilder：统一证据包构造

当前 `searchAndFetch` 已经有 evidence bundle 雏形。建议将其抽象为通用 builder：

```js
EvidenceBundleBuilder
  .addWebResult(...)
  .addFetchedPage(...)
  .addPaper(...)
  .addCitationEdge(...)
  .addFailure(...)
  .build()
```

输出中保留：

```text
bundle_id
query
source_policy
items
failures
artifacts
created_at
```

设计模式：**Builder + DTO**。

---

### 3.4 工具注册统一化

新增 `src/registry/toolRegistry.js`：

```text
ToolRegistry
├── registerTool(definition)
├── listTools()
├── callTool(name, args)
└── toMcpSdk(server)
```

每个 tool 定义：

```js
{
  name,
  title,
  description,
  zodSchema,
  jsonSchema,
  handler
}
```

集成方式：

```text
mcp/server.js
  从 ToolRegistry 注册到 SDK server

http_server.js /mcp
  从 ToolRegistry 生成 tools/list
  从 ToolRegistry 路由 tools/call
```

这样新增论文工具时，只需要注册一次。

---

### 3.5 分阶段实施路线

#### 阶段 A：零行为变更的基础修复

目标：不改变外部 API 行为。

任务：

1. 修复 `fetchWithTimeout` body 透传。
2. 修复 `safeJoin` 边界判断。
3. 给 `api_fallback` 增加基础单测，覆盖 POST body。
4. 给 `ArtifactStore` 增加文件不存在时的明确错误。
5. 给 `BLOCKED_DOMAINS` 做小写归一化。
6. 保持 `search_web`、`fetch_page`、`search_and_fetch` 返回结构不变。

验收：

```text
node --check 全部通过
self_check.js 可运行
search_web 返回结构不变
fetch_page 返回结构不变
```

#### 阶段 B：公共基础设施旁路接入

目标：新增基础设施，但现有 web search 不强制迁移。

任务：

1. 新增 `HttpClient`。
2. 新增 `RateLimiter`。
3. 新增 `RetryPolicy`。
4. 新增 `CircuitBreaker`。
5. 新增 `SourceRegistry`。
6. 新增 `ToolRegistry`，但先只给论文工具使用。

验收：

```text
现有工具仍可用
新增模块有 unit tests
无环境变量时系统可以启动
```

#### 阶段 C：论文接口独立上线

目标：新增 paper tools，不影响 web tools。

任务：

1. 实现 P0 学术源：OpenAlex、Semantic Scholar、arXiv、Crossref、Unpaywall。
2. 新增 `PaperRecord` 标准模型。
3. 新增 `paper_search`、`paper_lookup`、`paper_open_access`、`paper_citations`。
4. 写入 `artifact://papers/...` 和 `artifact://citations/...`。
5. 使用 `ENABLE_PAPER_TOOLS=true` 功能开关。

验收：

```text
ENABLE_PAPER_TOOLS=false 时不暴露论文工具
ENABLE_PAPER_TOOLS=true 时 MCP tools/list 出现论文工具
无 OpenAlex/Semantic Scholar key 时可以仅使用 arXiv/Crossref/Unpaywall 降级
arXiv 限速不低于 3 秒间隔
```

#### 阶段 D：Deep Research 编排器

目标：把 web evidence 与 paper evidence 合并为研究证据包。

任务：

1. 新增 `research_deep` 工具。
2. 将 query rewrite、source route、paper search、web search、citation expansion、evidence ranker 串成 pipeline。
3. 输出结构化 evidence pack，而不是直接生成最终结论。
4. 让 LLM 基于 evidence pack 生成结论。

验收：

```text
输入一个技术问题，返回：
  - web evidence bundles
  - paper evidence bundles
  - key papers
  - related papers
  - open access links
  - contradictions / limitations candidates
  - confidence hints
```

---

## 4. 论文查询接口实施方案

### 4.1 设计目标

论文查询接口不只是“搜论文”，而应支撑 deep research 的以下任务：

1. 查询相关论文。
2. 校验 DOI、正式发表信息、venue、年份。
3. 查找引用与被引用关系。
4. 查找开放全文与 PDF。
5. 对论文证据进行标准化、去重、排序与分级。
6. 将论文证据与网页证据合并到统一 evidence bundle。

---

### 4.2 免费学术接口优先级

#### P0：第一版必须支持

| Source | 主要用途 | 是否需要 key/email | 说明 |
|---|---|---|---|
| OpenAlex | 跨学科论文元数据、作者、机构、主题、引用关系 | 需要免费 API key | 主力元数据源 |
| Semantic Scholar | AI/CS 论文、引用、相关论文、作者、影响力信息 | 建议免费 API key | AI/ML 方向主力 |
| arXiv | 预印本搜索 | 不需要 key | 最新论文雷达 |
| Crossref | DOI、期刊、会议、正式出版信息 | 不强制 key，建议 mailto | 元数据校验 |
| Unpaywall | 根据 DOI 查开放全文 | 需要 email 参数 | OA PDF/HTML 定位 |

#### P1：第二版建议支持

| Source | 主要用途 | 说明 |
|---|---|---|
| CORE | 开放获取论文全文与 PDF 补充 | 适合补全文 |
| OpenCitations | DOI 引用图谱补充 | 适合 citation expansion |
| PubMed / PMC | 医学、生物、临床方向 | 按领域路由启用 |
| Europe PMC | 生命科学 OA 全文与元数据 | 医学生物补充 |

#### P2：按需支持

| Source | 主要用途 |
|---|---|
| DataCite | 数据集、软件、研究对象 DOI |
| OpenReview | ICLR、NeurIPS 等开放评审和投稿记录 |
| Papers with Code data | 论文、代码、任务、benchmark 对应关系 |

---

### 4.3 环境变量设计

建议新增：

```bash
# Paper tools feature flag
ENABLE_PAPER_TOOLS=true

# OpenAlex
OPENALEX_API_KEY=...

# Semantic Scholar
SEMANTIC_SCHOLAR_API_KEY=...

# Crossref polite pool
CROSSREF_MAILTO=your_email@example.com

# Unpaywall
UNPAYWALL_EMAIL=your_email@example.com

# Optional
CORE_API_KEY=...
NCBI_API_KEY=...
NCBI_TOOL=local-search-mcp
NCBI_EMAIL=your_email@example.com
OPENCITATIONS_ACCESS_TOKEN=...
```

原则：

- `ENABLE_PAPER_TOOLS=false` 时不注册论文工具。
- 没有某个 key 时，禁用对应 source 或进入低额度模式。
- email 参数应由用户自己配置，不在代码中硬编码。
- 所有 key 和 email 不写入 artifact 正文。

---

### 4.4 统一 PaperRecord 模型

建议标准输出：

```json
{
  "type": "paper",
  "title": "",
  "authors": [
    { "name": "", "id": "", "source": "" }
  ],
  "year": 2026,
  "published_date": "",
  "venue": "",
  "publication_type": "journal-article | proceedings-article | preprint | dataset | software | unknown",
  "doi": "",
  "arxiv_id": "",
  "openalex_id": "",
  "semantic_scholar_id": "",
  "pubmed_id": "",
  "abstract": "",
  "citation_count": null,
  "reference_count": null,
  "fields_of_study": [],
  "topics": [],
  "is_open_access": null,
  "open_access_status": "unknown",
  "landing_page_url": "",
  "pdf_url": "",
  "license": "",
  "source_records": [
    { "source": "openalex", "id": "", "url": "" }
  ],
  "scores": {
    "relevance": 0,
    "freshness": 0,
    "authority": 0,
    "availability": 0,
    "final": 0
  }
}
```

设计原则：

- DOI 统一小写并去掉 `https://doi.org/` 前缀。
- arXiv ID 统一去版本号与保留版本号两套字段。
- title 用 normalized title 做 fuzzy dedup。
- 一个 PaperRecord 可以合并多个 source 的记录。

---

### 4.5 论文工具设计

#### 4.5.1 `search_papers`

用途：跨源搜索论文。

输入：

```json
{
  "query": "kv cache compression transformer inference",
  "sources": ["auto"],
  "year_from": 2020,
  "year_to": 2026,
  "limit": 20,
  "domain": "ai_ml",
  "include_preprints": true,
  "open_access_only": false
}
```

输出：

```json
{
  "query_id": "pq_xxx",
  "query": "...",
  "sources_tried": ["openalex", "semantic_scholar", "arxiv"],
  "papers": [],
  "failures": [],
  "artifact_ref": "artifact://papers/papers_xxx.txt",
  "created_at": "..."
}
```

内部流程：

```text
validate args
  ↓
paperRouter.chooseSources(domain, sources)
  ↓
parallel/sequential by sourceScheduler
  ↓
source-specific search
  ↓
normalize to PaperRecord
  ↓
deduplicate
  ↓
rank
  ↓
write artifact
```

---

#### 4.5.2 `lookup_paper`

用途：根据 DOI、arXiv ID、OpenAlex ID、Semantic Scholar ID 查询单篇论文。

输入：

```json
{
  "identifier": "10.48550/arXiv.2401.12345",
  "identifier_type": "auto",
  "sources": ["auto"]
}
```

识别规则：

```text
10.xxxx/...              => DOI
arXiv:xxxx.xxxxx         => arXiv ID
xxxx.xxxxx               => 可能是 arXiv ID
Wxxxxxxxxxx              => OpenAlex Work ID
CorpusId:xxxx            => Semantic Scholar Corpus ID
PMID:xxxx                => PubMed ID
```

输出：

```json
{
  "paper": {},
  "sources_tried": [],
  "source_records": [],
  "failures": []
}
```

---

#### 4.5.3 `expand_paper_citations`

用途：查 references、cited_by、related works。

输入：

```json
{
  "identifier": "10.xxxx/xxxx",
  "direction": "references | cited_by | both | related",
  "limit": 50,
  "sources": ["openalex", "semantic_scholar", "opencitations"]
}
```

输出：

```json
{
  "root_paper": {},
  "edges": [
    {
      "from": "paper_id",
      "to": "paper_id",
      "relation": "cites | cited_by | related",
      "source": "openalex"
    }
  ],
  "papers": [],
  "artifact_ref": "artifact://citations/citations_xxx.txt"
}
```

---

#### 4.5.4 `find_open_access`

用途：根据 DOI 或 PaperRecord 查开放全文。

输入：

```json
{
  "identifier": "10.xxxx/xxxx",
  "sources": ["unpaywall", "core", "europe_pmc"],
  "prefer_pdf": true
}
```

输出：

```json
{
  "identifier": "...",
  "is_open_access": true,
  "oa_status": "green | gold | hybrid | bronze | closed | unknown",
  "best_pdf_url": "",
  "best_landing_page_url": "",
  "license": "",
  "source_records": []
}
```

约束：

- 只返回开放访问入口。
- 不绕过付费墙。
- 不抓取需要登录或订阅的 PDF。

---

#### 4.5.5 `research_papers`

用途：对一个研究问题执行论文层面的 mini deep research。

输入：

```json
{
  "research_question": "What are recent methods for KV cache compression in transformer inference?",
  "domain": "ai_ml",
  "year_from": 2022,
  "year_to": 2026,
  "budget": {
    "max_queries": 5,
    "max_papers": 50,
    "max_citation_expansions": 10
  },
  "source_policy": {
    "prefer": ["peer_reviewed", "recent", "open_access"],
    "include_preprints": true
  }
}
```

输出：

```json
{
  "research_id": "pr_xxx",
  "queries_executed": [],
  "key_papers": [],
  "related_papers": [],
  "citation_clusters": [],
  "open_access_links": [],
  "evidence_summary": {
    "method_families": [],
    "recency_distribution": {},
    "source_distribution": {},
    "limitations_candidates": [],
    "contradiction_candidates": []
  },
  "artifact_ref": "artifact://papers/research_papers_xxx.txt"
}
```

注意：

`research_papers` 不直接写最终论文综述结论，只返回结构化证据。最终结论由 LLM 基于该 evidence pack 生成。

---

### 4.6 Source routing 策略

建议 `paperRouter` 使用领域路由：

```text
AI / ML / LLM / Agent / RAG / Inference
  → Semantic Scholar + OpenAlex + arXiv

数学 / 统计 / 物理
  → arXiv + OpenAlex + Crossref

医学 / 生物 / 临床
  → PubMed + Europe PMC + OpenAlex + Crossref

查 DOI / 正式发表
  → Crossref + OpenAlex

查开放全文
  → Unpaywall + CORE + Europe PMC

查引用链
  → OpenAlex + Semantic Scholar + OpenCitations

查代码 / Benchmark
  → Papers with Code dataset + GitHub web search
```

实现上不要让 LLM 直接决定所有 source，而是让 LLM 只提供：

```text
query
domain
intent
constraints
```

由 `paperRouter` 做确定性路由。

设计模式：**Strategy + Rule-based Router + LLM as query planner only**。

---

### 4.7 去重策略

论文去重优先级：

```text
1. DOI 完全相同
2. arXiv ID 完全相同
3. OpenAlex ID / Semantic Scholar ID 映射相同
4. 标题 normalized 后高度相似 + 年份接近
5. 标题相似 + 第一作者相同 + 年份接近
```

normalized title：

```text
lowercase
去标点
去多余空格
去 LaTeX 包裹字符
去 arxiv version suffix
```

合并策略：

```text
Crossref 提供正式出版元数据
OpenAlex 提供开放学术图谱和引用数
Semantic Scholar 提供 CS/AI 相关字段和相关论文
arXiv 提供预印本版本和摘要
Unpaywall 提供 OA 状态和 PDF/landing page
```

---

### 4.8 排序与证据评分

建议 `paperRanker` 输出多维评分，不只按引用数。

```text
final_score =
  0.35 * relevance
+ 0.20 * source_authority
+ 0.15 * recency
+ 0.10 * citation_signal
+ 0.10 * method_match
+ 0.05 * open_access_availability
+ 0.05 * reproducibility_signal
```

其中：

```text
relevance
  查询与 title/abstract/topics 的匹配度

source_authority
  peer-reviewed > preprint
  known venue > unknown venue
  Crossref/OpenAlex/S2 多源一致性加分

recency
  按研究主题配置，不同领域衰减不同

citation_signal
  citation_count 使用 log 缩放，避免老论文垄断

method_match
  方法名、benchmark、数据集、任务关键词匹配

open_access_availability
  有合法 OA PDF 或 HTML 加分

reproducibility_signal
  有 code、dataset、benchmark、appendix 加分
```

注意：

- 引用数不能作为唯一质量指标。
- 新预印本引用少但可能很关键。
- 对 LLM / agent / inference acceleration 方向，应提高 recency 权重。

---

### 4.9 证据等级设计

建议输出证据等级：

| 等级 | 定义 |
|---|---|
| S | 多篇论文支持 + 独立复现或主流 benchmark + 代码/数据可查 |
| A+ | 顶会/顶刊/正式发表 + 实验完整 + 元数据多源一致 |
| A | arXiv 预印本 + 实验完整 + 代码或附录可查 |
| B | 预印本或技术报告 + 实验有限或复现不足 |
| C | 博客、白皮书、厂商报告、项目 README |
| D | 社交媒体、转述、营销材料、无法校验来源 |

论文接口自身只给 `confidence_hint`，最终证据等级由 deep research 编排器综合 web evidence、paper evidence、代码 evidence、实验 evidence 后生成。

---

## 5. 论文接口与现有 MCP 的集成方案

### 5.1 不影响现有代码的接入方式

第一阶段不要修改现有工具行为。建议：

```text
现有：
  search_web
  fetch_page
  search_and_fetch
  research_problem
  get_artifact
  engine_status

新增：
  search_papers
  lookup_paper
  expand_paper_citations
  find_open_access
  research_papers
```

以功能开关控制：

```bash
ENABLE_PAPER_TOOLS=true
```

当开关关闭：

```text
工具不注册
依赖不初始化
环境变量不校验
现有功能完全不受影响
```

### 5.2 SearchKernel 扩展方式

当前：

```js
export class SearchKernel {
  constructor({ proxyRouter, browserPool, artifactStore }) { ... }
}
```

建议新增组合对象，不要塞太多职责进 `SearchKernel`：

```js
const paperKernel = new PaperKernel({
  httpClient,
  sourceRegistry,
  artifactStore,
  rateLimiter
});
```

然后在 `createKernel` 返回：

```js
return { kernel, paperKernel, browserPool };
```

如果不希望修改 `createKernel`，也可先在 MCP server 初始化时旁路创建 `PaperKernel`。

推荐方案：

- 短期：MCP server 内部创建 `PaperKernel`，减少对主链路影响。
- 中期：`createKernel` 统一创建所有 kernel。
- 长期：拆成 `WebSearchKernel`、`PaperSearchKernel`、`DeepResearchKernel`。

设计模式：**Composition over Inheritance**。

---

### 5.3 DeepResearchKernel 编排

最终 deep research 不应直接等于 `research_problem`。

建议新增：

```text
src/research/deepResearchKernel.js
```

职责：

```text
1. query planning
2. web search route
3. paper search route
4. evidence collection
5. evidence extraction
6. evidence ranking
7. contradiction candidates
8. final evidence pack
```

工具：

```text
research_deep
```

输入：

```json
{
  "question": "...",
  "domain": "ai_ml",
  "budget": {
    "web_queries": 4,
    "paper_queries": 4,
    "max_web_pages": 12,
    "max_papers": 50,
    "max_citation_expansions": 10
  },
  "source_policy": {
    "prefer_official_docs": true,
    "prefer_peer_reviewed": true,
    "include_preprints": true,
    "open_access_only": false
  }
}
```

输出：

```json
{
  "research_id": "dr_xxx",
  "question": "...",
  "web_evidence_bundles": [],
  "paper_evidence_bundles": [],
  "key_claim_candidates": [],
  "supporting_sources": [],
  "contradiction_candidates": [],
  "uncertainty_notes": [],
  "artifact_ref": "artifact://bundles/deep_research_xxx.txt"
}
```

---

## 6. 免费接口限速与实现注意事项

### 6.1 建议默认限速配置

```js
export const ACADEMIC_SOURCE_POLICIES = {
  openalex: {
    minIntervalMs: 120,
    maxConcurrency: 2,
    requiresKey: true
  },
  semantic_scholar: {
    minIntervalMs: 1100,
    maxConcurrency: 1,
    requiresKey: true
  },
  arxiv: {
    minIntervalMs: 3200,
    maxConcurrency: 1,
    requiresKey: false
  },
  crossref: {
    minIntervalMs: 250,
    maxConcurrency: 1,
    requiresKey: false,
    recommendsMailto: true
  },
  unpaywall: {
    minIntervalMs: 150,
    maxConcurrency: 2,
    requiresEmail: true
  },
  opencitations: {
    minIntervalMs: 400,
    maxConcurrency: 1
  },
  ncbi: {
    minIntervalMs: 350,
    maxConcurrency: 1
  }
};
```

说明：

- 这里采用保守值，优先稳定，不追求吞吐。
- 实际运行时应读取接口返回的 rate-limit headers。
- 对 429、503 应做指数退避。
- 对连续失败 source 应短期熔断。

### 6.2 官方约束摘要

- OpenAlex 当前使用免费 API key 模式；免费额度适合个人低频检索。
- Semantic Scholar 免费 API key 初始限速约 1 RPS。
- arXiv legacy API 要求不超过每 3 秒 1 次请求，并保持单连接。
- Crossref 建议使用 `mailto` 进入 polite pool，并读取 response headers 中的限速信息。
- Unpaywall 需要 email 参数，建议每日请求量不超过 100,000。
- CORE 提供免费 API，聚合开放获取论文元数据和全文内容。
- NCBI E-utilities 无 key 时建议不超过 3 RPS，有 key 时通常为 10 RPS。
- OpenCitations API 限速为每 IP 每分钟 180 次。

---

## 7. 具体实现清单

### 7.1 第一批提交：基础修复

```text
[ ] 修复 fetchWithTimeout body 透传
[ ] 修复 safeJoin 路径边界判断
[ ] Google API fallback 同时检查 API key 和 CX
[ ] 对 source-specific limit 做 clamp
[ ] BLOCKED_DOMAINS 全部小写并改为配置化
[ ] 为 ArtifactStore 增加 read 失败时的明确错误
[ ] 增加基础单测
```

### 7.2 第二批提交：公共基础设施

```text
[ ] 新增 common/httpClient.js
[ ] 新增 common/rateLimiter.js
[ ] 新增 common/retryPolicy.js
[ ] 新增 common/circuitBreaker.js
[ ] 新增 registry/sourceRegistry.js
[ ] 新增 registry/toolRegistry.js
[ ] 新增 evidence/evidenceBundleBuilder.js
```

### 7.3 第三批提交：论文客户端

```text
[ ] openalexClient.searchWorks
[ ] openalexClient.lookupWork
[ ] semanticScholarClient.searchPapers
[ ] semanticScholarClient.lookupPaper
[ ] semanticScholarClient.citations/references
[ ] arxivClient.search
[ ] arxivClient.lookup
[ ] crossrefClient.lookupByDoi
[ ] crossrefClient.searchWorks
[ ] unpaywallClient.lookupByDoi
[ ] paperNormalizer
[ ] paperDeduplicator
[ ] paperRanker
```

### 7.4 第四批提交：MCP 工具

```text
[ ] search_papers
[ ] lookup_paper
[ ] expand_paper_citations
[ ] find_open_access
[ ] research_papers
[ ] artifact://papers resource support
[ ] artifact://citations resource support
```

### 7.5 第五批提交：Deep Research 编排

```text
[ ] DeepResearchKernel
[ ] QueryPlanner
[ ] SourceRouter
[ ] EvidenceCollector
[ ] EvidenceRanker
[ ] research_deep MCP tool
[ ] Web evidence + paper evidence 合并
```

---

## 8. 验收标准

### 8.1 不回归验收

```text
[ ] search_web 返回结构保持兼容
[ ] fetch_page 返回结构保持兼容
[ ] search_and_fetch 返回结构保持兼容
[ ] research_problem 不被破坏
[ ] get_artifact 仍可读取旧 artifact
[ ] engine_status 仍可返回当前 engines 与 browser sessions
```

### 8.2 论文接口验收

```text
[ ] search_papers("KV cache compression transformer inference") 返回至少来自两个 source 的结果
[ ] lookup_paper 可识别 DOI 与 arXiv ID
[ ] find_open_access 对 DOI 返回 OA 状态和合法入口
[ ] expand_paper_citations 可返回 references 或 cited_by
[ ] 所有论文结果统一为 PaperRecord
[ ] 重复论文可按 DOI / arXiv ID / title 合并
[ ] 429 时自动退避而不是持续请求
[ ] 无 API key 时可降级，不导致服务启动失败
[ ] artifact 中不包含 API key 或 email
```

### 8.3 Deep Research 验收

```text
[ ] 同一问题可同时返回 web evidence 与 paper evidence
[ ] 输出中区分 source type：web / paper / official_doc / github / forum
[ ] 输出中包含 failures，不静默吞错
[ ] 输出中包含 confidence_hint，不把 snippet 直接当事实
[ ] 能输出 citation expansion 的关键论文
[ ] 能标记 open_access 可用性
```

---

## 9. 推荐最终架构

```text
                    ┌────────────────────┐
                    │ MCP / HTTP Client   │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ ToolRegistry        │
                    └─────────┬──────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
┌─────────▼─────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
│ WebSearchKernel   │ │ PaperKernel    │ │ DeepResearchKernel│
└─────────┬─────────┘ └───────┬────────┘ └────────┬─────────┘
          │                   │                   │
┌─────────▼─────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
│ EngineRegistry    │ │ SourceRegistry │ │ EvidencePipeline │
└─────────┬─────────┘ └───────┬────────┘ └────────┬─────────┘
          │                   │                   │
┌─────────▼─────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
│ Web Engines       │ │ Paper Clients  │ │ EvidenceRanker   │
└─────────┬─────────┘ └───────┬────────┘ └────────┬─────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ ArtifactStore       │
                    └────────────────────┘
```

核心判断：

- 当前项目已经有可用的 web search MCP 雏形。
- 不应在当前 `EngineRegistry` 里直接混入论文接口。
- 论文接口应作为独立 `PaperKernel` 接入。
- Deep research 应作为更高层编排器，组合 web evidence 与 paper evidence。
- 在此之前，必须先补齐 HTTP body、限速、工具注册单一事实源、artifact manifest 等基础问题。

---

## 10. 参考资料

以下为实现论文接口时应优先参考的官方文档：

- OpenAlex Authentication & Pricing：`https://developers.openalex.org/guides/authentication`
- OpenAlex API Reference：`https://developers.openalex.org/api-reference/introduction`
- Semantic Scholar Academic Graph API：`https://www.semanticscholar.org/product/api`
- Semantic Scholar API Docs：`https://api.semanticscholar.org/api-docs/`
- arXiv API Terms of Use：`https://info.arxiv.org/help/api/tou.html`
- arXiv API User Manual：`https://info.arxiv.org/help/api/user-manual.html`
- Crossref REST API Access and Authentication：`https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/`
- Unpaywall REST API：`https://unpaywall.org/products/api`
- CORE API Documentation：`https://core.ac.uk/documentation/api`
- NCBI E-utilities Introduction：`https://www.ncbi.nlm.nih.gov/books/NBK25497/`
- OpenCitations REST API：`https://api.opencitations.net/index`
