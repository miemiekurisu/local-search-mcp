FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
ARG PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
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
    TAVILY_API_KEY= \
    PAPER_CACHE_ENABLED=true \
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

RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
    && PW_VERSION=$(node -e "try { console.log(require('playwright/package.json').version) } catch (e) { console.log(require('playwright-core/package.json').version) }") \
    && echo "Installing Playwright Chromium for version ${PW_VERSION}" \
    && PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" npx --yes "playwright@${PW_VERSION}" install chromium \
    && chmod -R 755 "${PLAYWRIGHT_BROWSERS_PATH}"

RUN set -eux; \
    for d in "${PLAYWRIGHT_BROWSERS_PATH}"/chromium-*; do \
      [ -d "$d" ] || continue; \
      if [ -d "$d/chrome-linux64" ] && [ ! -e "$d/chrome-linux" ]; then \
        ln -s chrome-linux64 "$d/chrome-linux"; \
      fi; \
    done; \
    find "${PLAYWRIGHT_BROWSERS_PATH}" -maxdepth 4 -type f -path '*/chrome-linux64/chrome' -print; \
    find "${PLAYWRIGHT_BROWSERS_PATH}" -maxdepth 4 -type l -path '*/chrome-linux' -print

COPY src ./src
COPY config ./config
COPY scripts ./scripts
COPY extensions/ublock-origin.zip /app/extensions/ublock-origin.zip
RUN mkdir -p /app/extensions/ublock-origin && python3 -c "import zipfile; z=zipfile.ZipFile('/app/extensions/ublock-origin.zip'); z.extractall('/app/extensions/ublock-origin/'); z.close()" && rm -f /app/extensions/ublock-origin.zip
COPY docker/local-search/start.sh /usr/local/bin/start-local-search.sh
RUN chmod +x /usr/local/bin/start-local-search.sh
RUN mkdir -p \
    /data/artifacts \
    /data/cache/papers/raw \
    /data/cache/papers/text \
    /data/cache/papers/sections \
    /data/cache/papers/chunks \
    /data/cache/papers/tmp \
    /data/cache/papers/locks

EXPOSE 8765 6080
CMD ["/usr/local/bin/start-local-search.sh"]
