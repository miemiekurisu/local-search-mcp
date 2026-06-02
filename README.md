# local-search-mcp

单容器部署的 **Local Search & Web Evidence MCP/HTTP 服务**。不依赖任何付费搜索 API，内置 DuckDuckGo、Bing、Wikipedia、Google 等搜索引擎，支持自定义 HTML 引擎配置。

## 0. 分支与平台说明

本项目维护两个分支，对应两种 Docker 基础镜像方案：

| 分支 | 平台 | Dockerfile 基础镜像 | Chromium 来源 | 适用场景 |
|------|------|---------------------|---------------|----------|
| `main` | x86_64 / macOS | `playwright:v1.59.1-noble` | 镜像预装 | 主流桌面/服务器 |
| `arm64` | ARM (aarch64) | `node:22-bookworm` | 构建时自装 | ARM 设备（如 TN3399） |

**为什么分两个分支**：部分 ARM 设备（如 TN3399，内核 5.8.1）的 Docker overlay2 驱动不支持 `security.capability` xattr，导致 `playwright:v1.59.1-noble` 镜像无法 `docker pull`（报错 `failed to register layer: lsetxattr security.capability`）。`arm64` 分支换用 `node:22-bookworm` 基础镜像，在构建阶段通过 `apt-get` 安装系统依赖 + `npx playwright install chromium` 自装 Chromium，绕过 xattr 限制。

**两个分支的代码差异**：
- `Dockerfile` 不同（基础镜像 + Chromium 安装方式）
- `docker-compose.yml` 中 `SEARCH_HEADLESS` 默认值不同（main: `true`, arm64: `false`）
- 其余代码完全一致

**开发流程**：在 `main` 分支开发 → push → ARM 机器上 `git checkout arm64 && git merge main && git pull && docker compose up -d --build`。

## 1. 架构概览

```
┌──────────────────────────────────────────────────────┐
│  Docker Container                                    │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  Xvfb   │→ │ Openbox  │→ │ Chromium (visible) │  │
│  │  :99    │  │ WM       │  │ :9224 CDP          │  │
│  └─────────┘  └──────────┘  └────────┬───────────┘  │
│  ┌──────────┐  ┌──────────┐          │              │
│  │  x11vnc  │→ │ noVNC    │  ┌───────┘              │
│  │  :5900   │  │ :6080    │  │ Node.js :8765        │
│  └──────────┘  └──────────┘  │  ├─ HTTP 服务器      │
│                               │  ├─ MCP 端点         │
│                               │  ├─ PlaywrightPool   │
│                               │  └─ SearchKernel     │
│                               └──────────────────────┘
│  /data (持久化)                          │
│    ├── browser-profile (Chromium 用户数据) │
│    ├── browser-state (会话快照)           │
│    ├── artifacts (搜索结果/页面文本)       │
│    └── cache/papers (论文缓存)            │
└──────────────────────────────────────────────────────┘
```

**容器进程架构**（`start.sh` 管理）：
- Xvfb 虚拟显示（`-screen 0 1920x1080x24`），崩溃自动重启
- Openbox 窗口管理器，崩溃自动重启
- x11vnc VNC 服务器（仅 127.0.0.1:5900）
- noVNC websockify（仅 127.0.0.1:6080 → 暴露为宿主 6082）
- Chromium 监督器：启动 Chromium → 崩溃自动重启 → 循环
- Node.js HTTP 服务器：崩溃则停止容器，由 Docker `restart` 策略拉起

## 2. 快速启动

### 2.1 无浏览器模式（纯搜索）

适用于只需 HTTP 搜索、不需要可视化浏览器的场景：

```bash
docker compose up --build -d
```

启动后验证：

```bash
curl http://localhost:8765/health
# 返回: {"status":"ok"}
```

### 2.2 可视化浏览器模式（默认）

`docker-compose.yml` 已配置 `SEARCH_HEADLESS=false` + `USE_EXISTING_CHROME=true`。启动后可通过 noVNC 操作容器内 Chromium：

```bash
docker compose up --build -d
```

打开浏览器访问：

```
http://localhost:6082/vnc.html?autoconnect=1&resize=remote
```

### 2.3 ARM 设备部署

```bash
# 克隆仓库
git clone <repo-url> local-search-mcp
cd local-search-mcp

# 切换到 arm64 分支
git checkout arm64

# 配置环境变量
cp .env.example .env

# 构建并启动
docker compose up -d --build
```

### 2.4 数据迁移

可移植数据均在 `./data` 目录：

| 目录 | 内容 | 可迁移 |
|------|------|--------|
| `data/browser-profile` | Chromium 用户目录（登录态、扩展） | 是 |
| `data/browser-state` | `chatgpt/google/bing` 会话快照 | 是 |
| `data/artifacts` | 搜索结果与抓取文本 | 是 |
| `data/cache/papers` | 论文缓存（SQLite + 文件） | 是 |

迁移到新机器：

```bash
# 旧机器
tar czf local-search-data.tar.gz data/

# 新机器
scp local-search-data.tar.gz user@new-host:/path/to/project/
cd /path/to/project/
tar xzf local-search-data.tar.gz
docker compose up -d
```

## 3. HTTP 接口

### 3.1 端点总览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/engine_status` | 引擎列表、代理状态、浏览器会话 |
| GET | `/browser_sessions` | 浏览器会话状态 |
| POST | `/browser_sessions/open` | 打开浏览器登录页 |
| POST | `/browser_sessions/save` | 保存浏览器会话 |
| POST | `/search` | 搜索 |
| POST | `/fetch_page` | 抓取单页 |
| POST | `/search_and_fetch` | 搜索 + 抓取 |
| POST | `/research_problem` | 高阶问题研究 |
| POST | `/artifact` | 读取 artifact |
| POST | `/mcp` | MCP JSON-RPC 端点 |
| ALL | `/mcp-stream` | MCP Streamable HTTP 端点 |

### 3.2 搜索

```bash
curl -s http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "ollama openai compatible api",
    "limit": 10,
    "engines": ["duckduckgo", "wikipedia"]
  }' | jq
```

**默认搜索引擎**：`duckduckgo` + `wikipedia` + 自定义 HTML 引擎。
Google、Bing 需要浏览器会话支持；ChatGPT 需要额外登录。

返回：
```json
{
  "query_id": "q_xxx",
  "results": [{"title": "...", "url": "...", "snippet": "...", "engine": "duckduckgo", "rank": 1}],
  "failures": [],
  "artifact_ref": "artifact://search/search_xxx.txt"
}
```

### 3.3 搜索 + 抓取

```bash
curl -s http://localhost:8765/search_and_fetch \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "ollama openai compatible api v1 404",
    "limit": 10,
    "fetch_top_k": 5,
    "max_chars_total": 30000
  }' | jq
```

### 3.4 抓取单页

```bash
curl -s http://localhost:8765/fetch_page \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://docs.ollama.com/openai", "mode": "auto", "max_chars": 12000}' | jq
```

`mode=auto`：先 HTTP 抓取 → 失败后浏览器抓取。

### 3.5 高阶研究

```bash
curl -s http://localhost:8765/research_problem \
  -H 'Content-Type: application/json' \
  -d '{
    "problem_signature": {
      "task": "fix ollama /v1 404",
      "symptom": "returns 404 not found",
      "environment": {"ollama_url": "http://localhost:11434"}
    },
    "budget": {
      "max_queries": 4,
      "max_results_per_query": 8,
      "max_pages": 8
    }
  }' | jq
```

### 3.6 读取 Artifact

```bash
curl -s http://localhost:8765/artifact \
  -H 'Content-Type: application/json' \
  -d '{"artifact_ref": "artifact://search/search_xxx.txt", "offset": 0, "limit": 8000}' | jq
```

### 3.7 天气查询

```bash
curl -s http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"北京"}}}'
```

支持中文城市名（自动拼音转码）、多地点消歧。

### 3.8 时间查询

```bash
curl -s http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_time","arguments":{"query":"Beijing"}}}'
```

支持时区：`UTC`、`Beijing`、`Tokyo`、`New York`、`London` 等。

### 3.9 速率限制

HTTP 接口默认 **60 请求/分钟/IP**。

## 4. MCP 模式

### 4.1 MCP-over-HTTP（推荐）

```bash
# JSON-RPC 端点
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Streamable HTTP 端点（支持 SSE）
curl -s -X GET http://localhost:8765/mcp-stream
```

### 4.2 MCP stdio

```bash
docker run --rm -i local-search-mcp:latest npm run mcp
```

### 4.3 工具列表

| 工具 | 说明 |
|------|------|
| `search_web` | 多引擎搜索 |
| `fetch_page` | 抓取单页 |
| `search_and_fetch` | 搜索 + 抓取 |
| `research_problem` | 高阶研究 |
| `get_artifact` | 读取 artifact |
| `engine_status` | 引擎/代理/会话状态 |
| `get_weather` | 天气查询（Open-Meteo，免费） |
| `get_time` | 时间查询（多时区支持） |

### 4.4 MCP Prompts

| Prompt | 说明 |
|--------|------|
| `search_and_summarize` | 搜索 + 摘要 |
| `debug_error` | 错误调试 |

### 4.5 MCP Resources

| 模板 | 说明 |
|------|------|
| `artifact://{kind}/{file}` | 读取 artifact 文件 |

## 5. 浏览器登录会话

支持在容器内 Chromium 中登录 Google、Bing、ChatGPT，并将登录态持久化到 `./data/browser-state`。

### 5.1 操作流程

```bash
# 1. 查看所有会话状态
curl -s http://localhost:8765/browser_sessions | jq

# 2. 打开登录页
curl -s http://localhost:8765/browser_sessions/open \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}' | jq

# 3. 在 noVNC 中完成登录
#    访问 http://localhost:6082/vnc.html?autoconnect=1&resize=remote

# 4. 保存会话
curl -s http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}' | jq
```

### 5.2 批量操作

```bash
npm run browser:sessions -- status
npm run browser:sessions -- open all
npm run browser:sessions -- save all
```

### 5.3 会话用途

| 会话 | 引擎 | 说明 |
|------|------|------|
| `google` | `searchGoogle` | 复用 Google 登录态 |
| `bing` | `searchBing` | 复用 Bing 登录态 |
| `chatgpt` | `searchChatGPT` | 通过 chrome-devtools-mcp 复用 |

### 5.4 自动登录 ChatGPT（可选）

在 `docker-compose.yml` 中设置：

```yaml
environment:
  - CHATGPT_EMAIL=your@email.com
  - CHATGPT_PASSWORD=your_password
```

> 注意：自动登录可能触发 MFA/风控，推荐通过 noVNC 手动登录后保存会话。

## 6. 配置

### 6.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8765` | HTTP 服务端口 |
| `TIMEZONE` | 服务器本地时区 | `get_time` 默认时区 |
| `DEFAULT_SEARCH_LIMIT` | `10`（compose）/ `20`（Dockerfile） | 默认搜索返回条数 |
| `MAX_SEARCH_LIMIT` | `20` | 搜索硬上限 |
| `MAX_FETCH_CONCURRENCY` | `3` | 并行抓取数 |
| `SEARCH_HEADLESS` | `false`（compose）/ `true`（Dockerfile） | 浏览器模式 |
| `BROWSER_STATE_DIR` | `/data/browser-state` | 会话存储目录 |
| `USE_EXISTING_CHROME` | `true`（compose）/ `false`（Dockerfile） | 复用容器内 Chromium |
| `CDP_URL` | `http://127.0.0.1:9224` | Chromium CDP 地址 |
| `VISIBLE_BROWSER_CDP_PORT` | `9224` | Chromium CDP 端口 |
| `VISIBLE_BROWSER_PROFILE_DIR` | `/data/browser-profile` | Chromium 用户目录 |
| `VISIBLE_BROWSER_START_URL` | `about:blank` | Chromium 启动 URL |
| `VISIBLE_BROWSER_PROXY_SERVER` | `""` | Chromium 代理（`http://host:port`） |
| `HTTP_PROXY` / `HTTPS_PROXY` | `""` | 全局 HTTP 代理 |
| `NO_PROXY` | `""` | 代理白名单 |
| `LAN_PROXY_SERVER` | `""` | 局域网代理服务器地址 |
| `CHATGPT_EMAIL` / `CHATGPT_PASSWORD` | `""` | ChatGPT 自动登录凭据 |
| `BRAVE_API_KEY` | `""` | Brave Search 备用 API Key |
| `TAVILY_API_KEY` | `""` | Tavily 备用 API Key |
| `EXA_API_KEY` | `""` | Exa 备用 API Key |
| `GOOGLE_API_KEY` | `""` | Google Custom Search API Key |
| `GOOGLE_SEARCH_ENGINE_ID` | `""` | Google CSE ID |
| `ENABLE_GOOGLE_API_FALLBACK` | `""` | 启用 Google API 备用 |
| `OPENALEX_API_KEY` | `""` | OpenAlex API Key |
| `CROSSREF_MAILTO` | `""` | Crossref 邮箱 |
| `UNPAYWALL_EMAIL` | `""` | Unpaywall 邮箱 |

### 6.2 自定义搜索引擎

```bash
cp config/search_engines.example.json config/search_engines.json
```

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

调用：

```bash
curl -s http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"test", "engines":["my_engine"]}' | jq
```

### 6.3 代理配置

```bash
cp config/proxy_profiles.example.json config/proxy_profiles.json
```

请求时指定：

```json
{"query": "github issue", "proxy_profile": "corp"}
```

内置 `no_proxy`：`localhost`、`127.0.0.1`、`10.*`、`172.16-31.*`、`192.168.*`。

### 6.4 付费 API 备用

当内置搜索引擎全部失败时，自动回退到付费 API：

| API | 环境变量 | 获取 |
|-----|----------|------|
| Brave Search | `BRAVE_API_KEY` | https://brave.com/search/api/ |
| Tavily | `TAVILY_API_KEY` | https://tavily.com/ |
| Exa | `EXA_API_KEY` | https://exa.ai/ |
| Google CSE | `GOOGLE_API_KEY` + `GOOGLE_SEARCH_ENGINE_ID` + `ENABLE_GOOGLE_API_FALLBACK=true` | https://developers.google.com/custom-search |

## 7. 测试

### 7.1 健康检查

```bash
curl http://localhost:8765/health
```

### 7.2 搜索引擎验证

```bash
# 查看所有引擎
curl -s http://localhost:8765/engine_status | jq

# 搜索
curl -s http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"test", "engines":["duckduckgo"]}' | jq '.ok'
```

### 7.3 浏览器验证

```bash
# 查看会话状态
curl -s http://localhost:8765/browser_sessions | jq

# 检查 Chromium CDP
curl -s http://localhost:9224/json/version
```

### 7.4 MCP 验证

```bash
# 列出工具
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

# 应该返回 8
```

### 7.5 天气工具验证

```bash
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"Tokyo"}}}' | jq '.result.content[0].text'
```

### 7.6 时间工具验证

```bash
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_time","arguments":{"query":"UTC"}}}' | jq '.result.content[0].text'
```

### 7.7 ARM 设备验证

```bash
# SSH 到 ARM 服务器
ssh user@arm-host

# 检查容器状态
docker ps --filter name=local-search --format '{{.Names}} {{.Status}}'

# 检查 Chromium tabs（不应有 about:blank 堆积）
docker exec local-search-mcp-local-search-mcp-1 \
  curl -s http://127.0.0.1:9224/json/list | jq 'length'

# 运行搜索后再次检查
curl -s -X POST http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"test", "engines":["duckduckgo"]}' > /dev/null

# tabs 数应保持不变（搜索使用独立 context，不污染 default context）
docker exec local-search-mcp-local-search-mcp-1 \
  curl -s http://127.0.0.1:9224/json/list | jq 'length'
```

## 8. 注意事项

- 默认配置不依赖宿主机代理，所有值从环境变量读取，无硬编码 IP
- `.env` 文件已加入 `.gitignore`，不要提交
- 遇到 Google/ChatGPT 的 MFA、验证码或风控时，通过 noVNC 手动登录后保存会话
- 容器内置 uBlock Origin 扩展，自动拦截广告
- `search_and_fetch` 单页失败会自动跳过，继续处理后续结果
- 项目不做验证码破解、登录绕过、付费墙绕过
