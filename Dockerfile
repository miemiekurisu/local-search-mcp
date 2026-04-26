FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
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
    BRAVE_API_KEY= \
    TAVILY_API_KEY=

RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
    && PW_VERSION="$(node -p \"try { require('playwright/package.json').version } catch(e) { require('playwright-core/package.json').version }\")" \
    && echo "Installing Playwright Chromium for version ${PW_VERSION}" \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright@${PW_VERSION} install chromium \
    && chmod -R 755 /ms-playwright

COPY src ./src
COPY config ./config
COPY scripts ./scripts
COPY docker/local-search/start.sh /usr/local/bin/start-local-search.sh
RUN chmod +x /usr/local/bin/start-local-search.sh
RUN mkdir -p /data/artifacts

EXPOSE 8765 6080
CMD ["/usr/local/bin/start-local-search.sh"]
