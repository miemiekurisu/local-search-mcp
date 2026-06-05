# local-search-mcp

> **该手册由AI生成，可能存在错误，请以实际代码为准。**

---

## ⚠️ 安全警告

**本项目设计用于内网部署及个人使用。**

- **请勿将本服务直接暴露到公网**。服务包含浏览器远程访问（noVNC）功能，一旦暴露到公网将导致登录凭据泄露、会话劫持等严重安全风险。
- 如果必须暴露到公网，**务必**：
  1. 设置 `MCP_BEARER_TOKEN` 启用 Bearer Token 认证
  2. 设置强密码 `NOVNC_PASSWORD` 并限制 `NOVNC_LISTEN_HOST=127.0.0.1`
  3. 使用反向代理（如 Nginx/Caddy）并配置 HTTPS
  4. 使用防火墙限制访问 IP
- **免责声明：本项目为开源软件，作者不对使用该应用造成的任何后果和损失承担任何责任。使用者应自行承担安全风险，包括但不限于数据泄露、账户被盗、服务被滥用等。**

---

## 项目简介

**Local Search & Web Evidence MCP 服务** 是一个单容器部署的本地搜索和网页抓取工具，为 AI Agent 提供 MCP（Model Context Protocol）和 HTTP 接口。

### 核心特性

- **无需付费 API**：内置 DuckDuckGo、Bing、Wikipedia、Google 等搜索引擎，不依赖任何付费搜索服务
- **多引擎搜索**：支持 DuckDuckGo（HTTP）、Wikipedia（HTTP）、Google（浏览器）、Bing（浏览器）、ChatGPT（浏览器）
- **网页抓取**：HTTP 抓取失败自动回退到浏览器渲染，支持 SPA 页面
- **深度研究**：自动生成查询家族，多引擎并行搜索，返回结构化证据
- **天气查询**：基于 Open-Meteo API，支持中文地名（自动拼音转换）
- **时间查询**：支持 UTC、北京时间、东京时间、纽约时间、伦敦时间等多时区
- **自定义引擎**：支持通过 JSON 配置自定义 HTML 搜索引擎
- **跨平台**：支持 x86_64（Windows/Linux/macOS）和 ARM64（Linux）

### 架构

```
┌────────────── Docker Container ──────────────┐
│  Xvfb :99 ──▶ Openbox ──▶ Chromium :9224    │
│  x11vnc :5900 ──▶ noVNC :6080               │
│  Node.js :8765 (HTTP + MCP)                 │
│  /data (持久化：profile、会话、artifact)        │
└──────────────────────────────────────────────┘
```

### 分支说明

| 分支 | 平台 | 基础镜像 | 适用场景 |
|------|------|----------|----------|
| `main` | x86_64 / macOS | `node:22-bookworm` + Playwright Chromium | 主流桌面/服务器 |
| `arm64` | ARM (aarch64) | `node:22-bookworm` + apt Chromium | ARM 设备（如 TN3399） |

---

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/miemiekurisu/local-search-mcp.git
cd local-search-mcp

# 2. 配置环境变量
cp .env.example .env

# 3. 一键启动
docker compose up -d --build

# 4. 验证
curl http://localhost:8765/health
# 返回: {"ok":true}
```

ARM 设备额外步骤：
```bash
git checkout arm64
docker compose up -d --build
```

---

## 环境变量配置

详见 `.env.example`，以下为完整参数说明：

### 网络端口

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_LISTEN_HOST` | `0.0.0.0` | MCP 服务监听地址，`0.0.0.0` 表示所有网卡 |
| `HTTP_LISTEN_PORT` | `8765` | MCP 服务宿主端口 |
| `NOVNC_LISTEN_HOST` | `127.0.0.1` | noVNC 监听地址，**默认仅本机** |
| `NOVNC_LISTEN_PORT` | `6082` | noVNC 宿主端口 |

### 代理配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LAN_PROXY_SERVER` | `""` | 搜索引擎 HTTP 代理（如 `http://192.168.1.100:7890`） |
| `VISIBLE_BROWSER_PROXY_SERVER` | `""` | Chromium 浏览器代理（`--proxy-server` 参数） |
| `BROWSER_PROXY_SERVER` | `""` | HTTP profile 代理（proxy_profiles.json） |

### 安全配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_BEARER_TOKEN` | `""` | Bearer Token，**公网暴露时必须设置** |
| `NOVNC_PASSWORD` | `""` | noVNC 密码，留空则 noVNC **不启动** |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | 每 IP 每窗口期最大请求数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 速率限制窗口（毫秒） |

### 搜索引擎

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHATGPT_EMAIL` | `""` | ChatGPT 自动登录邮箱 |
| `CHATGPT_PASSWORD` | `""` | ChatGPT 自动登录密码 |

### 学术论文工具

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_PAPER_TOOLS` | `true` | 是否启用论文搜索工具 |
| `OPENALEX_API_KEY` | `""` | OpenAlex API Key（免费） |
| `CROSSREF_MAILTO` | `""` | Crossref 邮箱（提高限频） |
| `UNPAYWALL_EMAIL` | `""` | Unpaywall 邮箱 |

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TIMEZONE` | 服务器时区 | `get_time` 工具默认时区（如 `Asia/Shanghai`） |

---

## 功能说明

### 1. 网络搜索

通过 MCP 的 `search_web` 工具或 HTTP 的 `/search` 端点进行多引擎搜索。

```bash
# MCP 方式
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_web","arguments":{"query":"Rust 编程","limit":5,"engines":["duckduckgo","wikipedia"]}}}'

# HTTP 方式
curl -s -X POST http://localhost:8765/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Rust 编程","limit":5}'
```

**搜索引擎列表：**

| 引擎 | 类型 | 需要登录 | 说明 |
|------|------|----------|------|
| `duckduckgo` | HTTP | 否 | 默认引擎，无需浏览器 |
| `wikipedia` | HTTP | 否 | 默认引擎，无需浏览器 |
| `google` | 浏览器 | 是 | 需通过 noVNC 登录后保存会话 |
| `bing` | 浏览器 | 是 | 需通过 noVNC 登录后保存会话 |
| `chatgpt` | 浏览器 | 是 | 需通过 noVNC 登录后保存会话 |

### 2. 网页抓取

`fetch_page` 工具支持 HTTP 抓取和浏览器渲染两种模式，`mode=auto` 会自动回退。

```bash
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_page","arguments":{"url":"https://example.com","mode":"auto"}}}'
```

### 3. 搜索 + 抓取

`search_and_fetch` 先搜索再抓取前 N 个结果的页面内容，返回结构化证据包。

```bash
curl -s -X POST http://localhost:8765/search_and_fetch \
  -H 'Content-Type: application/json' \
  -d '{"query":"AI Agent 框架","limit":10,"fetch_top_k":5}'
```

### 4. 深度研究

`research_problem` 根据问题描述自动生成查询家族，多引擎并行搜索，返回带置信度的证据候选。

```bash
curl -s -X POST http://localhost:8765/research_problem \
  -H 'Content-Type: application/json' \
  -d '{"problem_signature":{"task":"排查 Docker 构建失败","symptom":"lsetxattr security.capability"},"budget":{"max_queries":3,"max_pages":5}}'
```

### 5. 天气查询

`get_weather` 工具基于 Open-Meteo API，免费无需 API Key，支持中文地名（自动拼音转换）。

```bash
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"北京"}}}'
```

支持中文城市名、区县名（如"上海三林"），自动处理多地点消歧。

### 6. 时间查询

`get_time` 工具支持多时区查询：

```bash
curl -s -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_time","arguments":{"query":"Beijing"}}}'
```

支持时区：`UTC`、`Beijing`、`Tokyo`、`New York`、`London` 等。

### 7. MCP 工具总览

| 工具 | 说明 |
|------|------|
| `search_web` | 多引擎搜索 |
| `fetch_page` | 网页抓取（HTTP + 浏览器回退） |
| `search_and_fetch` | 搜索 + 抓取 |
| `research_problem` | 深度研究 |
| `get_artifact` | 读取历史 artifact |
| `engine_status` | 引擎/代理/会话状态 |
| `get_weather` | 天气查询（Open-Meteo） |
| `get_time` | 时间查询（多时区） |

---

## noVNC 可视化浏览器

noVNC 提供容器内 Chromium 浏览器的远程可视化访问，用于手动登录 Google、Bing、ChatGPT 等需要浏览器会话的服务。

### ⚠️ 安全警告（再次强调）

**noVNC 暴露完整的浏览器会话（含登录态、Cookie、页面内容），存在极大安全隐患。**

- 默认情况下 noVNC **不启动**（`NOVNC_PASSWORD` 为空）
- **严禁**将 noVNC 暴露到公网
- 仅建议在遇到验证码/MFA 需要手动登录时临时启用，使用后立即关闭
- 如需远程访问 noVNC，请通过 SSH 隧道而非直接暴露端口

### 启用方法

1. 在 `.env` 中设置密码（使用强密码）：
   ```
   NOVNC_PASSWORD=your_strong_password_here
   ```

2. 重启容器：
   ```bash
   docker compose up -d
   ```

3. 通过浏览器访问（仅本机）：
   ```
   http://localhost:6082/vnc.html
   ```

### 远程访问 noVNC（推荐 SSH 隧道）

```bash
# 通过 SSH 隧道转发，不暴露端口到公网
ssh -L 6082:127.0.0.1:6082 user@server
# 然后访问 http://localhost:6082/vnc.html
```

### 登录和手动验证

某些网站（如 Google、ChatGPT）可能触发验证码或 MFA，此时需要通过 noVNC 手动完成验证：

1. 启用 noVNC 并访问 `http://localhost:6082/vnc.html`
2. 在浏览器中完成登录/验证
3. 保存会话：
   ```bash
   curl -s -X POST http://localhost:8765/browser_sessions/save \
     -H 'Content-Type: application/json' \
     -d '{"session":"google"}'
   ```
4. 验证完成后立即关闭 noVNC（从 `.env` 删除 `NOVNC_PASSWORD`）

### 降低被拦截建议

- 通过 noVNC 手动登录后保存会话，减少自动登录触发风控的概率
- 使用代理（设置 `VISIBLE_BROWSER_PROXY_SERVER`）
- 容器内置 uBlock Origin 扩展，自动拦截广告

### 关闭 noVNC

```bash
# 从 .env 中删除或注释掉 NOVNC_PASSWORD 行
# NOVNC_PASSWORD=

# 重启容器
docker compose up -d
```

---

## 安全配置

### Bearer Token 认证

公网暴露时，设置 `MCP_BEARER_TOKEN` 启用认证：

```env
MCP_BEARER_TOKEN=your-random-secure-token-here
```

启用后，所有 API 请求（除 `/health`）需携带认证头：

```bash
curl -s http://localhost:8765/mcp \
  -H 'Authorization: Bearer your-random-secure-token-here' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 内置安全措施

- **SSRF 防护**：拦截内网 IP（IPv4/IPv6）、非 http(s) scheme、重定向回内网
- **路径遍历防护**：artifact 读取限制在 `/data/artifacts/` 内
- **信息泄露防护**：`/health` 仅返回 `{"ok":true}`，不泄露版本信息
- **速率限制**：默认 100 请求/分钟/IP，支持自定义

---

## 数据持久化

所有数据存储在 `./data` 目录（Docker volume 挂载）：

| 目录 | 内容 |
|------|------|
| `data/browser-profile` | Chromium 用户目录（登录态、扩展） |
| `data/browser-state` | 搜索引擎会话快照 |
| `data/artifacts` | 搜索结果与抓取文本 |
| `data/cache/papers` | 论文缓存（SQLite + 文件） |

### 数据迁移

```bash
# 旧机器打包
tar czf local-search-data.tar.gz data/

# 新机器解压
tar xzf local-search-data.tar.gz
docker compose up -d
```

---

## License

本项目采用 **GNU General Public License v3.0 (GPL-3.0)** 协议。

完整协议文本见 [LICENSE](LICENSE) 文件，或访问 https://www.gnu.org/licenses/gpl-3.0.html

### 依赖项许可证

本项目使用的第三方库遵循各自的开源协议：

| 库 | 协议 |
|----|------|
| Express | MIT |
| Playwright | Apache-2.0 |
| @modelcontextprotocol/sdk | MIT |
| cheerio | MIT |
| jsdom | MIT |
| @mozilla/readability | MPL-2.0 |
| undici | MIT |
| zod | MIT |
| html-to-text | BSD-2-Clause |
| pdf-parse | MIT |
| tiny-pinyin | MIT |
| x11vnc | GPL-2.0 |
| noVNC | MPL-2.0 |
| Chromium | BSD-3-Clause |

### GPL-3.0 概要

- ✅ 允许自由使用、修改和分发本软件
- ✅ 允许用于商业用途
- ⚠️ 修改后的代码必须以相同许可证（GPL-3.0）发布
- ⚠️ 分发修改版时需提供完整源码
- ❌ 不提供任何担保，使用者自行承担风险

---

*Local Search MCP — 为 AI Agent 提供本地搜索和网页证据获取能力。*
