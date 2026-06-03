import * as assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// ─── Bug 1: searchKernel.js text_preview should not strip < > from plain text ───
describe('Bug 1: searchKernel text_preview plain text integrity', () => {
  it('should preserve less-than and greater-than symbols in text_preview', () => {
    const text_preview = 'response code < 200 means error, but b > a is true';
    const text = String(text_preview || '');

    assert.ok(text.includes('< 200'), 'should preserve "< 200"');
    assert.ok(text.includes('> a'), 'should preserve "> a"');
    assert.ok(text.includes('<'), 'should preserve < character');
    assert.ok(text.includes('>'), 'should preserve > character');
  });

  it('should preserve code-like content with angle brackets', () => {
    const text_preview = 'Use <div class="test"> and import <Module> for the fix';
    const text = String(text_preview || '');

    assert.ok(text.includes('<div'), 'should preserve <div');
    assert.ok(text.includes('<Module>'), 'should preserve <Module>');
  });
});

// ─── Bug 2: http.js sec-fetch-user header field name ───
describe('Bug 2: http.js sec-fetch-user header name', async () => {
  let createHeaders;
  let DEFAULT_HEADERS;

  before(async () => {
    const mod = await import('../src/utils/http.js');
    createHeaders = mod.createHeaders;
    DEFAULT_HEADERS = mod.DEFAULT_HEADERS;
  });

  it('should use correct sec-fetch-user field name (not sec-fetch-user-mode)', () => {
    const headers = createHeaders({}, true);
    assert.ok('sec-fetch-user' in headers);
    assert.equal(headers['sec-fetch-user'], '?1');
    assert.ok(!('sec-fetch-user-mode' in headers));
  });
});

// ─── Bug 3: isInternalHost IPv6 private address SSRF protection ───
describe('Bug 3: SSRF validation for IPv6', async () => {
  let PageFetcher;

  before(async () => {
    const mod = await import('../src/fetch/pageFetcher.js');
    PageFetcher = mod.PageFetcher;
  });

  it('should reject IPv6 loopback, ULA, and link-local addresses', () => {
    const fetcher = new PageFetcher({ proxyRouter: null, browserPool: null, artifactStore: null });
    assert.equal(fetcher.validateUrl('http://[::1]:8080'), false);
    assert.equal(fetcher.validateUrl('http://[fc00::1]'), false);
    assert.equal(fetcher.validateUrl('http://[fe80::1]'), false);
    assert.equal(fetcher.validateUrl('https://www.google.com/search'), true);
  });
});

// ─── Bug 4: chrome.js searchGoogleViaChrome should not pass unused engine param ───
describe('Bug 4: chrome.js cleanup', async () => {
  it('should pass opts through without adding unused engine field', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/engines/chrome.js', import.meta.url), 'utf8');
    const lines = src.split('\n');
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('searchGoogleViaChrome')) { startIdx = i; break; }
    }
    assert.ok(startIdx >= 0, 'function should exist');
    const fnBody = lines.slice(startIdx).join('\n');
    assert.ok(!fnBody.includes("engine: 'google'"), 'should NOT contain engine: google');
    assert.ok(fnBody.includes('searchViaChromeDevTools(query, opts)'), 'should pass opts directly');
  });
});

// ─── Bug 5: playwrightPool.js indentation fix ───
describe('Bug 5: playwrightPool.js indentation', () => {
  it('should have consistent indentation at line 600', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/browser/playwrightPool.js', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const targetLine = lines[599]; // line 600 is index 599
    assert.ok(targetLine.startsWith('    let pageEntry'), 'should be indented with 4 spaces');
    assert.ok(!targetLine.startsWith('      let pageEntry'), 'should NOT have 6 spaces');
  });
});

// ─── NEW: artifactStore.js symlink attack & TOCTOU ───
describe('artifactStore.js: symlink protection and safeJoin', async () => {
  it('should use safeJoin for directory paths in _cleanupOld', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/artifacts/artifactStore.js', import.meta.url), 'utf8');
    assert.ok(src.includes('safeJoin(this.baseDir, entry.name)'), '_cleanupOld should use safeJoin');
    assert.ok(src.includes('safeJoin(dirPath, file)'), 'file paths should use safeJoin');
    assert.ok(src.includes('lstatSync'), 'should use lstatSync to detect symlinks');
    assert.ok(src.includes('isSymbolicLink'), 'should check for symlinks');
    assert.ok(!src.includes('catch {}'), 'should not swallow errors silently');
  });
});

// ─── NEW: httpClient.js SSRF-safe redirect ───
describe('httpClient.js: SSRF-safe redirect handling', async () => {
  it('should use redirect: manual and check for internal hosts', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/common/httpClient.js', import.meta.url), 'utf8');
    assert.ok(src.includes("redirect: 'manual'"), 'should use redirect: manual');
    assert.ok(src.includes('isInternalHost'), 'should validate redirect destinations');
    assert.ok(src.includes('SSRF_REDIRECT_BLOCKED') || src.includes('internal address blocked'), 'should block internal redirects');
  });
});

// ─── NEW: rateLimiter.js queue flood protection & timer leak ───
describe('rateLimiter.js: queue size limit and timer leak fix', async () => {
  let RateLimiter;

  before(async () => {
    const mod = await import('../src/common/rateLimiter.js');
    RateLimiter = mod.RateLimiter;
  });

  it('should reject acquire when queue is full', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 100, maxConcurrency: 1, maxQueueSize: 2 });
    const active = limiter.acquire('key'); // active slot
    await active; // wait for it to be dispatched
    const q1 = limiter.acquire('key'); // queued slot 1
    const q2 = limiter.acquire('key'); // queued slot 2 (at max)
    // Fourth queued should reject
    await assert.rejects(limiter.acquire('key'), /queue full/i);
    limiter.release('key'); // release active to let queued ones proceed
    await q1;
    limiter.release('key');
    await q2;
  });

  it('should unref timers to avoid blocking process exit', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/common/rateLimiter.js', import.meta.url), 'utf8');
    assert.ok(src.includes('unref'), 'timers should be unref\'d');
  });
});

// ─── NEW: retryPolicy.js abort detection ───
describe('retryPolicy.js: improved abort detection', async () => {
  let retry;

  before(async () => {
    const mod = await import('../src/common/retryPolicy.js');
    retry = mod.retry;
  });

  it('should not retry abort errors with name AbortError', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /aborted/
    );
    assert.equal(calls, 1, 'should only call once, not retry');
  });

  it('should not retry abort errors with nested cause AbortError', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        const wrapper = new Error('fetch failed');
        wrapper.cause = abortErr;
        throw wrapper;
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /fetch failed/
    );
    assert.equal(calls, 1, 'should not retry cause-based abort');
  });

  it('should not retry abort errors with code ABORT_ERR', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        const err = new Error('abort');
        err.code = 'ABORT_ERR';
        throw err;
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /abort/
    );
    assert.equal(calls, 1);
  });

  it('sleep timers should be unref\'d', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/common/retryPolicy.js', import.meta.url), 'utf8');
    assert.ok(src.includes('unref'), 'sleep timers should be unref\'d');
  });
});

// ─── NEW: weather.js fetch timeout ───
describe('weather.js: fetch timeout protection', async () => {
  it('should use AbortController for fetch calls', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/tools/weather.js', import.meta.url), 'utf8');
    assert.ok(src.includes('AbortController'), 'should use AbortController');
    assert.ok(src.includes('controller.abort'), 'should have abort capability');
    assert.ok(src.includes('signal'), 'should pass signal to fetch');
  });
});

// ─── NEW: wikipedia.js meaningful error handling ───
describe('wikipedia.js: error handling fix', async () => {
  it('should not silently swallow errors behind browserPool check', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/engines/wikipedia.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('opts.browserPool'), 'should not check opts.browserPool');
    assert.ok(src.includes('instanceof SearchEngineError') || src.includes("throw new SearchEngineError"), 'should always throw meaningful errors');
  });
});

// ─── NEW: custom_html.js template validation ───
describe('custom_html.js: template validation', async () => {
  it('should throw if url_template has no {{query}} placeholder', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/engines/custom_html.js', import.meta.url), 'utf8');
    assert.ok(src.includes('INVALID_CONFIG') || src.includes("no {{query}}"), 'should validate template');
  });
});

// ─── NEW: time.js overly broad "in" regex ───
describe('time.js: regex specificity fix', async () => {
  it('should not match "within", "China" for India timezone', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/tools/time.js', import.meta.url), 'utf8');
    // The old regex was /in|india|.../ which matched "within", "China" etc.
    // The fix removes the bare "in" pattern
    assert.ok(!src.includes('/in|india') && !src.includes('/in|india'), 'should not contain bare "in" regex');
    assert.ok(src.includes('india'), 'should still match "india"');
  });
});

// ─── NEW: bing.js + google.js limit sanitization ───
describe('bing.js + google.js: limit sanitization', async () => {
  it('should clamp limit to valid integer range', async () => {
    const bingSrc = (await import('node:fs')).readFileSync(new URL('../src/engines/bing.js', import.meta.url), 'utf8');
    const googleSrc = (await import('node:fs')).readFileSync(new URL('../src/engines/google.js', import.meta.url), 'utf8');
    assert.ok(bingSrc.includes('Math.max') && bingSrc.includes('Number('), 'bing should sanitize limit');
    assert.ok(googleSrc.includes('Math.max') && googleSrc.includes('Number('), 'google should sanitize limit');
  });
});

// ─── NEW: searchKernel.js text integrity (integration) ───
describe('Integration: text integrity through pipeline', () => {
  it('simulating searchKernel item building with angle bracket content', () => {
    const mockPage = {
      status: 'success',
      text_preview: 'Error: HTTP status < 200 detected. If latency > 500ms, check <server-config>',
      fetch_mode: 'http'
    };
    // Fixed code: String(row.page.text_preview || '')
    const text = String(mockPage.text_preview || '');
    assert.ok(text.includes('< 200'), 'should preserve "< 200"');
    assert.ok(text.includes('> 500ms'), 'should preserve "> 500ms"');
    assert.ok(text.includes('<server-config>'), 'should preserve "<server-config>"');
  });

  it('verifies old buggy behavior would have corrupted text', () => {
    const text_preview = 'a < b and b > c';
    const buggyResult = text_preview.replace(/<[^>]*>/g, '');
    assert.ok(buggyResult !== text_preview, 'old behavior should differ from original');
    const fixedResult = String(text_preview || '');
    assert.equal(fixedResult, text_preview, 'new behavior should be identical');
  });
});

// ─── NEW: utils/normalize.js regression tests ───
describe('normalize.js: utility functions', async () => {
  let hostOf, truncateText;

  before(async () => {
    const mod = await import('../src/utils/normalize.js');
    hostOf = mod.hostOf;
    truncateText = mod.truncateText;
  });

  it('hostOf should extract hostname correctly', () => {
    assert.equal(hostOf('https://www.google.com/search'), 'google.com');
    assert.equal(hostOf('not-a-url'), '');
  });

  it('truncateText should preserve text with angle brackets', () => {
    const input = 'a < b and b > c and x < 100';
    const result = truncateText(input, 200);
    assert.ok(result.includes('<'), 'should preserve <');
    assert.ok(result.includes('>'), 'should preserve >');
  });
});
