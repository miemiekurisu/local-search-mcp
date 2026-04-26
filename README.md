# local-search-mcp

本项目是一个单容器部署的 **Local Search & Web Evidence MCP/HTTP 服务**。它不是简单封装 SearXNG，而是内置无搜索 API 的网络搜索能力：

- 内置搜索引擎：DuckDuckGo、Bing、Wikipedia、Google。
- 默认搜索会走全部内置搜索引擎与自定义 HTML 引擎，但 **默认不包含 ChatGPT**；只有显式指定 `engines:["chatgpt"]` 时才会调用 ChatGPT。
- 支持自定义 HTML 搜索引擎配置。
- 搜索结果默认最多 20 条。
- `search_and_fetch` 会按结果列表抓取页面，单页失败会跳过继续后续结果。
- 页面输出为去 HTML 的纯文本，并保存为 artifact，减少上下文传输量。
- 内置 HTTP 接口，便于 `curl` 手工验证。
- 同时提供 MCP stdio 入口，后续可接 Local Claw / Claude Code 类客户端。

## 1. 快速启动

```bash
cp .env.example .env
docker compose up --build -d
```

服务启动后：

```bash
curl http://localhost:8765/health
```

容器内可视化浏览器入口：

- 登录/人工操作用 noVNC: `http://localhost:6082/vnc.html?autoconnect=1&resize=remote`

可移植性说明：

- 默认配置不依赖 `host.docker.internal:18001` 之类的宿主机代理；
- 如果你需要代理，只需要在 `.env` 里设置 `BROWSER_PROXY_SERVER=...` 后重建；
- 运行时持久化数据都在 `./data`，搬机器时复制项目目录即可重建。

迁移/重建步骤：

```bash
cp .env.example .env
docker compose up --build -d
```

如果要把登录态和 artifact 一起迁走，连同 `./data` 一起复制：

- `./data/browser-profile`：容器内 Chromium 用户目录；
- `./data/browser-state`：`google/chatgpt/bing` 会话快照；
- `./data/artifacts`：搜索结果与抓取文本 artifact。

## 2. 手工调用搜索

```bash
curl -s http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "qwen3.6 agent coding benchmark",
    "limit": 10,
    "engines": ["duckduckgo", "bing", "google"]
  }' | jq
```

返回结构包含：

```json
{
  "ok": true,
  "result": {
    "query_id": "q_xxx",
    "results": [
      {"title": "...", "url": "...", "snippet": "...", "engine": "duckduckgo", "rank": 1}
    ],
    "failures": [],
    "artifact_ref": "artifact://search/search_xxx.txt"
  }
}
```

## 3. 搜索并抓取页面正文

默认最多返回前 20 条搜索结果；`fetch_top_k` 控制继续抓取多少个结果页面。

```bash
curl -s http://localhost:8765/search_and_fetch \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "ollama openai compatible api v1 base url 404",
    "limit": 20,
    "fetch_top_k": 5,
    "max_chars_total": 30000,
    "engines": ["duckduckgo", "bing", "google"],
    "fetch_mode": "auto"
  }' | jq
```

返回结构是 Local Claw 可直接消费的 `EvidenceBundle`：

```json
{
  "type": "evidence_bundle",
  "bundle_id": "eb_xxx",
  "pages_fetched": 4,
  "items": [
    {
      "title": "...",
      "url": "...",
      "text_preview": "去 HTML 后的正文预览...",
      "artifact_ref": "artifact://pages/pages_xxx.txt",
      "source_type": "official_doc"
    }
  ],
  "failures": []
}
```

## 4. 抓取单页

```bash
curl -s http://localhost:8765/fetch_page \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://docs.ollama.com/openai",
    "mode": "auto",
    "max_chars": 12000
  }' | jq
```

`mode=auto` 会先使用普通 HTTP 抓取，失败后使用 Playwright 浏览器抓取。

## 5. 分段读取 artifact

```bash
curl -s http://localhost:8765/artifact \
  -H 'Content-Type: application/json' \
  -d '{
    "artifact_ref": "artifact://pages/pages_xxx.txt",
    "offset": 0,
    "limit": 8000
  }' | jq
```

## 6. 高阶问题研究接口

```bash
curl -s http://localhost:8765/research_problem \
  -H 'Content-Type: application/json' \
  -d '{
    "problem_signature": {
      "task": "fix local claw ollama openai compatible endpoint configuration",
      "symptom": "curl /v1 returns 404 page not found",
      "environment": {"ollama_url": "http://192.168.2.38:11434"},
      "constraints": ["no paid search api", "local docker deployment"]
    },
    "budget": {
      "max_queries": 4,
      "max_results_per_query": 8,
      "max_pages": 8,
      "max_chars_total": 50000
    },
    "source_policy": {
      "prefer": ["official docs", "github issues", "stackoverflow", "release notes"]
    }
  }' | jq
```

## 7. 自定义搜索引擎

复制示例文件：

```bash
cp config/search_engines.example.json config/search_engines.json
```

添加一个 HTML 搜索引擎：

```json
[
  {
    "id": "my_engine",
    "type": "html",
    "url_template": "https://example.com/search?q={{query}}",
    "method": "GET",
    "selectors": {
      "result": ".result-item",
      "title": "a.title",
      "url": "a.title",
      "snippet": ".snippet"
    }
  }
]
```

然后调用：

```bash
curl -s http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"test", "engines":["my_engine"], "limit": 10}' | jq
```

## 8. 代理配置

复制示例：

```bash
cp config/proxy_profiles.example.json config/proxy_profiles.json
```

请求时指定：

```json
{"query":"github issue", "proxy_profile":"corp"}
```

当前版本支持：

- 搜索请求代理；
- 页面抓取代理；
- 浏览器上下文代理；
- `no_proxy` 规则：localhost、127.0.0.1、10.*、172.16-31.*、192.168.*。

默认情况下所有引擎都走 `direct/auto`，不要求宿主机额外起代理服务。

## 9. 浏览器登录会话

这个项目支持在宿主机浏览器里直接操作容器内的可视化 Chromium，并把登录态保存到 `./data/browser-state`。`ChatGPT` 引擎使用 `chrome-devtools-mcp` 连接这份浏览器会话，避免继续维护自写的页面自动化流程。

查看当前会话状态：

```bash
curl -s http://localhost:8765/browser_sessions | jq
```

为 ChatGPT、Google 或 Bing 打开一个登录页：

```bash
curl -s http://localhost:8765/browser_sessions/open \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}' | jq

curl -s http://localhost:8765/browser_sessions/open \
  -H 'Content-Type: application/json' \
  -d '{"session":"google"}' | jq

curl -s http://localhost:8765/browser_sessions/open \
  -H 'Content-Type: application/json' \
  -d '{"session":"bing"}' | jq
```

更适合日常使用的是统一管理命令：

```bash
npm run browser:sessions -- status
npm run browser:sessions -- open all
npm run browser:sessions -- save all
```

也可以只开某一个：

```bash
npm run browser:sessions -- open google
npm run browser:sessions -- open chatgpt
npm run browser:sessions -- open bing
```

然后在宿主机打开：

```text
http://localhost:6082/vnc.html?autoconnect=1&resize=remote
```

在可视化浏览器里完成登录后，保存会话：

```bash
curl -s http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}' | jq

curl -s http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"google"}' | jq

curl -s http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"bing"}' | jq
```

说明：

- `searchGoogle` 会复用 `google` 会话；
- `searchBing` 会复用 `bing` 会话；
- `searchChatGPT` 会通过 `chrome-devtools-mcp` 复用 `chatgpt` 会话；
- 会话状态保存到 `./data/browser-state/*.json`，用于容器重启后的恢复；
- 手动登录请使用 `6082`；
- 如果你坚持用账号密码自动登录 ChatGPT，需要在 `docker-compose.yml` 中填入 `CHATGPT_EMAIL` 和 `CHATGPT_PASSWORD` 后重启容器。
- 如果仓库托管在 GitHub，`.github/dependabot.yml` 会每周检查 npm 和 Docker 更新。

## 10. MCP stdio 模式

HTTP 服务用于手工验证；MCP stdio 用于后续接 Local Claw/Claude Code 类客户端。

```bash
docker run --rm -i local-search-mcp:dev npm run mcp
```

暴露工具：

- `search_web`
- `fetch_page`
- `search_and_fetch`
- `research_problem`
- `get_artifact`
- `engine_status`

## 11. 当前实现边界

这个包已经能真实执行：搜索、搜索结果抓取、文本抽取、artifact 存储、失败跳过。

项目没有做验证码破解、登录绕过、付费墙绕过。遇到 Google/ChatGPT 的 MFA、验证码或风控时，应通过本地 noVNC 浏览器手动完成一次登录，然后保存会话状态。
