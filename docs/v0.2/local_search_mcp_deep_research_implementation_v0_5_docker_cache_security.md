# Local Search MCP：Deep Research 论文抓取、缓存归档与 Docker/noVNC 部署边界实施方案 v0.5

> 基于代码包：`local-search-mcp.zip`、新增 Docker 部署文件 `Dockerfile` / `docker-compose.yml` / `start.sh` / `proxy_profiles*.json` / `search_engines*.json`  
> 检查日期：2026-05-30  
> 范围：**只生成实施文档，不修改现有源码**。  
> 版本定位：本文件是 v0.4 的 Docker 实化修订版，重点把“论文正文抓取后的缓存归档控制”和“noVNC 只允许本机访问、MCP 允许内网访问”的部署策略落到当前 Docker 文件上。

---

## 0. 本次修正的核心结论

新增 Docker 信息后，可以把前一版中的部署假设具体化。当前部署已经具备三个重要基础：

1. `Dockerfile` 使用 Playwright 官方镜像，安装 `xvfb`、`x11vnc`、`novnc`、`websockify`、`openbox`，并设置 `ARTIFACT_DIR=/data/artifacts`。
2. `docker-compose.yml` 已挂载 `./data:/data`，因此 artifact、浏览器 profile、后续论文缓存都可以落在宿主机持久目录中。
3. Chromium CDP 已按 `127.0.0.1:9224` 设计，默认没有发布到宿主机端口，这是正确方向。

但也有两个必须修正的部署问题：

1. `docker-compose.yml` 当前把 noVNC 映射为：

```yaml
- "0.0.0.0:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

这意味着 noVNC 会暴露给宿主机所有网卡，与“noVNC 只允许本机访问”的目标冲突。

2. `start.sh` 当前启动 `x11vnc` 时使用：

```bash
-listen 0.0.0.0
-nopw
```

即使 Docker 端口改成只绑定本机，容器内部的 VNC 服务仍不应开放到容器网络所有接口。最佳实践是：**x11vnc 只监听 127.0.0.1，websockify 也只监听 127.0.0.1，Docker 只把 noVNC 映射到宿主机 127.0.0.1。**

目标状态应为：

```text
MCP HTTP / MCP Streamable HTTP
    宿主机 0.0.0.0:8765  ->  容器 8765
    允许局域网访问

noVNC
    宿主机 127.0.0.1:6082  ->  容器 127.0.0.1:6080
    只允许本机访问

x11vnc
    容器内 127.0.0.1:5900
    只允许 websockify 访问

Chromium CDP
    容器内 127.0.0.1:9224
    不发布到宿主机
```

---

## 1. 当前 Docker 文件检查

### 1.1 Dockerfile 检查

当前 `Dockerfile` 的关键事实如下：

```dockerfile
FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV NODE_ENV=production \
    PORT=8765 \
    ARTIFACT_DIR=/data/artifacts \
    DEFAULT_SEARCH_LIMIT=20 \
    DEFAULT_FETCH_TOP_K=20 \
    MAX_SEARCH_LIMIT=20 \
    MAX_FETCH_CONCURRENCY=3 \
    SEARCH_HEADLESS=true \
    USE_EXISTING_CHROME=false \
    CDP_URL=http://localhost:9222 \
    PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH} \
    BRAVE_API_KEY= \
    TAVILY_API_KEY=

RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data/artifacts

EXPOSE 8765 6080
CMD ["/usr/local/bin/start-local-search.sh"]
```

判断：

1. `ARTIFACT_DIR=/data/artifacts` 是正确的，符合后续把研究结果、证据包、论文文本摘要长期保留到 `/data` 的目标。
2. `RUN mkdir -p /data/artifacts` 只创建 artifact 目录，不创建论文缓存目录。后续应补充 `/data/cache/papers` 等目录，但也可以由 Node 代码启动时按需创建。
3. `EXPOSE 6080` 本身不是安全问题，因为真正暴露由 compose 的 `ports` 决定。但为了文档表达准确，应说明：`EXPOSE` 是镜像元数据，不等于发布端口。
4. `COPY docker/local-search/start.sh /usr/local/bin/start-local-search.sh` 表明真正生效的入口脚本路径是仓库内的 `docker/local-search/start.sh`。如果只是修改根目录下的 `start.sh`，而没有同步到 `docker/local-search/start.sh`，重新构建镜像时不会生效。

### 1.2 docker-compose.yml 检查

当前 `docker-compose.yml` 的端口段是：

```yaml
ports:
  - "${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
  - "0.0.0.0:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

判断：

1. 第一行没有指定 host IP，Docker 默认通常绑定到所有宿主机接口。这符合“**MCP 允许内网访问**”的目标。
2. 第二行明确把 noVNC 绑定到 `0.0.0.0`，这会让局域网机器可以访问 noVNC 页面。由于当前 VNC 是 `-nopw`，这是部署层面的主要风险。
3. 已挂载 `./data:/data`，这是论文抓取缓存、Artifact、浏览器 profile 的统一持久化基础。
4. 已挂载 `./src:/app/src` 和 `./config:/app/config`，适合开发阶段热更新，但生产阶段应谨慎，因为宿主机源码会覆盖镜像内源码。
5. 已设置 `ENABLE_PAPER_TOOLS=${ENABLE_PAPER_TOOLS:-true}`，说明论文工具默认启用。这样一旦补充正文抓取接口，必须同步补充缓存上限，否则会直接进入高增长存储模式。

### 1.3 start.sh 检查

当前 `start.sh` 中 VNC/noVNC 启动逻辑是：

```bash
x11vnc \
  -display "${DISPLAY_NUMBER}" \
  -forever \
  -shared \
  -nopw \
  -rfbport "${VNC_PORT}" \
  -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &

websockify --web=/usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
```

判断：

1. `x11vnc -nopw` 在个人本机使用场景可以接受，但前提是严格限制监听地址和 Docker 端口映射。
2. `x11vnc -listen 0.0.0.0` 不符合最小暴露面原则，应改为 `127.0.0.1`。
3. `websockify "${NOVNC_PORT}" ...` 默认监听地址依赖 websockify 默认行为。为避免歧义，应改成显式 `127.0.0.1:${NOVNC_PORT}`。
4. Chromium CDP 已设置：

```bash
--remote-debugging-port=${VISIBLE_BROWSER_CDP_PORT}
--remote-debugging-address=127.0.0.1
```

这是正确的。CDP 只应供容器内 MCP/Playwright/Chrome DevTools MCP 使用，不应发布到宿主机或局域网。

---

## 2. Docker 部署边界目标

### 2.1 端口暴露策略

| 服务 | 容器内端口 | 宿主机绑定 | 是否允许内网访问 | 说明 |
|---|---:|---:|---:|---|
| MCP HTTP | 8765 | `0.0.0.0:8765` | 是 | 给本机 LLM、其他内网设备、Agent 客户端调用 |
| MCP Streamable HTTP | 8765 `/mcp-stream` | 同 8765 | 是 | 与 MCP HTTP 共用端口 |
| noVNC | 6080 | `127.0.0.1:6082` | 否 | 只供宿主机浏览器登录 Google/Bing/ChatGPT 等页面 |
| x11vnc | 5900 | 不发布 | 否 | 只供容器内 websockify 访问 |
| Chromium CDP | 9224 | 不发布 | 否 | 只供容器内自动化组件访问 |

### 2.2 推荐网络边界

```text
局域网设备
  ↓ 允许
http://<宿主机IP>:8765/mcp
http://<宿主机IP>:8765/health

局域网设备
  ↓ 禁止
http://<宿主机IP>:6082/vnc.html

宿主机本机
  ↓ 允许
http://localhost:6082/vnc.html

容器内部
  ↓ 允许
http://127.0.0.1:9224  Chromium CDP
127.0.0.1:5900        x11vnc
127.0.0.1:6080        websockify/noVNC
```

---

## 3. docker-compose.yml 推荐修订

### 3.1 最小修订版

只改 noVNC 端口绑定即可满足你当前的核心要求：

```yaml
services:
  local-search-mcp:
    build: .
    image: local-search-mcp:latest
    ports:
      # MCP 允许局域网访问。
      - "0.0.0.0:${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"

      # noVNC 只允许宿主机本机访问。
      - "127.0.0.1:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

说明：

1. MCP 端口显式写 `0.0.0.0`，避免 Docker 默认行为在不同环境下产生歧义。
2. noVNC 端口显式写 `127.0.0.1`，局域网机器无法直接访问。
3. 如果需要远程管理 noVNC，应使用 SSH 隧道，而不是直接发布 noVNC 到局域网：

```bash
ssh -L 6082:127.0.0.1:6082 user@server
```

然后在本机访问：

```text
http://localhost:6082/vnc.html
```

### 3.2 加入论文缓存环境变量的推荐版

在正文抓取能力启用后，建议同步增加缓存和配额环境变量：

```yaml
services:
  local-search-mcp:
    build: .
    image: local-search-mcp:latest
    ports:
      - "0.0.0.0:${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
      - "127.0.0.1:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
    environment:
      - PORT=8765
      - ARTIFACT_DIR=/data/artifacts
      - BROWSER_STATE_DIR=/data/browser-state

      # Paper tools
      - ENABLE_PAPER_TOOLS=${ENABLE_PAPER_TOOLS:-true}
      - OPENALEX_API_KEY=${OPENALEX_API_KEY:-}
      - SEMANTIC_SCHOLAR_API_KEY=${SEMANTIC_SCHOLAR_API_KEY:-}
      - CROSSREF_MAILTO=${CROSSREF_MAILTO:-}
      - UNPAYWALL_EMAIL=${UNPAYWALL_EMAIL:-}

      # Paper content cache
      - PAPER_CACHE_ENABLED=${PAPER_CACHE_ENABLED:-true}
      - PAPER_CACHE_DIR=/data/cache/papers
      - PAPER_CACHE_MANIFEST=/data/cache/papers/manifest.sqlite
      - PAPER_CACHE_RAW_DIR=/data/cache/papers/raw
      - PAPER_CACHE_TEXT_DIR=/data/cache/papers/text
      - PAPER_CACHE_SECTION_DIR=/data/cache/papers/sections
      - PAPER_CACHE_CHUNK_DIR=/data/cache/papers/chunks
      - PAPER_CACHE_TMP_DIR=/data/cache/papers/tmp

      # Cache quota and lifecycle
      - PAPER_CACHE_MAX_BYTES=${PAPER_CACHE_MAX_BYTES:-10737418240}        # 10 GiB
      - PAPER_CACHE_RAW_MAX_BYTES=${PAPER_CACHE_RAW_MAX_BYTES:-4294967296} # 4 GiB
      - PAPER_CACHE_RAW_TTL_DAYS=${PAPER_CACHE_RAW_TTL_DAYS:-7}
      - PAPER_CACHE_TEXT_TTL_DAYS=${PAPER_CACHE_TEXT_TTL_DAYS:-90}
      - PAPER_CACHE_BUNDLE_TTL_DAYS=${PAPER_CACHE_BUNDLE_TTL_DAYS:-30}
      - PAPER_FETCH_MAX_BYTES=${PAPER_FETCH_MAX_BYTES:-52428800}           # 50 MiB
      - PAPER_FETCH_MAX_FULLTEXT_PAPERS=${PAPER_FETCH_MAX_FULLTEXT_PAPERS:-5}
      - PAPER_FETCH_PRESERVE_RAW=${PAPER_FETCH_PRESERVE_RAW:-false}

      # Visible browser / noVNC
      - SEARCH_HEADLESS=false
      - USE_EXISTING_CHROME=true
      - CDP_URL=http://127.0.0.1:9224
      - CHROME_DEVTOOLS_MCP_BROWSER_URL=http://127.0.0.1:9224
      - VISIBLE_BROWSER_CDP_PORT=9224
      - VISIBLE_BROWSER_PROFILE_DIR=/data/browser-profile
      - VISIBLE_BROWSER_START_URL=about:blank
      - VISIBLE_BROWSER_PROXY_SERVER=${BROWSER_PROXY_SERVER:-}

      # noVNC / VNC local-only defaults inside container
      - LOCAL_SEARCH_VNC_LISTEN=127.0.0.1
      - LOCAL_SEARCH_NOVNC_LISTEN=127.0.0.1
      - LOCAL_SEARCH_VNC_PORT=5900
      - LOCAL_SEARCH_NOVNC_PORT=6080
    volumes:
      - ./data:/data
      - ./src:/app/src
      - ./config:/app/config
    extra_hosts:
      - "host.docker.internal:host-gateway"
    shm_size: "1gb"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8765/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### 3.3 `.gitignore` 建议

由于 `./data` 会快速产生浏览器状态、artifact、论文缓存和日志，仓库必须排除：

```gitignore
/data/
!.gitkeep
```

如果希望保留目录结构，可以在 `data/.gitkeep` 外排除全部实际内容。

---

## 4. start.sh 推荐修订

### 4.1 增加监听地址变量

在脚本顶部增加：

```bash
VNC_LISTEN="${LOCAL_SEARCH_VNC_LISTEN:-127.0.0.1}"
NOVNC_LISTEN="${LOCAL_SEARCH_NOVNC_LISTEN:-127.0.0.1}"
```

### 4.2 收窄 x11vnc 监听地址

把当前：

```bash
x11vnc \
  -display "${DISPLAY_NUMBER}" \
  -forever \
  -shared \
  -nopw \
  -rfbport "${VNC_PORT}" \
  -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &
```

改为：

```bash
x11vnc \
  -display "${DISPLAY_NUMBER}" \
  -forever \
  -shared \
  -nopw \
  -rfbport "${VNC_PORT}" \
  -listen "${VNC_LISTEN}" >/tmp/x11vnc.log 2>&1 &
```

默认 `VNC_LISTEN=127.0.0.1`。这样即使容器网络中存在其他服务，也不能直接连接容器内 VNC 端口。

### 4.3 显式收窄 websockify 监听地址

把当前：

```bash
websockify --web=/usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
```

改为：

```bash
websockify --web=/usr/share/novnc/ "${NOVNC_LISTEN}:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
```

默认 `NOVNC_LISTEN=127.0.0.1`。Docker 端再把宿主机 `127.0.0.1:6082` 映射到容器 `6080`，形成双层收窄。

### 4.4 是否保留 `-nopw`

个人本机使用可以保留 `-nopw`，但必须同时满足：

1. `x11vnc` 监听 `127.0.0.1`；
2. `websockify` 监听 `127.0.0.1`；
3. Docker compose 将 noVNC 发布到宿主机 `127.0.0.1`；
4. 不发布 `5900`；
5. 不发布 `9224`。

如果后续要把 noVNC 通过局域网访问，应删除 `-nopw` 并改用密码文件。但按照当前个人使用边界，不建议开放 noVNC 到局域网。

---

## 5. Dockerfile 推荐补充

### 5.1 创建缓存目录

当前 Dockerfile 只创建 `/data/artifacts`。建议增加：

```dockerfile
RUN mkdir -p \
    /data/artifacts \
    /data/cache/papers/raw \
    /data/cache/papers/text \
    /data/cache/papers/sections \
    /data/cache/papers/chunks \
    /data/cache/papers/tmp \
    /data/cache/papers/locks
```

注意：由于 compose 使用 `./data:/data` 挂载，容器运行时 `/data` 会被宿主机目录覆盖。因此 Node 代码仍必须在启动或首次使用时执行 `ensureDir`，不能只依赖 Dockerfile 创建目录。

### 5.2 增加缓存环境变量默认值

建议把以下默认值写入 Dockerfile 的 `ENV`，再允许 compose 覆盖：

```dockerfile
ENV PAPER_CACHE_ENABLED=true \
    PAPER_CACHE_DIR=/data/cache/papers \
    PAPER_CACHE_MANIFEST=/data/cache/papers/manifest.sqlite \
    PAPER_CACHE_RAW_DIR=/data/cache/papers/raw \
    PAPER_CACHE_TEXT_DIR=/data/cache/papers/text \
    PAPER_CACHE_SECTION_DIR=/data/cache/papers/sections \
    PAPER_CACHE_CHUNK_DIR=/data/cache/papers/chunks \
    PAPER_CACHE_TMP_DIR=/data/cache/papers/tmp \
    PAPER_CACHE_MAX_BYTES=10737418240 \
    PAPER_CACHE_RAW_MAX_BYTES=4294967296 \
    PAPER_CACHE_RAW_TTL_DAYS=7 \
    PAPER_CACHE_TEXT_TTL_DAYS=90 \
    PAPER_CACHE_BUNDLE_TTL_DAYS=30 \
    PAPER_FETCH_MAX_BYTES=52428800 \
    PAPER_FETCH_MAX_FULLTEXT_PAPERS=5 \
    PAPER_FETCH_PRESERVE_RAW=false
```

### 5.3 PDF 解析依赖选择

正文解析有两条路线：

| 路线 | Docker 依赖 | 优点 | 缺点 | 推荐阶段 |
|---|---|---|---|---|
| JS 解析，例如 `pdf-parse` | npm 包 | 容器轻、接入快 | 结构化能力弱，表格/公式差 | P0 |
| `pdftotext` / Poppler | `apt install poppler-utils` | 文本抽取稳定 | 仍然不是结构化解析 | P1 |
| GROBID | 单独服务或外部容器 | TEI 结构化好，适合论文 | 部署较重 | P1/P2 |

第一阶段建议：

1. P0 先用 JS PDF 文本抽取，快速形成闭环；
2. P1 增加可选 `poppler-utils`；
3. P1/P2 增加可选 GROBID 服务，不默认启用。

如果决定引入 Poppler，Dockerfile 增加：

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox poppler-utils \
    && rm -rf /var/lib/apt/lists/*
```

---

## 6. 论文缓存与归档设计：结合当前 `/data` 挂载

### 6.1 当前 ArtifactStore 的限制

当前 `ArtifactStore` 只有：

```text
writeText(kind, text, metadata)
read(ref, offset, limit)
```

它的问题是：

1. 每次写入都用时间戳和随机值生成新文件，没有内容哈希去重；
2. 没有 manifest；
3. 没有 TTL；
4. 没有 quota；
5. 没有 LRU 清理；
6. 没有 raw/text/sections/chunks 的生命周期分层；
7. 不能管理 PDF、XML、TEI 这类二进制或半结构化文件。

因此，论文正文抓取不应直接复用 `ArtifactStore.writeText` 保存 raw PDF。正确方式是新增一个受管理的 `PaperCacheStore`，并让 `ArtifactStore` 继续只负责可读证据包和文本 artifact。

### 6.2 推荐目录结构

在当前 `./data:/data` 挂载基础上，推荐目录如下：

```text
/data
├── artifacts/
│   ├── search/
│   ├── pages/
│   ├── papers/
│   └── bundles/
│
├── browser-profile/
├── browser-state/
│
└── cache/
    └── papers/
        ├── manifest.sqlite
        ├── raw/
        │   ├── pdf/
        │   ├── html/
        │   ├── xml/
        │   └── tei/
        ├── text/
        ├── sections/
        ├── chunks/
        ├── tmp/
        └── locks/
```

### 6.3 生命周期分层

| 层级 | 内容 | 默认 TTL | 是否默认保留 | 说明 |
|---|---|---:|---:|---|
| raw PDF | 原始 PDF | 7 天 | 否 | 体积最大，只作为短期 cache |
| raw HTML/XML/TEI | 开放全文原始文件 | 14 天 | 可选 | XML/TEI 比 PDF 更有结构价值 |
| text | 抽取后的纯文本 | 90 天 | 是 | deep research 常用基础内容 |
| sections | 标题、摘要、方法、实验、结论等结构化章节 | 180 天 | 是 | 最有复用价值 |
| chunks | 面向 LLM 的分块 | 90 天 | 是 | 可重建，优先级低于 sections |
| evidence bundle | 某次研究任务证据包 | 30 天 | 是 | 与具体问题绑定 |
| manifest | 文件索引与状态 | 长期 | 是 | 缓存管理核心 |

### 6.4 Manifest 数据结构

建议使用 SQLite，而不是单个 JSON 文件。原因：

1. 文件数量增长后，JSON manifest 容易出现并发写损坏；
2. SQLite 支持事务；
3. 清理、统计、按 DOI/URL/hash 查询更方便；
4. 便于未来增加全文索引或 FTS。

推荐表：

```sql
CREATE TABLE paper_cache_items (
  id TEXT PRIMARY KEY,
  paper_key TEXT NOT NULL,
  identifier_type TEXT,
  identifier_value TEXT,
  variant TEXT NOT NULL,
  source TEXT,
  source_url TEXT,
  normalized_url TEXT,
  content_hash TEXT,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_access_at TEXT NOT NULL,
  expires_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  open_access_status TEXT,
  license TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  error_message TEXT
);

CREATE INDEX idx_paper_cache_key_variant ON paper_cache_items(paper_key, variant);
CREATE INDEX idx_paper_cache_hash ON paper_cache_items(content_hash);
CREATE INDEX idx_paper_cache_last_access ON paper_cache_items(last_access_at);
CREATE INDEX idx_paper_cache_expires ON paper_cache_items(expires_at);
```

`paper_key` 生成优先级：

```text
DOI > arXiv ID > Semantic Scholar ID > OpenAlex ID > sha1(normalized_title + year)
```

### 6.5 缓存命中顺序

`fetch_paper_content` 不应直接下载。推荐流程：

```text
输入 paper identifier
  ↓
resolve paper key
  ↓
查 sections cache
  ├─ 命中：返回 sections/chunks 摘要
  ↓ 未命中
查 text cache
  ├─ 命中：按需重新切 sections/chunks
  ↓ 未命中
查 raw cache
  ├─ 命中：解析 raw -> text -> sections -> chunks
  ↓ 未命中
locate open access candidates
  ↓
按 source policy 选择 PDF/XML/HTML/TEI
  ↓
下载到 tmp/*.part
  ↓
校验 mime / size / hash
  ↓
原子 rename 到 raw/
  ↓
写入 manifest
  ↓
解析正文
  ↓
写入 text / sections / chunks
  ↓
执行 quota cleanup
```

### 6.6 下载文件去重策略

必须同时做三种去重：

1. **Identifier 去重**：同 DOI/arXiv ID 不重复下载。
2. **URL 去重**：同 normalized URL 不重复下载。
3. **内容哈希去重**：即使来自不同源，只要 sha256 相同，只保留一份 raw 文件。

推荐文件命名：

```text
raw/pdf/sha256_<hash>.pdf
raw/html/sha256_<hash>.html
raw/xml/sha256_<hash>.xml
raw/tei/sha256_<hash>.tei.xml
text/<paper_key>.txt
sections/<paper_key>.json
chunks/<paper_key>.jsonl
```

### 6.7 清理策略

清理器应遵守以下规则：

1. `pinned=1` 的文件不清理；
2. 先清理 `tmp` 中超过 24 小时的残留文件；
3. 再清理过期 raw PDF；
4. 再按 LRU 清理 raw 文件，直到 `PAPER_CACHE_RAW_MAX_BYTES` 以下；
5. 再按 LRU 清理 chunks；
6. 最后才清理 text/sections；
7. evidence bundle 保留期由 `PAPER_CACHE_BUNDLE_TTL_DAYS` 控制；
8. 每次 `fetch_paper_content` 后可以触发轻量 cleanup；
9. 每次容器启动可以执行一次非阻塞 cleanup；
10. 提供手动工具 `cache_cleanup(dry_run=true)`。

---

## 7. 与当前代码结合的实施方案

### 7.1 新增配置项

修改 `src/config/index.js`，增加：

```js
paperCache: {
  enabled: (process.env.PAPER_CACHE_ENABLED || 'true') !== 'false',
  dir: process.env.PAPER_CACHE_DIR || '/data/cache/papers',
  manifest: process.env.PAPER_CACHE_MANIFEST || '/data/cache/papers/manifest.sqlite',
  rawDir: process.env.PAPER_CACHE_RAW_DIR || '/data/cache/papers/raw',
  textDir: process.env.PAPER_CACHE_TEXT_DIR || '/data/cache/papers/text',
  sectionDir: process.env.PAPER_CACHE_SECTION_DIR || '/data/cache/papers/sections',
  chunkDir: process.env.PAPER_CACHE_CHUNK_DIR || '/data/cache/papers/chunks',
  tmpDir: process.env.PAPER_CACHE_TMP_DIR || '/data/cache/papers/tmp',
  maxBytes: clampInt(process.env.PAPER_CACHE_MAX_BYTES, 10 * 1024 * 1024 * 1024, 100 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
  rawMaxBytes: clampInt(process.env.PAPER_CACHE_RAW_MAX_BYTES, 4 * 1024 * 1024 * 1024, 50 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
  rawTtlDays: clampInt(process.env.PAPER_CACHE_RAW_TTL_DAYS, 7, 1, 365),
  textTtlDays: clampInt(process.env.PAPER_CACHE_TEXT_TTL_DAYS, 90, 1, 3650),
  bundleTtlDays: clampInt(process.env.PAPER_CACHE_BUNDLE_TTL_DAYS, 30, 1, 3650),
  fetchMaxBytes: clampInt(process.env.PAPER_FETCH_MAX_BYTES, 50 * 1024 * 1024, 1024 * 1024, 500 * 1024 * 1024),
  maxFulltextPapers: clampInt(process.env.PAPER_FETCH_MAX_FULLTEXT_PAPERS, 5, 1, 50),
  preserveRaw: (process.env.PAPER_FETCH_PRESERVE_RAW || 'false') === 'true'
}
```

注意：当前 `clampInt` 用 `Number()` 解析环境变量，因此 compose 中建议写纯数字字节数，不建议写 `10GB` 这种字符串。

### 7.2 新增模块

推荐新增：

```text
src/papers/content/
├── paperContentKernel.js
├── paperContentLocator.js
├── documentFetcher.js
├── contentTypeDetector.js
├── sectionChunker.js
└── extractors/
    ├── pdfTextExtractor.js
    ├── htmlPaperExtractor.js
    ├── xmlPaperExtractor.js
    └── teiExtractor.js

src/papers/cache/
├── paperCacheStore.js
├── paperCacheManifest.js
├── paperCachePolicy.js
├── paperCacheCleanup.js
└── paperKey.js
```

### 7.3 设计模式对应

| 设计点 | 推荐模式 | 用途 |
|---|---|---|
| 不同来源定位开放正文 | Strategy | arXiv / Unpaywall / Semantic Scholar / CORE / Europe PMC 各自实现 locator |
| PDF/XML/HTML/TEI 解析 | Strategy + Adapter | 不同格式统一输出 `PaperTextDocument` |
| 多来源抓取顺序 | Chain of Responsibility | 按 source priority 逐一尝试，失败自动降级 |
| 缓存读写 | Repository | `PaperCacheStore` 隔离文件系统与 SQLite manifest |
| 配额与 TTL | Policy Object | `PaperCachePolicy` 统一判断是否过期、是否清理 |
| 对 MCP 暴露统一入口 | Facade | `PaperContentKernel` 封装 locate/fetch/sections/cache stats |
| 原子下载 | Unit of Work | tmp 写入、hash 校验、rename、manifest 事务一致提交 |

### 7.4 新增 MCP 工具

建议新增 5 个工具：

```text
locate_paper_content
fetch_paper_content
fetch_paper_batch
get_paper_sections
paper_cache_stats
paper_cache_cleanup
```

其中：

```text
locate_paper_content
```

只定位可抓取入口，不下载正文。

```text
fetch_paper_content
```

下载并解析单篇论文，默认优先使用缓存。

```text
fetch_paper_batch
```

批量抓取 top N 论文，但必须受 `PAPER_FETCH_MAX_FULLTEXT_PAPERS` 限制。

```text
get_paper_sections
```

读取已经解析好的章节，不重新下载。

```text
paper_cache_cleanup
```

执行清理，默认 `dry_run=true`。

### 7.5 REST 端点

当前已有：

```text
/papers/search
/papers/lookup
/papers/citations
/papers/open_access
/papers/research
/research/deep
```

建议新增：

```text
/papers/content/locate
/papers/content/fetch
/papers/content/batch
/papers/content/sections
/papers/cache/stats
/papers/cache/cleanup
```

### 7.6 DeepResearchKernel 接入

当前 `DeepResearchKernel` 在论文侧只做：

```text
searchPapers -> deduplicate -> rank -> citation expansion -> claim candidates from title/abstract
```

新增正文抓取后，建议增加参数：

```json
{
  "question": "...",
  "budget": {
    "max_papers": 50,
    "max_fulltext_papers": 5
  },
  "source_policy": {
    "fetch_fulltext": true,
    "open_access_only": true,
    "preserve_raw": false
  }
}
```

默认值必须是：

```text
fetch_fulltext=false
preserve_raw=false
max_fulltext_papers=5
```

这样不会影响当前 `research_deep` 的行为，也不会在用户没有明确要求时下载大量 PDF。

---

## 8. 论文抓取 source policy

### 8.1 抓取优先级

推荐优先级：

```text
1. arXiv PDF
2. Europe PMC XML / fulltext
3. Unpaywall best_oa_location PDF / HTML
4. Semantic Scholar openAccessPdf
5. OpenAlex primary_location / best_oa_location
6. CORE fulltext / PDF
7. Publisher landing page HTML
```

### 8.2 格式优先级

```text
TEI/XML > HTML fulltext > PDF text extraction > abstract only
```

原因：

1. TEI/XML 通常结构最好；
2. HTML fulltext 可保留章节层次；
3. PDF 最常见，但结构化解析成本最高；
4. 摘要只能作为 fallback，不能视为完整正文证据。

### 8.3 合规边界

抓取模块只应处理：

1. arXiv PDF；
2. Unpaywall 标记的开放访问位置；
3. CORE / Europe PMC / OpenAlex content API 等开放来源；
4. 论文作者或机构开放仓储页面；
5. 用户手动提供且其有权访问的 PDF URL。

不应实现：

1. 绕过付费墙；
2. 自动使用用户浏览器登录态批量下载出版商付费 PDF；
3. 规避 robots 或访问控制；
4. 使用 Sci-Hub 等侵权来源。

---

## 9. noVNC 与浏览器登录状态的安全边界

### 9.1 当前风险来源

noVNC 能看到可视化浏览器。如果浏览器中存在 Google、Bing、ChatGPT 或其他账户登录态，那么暴露 noVNC 就等于暴露一个可交互浏览器。因此它的风险明显高于 MCP API。

MCP API 的风险是“接口可被调用”；noVNC 的风险是“账户会话可被直接操作”。因此二者不能使用同一暴露策略。

### 9.2 推荐策略

```text
MCP：允许内网访问。
noVNC：仅宿主机本机访问。
CDP：仅容器内部访问。
VNC：仅容器内部访问。
```

### 9.3 配置验收

启动后执行：

```bash
docker compose up -d --build
```

本机验证 MCP：

```bash
curl http://localhost:8765/health
```

局域网验证 MCP：

```bash
curl http://<宿主机局域网IP>:8765/health
```

本机验证 noVNC：

```bash
curl -I http://localhost:6082/
```

局域网验证 noVNC 应失败：

```bash
curl -I http://<宿主机局域网IP>:6082/
```

容器内验证监听地址：

```bash
docker compose exec local-search-mcp bash -lc "ss -ltnp | grep -E ':(5900|6080|9224|8765)'"
```

期望结果：

```text
0.0.0.0:8765       # MCP，允许内网
127.0.0.1:5900     # x11vnc，仅容器内 loopback
127.0.0.1:6080     # websockify/noVNC，仅容器内 loopback
127.0.0.1:9224     # Chromium CDP，仅容器内 loopback
```

如果 `6080` 显示 `0.0.0.0:6080`，但 compose 已经把宿主机端口绑定到 `127.0.0.1`，宿主机局域网仍无法访问；但最佳状态仍然是容器内部也绑定 `127.0.0.1`。

---

## 10. 代理配置与 Docker 网络

### 10.1 当前代理配置判断

`proxy_profiles.json` 已经包含：

```json
"lan": {
  "type": "http",
  "server": "${LAN_PROXY_SERVER:-}",
  "no_proxy": [
    "localhost",
    "127.0.0.1",
    "host.docker.internal",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ]
}
```

这是合理的。它保证访问内网地址、宿主机地址和本地回环地址时不经过外部代理。

### 10.2 对论文抓取的建议

论文抓取建议默认使用 `direct` 或 `lan` 策略，但要注意：

1. DOI / Unpaywall / OpenAlex / Semantic Scholar / arXiv 通常应走普通互联网出口；
2. 本地 MCP、CDP、noVNC、host.docker.internal 不应经过代理；
3. 如果 `LAN_PROXY_SERVER` 为空，`lan` 应降级为 direct；
4. 抓 PDF 时要独立设置超时、最大文件大小和 content-type 校验，不能复用网页搜索的短文本抽取参数。

---

## 11. 实施顺序

### P0：立即修正部署边界

1. 修改 compose noVNC 绑定：

```yaml
- "127.0.0.1:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

2. 修改 MCP 绑定为显式内网可访问：

```yaml
- "0.0.0.0:${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
```

3. 修改 `docker/local-search/start.sh` 中 x11vnc 和 websockify 监听地址为 `127.0.0.1`。
4. 保持 CDP 不发布到宿主机。
5. 验证局域网只能访问 MCP，不能访问 noVNC。

### P1：缓存基础设施

1. 增加 `PAPER_CACHE_*` 环境变量；
2. 新增 `PaperCacheStore`；
3. 新增 SQLite manifest；
4. 新增目录初始化；
5. 新增 `paper_cache_stats` 和 `paper_cache_cleanup`；
6. 先不接入正文抓取，只验证缓存可写、可查、可清理。

### P2：正文抓取闭环

1. 新增 `PaperContentLocator`；
2. 新增 `DocumentFetcher`；
3. 新增 PDF/HTML/XML/TEI extractor；
4. 新增 `fetch_paper_content`；
5. 接入 `find_open_access` 结果；
6. 默认只抓取单篇论文，验证去重、TTL、quota。

### P3：接入 deep research

1. `research_deep` 增加 `fetch_fulltext` 开关；
2. 默认 false；
3. 开启后只抓 top N；
4. 用 sections/chunks 生成更可靠的 claim candidates；
5. evidence bundle 中记录正文来源、抓取时间、缓存命中状态和 OA 信息。

---

## 12. 最小 patch 摘要

### 12.1 docker-compose.yml

```diff
 ports:
-  - "${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
-  - "0.0.0.0:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
+  - "0.0.0.0:${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
+  - "127.0.0.1:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

### 12.2 start.sh

```diff
 VNC_PORT="${LOCAL_SEARCH_VNC_PORT:-5900}"
 NOVNC_PORT="${LOCAL_SEARCH_NOVNC_PORT:-6080}"
+VNC_LISTEN="${LOCAL_SEARCH_VNC_LISTEN:-127.0.0.1}"
+NOVNC_LISTEN="${LOCAL_SEARCH_NOVNC_LISTEN:-127.0.0.1}"
```

```diff
 x11vnc \
   -display "${DISPLAY_NUMBER}" \
   -forever \
   -shared \
   -nopw \
   -rfbport "${VNC_PORT}" \
-  -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &
+  -listen "${VNC_LISTEN}" >/tmp/x11vnc.log 2>&1 &
```

```diff
-websockify --web=/usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
+websockify --web=/usr/share/novnc/ "${NOVNC_LISTEN}:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
```

### 12.3 Dockerfile

```diff
-RUN mkdir -p /data/artifacts
+RUN mkdir -p \
+    /data/artifacts \
+    /data/cache/papers/raw \
+    /data/cache/papers/text \
+    /data/cache/papers/sections \
+    /data/cache/papers/chunks \
+    /data/cache/papers/tmp \
+    /data/cache/papers/locks
```

---

## 13. 验收标准

### 13.1 安全边界验收

| 测试项 | 命令 | 期望 |
|---|---|---|
| 本机访问 MCP | `curl http://localhost:8765/health` | 成功 |
| 局域网访问 MCP | `curl http://<host-ip>:8765/health` | 成功 |
| 本机访问 noVNC | `curl -I http://localhost:6082/` | 成功 |
| 局域网访问 noVNC | `curl -I http://<host-ip>:6082/` | 失败 |
| CDP 宿主机访问 | `curl http://localhost:9224/json/version` | 失败，除非显式映射 |
| 容器内 CDP | `curl http://127.0.0.1:9224/json/version` | 成功 |

### 13.2 缓存验收

| 测试项 | 期望 |
|---|---|
| 同一 DOI 抓取两次 | 第二次命中缓存，不重复下载 raw PDF |
| 同一 PDF 从两个 URL 抓取 | content hash 去重，只保留一份 raw 文件 |
| raw TTL 到期 | raw 被清理，text/sections 保留 |
| 超出 raw quota | 按 LRU 清理 raw 文件 |
| `preserve_raw=false` | 解析成功后 raw 可被优先清理 |
| `pinned=true` | 不被自动清理 |
| cleanup dry run | 只报告将清理文件，不删除 |
| 容器重启 | manifest 和已解析 sections 仍可读取 |

### 13.3 Deep Research 验收

| 测试项 | 期望 |
|---|---|
| `fetch_fulltext=false` | 行为与当前版本一致，只用标题/摘要/网页证据 |
| `fetch_fulltext=true` | 只抓 top N 论文 |
| `max_fulltext_papers=3` | 不超过 3 篇正文抓取 |
| 无 OA 全文 | 降级为 abstract only，并记录 failure |
| PDF 超过大小限制 | 跳过并记录 `FILE_TOO_LARGE` |
| 抓取失败 | 不影响其他论文检索和 web evidence |

---

## 14. 最终建议

当前 Docker 结构已经接近可用，但必须先修正 noVNC 暴露边界。建议立即执行以下最小变更：

```yaml
# docker-compose.yml
ports:
  - "0.0.0.0:${LOCAL_SEARCH_HTTP_HOST_PORT:-8765}:8765"
  - "127.0.0.1:${LOCAL_SEARCH_NOVNC_HOST_PORT:-6082}:6080"
```

并同步修正入口脚本：

```bash
x11vnc ... -listen 127.0.0.1
websockify --web=/usr/share/novnc/ "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}"
```

论文正文抓取部分不应直接写入现有 `ArtifactStore`。应新增 `PaperCacheStore + SQLite manifest + quota/TTL cleanup`，并把 raw PDF 视为短期 cache，把 text/sections/evidence bundle 视为较长期研究资产。

最稳妥的实施顺序是：

```text
先修 noVNC 端口边界
  ↓
再补 PaperCacheStore / manifest / cleanup
  ↓
再实现单篇论文正文抓取
  ↓
最后接入 research_deep(fetch_fulltext=true)
```

这样既不会破坏现有搜索 MCP，又能把 deep research 从“论文发现”推进到“论文正文证据读取”，同时避免 PDF 下载导致 `/data` 持续膨胀。
