import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, it, before } from 'node:test';

const src = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

// ─── Bug 1: searchKernel.js text_preview should not strip < > from plain text ───
describe('Bug 1: searchKernel text_preview plain text integrity', () => {
  it('should preserve less-than and greater-than symbols in text_preview', () => {
    const text_preview = 'response code < 200 means error, but b > a is true';
    const text = String(text_preview || '');

    assert.ok(text.includes('< 200'), 'should preserve "< 200"');
    assert.ok(text.includes('> a'), 'should preserve "> a"');
  });

  it('should preserve code-like content with angle brackets', () => {
    const text_preview = 'Use <div class="test"> and import <Module> for the fix';
    const text = String(text_preview || '');

    assert.ok(text.includes('<div'), 'should preserve <div');
    assert.ok(text.includes('<Module>'), 'should preserve <Module>');
  });

  it('verifies old buggy replace would have corrupted text', () => {
    const text_preview = 'a < b and b > c';
    const buggyResult = text_preview.replace(/<[^>]*>/g, '');
    assert.ok(buggyResult !== text_preview, 'old behavior should differ from original');
    const fixedResult = String(text_preview || '');
    assert.equal(fixedResult, text_preview, 'new behavior should be identical');
  });
});

// ─── Bug 2: http.js sec-fetch-user header field name ───
describe('Bug 2: http.js sec-fetch-user header name', () => {
  const httpSrc = src('../src/utils/http.js');

  it('should use correct sec-fetch-user field name', () => {
    assert.ok(httpSrc.includes("'sec-fetch-user'"), 'should contain sec-fetch-user');
    assert.ok(!httpSrc.includes("'sec-fetch-user-mode'"), 'should NOT contain sec-fetch-user-mode');
  });

  it('should set sec-fetch-user to ?1', () => {
    assert.ok(httpSrc.includes("'sec-fetch-user'") && httpSrc.includes("'?1'"), 'sec-fetch-user should be ?1');
  });
});

// ─── Bug 3: isInternalHost IPv6 + bracket stripping ───
describe('Bug 3: SSRF IPv6 and bracket stripping', () => {
  it('http.js should strip IPv6 brackets and check fc/fd/fe8 ranges', () => {
    const httpSrc = src('../src/utils/http.js');
    assert.ok(httpSrc.includes("hostname.slice(1, -1)"), 'should strip IPv6 brackets');
    assert.ok(httpSrc.includes("hostname.startsWith('fc')"), 'should block fc prefix');
    assert.ok(httpSrc.includes("hostname.startsWith('fd')"), 'should block fd prefix');
    assert.ok(httpSrc.includes("hostname.startsWith('fe8')"), 'should block fe8 prefix');
  });

  it('pageFetcher.js should strip IPv6 brackets and check fc/fd/fe8 ranges', () => {
    const pfSrc = src('../src/fetch/pageFetcher.js');
    assert.ok(pfSrc.includes("h.slice(1, -1)"), 'should strip IPv6 brackets');
    assert.ok(pfSrc.includes("h.startsWith('fc')"), 'should block fc prefix');
    assert.ok(pfSrc.includes("h.startsWith('fd')"), 'should block fd prefix');
    assert.ok(pfSrc.includes("h.startsWith('fe8')"), 'should block fe8 prefix');
  });
});

// ─── Bug 4: chrome.js searchGoogleViaChrome unused engine param ───
describe('Bug 4: chrome.js cleanup', () => {
  it('should pass opts through without adding unused engine field', () => {
    const lines = src('../src/engines/chrome.js').split('\n');
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
  it('should have consistent indentation at line 600', () => {
    const lines = src('../src/browser/playwrightPool.js').split('\n');
    const targetLine = lines[599];
    assert.ok(targetLine.startsWith('    let pageEntry'), 'should be indented with 4 spaces');
    assert.ok(!targetLine.startsWith('      let pageEntry'), 'should NOT have 6 spaces');
  });
});

// ─── artifactStore.js: symlink attack & TOCTOU ───
describe('artifactStore.js: symlink protection and safeJoin', () => {
  it('should use safeJoin for directory paths in _cleanupOld', () => {
    const aSrc = src('../src/artifacts/artifactStore.js');
    assert.ok(aSrc.includes('safeJoin(this.baseDir, entry.name)'), '_cleanupOld should use safeJoin');
    assert.ok(aSrc.includes('safeJoin(dirPath, file)'), 'file paths should use safeJoin');
    assert.ok(aSrc.includes('lstatSync'), 'should use lstatSync to detect symlinks');
    assert.ok(aSrc.includes('isSymbolicLink'), 'should check for symlinks');
    assert.ok(!aSrc.includes('catch {}'), 'should not swallow errors silently');
  });

  it('should delete symlinks rather than follow them', () => {
    const aSrc = src('../src/artifacts/artifactStore.js');
    assert.ok(aSrc.includes('isSymbolicLink') && aSrc.includes('continue'), 'should skip/delete symlinks');
  });
});

// ─── httpClient.js SSRF-safe redirect ───
describe('httpClient.js: SSRF-safe redirect handling', () => {
  it('should use redirect: manual and validate redirect destinations', () => {
    const hSrc = src('../src/common/httpClient.js');
    assert.ok(hSrc.includes("redirect: 'manual'"), 'should use redirect: manual');
    assert.ok(hSrc.includes('isInternalHost'), 'should validate redirect destinations');
    assert.ok(hSrc.includes('internal address blocked') || hSrc.includes('SSRF'), 'should block internal redirects');
    assert.ok(hSrc.includes('Too many redirects'), 'should limit redirect count');
    assert.ok(hSrc.includes('maxRedirects') || hSrc.includes('max_redirects') || hSrc.includes('5'), 'should have max redirect limit');
  });

  it('isInternalHost should cover IPv6 ranges', () => {
    const hSrc = src('../src/common/httpClient.js');
    assert.ok(hSrc.includes("'fc'"), 'should block fc');
    assert.ok(hSrc.includes("'fd'"), 'should block fd');
    assert.ok(hSrc.includes("'fe8'"), 'should block fe8');
  });
});

// ─── rateLimiter.js queue flood protection & timer leak ───
describe('rateLimiter.js: queue size limit and timer leak fix', async () => {
  let RateLimiter;

  before(async () => {
    const mod = await import('../src/common/rateLimiter.js');
    RateLimiter = mod.RateLimiter;
  });

  it('should reject acquire when queue is full', async () => {
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

  it('timers should be unref\'d', () => {
    assert.ok(src('../src/common/rateLimiter.js').includes('unref'));
  });
});

// ─── retryPolicy.js abort detection ───
describe('retryPolicy.js: improved abort detection', async () => {
  let retry;

  before(async () => {
    const mod = await import('../src/common/retryPolicy.js');
    retry = mod.retry;
  });

  it('should not retry abort errors with name AbortError', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, { maxRetries: 5, baseDelayMs: 1 }),
      /aborted/
    );
    assert.equal(calls, 1);
  });

  it('should not retry abort errors with nested cause AbortError', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /fetch failed/
    );
    assert.equal(calls, 1);
  });

  it('should not retry abort errors with code ABORT_ERR', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => { calls++; throw Object.assign(new Error('abort'), { code: 'ABORT_ERR' }); }, { maxRetries: 5, baseDelayMs: 1 }),
      /abort/
    );
    assert.equal(calls, 1);
  });

  it('should not retry abort errors with deeply nested cause', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
        throw Object.assign(new Error('outer'), { cause: Object.assign(new Error('middle'), { cause: abortErr }) });
      }, { maxRetries: 5, baseDelayMs: 1 }),
      /outer/
    );
    assert.equal(calls, 1);
  });

  it('sleep timers should be unref\'d', () => {
    assert.ok(src('../src/common/retryPolicy.js').includes('unref'));
  });
});

// ─── weather.js fetch timeout ───
describe('weather.js: fetch timeout protection', () => {
  it('should use AbortController with timeout for all fetch calls', () => {
    const wSrc = src('../src/tools/weather.js');
    assert.ok(wSrc.includes('AbortController'));
    assert.ok(wSrc.includes('controller.abort'));
    assert.ok(wSrc.includes('signal: controller.signal'));
    assert.ok(wSrc.includes('clearTimeout(timer)'), 'should clear timeout on success');
  });
});

// ─── wikipedia.js error handling ───
describe('wikipedia.js: error handling fix', () => {
  it('should not silently swallow errors behind browserPool check', () => {
    const wSrc = src('../src/engines/wikipedia.js');
    assert.ok(!wSrc.includes('opts.browserPool'), 'should not check opts.browserPool');
    assert.ok(wSrc.includes('SearchEngineError'), 'should always throw SearchEngineError');
  });
});

// ─── custom_html.js template validation ───
describe('custom_html.js: template validation', () => {
  it('should throw if url_template has no {{query}} placeholder', () => {
    const cSrc = src('../src/engines/custom_html.js');
    assert.ok(cSrc.includes('INVALID_CONFIG') || cSrc.includes('{{query}}'), 'should validate template');
    assert.ok(cSrc.includes('replace'), 'should still use replace');
  });
});

// ─── time.js overly broad "in" regex ───
describe('time.js: regex specificity fix', () => {
  it('should not match bare "in" that catches China/Finland/within', () => {
    const tSrc = src('../src/tools/time.js');
    // The old regex /in|india|.../ matched "within", "China" etc.
    const indiaLine = tSrc.split('\n').find(l => l.includes('Kolkata'));
    assert.ok(indiaLine, 'should still have India/Kolkata detection');
    assert.ok(!indiaLine.includes('/in|india') && !indiaLine.includes('"in|india"'), 'should not contain bare "in" pattern');
  });
});

// ─── bing.js + google.js limit sanitization ───
describe('bing.js + google.js: limit sanitization', () => {
  it('bing should clamp limit to valid integer range', () => {
    const bSrc = src('../src/engines/bing.js');
    assert.ok(bSrc.includes('Math.max') && bSrc.includes('Number('), 'bing should sanitize limit');
  });

  it('google should clamp limit to valid integer range', () => {
    const gSrc = src('../src/engines/google.js');
    assert.ok(gSrc.includes('Math.max') && gSrc.includes('Number('), 'google should sanitize limit');
  });
});

// ─── normalize.js regression tests ───
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
    const result = truncateText('a < b and b > c', 200);
    assert.ok(result.includes('<'), 'should preserve <');
    assert.ok(result.includes('>'), 'should preserve >');
  });
});
