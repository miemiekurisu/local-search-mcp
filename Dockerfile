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
    TAVILY_API_KEY=

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
COPY docker/local-search/start.sh /usr/local/bin/start-local-search.sh
RUN chmod +x /usr/local/bin/start-local-search.sh
RUN mkdir -p /data/artifacts

EXPOSE 8765 6080
CMD ["/usr/local/bin/start-local-search.sh"]
