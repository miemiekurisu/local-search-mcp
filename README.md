# local-search-mcp

**Give your local LLM agent access to the web — without requiring a paid search API.**

A self-hosted MCP server for web search, page retrieval, browser-backed search and multi-query research. Built for local LLM agents and coding agents that need fresh information without relying on a commercial Search API.

[简体中文](README.zh-CN.md)

---

## Why?

Local models can be surprisingly capable at coding and reasoning, but they often struggle when the answer depends on information outside their training data:

- recent library or framework changes
- obscure GitHub issues and error reports
- current documentation
- niche technical problems
- newly released models or software
- facts that need external verification

`local-search-mcp` gives an MCP-capable agent tools to search the web, read pages, collect evidence, and keep reasoning with fresh information.

> **No paid search API is required for the core search workflow.**

---

## What it does

```text
Local LLM / Coding Agent
          │
          │ MCP
          ▼
┌──────────────────────────────┐
│       local-search-mcp       │
├──────────────────────────────┤
│ Search                       │
│ Fetch web pages              │
│ Browser-backed search        │
│ Multi-query research         │
│ Optional Web AI sessions     │
└──────────────────────────────┘
          │
          ▼
Search results + page content + evidence
          │
          ▼
Local agent continues reasoning
```

`local-search-mcp` is a server your MCP-capable agent connects to. It is especially useful when your agent is powered by a local model through runtimes such as Ollama, llama.cpp, vLLM or LM Studio.

---

## Who is this for?

`local-search-mcp` is mainly designed for developers who:

- run LLMs locally or self-host their models
- use local models through coding agents or general-purpose agents
- want web search without paying for a commercial Search API
- need current documentation, GitHub issues, release information or niche technical knowledge
- want their agents to retrieve evidence instead of relying entirely on model memory
- prefer a self-hosted search/research component

> If your local model is already capable of reasoning about a problem but lacks the information needed to solve it, this project is designed to help bridge that gap.

---

## Why I built this

I use local LLMs for coding, troubleshooting and technical research.

A recurring problem was that the model often had enough reasoning ability to solve a task, but lacked one critical piece of information: a recent API change, an obscure bug report, a GitHub issue, new documentation, or experience shared by another developer.

After giving the agent web search and page retrieval tools, I found that several problems it could not solve offline became solvable through searching, reading and verification.

This project grew out of that workflow.

---

## Features

### Core capabilities

- **Web search** — search the web through multiple available search backends (`search_web`).
- **Page retrieval** — retrieve readable page content for the agent. HTTP retrieval can optionally fall back to browser rendering for pages that require JavaScript (`fetch_page`).
- **Search + Fetch** — search first, then retrieve selected result pages and return structured evidence to the agent (`search_and_fetch`).
- **Multi-query research** — expand a problem into multiple queries, search across sources, retrieve relevant pages and return evidence candidates. It provides research material; the final synthesis remains with the calling agent (`research_problem`).

### Browser-backed sources

For sources that cannot be reached reliably through simple HTTP requests, `local-search-mcp` can use a persistent Chromium browser. Depending on configuration, browser sessions are used for **Bing**, **Google**, **ChatGPT Web** and **DeepSeek Web**.

Some providers require the user to log in manually through the optional noVNC interface. Login state can then be persisted locally.

### Optional Web AI providers

`local-search-mcp` can also interact with supported logged-in AI web sessions through the managed browser. This lets an agent use another web-accessible model as an additional research or problem-solving source.

- **ChatGPT Web** — browser-backed, requires login via noVNC.
- **DeepSeek Web** — browser-backed, requires a `chat.deepseek.com` login. Retrieves the generated answer (subject to `DEEPSEEK_MAX_SNIPPET`) and, when available, the reasoning text exposed by the DeepSeek web UI. An optional multi-step verification workflow (DeepSeek → Google AI → DeepSeek synthesis) can be enabled.

### Additional tools

- **Weather lookup** — Open-Meteo, free, no key. Supports Chinese place names (e.g. `上海三林`) with automatic disambiguation (`get_weather`).
- **Time / timezone lookup** — UTC, Beijing, Tokyo, New York, London and more (`get_time`).
- **Custom HTML search engines** — define your own engines via a JSON config file.

---

## Quick Start

Requirements: Docker and Docker Compose.

```bash
git clone https://github.com/miemiekurisu/local-search-mcp.git
cd local-search-mcp
cp .env.example .env
docker compose up -d --build
```

Verify:

```bash
curl http://localhost:8765/health
```

Expected:

```json
{"ok":true}
```

---

## Connect your agent

The server exposes three MCP transports:

| Interface     | Recommended for                                  |
| ------------- | ------------------------------------------------ |
| `/mcp-stream` | Standard MCP clients (Streamable HTTP)           |
| `/sse`        | Clients requiring legacy/remote SSE (e.g. opencode `remote`) |
| `/mcp`        | Direct HTTP/JSON-RPC usage (curl, scripts)       |

> **For most MCP clients, start with `http://localhost:8765/mcp-stream`.**

### Generic MCP client

Add a server with URL `http://<server-ip>:8765/mcp-stream`.

### opencode

opencode's `"type": "remote"` mode uses SSE. Use `http://<server-ip>:8765/sse` and raise the timeout (search can be slow):

```json
{
  "mcpServers": {
    "local-search": {
      "type": "remote",
      "url": "http://<server-ip>:8765/sse",
      "timeout": 120
    }
  }
}
```

On low-power devices (e.g. ARM boards), browser search can take longer — set `timeout` to 180–300 and consider `MAX_CONCURRENT_PAGES=1`.

---

## Available tools

| Tool                | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `search_web`        | Search available web sources                     |
| `fetch_page`        | Retrieve readable page content                   |
| `search_and_fetch`  | Search and retrieve selected results             |
| `research_problem`  | Multi-query evidence collection                  |
| `get_artifact`      | Retrieve stored research artifacts               |
| `engine_status`     | Check source/browser availability                |
| `get_weather`       | Weather lookup (Open-Meteo)                      |
| `get_time`          | Timezone-aware time lookup                       |

---

## Search sources

| Engine        | Type     | Login        | Notes                              |
| ------------- | -------- | ------------ | ---------------------------------- |
| `duckduckgo`  | HTTP     | no           | Default, no key, no browser        |
| `wikipedia`   | HTTP     | no           | Default, no key, no browser        |
| `bing`        | Browser  | no           | Browser-rendered, public search    |
| `google`      | Browser  | no           | Browser-rendered, public search    |
| `chatgpt`     | Browser  | yes          | Requires login via noVNC           |
| `deepseek`    | Browser  | yes          | Requires `chat.deepseek.com` login |

The core workflow (`duckduckgo`, `wikipedia`) needs no API key. Optional API-key fallbacks (Brave, Tavily, Exa, Google Custom Search) can be configured; they are used only when a page-based engine fails.

---

## Browser login & sessions (noVNC)

noVNC exposes the container's Chromium through a remote browser UI. It is used to log in manually to providers that need a browser session (e.g. ChatGPT).

> noVNC is **disabled by default** (`NOVNC_PASSWORD` empty).

To enable:

```bash
# in .env
NOVNC_PASSWORD=your_strong_password_here
```

```bash
docker compose up -d
```

Open `http://localhost:6082/vnc.html`, complete the login / CAPTCHA / MFA manually, then save the session:

```bash
curl -s -X POST http://localhost:8765/browser_sessions/save \
  -H 'Content-Type: application/json' \
  -d '{"session":"chatgpt"}'
```

For remote access, prefer an SSH tunnel rather than exposing the port:

```bash
ssh -L 6082:127.0.0.1:6082 user@server
```

Disable noVNC again by removing `NOVNC_PASSWORD` and restarting the container.

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. The most common options:

| Variable               | Default | Notes                                  |
| ---------------------- | ------- | -------------------------------------- |
| `HTTP_LISTEN_PORT`     | `8765`  | Host port for the MCP server           |
| `MCP_BEARER_TOKEN`     | `""`    | Bearer token auth (required if public) |
| `NOVNC_PASSWORD`       | `""`    | noVNC password (empty = noVNC disabled)|
| `LOW_POWER_DEVICE`     | `false` | Reduce concurrency for low-power hosts |
| `MEM_LIMIT`            | —       | Container memory cap (e.g. `2g`)       |

See [.env.example](.env.example) for the full configuration reference.

---

## Architecture

### User perspective

```text
Agent
  │
 MCP
  ▼
local-search-mcp
  ├── HTTP sources (duckduckgo, wikipedia)
  ├── Chromium sources (bing, google, chatgpt, deepseek)
  ├── page fetch (HTTP + browser fallback)
  └── multi-query research
```

### Implementation perspective

A single Docker container bundles:

```text
Docker
├── Node.js (HTTP + MCP server :8765)
├── Chromium (:9224, visible browser)
├── Xvfb :99 ── Openbox
├── x11vnc :5900 ── noVNC :6080
└── /data (persisted: profile, sessions, artifacts)
```

---

## Security

> [!WARNING]
> This project is designed primarily for local/private-network deployment.
> Browser sessions may contain authenticated cookies and sensitive data.
> Do not expose noVNC directly to the public Internet.
> See [Security](#security) below.

Built-in protections:

- **SSRF guard** — blocks private/loopback/reserved addresses, numeric/hex/IPv4-mapped IP literals, DNS rebinding, non-http(s) schemes and redirects back to private networks.
- **Path traversal guard** — artifact reads are confined to `/data/artifacts/`.
- **Rate limiting** — default 100 requests per minute per IP (configurable).
- **Bearer token auth** — enable with `MCP_BEARER_TOKEN`; all endpoints except `/health` require `Authorization: Bearer <token>`.
- **Minimal health endpoint** — `/health` returns only `{"ok":true}`.

If you must expose the service publicly, at minimum: set a strong `MCP_BEARER_TOKEN`, set `NOVNC_PASSWORD` and keep `NOVNC_LISTEN_HOST=127.0.0.1`, use HTTPS via a reverse proxy, and firewall the access IPs. This project is open-source software; the author accepts no liability for any consequences of its use.

---

## Data & privacy

All state is persisted under `./data` (Docker volume):

| Directory             | Contents                              |
| --------------------- | ------------------------------------- |
| `data/browser-profile`| Chromium user directory (login, extensions) |
| `data/browser-state`  | Search-engine session snapshots       |
| `data/artifacts`      | Search results and fetched text       |
| `data/cache/papers`   | Paper cache (SQLite + files)          |
| `data/traces`         | DeepSeek conversation traces (when `DEEPSEEK_TRACE_ENABLED=true`) |

Migrate by archiving `data/` and restoring it on the new host before `docker compose up -d`.

---

## What does "free search" mean?

The core workflow does not require a commercial Search API subscription. Some optional browser-backed providers may require a user account, may impose their own usage limits, and remain subject to their respective terms and availability.

---

## Limitations

- Browser-backed search is slower than direct Search APIs.
- Websites may change their DOM and temporarily break browser integrations.
- CAPTCHA or MFA may require manual interaction via noVNC.
- Search quality depends on the selected source.
- External websites may rate-limit or block automated access.
- Web evidence can still be incorrect; the calling model should evaluate sources critically.
- This project does not guarantee that a local model will produce correct answers.
- Deployment is Docker-based and primarily tested on Linux x86_64. Other Docker-compatible platforms (Windows/macOS via Docker Desktop, Linux ARM64) may work but are not regularly tested.

---

## License

Licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See [LICENSE](LICENSE) or https://www.gnu.org/licenses/gpl-3.0.html.

*Local Search MCP — self-hosted web search and evidence retrieval for local LLM agents.*
