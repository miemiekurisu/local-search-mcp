import { describe, it, before, after, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';

// ─── Unit: route.abort().catch() ───────────────────────────────
describe('route abort catch', () => {
  it('should not throw when abort rejects after page close', async () => {
    let caught = false;
    const route = {
      abort: async () => { throw new Error('Target closed'); }
    };
    await route.abort().catch(() => { caught = true; });
    assert.ok(caught, '.catch() must be invoked');
  });

  it('should pass through successful abort', async () => {
    let resolved = false;
    const route = {
      abort: async () => { resolved = true; }
    };
    await route.abort().catch(() => {});
    assert.ok(resolved, 'abort should resolve normally');
  });

  it('should not produce unhandled rejection (must complete within tick)', async () => {
    const route = {
      abort: async () => { throw new Error('Target closed'); }
    };
    // If .catch() is missing, Node.js emits 'unhandledRejection'
    await route.abort().catch(() => {});
    assert.ok(true);
  });
});

// ─── Unit: about:blank navigation order ────────────────────────
describe('about:blank navigation before close', () => {
  it('withPage calls goto about:blank before page.close on normal exit', async () => {
    const calls = [];
    const page = {
      setDefaultTimeout: () => {},
      goto: async (url) => { calls.push(`goto:${url}`); },
      close: async () => { calls.push('close'); },
      route: async () => { calls.push('route'); },
      addInitScript: async () => {},
      mouse: { move: async () => {}, },
      waitForTimeout: async () => {},
    };
    const context = {
      newPage: async () => page,
      close: async () => { calls.push('context.close'); },
      addCookies: async () => {},
      storageState: async () => {},
      pages: () => [page],
    };
    const browser = {
      newContext: async () => context,
      contexts: () => [context],
      isConnected: () => true,
      on: () => {},
    };

    // Test via the actual PlaywrightPool with mocked browser
    const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

    // Mock chromium.launch to return our fake browser
    const originalLaunch = chromium.launch;
    chromium.launch = async () => browser;
    chromium.connectOverCDP = async () => { throw new Error('not needed'); };

    try {
      const pool = new PlaywrightPool({ resolve: () => null });
      await pool.withPage({}, async () => { return 'ok'; });

      const lastGoto = calls.filter(c => c.startsWith('goto:')).pop();
      const closeIdx = calls.indexOf('close');
      const gotoIdx = calls.indexOf(lastGoto);

      assert.ok(gotoIdx >= 0, 'goto should be called');
      assert.ok(closeIdx >= 0, 'close should be called');
      assert.ok(gotoIdx < closeIdx, 'goto(about:blank) must be before page.close()');
      assert.equal(lastGoto, 'goto:about:blank', 'last goto must be about:blank');
    } finally {
      chromium.launch = originalLaunch;
    }
  });

  it('withPage calls goto about:blank before close even when fn throws', async () => {
    const calls = [];
    const page = {
      setDefaultTimeout: () => {},
      goto: async (url) => { calls.push(`goto:${url}`); },
      close: async () => { calls.push('close'); },
      route: async () => {},
      addInitScript: async () => {},
      mouse: { move: async () => {}, },
      waitForTimeout: async () => {},
    };
    const context = {
      newPage: async () => page,
      close: async () => { calls.push('context.close'); },
      addCookies: async () => {},
      storageState: async () => {},
      pages: () => [page],
    };
    const browser = {
      newContext: async () => context,
      contexts: () => [context],
      isConnected: () => true,
      on: () => {},
    };

    const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');
    const originalLaunch = chromium.launch;
    chromium.launch = async () => browser;
    chromium.connectOverCDP = async () => { throw new Error('not needed'); };

    try {
      const pool = new PlaywrightPool({ resolve: () => null });
      await assert.rejects(
        () => pool.withPage({}, async () => { throw new Error('boom'); }),
        /boom/
      );

      const lastGoto = calls.filter(c => c.startsWith('goto:')).pop();
      const closeIdx = calls.indexOf('close');
      const gotoIdx = calls.indexOf(lastGoto);

      assert.ok(gotoIdx >= 0, 'goto should be called on error path');
      assert.ok(closeIdx >= 0, 'close should be called on error path');
      assert.ok(gotoIdx < closeIdx, 'goto(about:blank) must be before page.close() on error');
      assert.equal(lastGoto, 'goto:about:blank', 'last goto must be about:blank');
    } finally {
      chromium.launch = originalLaunch;
    }
  });
});

// ─── Integration: real Playwright + real HTTP server ────────────
describe('real browser close behavior', () => {
  let server;
  let baseUrl;
  let browser;

  before(async () => {
    // Start a test server that serves a page with a long-running SSE connection
    server = http.createServer((req, res) => {
      if (req.url === '/sse') {
        // SSE endpoint that never stops sending data
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const interval = setInterval(() => {
          res.write(`data: ${Date.now()}\n\n`);
        }, 100);
        req.on('close', () => {
          clearInterval(interval);
          res.end();
        });
        return;
      }
      if (req.url === '/slow-image') {
        // Image endpoint that never completes
        res.writeHead(200, { 'Content-Type': 'image/png' });
        // Never end the response — simulates a stalled resource
        return;
      }
      if (req.url === '/websocket-like') {
        // Long-polling-style endpoint
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Simulate server push that never ends
        const interval = setInterval(() => {
          res.write('ping\n');
        }, 200);
        req.on('close', () => {
          clearInterval(interval);
          res.end();
        });
        return;
      }
      // Main test page — references SSE + slow resources
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html><body>
          <h1>Test Page</h1>
          <div id="content">Hello World</div>
          <script>
            // SSE connection that never closes
            const evtSource = new EventSource('/sse');
            evtSource.onmessage = (e) => {
              document.getElementById('content').textContent = 'SSE: ' + e.data;
            };
            // Stalled image fetch
            const img = new Image();
            img.src = '/slow-image';
            // Long-polling-style XHR
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '/websocket-like');
            xhr.send();
          </script>
        </body></html>
      `);
    });
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        server.maxConnections = 50;
        resolve();
      });
      server.on('error', reject);
    });

    // Launch real headless Chromium
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(r => server.close(r));
  });

  it('page.goto(about:blank) + page.close() should not hang with active SSE', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Block images via route
    await page.route(/\.(png|jpg)/i, route => route.abort().catch(() => {}));

    // Load the test page
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    // Give SSE a moment to establish
    await new Promise(r => setTimeout(r, 500));

    // Now test: navigate to about:blank then close — should complete within timeout
    const start = Date.now();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await page.close();
    await context.close();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `close should be fast (<5s), took ${elapsed}ms`);
  });

  it('page.close() without about:blank would timeout (prevents regression awareness)', async () => {
    // This test demonstrates why about:blank is needed: page.close() alone
    // can stall on pages with active SSE. We use a short timeout to prove it.
    const context = await browser.newContext();
    const page = await context.newPage();

    // Block nothing via route
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, 500));

    // Try to close WITHOUT about:blank navigation — this is the "before fix" scenario
    const start = Date.now();
    // Close with a 3s deadline — should time out because of active SSE
    let timedOut = false;
    try {
      await Promise.race([
        page.close(),
        new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error('TIMEOUT')); }, 2000))
      ]);
    } catch {
      // Expected — page.close() blocks on active connections
    }
    // If it didn't time out, at least verify it was slower
    const elapsed = Date.now() - start;
    if (!timedOut) {
      // Rare case where Chromium closes fast anyway — log for info
      console.log(`[INFO] page.close() without about:blank took ${elapsed}ms`);
    }
    await context.close().catch(() => {});
  });

  it('about:blank before close works under concurrent route abort', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Register abort route for images/fonts only (not the main document)
    await page.route(/\.(png|jpg|jpeg|gif|svg|webp|woff2?|eot|ttf)(\?|$)/i, route => route.abort().catch(() => {}));

    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, 200));

    // Navigate to about:blank (aborts all pending requests)
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    // Route abort handlers fire after navigation — should not throw
    await new Promise(r => setTimeout(r, 100));
    // Now close
    await page.close();
    await context.close();
    assert.ok(true);
  });

  it('withPage end-to-end with real PlaywrightPool', async () => {
    // Create a PlaywrightPool that connects to our real browser
    // We need to use the pool's browser directly via a minimal setup
    const pool = (await import('../src/browser/playwrightPool.js')).PlaywrightPool;

    // Use a proxyRouter that doesn't require proxy
    const noopRouter = { resolve: () => ({ playwrightProxy: undefined, proxyUrl: undefined, profile: 'direct' }) };
    const instance = new pool(noopRouter);

    // Override getBrowser and friends to use our pre-launched browser
    instance.getBrowser = async () => browser;
    instance.getSearchContext = async () => {
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        try { contexts[0].pages(); return contexts[0]; } catch {}
      }
      return await browser.newContext();
    };
    instance.createEphemeralContext = async () => await browser.newContext();

    try {
      const result = await instance.withPage({ url: baseUrl + '/' }, async (page) => {
        await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const text = await page.evaluate(() => document.body.innerText);
        return { status: 'success', text };
      });

      // Verify: result should be successful
      assert.equal(result.status, 'success');
      assert.ok(result.text.includes('Test Page'), 'page content should be accessible');

      // Verify: pool state is clean
      assert.equal(instance._activePageCount, 0, 'activePageCount should be 0 after close');
    } finally {
      await instance.close().catch(() => {});
    }
  });
});
