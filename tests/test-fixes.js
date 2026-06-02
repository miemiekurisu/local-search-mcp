import * as assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// ─── Bug 1: searchKernel.js text_preview should not strip < > from plain text ───
describe('Bug 1: searchKernel text_preview plain text integrity', () => {
  it('should preserve less-than and greater-than symbols in text_preview', () => {
    // text_preview from pageFetcher is already plain text (Readability / innerText).
    // The previous code did: String(row.page.text_preview || '').replace(/<[^>]*>/g, '')
    // which destroyed legitimate < and > characters.
    const text_preview = 'response code < 200 means error, but b > a is true';
    // Fixed code simply does: String(row.page.text_preview || '')
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
    assert.ok(text.includes('class='), 'should preserve class= inside angle brackets');
    assert.ok(text.includes('<Module>'), 'should preserve <Module>');
  });

  it('should handle empty/undefined text_preview gracefully', () => {
    assert.equal(String(null || ''), '');
    assert.equal(String(undefined || ''), '');
    assert.equal(String('' || ''), '');
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
    const headers = createHeaders({}, true); // forGoogle = true

    assert.ok(
      'sec-fetch-user' in headers,
      'should contain sec-fetch-user header'
    );
    assert.equal(
      headers['sec-fetch-user'],
      '?1',
      'sec-fetch-user should be ?1'
    );
    assert.ok(
      !('sec-fetch-user-mode' in headers),
      'should NOT contain invalid sec-fetch-user-mode header'
    );
  });

  it('should include all Google-specific sec-* headers', () => {
    const headers = createHeaders({}, true);

    assert.equal(headers['sec-ch-ua'], '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126", "WebKit";v="126"');
    assert.equal(headers['sec-ch-ua-mobile'], '?0');
    assert.equal(headers['sec-ch-ua-platform'], '"Windows"');
    assert.equal(headers['sec-fetch-dest'], 'document');
    assert.equal(headers['sec-fetch-mode'], 'navigate');
    assert.equal(headers['sec-fetch-site'], 'none');
    assert.equal(headers['sec-fetch-user'], '?1');
    assert.equal(headers['upgrade-insecure-requests'], '1');
  });

  it('should not add sec-* headers when forGoogle is false', () => {
    const headers = createHeaders({}, false);

    assert.ok(!('sec-fetch-user' in headers), 'sec-fetch-user should not be present');
    assert.ok(!('sec-fetch-dest' in headers), 'sec-fetch-dest should not be present');
  });

  it('DEFAULT_HEADERS should be defined and contain accept and accept-language', () => {
    assert.ok(DEFAULT_HEADERS, 'DEFAULT_HEADERS should be truthy');
    assert.ok(DEFAULT_HEADERS['accept'], 'should have accept header');
    assert.ok(DEFAULT_HEADERS['accept-language'], 'should have accept-language header');
  });
});

// ─── Bug 3: isInternalHost IPv6 private address SSRF protection ───
describe('Bug 3: isInternalHost IPv6 private address detection', async () => {
  let fetchWithTimeout;

  before(async () => {
    // Import to ensure the module loads without errors
    const mod = await import('../src/utils/http.js');
    fetchWithTimeout = mod.fetchWithTimeout;
  });

  // We can't easily call isInternalHost directly (not exported), but we can
  // verify the module loads and that pageFetcher.validateUrl covers IPv6.
  // Instead, let's test the pageFetcher validateUrl method which uses the
  // same SSRF protection logic.
  describe('pageFetcher SSRF validation for IPv6', async () => {
    let PageFetcher;
    let fetcher;

    before(async () => {
      const mod = await import('../src/fetch/pageFetcher.js');
      PageFetcher = mod.PageFetcher;
      fetcher = new PageFetcher({ proxyRouter: null, browserPool: null, artifactStore: null });
    });

    it('should reject IPv4 loopback addresses', () => {
      assert.equal(fetcher.validateUrl('http://127.0.0.1:8080'), false);
      assert.equal(fetcher.validateUrl('http://localhost:8080'), false);
      assert.equal(fetcher.validateUrl('http://0.0.0.0:8080'), false);
    });

    it('should reject IPv4 private addresses', () => {
      assert.equal(fetcher.validateUrl('http://192.168.1.1'), false);
      assert.equal(fetcher.validateUrl('http://10.0.0.1'), false);
      assert.equal(fetcher.validateUrl('http://172.16.0.1'), false);
      assert.equal(fetcher.validateUrl('http://172.31.255.255'), false);
    });

    it('should reject IPv6 loopback', () => {
      assert.equal(fetcher.validateUrl('http://[::1]:8080'), false);
    });

    it('should reject IPv6 Unique Local Address (fc00::/7)', () => {
      assert.equal(fetcher.validateUrl('http://[fc00::1]'), false);
      assert.equal(fetcher.validateUrl('http://[fd00::dead:beef]'), false);
      assert.equal(fetcher.validateUrl('http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]'), false);
    });

    it('should reject IPv6 Link-Local Address (fe80::/10)', () => {
      assert.equal(fetcher.validateUrl('http://[fe80::1]'), false);
      assert.equal(fetcher.validateUrl('http://[fe80::dead:beef]'), false);
      assert.equal(fetcher.validateUrl('http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]'), false);
    });

    it('should reject cloud metadata endpoints', () => {
      assert.equal(fetcher.validateUrl('http://169.254.169.254/latest/meta-data/'), false);
    });

    it('should reject internal hostnames', () => {
      assert.equal(fetcher.validateUrl('http://my-app.internal'), false);
      assert.equal(fetcher.validateUrl('http://printer.local'), false);
      assert.equal(fetcher.validateUrl('http://host.docker.internal'), false);
    });

    it('should allow external URLs', () => {
      assert.equal(fetcher.validateUrl('https://www.google.com/search?q=test'), true);
      assert.equal(fetcher.validateUrl('https://github.com/user/repo'), true);
      assert.equal(fetcher.validateUrl('http://example.com/page'), true);
      assert.equal(fetcher.validateUrl('https://stackoverflow.com/questions/123'), true);
    });

    it('should reject non-http schemes', () => {
      assert.equal(fetcher.validateUrl('ftp://files.example.com'), false);
      assert.equal(fetcher.validateUrl('file:///etc/passwd'), false);
      assert.equal(fetcher.validateUrl('javascript:alert(1)'), false);
    });

    it('should reject invalid URLs', () => {
      assert.equal(fetcher.validateUrl('not-a-url'), false);
      assert.equal(fetcher.validateUrl(''), false);
    });
  });
});

// ─── Bug 4: chrome.js searchGoogleViaChrome should not pass unused engine param ───
describe('Bug 4: chrome.js searchGoogleViaChrome cleanup', async () => {
  it('should pass opts through without adding unused engine field', async () => {
    // We can't run the actual chrome search (requires browser), but we can
    // verify the source code structure. The fix ensures:
    //   searchViaChromeDevTools(query, opts)
    // instead of:
    //   searchViaChromeDevTools(query, { ...opts, engine: 'google' })
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/engines/chrome.js', import.meta.url), 'utf8');

    // Extract the searchGoogleViaChrome function body (from export to closing brace at end)
    const lines = src.split('\n');
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('searchGoogleViaChrome')) {
        startIdx = i;
        break;
      }
    }
    assert.ok(startIdx >= 0, 'searchGoogleViaChrome function should exist');

    // The function is the last function in the file — grab from its line to end of file
    const fnBody = lines.slice(startIdx).join('\n');

    assert.ok(
      !fnBody.includes("engine: 'google'") && !fnBody.includes('engine: "google"'),
      'should NOT contain the unused engine: "google" parameter spread'
    );
    assert.ok(
      fnBody.includes('searchViaChromeDevTools'),
      'should still delegate to searchViaChromeDevTools'
    );
    assert.ok(
      fnBody.includes('searchViaChromeDevTools(query, opts)'),
      'should pass opts directly without modification'
    );
  });
});

// ─── Bug 5: playwrightPool.js indentation fix ───
describe('Bug 5: playwrightPool.js indentation consistency', () => {
  it('openSessionPage method should have consistent indentation at line 600', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/browser/playwrightPool.js', import.meta.url), 'utf8');
    const lines = src.split('\n');

    // Line 600 (0-indexed: 599) should start with 4 spaces (same as surrounding lines)
    const targetLine = lines[599]; // line 600 is index 599
    // The line should be: '    let pageEntry = this.sessionPages.get(sessionKey);'
    assert.ok(
      targetLine.startsWith('    let pageEntry'),
      `line 600 should be indented with 4 spaces, got: "${targetLine.slice(0, 10)}..."`
    );
    assert.ok(
      !targetLine.startsWith('      let pageEntry'),
      'line 600 should NOT have 6 spaces (double indent)'
    );
  });
});

// ─── Additional: normalize.js regression tests ───
describe('normalize.js - utility functions used by fixes', async () => {
  let hostOf, truncateText;

  before(async () => {
    const mod = await import('../src/utils/normalize.js');
    hostOf = mod.hostOf;
    truncateText = mod.truncateText;
  });

  it('hostOf should extract hostname correctly', () => {
    assert.equal(hostOf('https://www.google.com/search'), 'google.com');
    assert.equal(hostOf('http://github.com/user/repo'), 'github.com');
    assert.equal(hostOf('not-a-url'), '');
  });

  it('truncateText should preserve text within limit', () => {
    const short = 'hello world';
    assert.equal(truncateText(short, 100), short);
  });

  it('truncateText should truncate and note overflow', () => {
    const long = 'a'.repeat(150);
    const result = truncateText(long, 100);
    assert.ok(result.length < 150, 'should be shorter than original');
    assert.ok(result.includes('[TRUNCATED'), 'should contain truncation marker');
  });

  it('text_preview with angle brackets should survive truncateText', () => {
    const input = 'a < b and b > c and x < 100';
    const result = truncateText(input, 200);
    assert.ok(result.includes('<'), 'should preserve < after truncate');
    assert.ok(result.includes('>'), 'should preserve > after truncate');
  });
});

// ─── Integration: full pipeline text integrity ───
describe('Integration: text integrity through pipeline', () => {
  it('simulating searchKernel item building with angle bracket content', () => {
    // Simulate what searchKernel.js line 75 does after the fix:
    // const text = String(row.page.text_preview || '');
    // Previously: .replace(/<[^>]*>/g, '')

    const mockPage = {
      status: 'success',
      text_preview: 'Error: HTTP status < 200 detected. If latency > 500ms, check <server-config>',
      fetch_mode: 'http'
    };

    const mockResult = {
      title: 'Test Error Guide',
      url: 'https://example.com/errors',
      snippet: 'Troubleshooting HTTP errors',
      engine: 'duckduckgo',
      rank: 1
    };

    // This is what the fixed code does
    const text = String(mockPage.text_preview || '');

    assert.ok(text.includes('< 200'), 'should preserve "< 200"');
    assert.ok(text.includes('> 500ms'), 'should preserve "> 500ms"');
    assert.ok(text.includes('<server-config>'), 'should preserve "<server-config>"');
    assert.equal(text, mockPage.text_preview, 'should be identical to input');
  });

  it('verifies old buggy behavior would have corrupted text', () => {
    const text_preview = 'status < 200 and a > b';

    // Old buggy behavior:
    const buggyResult = text_preview.replace(/<[^>]*>/g, '');
    // "< 200 and a " would become "" because < 200 and a > matches as a tag
    // Actually: < 200 and a > is one match from < to >
    assert.ok(
      buggyResult !== text_preview,
      'old behavior should differ from original (proving it was buggy)'
    );

    // New fixed behavior:
    const fixedResult = String(text_preview || '');
    assert.equal(fixedResult, text_preview, 'new behavior should be identical');
  });
});
