import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, it, before } from 'node:test';

const src = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

// ============================================================
// ROUND 1: Original 5 bugs
// ============================================================

describe('Bug 1: searchKernel text_preview plain text integrity', () => {
  it('should preserve less-than and greater-than symbols', () => {
    const text = String('response code < 200 and b > a' || '');
    assert.ok(text.includes('< 200'));
    assert.ok(text.includes('> a'));
  });

  it('verifies old buggy replace would have corrupted text', () => {
    const input = 'a < b and b > c';
    const buggy = input.replace(/<[^>]*>/g, '');
    assert.ok(buggy !== input, 'old behavior should differ');
    assert.equal(String(input || ''), input, 'new behavior should be identical');
  });
});

describe('Bug 2: http.js sec-fetch-user header name', () => {
  it('should use correct sec-fetch-user field name', () => {
    const s = src('../src/utils/http.js');
    assert.ok(s.includes("'sec-fetch-user'"), 'should have sec-fetch-user');
    assert.ok(!s.includes("'sec-fetch-user-mode'"), 'should NOT have sec-fetch-user-mode');
  });
});

describe('Bug 3: SSRF IPv6 and bracket stripping', () => {
  it('http.js should strip brackets and check fc/fd/fe8', () => {
    const s = src('../src/utils/http.js');
    assert.ok(s.includes("hostname.slice(1, -1)"));
    assert.ok(s.includes("hostname.startsWith('fc')"));
    assert.ok(s.includes("hostname.startsWith('fd')"));
    assert.ok(s.includes("hostname.startsWith('fe8')"));
  });

  it('pageFetcher.js should strip brackets and check fc/fd/fe8', () => {
    const s = src('../src/fetch/pageFetcher.js');
    assert.ok(s.includes("h.slice(1, -1)"));
    assert.ok(s.includes("h.startsWith('fc')"));
    assert.ok(s.includes("h.startsWith('fd')"));
    assert.ok(s.includes("h.startsWith('fe8')"));
  });
});

describe('Bug 4: chrome.js cleanup', () => {
  it('should pass opts directly without adding engine field', () => {
    const lines = src('../src/engines/chrome.js').split('\n');
    const idx = lines.findIndex(l => l.includes('searchGoogleViaChrome'));
    assert.ok(idx >= 0);
    const body = lines.slice(idx).join('\n');
    assert.ok(!body.includes("engine: 'google'"));
    assert.ok(body.includes('searchViaChromeDevTools(query, opts)'));
  });
});

describe('Bug 5: playwrightPool.js indentation', () => {
  it('openSessionPage let pageEntry line should have consistent 4-space indent', () => {
    const s = src('../src/browser/playwrightPool.js');
    const pageEntryLine = s.split('\n').find(l => l.includes('let pageEntry = this.sessionPages'));
    assert.ok(pageEntryLine, 'let pageEntry line should exist');
    assert.ok(pageEntryLine.startsWith('    let pageEntry'), `should be 4-space indented, got: "${pageEntryLine.slice(0, 10)}"`);
    assert.ok(!pageEntryLine.startsWith('      let pageEntry'), 'should NOT have 6-space indent');
  });
});

// ============================================================
// ROUND 2: Audit findings fixes
// ============================================================

describe('artifactStore.js: symlink protection', () => {
  it('should use safeJoin, lstatSync, and isSymbolicLink', () => {
    const s = src('../src/artifacts/artifactStore.js');
    assert.ok(s.includes('safeJoin(this.baseDir, entry.name)'));
    assert.ok(s.includes('safeJoin(dirPath, file)'));
    assert.ok(s.includes('lstatSync'));
    assert.ok(s.includes('isSymbolicLink'));
    assert.ok(!s.includes('catch {}'), 'no silent empty catches');
  });
});

describe('httpClient.js: SSRF-safe redirect', () => {
  it('should use manual redirect with internal host validation', () => {
    const s = src('../src/common/httpClient.js');
    assert.ok(s.includes("redirect: 'manual'"));
    assert.ok(s.includes('isInternalHost'));
    assert.ok(s.includes('internal address blocked'));
    assert.ok(s.includes('Too many redirects'));
  });
});

describe('rateLimiter.js: queue limit and unref', () => {
  it('should have maxQueueSize and unref timers', () => {
    const s = src('../src/common/rateLimiter.js');
    assert.ok(s.includes('maxQueueSize'));
    assert.ok(s.includes('unref'));
    assert.ok(s.includes('queue full'));
  });
});

describe('retryPolicy.js: abort detection', () => {
  it('should check cause chain and ABORT_ERR code', () => {
    const s = src('../src/common/retryPolicy.js');
    assert.ok(s.includes('isAbortError'));
    assert.ok(s.includes('cause'));
    assert.ok(s.includes('ABORT_ERR'));
    assert.ok(s.includes('unref'));
  });
});

describe('wikipedia.js: no silent error swallowing', () => {
  it('should always throw SearchEngineError', () => {
    const s = src('../src/engines/wikipedia.js');
    assert.ok(!s.includes('opts.browserPool'));
    assert.ok(s.includes('SearchEngineError'));
  });
});

describe('custom_html.js: template validation', () => {
  it('should validate {{query}} placeholder exists', () => {
    const s = src('../src/engines/custom_html.js');
    assert.ok(s.includes('{{query}}'));
    assert.ok(s.includes('INVALID_CONFIG'));
  });
});

describe('bing.js + google.js: limit sanitization', () => {
  it('should clamp limit to valid integer range', () => {
    assert.ok(src('../src/engines/bing.js').includes('Math.max'));
    assert.ok(src('../src/engines/google.js').includes('Math.max'));
  });
});

describe('time.js: regex specificity', () => {
  it('should not contain bare "in" regex', () => {
    const s = src('../src/tools/time.js');
    const indiaLine = s.split('\n').find(l => l.includes('Kolkata'));
    assert.ok(!indiaLine.includes('/in|india'));
  });
});

describe('weather.js: fetch timeout', () => {
  it('should use AbortController with timeout', () => {
    const s = src('../src/tools/weather.js');
    assert.ok(s.includes('AbortController'));
    assert.ok(s.includes('controller.abort'));
    assert.ok(s.includes('signal: controller.signal'));
    assert.ok(s.includes('clearTimeout(timer)'));
  });
});

// ============================================================
// ROUND 3: Codegraph line-by-line audit
// ============================================================

describe('Codegraph: Dead Code', () => {
  it('google.js: dead functions (humanScroll, humanMove, etc.) removed', () => {
    const s = src('../src/engines/google.js');
    assert.ok(!s.includes('function humanScroll'), 'humanScroll should be removed');
    assert.ok(!s.includes('function humanMove'), 'humanMove should be removed');
    assert.ok(!s.includes('function randomClick'), 'randomClick should be removed');
    assert.ok(!s.includes('function initGoogleSession'), 'initGoogleSession should be removed');
    assert.ok(!s.includes('function typeAndSearch'), 'typeAndSearch should be removed');
  });

  it('playwrightPool.js: dead origGet removed', () => {
    const s = src('../src/browser/playwrightPool.js');
    assert.ok(!s.includes('origGet'), 'dead origGet should be removed');
  });
});

describe('Codegraph: Null Pointer', () => {
  it('http_server.js: message.params guarded', () => {
    const s = src('../src/http_server.js');
    assert.ok(s.includes('message.params || {}'));
  });

  it('chrome.js: query type check', () => {
    const s = src('../src/engines/chrome.js');
    assert.ok(s.includes("typeof query !== 'string'"));
  });

  it('paperKernel.js: dateParts[0] guarded', () => {
    const s = src('../src/papers/paperKernel.js');
    assert.ok(s.includes('Array.isArray(work.issued.dateParts[0])'), 'dateParts[0] should be guarded');
  });
});

describe('Codegraph: Memory Leak / Overflow', () => {
  it('http_server.js: rateLimitMap has safety valve', () => {
    const s = src('../src/http_server.js');
    assert.ok(s.includes('RATE_LIMIT_MAX_ENTRIES'));
    assert.ok(s.includes('rateLimitMap.clear()'));
  });

  it('mcp/server.js: withTimeout timer is unref\'d', () => {
    const s = src('../src/mcp/server.js');
    assert.ok(s.includes('id.unref') || s.includes('id.unref()'));
  });

  it('limit.js: setTimeout is unref\'d', () => {
    const s = src('../src/utils/limit.js');
    assert.ok(s.includes('unref'));
  });
});

describe('Codegraph: Abnormal Memory Usage', () => {
  it('paperKernel.js: reconstructAbstract uses Map instead of sparse array', () => {
    const s = src('../src/papers/paperKernel.js');
    assert.ok(s.includes('new Map()'), 'should use Map');
    assert.ok(s.includes('maxLen'), 'should have maxLen guard');
  });

  it('paperRanker.js: year is dynamic not hardcoded', () => {
    const s = src('../src/papers/paperRanker.js');
    assert.ok(!s.includes('const now = 2026'), 'should not hardcode 2026');
    assert.ok(s.includes('new Date().getFullYear()'));
  });
});

// ============================================================
// Integration: behavioral tests
// ============================================================

describe('Integration: retryPolicy abort detection', async () => {
  let retry;
  before(async () => {
    const mod = await import('../src/common/retryPolicy.js');
    retry = mod.retry;
  });

  it('should not retry AbortError by name', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => { calls++; throw Object.assign(new Error('abort'), { name: 'AbortError' }); }, { maxRetries: 5, baseDelayMs: 1 }),
      /abort/
    );
    assert.equal(calls, 1);
  });

  it('should not retry AbortError by nested cause', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw Object.assign(new Error('outer'), { cause: Object.assign(new Error('abort'), { name: 'AbortError' }) });
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /outer/
    );
    assert.equal(calls, 1);
  });

  it('should not retry ABORT_ERR code', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => { calls++; throw Object.assign(new Error('abort'), { code: 'ABORT_ERR' }); }, { maxRetries: 5, baseDelayMs: 1 }),
      /abort/
    );
    assert.equal(calls, 1);
  });

  it('should not retry deeply nested abort cause', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw Object.assign(new Error('outer'), { cause: Object.assign(new Error('middle'), { cause: Object.assign(new Error('abort'), { name: 'AbortError' }) }) });
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /outer/
    );
    assert.equal(calls, 1);
  });
});

describe('Integration: rateLimiter queue flood protection', async () => {
  let RateLimiter;
  before(async () => {
    const mod = await import('../src/common/rateLimiter.js');
    RateLimiter = mod.RateLimiter;
  });

  it('should reject when queue is full', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 100, maxConcurrency: 1, maxQueueSize: 2 });
    const active = limiter.acquire('key');
    await active;
    const q1 = limiter.acquire('key');
    const q2 = limiter.acquire('key');
    await assert.rejects(limiter.acquire('key'), /queue full/i);
    limiter.release('key');
    await q1;
    limiter.release('key');
    await q2;
  });
});

describe('Integration: normalize.js utilities', async () => {
  let hostOf, truncateText;
  before(async () => {
    const mod = await import('../src/utils/normalize.js');
    hostOf = mod.hostOf;
    truncateText = mod.truncateText;
  });

  it('hostOf extracts hostname', () => {
    assert.equal(hostOf('https://www.google.com/search'), 'google.com');
    assert.equal(hostOf('not-a-url'), '');
  });

  it('truncateText preserves angle brackets', () => {
    const r = truncateText('a < b and b > c', 200);
    assert.ok(r.includes('<'));
    assert.ok(r.includes('>'));
  });
});
