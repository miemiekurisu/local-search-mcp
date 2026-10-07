# local-search-mcp

**让本地 LLM Agent 获得联网搜索与网页研究能力，无需付费 Search API。**

一个自托管 MCP 服务，提供网页搜索、页面抓取、浏览器搜索与多查询研究能力。专为本地 LLM Agent 和编码 Agent 设计，无需依赖商业 Search API 即可获取最新信息。

[English](README.md) | 简体中文

---

## 为什么需要它？

本地模型在编码和推理上常常表现出色，但当答案依赖训练数据之外的信息时，往往力不从心：

- 最新的库或框架变更
- 冷门的 GitHub Issue 和报错
- 当前文档
- 小众技术问题
- 新发布的模型或软件
- 需要外部核实的事实

`local-search-mcp` 给 MCP 能力的 Agent 提供工具，让它搜索网页、阅读页面、收集证据，并带着最新信息继续推理。

> **核心搜索流程无需付费 Search API。**

---

## 它做什么

```text
本地 LLM / 编码 Agent
          │
          │ MCP
          ▼
┌──────────────────────────────┐
│       local-search-mcp       │
├──────────────────────────────┤
│ 搜索                         │
│ 抓取网页                     │
│ 浏览器搜索                   │
│ 多查询研究                   │
│ 可选 Web AI 会话             │
└──────────────────────────────┘
          │
          ▼
搜索结果 + 页面内容 + 证据
          │
          ▼
本地 Agent 继续推理
```

`local-search-mcp` 是 Agent 连接的服务端。当你的 Agent 由本地模型（如 Ollama、llama.cpp、vLLM、LM Studio）驱动时尤其有用。

---

## 适用人群

`local-search-mcp` 主要面向：

- 本地运行或自托管模型的开发者
- 通过编码 Agent 或通用 Agent 使用本地模型的人
- 希望无需付费商业 Search API 就能联网搜索的人
- 需要当前文档、GitHub Issue、发布信息或小众技术知识的人
- 希望 Agent 检索证据、而非完全依赖模型记忆的人
- 偏好自托管搜索/研究组件的人

> 如果你的本地模型已能对一个问题的推理，但缺少解决它所需的信息，这个项目就是为了弥合这个差距。

---

## 为什么做这个项目

我用本地 LLM 做编码、排障和技术研究。

一个反复出现的问题是：模型往往有足够的推理能力，却缺少关键的那一块信息——最近的一次 API 变更、一个冷门的 bug 报告、一个 GitHub Issue、新的文档，或另一位开发者的经验。

在给 Agent 加上联网搜索和页面抓取工具后，我发现一些离线时无法解决的问题，通过搜索、阅读和验证变得可解。

这个项目就源自这种工作流。

---

## 功能

### 核心能力

- **联网搜索** — 通过多个可用搜索后端搜索网页（`search_web`）。
- **页面抓取** — 为 Agent 抓取可读的页面内容。HTTP 抓取可回退到浏览器渲染，以支持需要 JavaScript 的页面（`fetch_page`）。
- **搜索 + 抓取** — 先搜索，再抓取选中的结果页，向 Agent 返回结构化证据（`search_and_fetch`）。
- **多查询研究** — 将一个复杂问题展开成多个查询，跨来源搜索、抓取相关页面并返回证据候选。它提供研究素材，最终综合结论仍由调用它的 Agent 完成（`research_problem`）。

### 浏览器后端来源

对于无法通过简单 HTTP 请求可靠访问的来源，`local-search-mcp` 可使用持久的 Chromium 浏览器。根据配置，浏览器会话用于 **DuckDuckGo**、**Bing**、**Google**、**ChatGPT Web** 和 **DeepSeek Web**。

部分提供方要求用户通过可选的 noVNC 界面手动登录，登录态可持久化保存在本地。

### 可选的 Web AI 提供方

`local-search-mcp` 也可通过托管浏览器与受支持的已登录 AI 网页会话交互，让 Agent 把另一个可网页访问的模型作为额外的研究或解题来源。

- **ChatGPT Web** — 浏览器后端，需通过 noVNC 登录。
- **DeepSeek Web** — 浏览器后端，需登录 `chat.deepseek.com`。可获取生成的回答（受 `DEEPSEEK_MAX_SNIPPET` 限制），并在可用时获取 DeepSeek 网页界面公开显示的推理文本。可选启用多步验证工作流（DeepSeek → Google AI → DeepSeek 综合）。

### 附加工具

- **天气查询** — Open-Meteo，免费无需 Key。支持中文地名（如 `上海三林`）并自动消歧（`get_weather`）。
- **时间查询** — 支持 UTC、北京、东京、纽约、伦敦等多个时区（`get_time`）。
- **自定义搜索引擎** — 通过 JSON 配置定义自己的引擎。

---

## 快速开始

依赖：Docker 和 Docker Compose。

```bash
git clone https://github.com/miemiekurisu/local-search-mcp.git
cd local-search-mcp
cp .env.example .env
docker compose up -d --build
```

验证：

```bash
curl http://localhost:8765/health
```

预期返回：

```json
{"ok":true}
```

---

## 接入你的 Agent

服务提供三种 MCP 传输方式：

| 接口        | 推荐场景                                       |
| ----------- | -------------------------------------------- |
| `/mcp-stream` | 标准 MCP 客户端（Streamable HTTP）          |
| `/sse`      | 需要旧版/远程 SSE 的客户端（如 opencode `remote`）|
| `/mcp`      | 直接 HTTP/JSON-RPC 使用（curl、脚本）         |

> **大多数 MCP 客户端，从 `http://localhost:8765/mcp-stream` 开始。**

### 通用 MCP 客户端

添加服务器，URL 填 `http://<服务器IP>:8765/mcp-stream`。

### opencode

opencode 的 `"type": "remote"` 模式使用 SSE，请用 `http://<服务器IP>:8765/sse` 并调大超时（搜索可能较慢）：

```json
{
  "mcpServers": {
    "local-search": {
      "type": "remote",
      "url": "http://<服务器IP>:8765/sse",
      "timeout": 240
    }
  }
}
```

服务端自身对 `search_web` / `search_and_fetch` 各设了 240 秒上限
（`SEARCH_TOOL_TIMEOUT_MS` / `BUNDLE_TOOL_TIMEOUT_MS`）：DeepSeek → Google AI → DeepSeek
验证链在 ARM 板上实测约 135 秒，120 秒的闸门会把本来已经成功的整条链砍成 `TIMEOUT`。
客户端超时请保持不低于该上限——客户端提前放弃会连带取消服务端任务并立刻释放页面槽位，
已经跑完的工作全部作废。低性能设备（如 ARM 开发板）建议 `timeout` 设为 240–300，
并考虑 `MAX_CONCURRENT_PAGES=1`。

---

## 可用工具

| 工具                | 说明                                      |
| ------------------- | --------------------------------------- |
| `search_web`        | 多后端联网搜索                          |
| `fetch_page`        | 抓取可读页面内容                        |
| `search_and_fetch`  | 先搜索再抓取选中结果                    |
| `research_problem`  | 多查询证据收集                          |
| `get_artifact`      | 读取存储的研究 artifact                 |
| `engine_status`     | 检查来源/浏览器可用性                   |
| `get_weather`       | 天气查询（Open-Meteo）                  |
| `get_time`          | 多时区时间查询                          |

---

## 搜索来源

| 引擎        | 类型     | 需要登录 | 说明                              |
| ----------- | -------- | -------- | ------------------------------- |
| `duckduckgo`| 浏览器   | 否       | 默认，无 Key，端点阶梯          |
| `wikipedia` | HTTP     | 否       | 默认，无 Key，无需浏览器        |
| `bing`      | 浏览器   | 否       | 浏览器渲染，公开搜索            |
| `google`    | 浏览器   | 否       | 浏览器渲染，公开搜索            |
| `chatgpt`   | 浏览器   | 是       | 需通过 noVNC 登录               |
| `deepseek`  | 浏览器   | 是       | 需登录 `chat.deepseek.com`      |

核心工作流（`duckduckgo`、`wikipedia`）无需 API Key，也无需登录。`duckduckgo` 同样驱动共享的
Chromium：纯 HTTP 访问 DuckDuckGo 会被软封。可配置可选的 API Key 回退（Brave、Tavily、Exa、
Google Custom Search），仅在基于页面的引擎失败时使用。

### DuckDuckGo 端点阶梯

`duckduckgo` 在同一个页面槽位内依次尝试三个 DuckDuckGo 端点，直到其中一个返回结果：

| 顺序 | 端点 | 本机实测 | 为什么排在这里 |
| ---- | ---- | -------- | ---------------- |
| 1 | `duckduckgo.com/?q=` | 200，渲染后约 170 KB，直链 | 它 `robots.txt` 里唯一放行的 SERP：`Disallow: /lite`、`Disallow: /html` 位于 `Disallow: /*?` 之上，其后才是 `Allow: /?*`。结果由前端渲染。 |
| 2 | `html.duckduckgo.com/html/` | 当前是 202 挑战页，约 30 KB | 静态且便宜，但被 `Disallow`，而且结果来自 Bing——`ddgs` 项目把该引擎标为 `provider="bing"`——所以基本和 `bing` 重复，也正是最先被拦的一跳。 |
| 3 | `lite.duckduckgo.com/lite/` | 200，约 22 KB | 与上一跳同样受限，三者中页面最小。 |

软封的形态是用 **HTTP 200 或 202** 返回一个 `anomaly-modal` 挑战页，因此状态码和响应体必须一起
判定；否则挑战页会被解析成 0 条结果，客户端收到 `SERP_PARSE_FAILED`，看起来像选择器失效，而不是
一个会自行恢复的限流。

当有别的客户端正在排队等槽位时，顺序改为最省优先（`lite,html,main`）：单槽位机器上稀缺的资源是
槽位本身，3.5 秒的静态页优于 9 秒的渲染并占用。`DUCKDUCKGO_ENDPOINTS` 可覆盖空闲时的顺序。

---

## 浏览器登录与会话（noVNC）

noVNC 以远程浏览器界面的形式暴露容器内的 Chromium，用于手动登录需要浏览器会话的提供方（如 ChatGPT）。

> noVNC **默认不启动**（`NOVNC_PASSWORD` 为空）。

启用方式：

```bash
# 在 .env 中
NOVNC_PASSWORD=你的强密码
```

```bash
docker compose up -d
```

打开 `http://localhost:6082/vnc.html`，手动完成登录 / 验证码 / MFA，然后保存会话：

```bash
curl -s -X POST http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}'
```

远程访问时优先使用 SSH 隧道，而不是直接暴露端口：

```bash
ssh -L 6082:127.0.0.1:6082 user@server
```

移除 `NOVNC_PASSWORD` 并重启容器即可关闭 noVNC。

如果 `vnc.html` 能打开但桌面一直出不来（`Disconnected` / "Failed to connect to
server"），说明网页这半是好的、VNC server 那半不是：页面由 websockify 提供，它再去连容器内
的 5900。现在这两半都被守护着——容器会先等 X display 就绪再启动 `x11vnc`，`x11vnc` 或
websockify 任一退出都会被重新拉起。以前的写法只在启动时各拉一次，所以只要有一次起早了
（Xvfb 还没就绪）或者 Xvfb 自己重启过，noVNC 就会一直连不上，除非重建容器。宿主机上排查：

```bash
docker logs <container> 2>&1 | grep -E 'x11vnc|noVNC proxy'
docker exec <container> netstat -ltn | grep 5900
```

---

## 配置

将 `.env.example` 复制为 `.env` 并按需调整。最常用的选项：

| 变量                  | 默认值   | 说明                                  |
| --------------------- | ------- | ----------------------------------- |
| `HTTP_LISTEN_PORT`    | `8765`  | MCP 服务宿主端口                     |
| `MCP_BEARER_TOKEN`    | `""`    | Bearer Token 认证（公网暴露时必须） |
| `NOVNC_PASSWORD`      | `""`    | noVNC 密码（为空则不启用 noVNC）    |
| `LOW_POWER_DEVICE`    | `false` | 低性能设备降低并发                   |
| `MEM_LIMIT`           | —       | 容器内存上限（如 `2g`）              |
| `SEARCH_TOOL_TIMEOUT_MS` | `240000` | 服务端 `search_web` 上限，客户端超时要更大 |
| `BUNDLE_TOOL_TIMEOUT_MS` | `240000` | 服务端 `search_and_fetch` 上限       |

完整配置参考见 [.env.example](.env.example)。

---

## 多客户端并发与拥塞控制

所有浏览器类引擎共用同一个 Chromium，真正的上限是 `MAX_CONCURRENT_PAGES` 个页面槽位。
多个客户端同时搜索时，多出来的请求会排队等槽位；下列参数决定「排队」的具体表现，
使单个卡死的引擎无法长期霸占小机器上唯一的槽位——旧行为是一堵
`page queue full after 60000ms`，只有重启才能恢复。

| 客户端看到的报错                                | 错误码            | 含义与处理建议                                                                 |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `page queue full after 60000ms`                  | `PAGE_BUSY`       | 已等待 `PAGE_QUEUE_TIMEOUT_MS` 仍未拿到槽位。稍后重试，或调大 `MAX_CONCURRENT_PAGES`/该超时。 |
| `no page slot free within the remaining Nms budget` | `PAGE_BUSY`     | 调用方自身预算（引擎时限/工具超时）短到等不到槽位，未入队即快速失败。              |
| `page queue is full (N waiting for M slots)`     | `PAGE_QUEUE_FULL` | 等待队列已达 `MAX_PAGE_QUEUE_WAITERS`，快速失败而不是继续堆积请求。              |
| `DuckDuckGo throttle queue is full`              | `DDG_THROTTLED`   | 超过 `DUCKDUCKGO_MAX_QUEUED` 个客户端在等 DuckDuckGo 的 2 秒最小间隔。            |
| `DuckDuckGo blocked in Chromium (… HTTP 202 …)`   | `ENGINE_BLOCKED`    | [端点阶梯](#duckduckgo-端点阶梯)三跳全部命中挑战页。它会自行恢复：给该引擎换一条 `engine_proxies` 出口，或从 `engines[]` 中移除。 |
| `DuckDuckGo was not attempted: under 4000ms of budget left` | `ENGINE_TIMEOUT` | 剩余预算装不下一跳导航，于是没有占着槽位去做注定失败的尝试。调大 `ENGINE_TIMEOUT_MS`/工具超时，或让其他引擎先回答。 |
| `ChatGPT browser session is busy (N waiting)`    | `CHATGPT_BUSY`    | 多个客户端共用一个登录标签页，排队数超过 `CHATGPT_MAX_QUEUED`。                   |
| `search cancelled before <engine>`               | `ABORTED`         | 客户端断开或工具超时，页面已立即释放。                                            |

高负载下的新行为：

- 取消已贯穿全链路：MCP 客户端断开/工具超时，以及 HTTP 客户端中途挂断
  （`/search`、`/fetch_page`、`/search_and_fetch`、`/research_problem`）都会取消
  引擎执行、排队中的槽位等待与浏览器抓页并立即关页，不再留下「没人读结果」的任务；
  OpenAPI 的 `/tools/*` 四条同名路由行为一致。
- 引擎超时后会真正 abort 该引擎，慢源立刻交还槽位。
  同一条引擎时限会写进 signal，页面队列据此自我设限：实际等待时间取
  `PAGE_QUEUE_TIMEOUT_MS` 与「调用方剩余预算」中的较小值。否则在
  `MAX_CONCURRENT_PAGES=1` 的设备上，短时限引擎会在「仍在排队」时就被自己的定时器
  砍掉，客户端看到的是假的 `ENGINE_TIMEOUT`（像是引擎故障）而不是拥塞；这个注定失败
  的等待者还占着队列容量，把后面的客户端挤成 `PAGE_QUEUE_FULL`。
- 关页收尾也设有上限：`PAGE_TEARDOWN_TIMEOUT_MS` 限制
  `storageState()` / `goto('about:blank')` / `page.close()` 最多占用槽位多久。
  页面卡死（被取消或超时的请求最容易留下卡死页面）时，旧行为是一个死页面把
  单槽位机器的唯一槽位占到重启为止；现在超时即交还槽位，关闭动作在后台完成。
 - 但「被预算放弃的 close」不会补做第二次：Playwright 记住了第一次调用，之后每次
   `page.close()` 都立刻返回而不去碰标签页，于是那个已经导航到 `about:blank` 的页面
   就永远留在可见浏览器里 —— 这正是查询结束后越攒越多的空白页。因此池子给每个自己
   打开的页面记账：只要「已经叫它关」却仍开着超过 `PAGE_CLOSE_WEDGE_MS`，就走
   DevTools 协议（`Target.closeTarget`）把它关掉，例行清扫每
   `PAGE_REAPER_INTERVAL_MS` 跑一次。同一次清扫也回收点击搜索结果新开的标签页，以及
   无法归属到任何任务的 `about:blank` 残留页（`BROWSER_REAP_STRAY_BLANK_PAGES=false`
   只停用后一类回收）；清扫绝不碰不是池子开的标签页，也绝不会把一个 CDP context 关到只剩
   最后一页。收尾阶段还会直接跳过「剩余预算根本不够跑完」的步骤
   （`MIN_AWAITABLE_STEP_MS`），而不是先启动一趟注定半途而废的导航。
   清扫的台账还能跨 CDP 断线重连存活：重连之后 Page 对象全部作废，能被记住的只有
   target id（上限 `PAGE_OWNERSHIP_MAX`），所以上一次连接里我们留下的页会被重新认领回
   自己名下，而不是被永久升级成「不能关的陌生人」—— 空白页只增不减正是这么来的。
   至于连接建立那一刻就已经开着的标签页（可见浏览器启动页、持久化 profile 恢复的窗口）
   仍然算别人的，除非 `BROWSER_REAP_FOREIGN_BLANK_PAGES=true`：只有本服务在驱动的浏览器
   应当打开它。
- 命中验证码/风控而保留不关的页面（`keepPageOpen`）受 `MAX_KEPT_PAGES` 约束：
  这类页面不计入页面槽位，launch 模式下还各自独占一个 context，多个客户端同时抓风控
  站点会在 `KEPT_PAGE_TTL_MS`（默认 5 分钟）内攒出数个常驻 Chromium；超限时按
  「临时页优先、最早优先」淘汰。
- 关停阶段每一步（chrome-devtools MCP / 浏览器池 / HTTP 服务）受
  `SHUTDOWN_STEP_TIMEOUT_MS` 约束：卡死的 `page.close()` 或一直不断开的 SSE 客户端
  曾让 `pool.close()`/`server.close()` 永不返回，进程退不出去就等于整份 Chromium 常驻。
- 有人排队时跳过关页前的「拟人停留」（`BROWSER_KEEP_LINGER_UNDER_LOAD=true` 可恢复），
  同时跳过可选的拟人等待动作。
- DuckDuckGo 在一个槽位内走端点阶梯，而不是只信单个 URL；它也不会启动一跳注定跑不完的导航：
  宁可上报 `ENGINE_TIMEOUT`，也不先占住槽位、再报告一个并非自己造成的解析失败。
- 会话 context 按 LRU 驱逐，且绝不驱逐正在执行任务的 context，
  因此并发客户端下 `MAX_SESSION_CONTEXTS=1` 也是安全的。
- 空闲的 `/mcp-stream`、`/sse` 会话在 `SESSION_IDLE_TTL_MS` 后回收。

实时饱和度看 `engine_status` → `page_pool`
（`active_pages` / `max_pages` / `queued_pages` / `max_queued_pages` / `session_contexts`
/ `kept_pages` / `session_pages` / `tracked_pages` / `wedged_pages` / `reaped_pages` /
/ `reaped_targets`）。
 `session_pages` 是各会话在可见浏览器里钉住的交互页（清扫刻意跳过它们）；
 `tracked_pages` 是池子开过、尚未确认关掉的页面，`wedged_pages` 是「已叫它关却还开着」
 的页面（长期大于 0 就说明 close 永远不会应答了），后两个是清扫累计收回的页面数与
 其中必须走协议才能关掉的 target 数。

ARM 或 2G 内存机器的建议起点：

```ini
LOW_POWER_DEVICE=true
MAX_CONCURRENT_PAGES=1
MAX_SESSION_CONTEXTS=1
MAX_FETCH_CONCURRENCY=1
PAGE_QUEUE_TIMEOUT_MS=30000
MAX_PAGE_QUEUE_WAITERS=4
MAX_KEPT_PAGES=2
```

对延迟敏感的调用建议固定 `engines: ["wikipedia"]`（配置了 Key 时再加 Brave/Tavily）：
`wikipedia` 是唯一不碰浏览器池的默认引擎，浏览器引擎排队时它依然快。`duckduckgo` 现在与
bing/google 共用同一个页面池，在单槽位机器上它是排队者，而不是旁路。

---

## 架构

### 用户视角

```text
Agent
  │
 MCP
  ▼
local-search-mcp
  ├── HTTP 来源（wikipedia）
  ├── Chromium 来源（duckduckgo、bing、google、chatgpt、deepseek）
  ├── 页面抓取（HTTP + 浏览器回退）
  └── 多查询研究
```

### 实现视角

单个 Docker 容器打包：

```text
Docker
├── Node.js（HTTP + MCP 服务 :8765）
├── Chromium（:9224，可见浏览器）
├── Xvfb :99 ── Openbox
├── x11vnc :5900 ── noVNC :6080
└── /data（持久化：profile、会话、artifact）
```

---

## 安全

> [!WARNING]
> 本项目主要面向本地/内网部署。浏览器会话可能包含已认证的 Cookie 和敏感数据。
> 请勿将 noVNC 直接暴露到公网。详见下方「安全」。

内置防护：

- **SSRF 防护** — 拦截内网/回环/保留地址，数字/十六进制/IPv4-mapped IP 字面量、DNS 重绑定、非 http(s) scheme 以及重定向回内网。
- **路径遍历防护** — artifact 读取限制在 `/data/artifacts/` 内。
- **速率限制** — 默认每 IP 每分钟 100 次请求（可配置）。
- **Bearer Token 认证** — 通过 `MCP_BEARER_TOKEN` 启用；除 `/health` 外所有端点需携带 `Authorization: Bearer <token>`。
- **最小化健康检查** — `/health` 仅返回 `{"ok":true}`。

如果必须公网暴露，至少应：设置强 `MCP_BEARER_TOKEN`，设置 `NOVNC_PASSWORD` 并保持 `NOVNC_LISTEN_HOST=127.0.0.1`，通过反向代理启用 HTTPS，并用防火墙限制访问 IP。本项目为开源软件，作者不对使用造成的任何后果承担责任。

---

## 数据与隐私

所有状态持久化在 `./data`（Docker volume）：

| 目录                    | 内容                            |
| ----------------------- | ----------------------------- |
| `data/browser-profile`  | Chromium 用户目录（登录态、扩展）|
| `data/browser-state`    | 搜索引擎会话快照               |
| `data/artifacts`        | 搜索结果与抓取文本             |
| `data/cache/papers`     | 论文缓存（SQLite + 文件）      |
| `data/traces`           | DeepSeek 对话轨迹（`DEEPSEEK_TRACE_ENABLED=true` 时启用）|

迁移时归档 `data/`，在目标机器恢复后再执行 `docker compose up -d`。

---

## 「免费搜索」是什么意思？

核心工作流不需要商业 Search API 订阅。部分可选的浏览器后端提供方可能要求用户账号、有自己的使用额度限制，并受各自条款和可用性约束。

---

## 局限性

- 浏览器搜索比直接调用 Search API 更慢。
- 网站可能改变其 DOM，暂时破坏浏览器集成。
- 验证码或 MFA 可能需要通过 noVNC 手动交互。
- 搜索质量取决于所选来源。
- 外部网站可能限流或屏蔽自动化访问。
- 网页证据仍可能出错；调用模型应批判性评估来源。
- 本项目不保证本地模型一定产生正确回答。
- 部署基于 Docker，主要在 Linux x86_64 上测试。其他兼容 Docker 的平台（如通过 Docker Desktop 的 Windows/macOS、Linux ARM64）可能可用，但未定期测试。

---

## 许可证

采用 **GNU General Public License v3.0 (GPL-3.0)** 协议。详见 [LICENSE](LICENSE) 或 https://www.gnu.org/licenses/gpl-3.0.html

*Local Search MCP — 为本地 LLM Agent 提供自托管联网搜索与证据获取能力。*
