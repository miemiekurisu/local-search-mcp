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

对于无法通过简单 HTTP 请求可靠访问的来源，`local-search-mcp` 可使用持久的 Chromium 浏览器。根据配置，浏览器会话用于 **Bing**、**Google**、**ChatGPT Web** 和 **DeepSeek Web**。

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
      "timeout": 120
    }
  }
}
```

在低性能设备（如 ARM 开发板）上，浏览器搜索耗时更长——建议 `timeout` 设为 180–300，并考虑 `MAX_CONCURRENT_PAGES=1`。

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
| `duckduckgo`| HTTP     | 否       | 默认，无 Key，无需浏览器        |
| `wikipedia` | HTTP     | 否       | 默认，无 Key，无需浏览器        |
| `bing`      | 浏览器   | 否       | 浏览器渲染，公开搜索            |
| `google`    | 浏览器   | 否       | 浏览器渲染，公开搜索            |
| `chatgpt`   | 浏览器   | 是       | 需通过 noVNC 登录               |
| `deepseek`  | 浏览器   | 是       | 需登录 `chat.deepseek.com`      |

核心工作流（`duckduckgo`、`wikipedia`）无需 API Key。可配置可选的 API Key 回退（Brave、Tavily、Exa、Google Custom Search），仅在基于页面的引擎失败时使用。

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

完整配置参考见 [.env.example](.env.example)。

---

## 架构

### 用户视角

```text
Agent
  │
 MCP
  ▼
local-search-mcp
  ├── HTTP 来源（duckduckgo、wikipedia）
  ├── Chromium 来源（bing、google、chatgpt、deepseek）
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
