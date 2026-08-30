import { CONFIG } from '../config/index.js';
import { fetchWithTimeout, contentTypeOf } from '../utils/http.js';
import { extractTextFromHtml } from './extract.js';
import { normalizeWhitespace, truncateText, isLikelyBlockedText } from '../utils/normalize.js';
import { hostIsPrivate } from '../utils/ssrf.js';

const LOW_POWER_DEVICE = process.env.LOW_POWER_DEVICE === 'true';
// Randomized human-like linger + scroll before closing a fetched browser page.
// Env: BROWSER_FETCH_CLOSE_DELAY_MS = single ms or "min,max". Default scales
// down on low-power (ARM) devices.
function browserFetchCloseDelay() {
  const v = process.env.BROWSER_FETCH_CLOSE_DELAY_MS;
  if (v) {
    if (v.includes(',')) {
      const [a, b] = v.split(',').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0) return [a, Math.max(a, b)];
    } else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return LOW_POWER_DEVICE ? [1200, 3000] : [2500, 6000];
}

export class PageFetcher {
  constructor({ proxyRouter, browserPool, artifactStore }) {
    this.proxyRouter = proxyRouter;
    this.browserPool = browserPool;
    this.artifactStore = artifactStore;
  }

  async fetchPage(url, opts = {}) {
    url = this.normalizeUrl(url);
    if (!this.validateUrl(url)) {
      return {
        status: 'failed', url, title: '', text_preview: '', text_chars: 0,
        artifact_ref: null, fetch_mode: opts.mode || 'auto',
        failure_code: 'BLOCKED_URL',
        failure_reason: 'URL scheme or host is blocked (SSRF protection)'
      };
    }
    const mode = opts.mode || 'auto';
    const maxChars = Number(opts.max_chars || opts.maxChars || 12000);
    const proxyProfile = opts.proxy_profile || opts.proxyProfile || 'auto';
    const isPdfUrl = url.split('?')[0].toLowerCase().endsWith('.pdf');
    const attempts = [];
    if (mode === 'http' || mode === 'auto') {
      try {
        const result = await this.fetchHttp(url, { maxChars, proxyProfile, timeoutMs: opts.timeout_ms || opts.timeoutMs });
        attempts.push(result.attempt);
        if (result.status === 'success') return { ...result, attempts };
      } catch (err) {
        attempts.push({ mode: 'http', status: 'failed', code: err.code || 'HTTP_FETCH_ERROR', message: err.message });
      }
    }
    // Skip browser fallback for PDF URLs — browser can't extract PDF text
    if (isPdfUrl && attempts.length > 0 && attempts.at(-1)?.status !== 'success') {
      return {
        status: 'failed', url, title: '', text_preview: '', text_chars: 0,
        artifact_ref: null, fetch_mode: mode,
        failure_code: attempts.at(-1)?.code || 'FETCH_FAILED',
        attempts
      };
    }
    if (mode === 'browser' || mode === 'auto') {
      const remainingForBrowser = opts.deadline ? Math.max(0, opts.deadline - Date.now()) : Infinity;
      if (remainingForBrowser < 5000) {
        attempts.push({ mode: 'browser', status: 'skipped', code: 'DEADLINE_EXCEEDED', message: 'browser fallback skipped — deadline exceeded' });
      } else {
        try {
          const result = await this.fetchBrowser(url, { maxChars, proxyProfile, timeoutMs: Math.min(remainingForBrowser, opts.timeout_ms || opts.timeoutMs || CONFIG.browserTimeoutMs) });
          attempts.push(result.attempt);
          return { ...result, attempts };
        } catch (err) {
          attempts.push({ mode: 'browser', status: 'failed', code: err.code || 'BROWSER_FETCH_ERROR', message: err.message });
        }
      }
    }
    return {
      status: 'failed',
      url,
      title: '',
      text_preview: '',
      text_chars: 0,
      artifact_ref: null,
      fetch_mode: mode,
      failure_code: attempts.at(-1)?.code || 'FETCH_FAILED',
      attempts
    };
  }

  normalizeUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.reddit.com') {
        u.hostname = 'old.reddit.com';
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  validateUrl(url) {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      if (!u.hostname) return false;
      // hostIsPrivate covers numeric/hex/octal/mapped IP literals and internal
      // hostnames. Public domains pass here; DNS resolution is re-checked in
      // fetchWithTimeout via assertPublicHost (DNS-rebinding guard).
      return !hostIsPrivate(u.hostname);
    } catch {
      return false;
    }
  }

  async fetchHttp(url, { maxChars, proxyProfile, timeoutMs } = {}) {
    const proxy = this.proxyRouter.resolve(proxyProfile, url);
    const resp = await fetchWithTimeout(url, { timeoutMs: timeoutMs || CONFIG.defaultTimeoutMs, proxyUrl: proxy.proxyUrl });
    const ct = contentTypeOf(resp);
    if (!resp.ok) return this.failure(url, 'http', `HTTP_${resp.status}`, `HTTP ${resp.status}`, proxy.profile);

    // Handle PDF: read as binary buffer and extract text
    const isPdf = ct === 'application/pdf' || (url.split('?')[0].toLowerCase().endsWith('.pdf') && ct.includes('octet-stream'));
    if (isPdf) {
      return await this.fetchPdf(url, resp, { maxChars, proxy: proxy.profile });
    }

    let bodyTimerId;
    const raw = await Promise.race([
      resp.text(),
      new Promise((_, reject) => {
        bodyTimerId = setTimeout(() => {
          if (resp.body && typeof resp.body.cancel === 'function') {
            resp.body.cancel().catch(() => {});
          }
          reject(Object.assign(new Error('body read timed out'), { code: 'BODY_TIMEOUT' }));
        }, 30000);
        if (typeof bodyTimerId?.unref === 'function') bodyTimerId.unref();
      })
    ]);
    clearTimeout(bodyTimerId);
    if (isLikelyBlockedText(raw)) return this.failure(url, 'http', 'PAGE_BLOCKED_OR_CAPTCHA', 'page appears blocked/captcha', proxy.profile);
    if (raw.includes('正在安全验证') || raw.includes('security verification') || raw.includes('Cloudflare')) {
      return this.failure(url, 'http', 'PAGE_BLOCKED_OR_CAPTCHA', 'page shows security check', proxy.profile);
    }
    if (ct && !ct.includes('html') && !ct.includes('text')) {
      return this.failure(url, 'http', 'UNSUPPORTED_CONTENT_TYPE', `unsupported content-type ${ct}`, proxy.profile);
    }
    const extracted = ct.includes('html') || raw.includes('<html') ? extractTextFromHtml(raw, url, maxChars) : { title: '', text: truncateText(normalizeWhitespace(raw), maxChars), extracted_chars: raw.length };
    if (!extracted.text || extracted.text.length < 80) return this.failure(url, 'http', 'EXTRACTION_EMPTY', 'extracted text too short', proxy.profile);
    const artifact_ref = this.artifactStore.writeText('pages', extracted.text, { url, title: extracted.title, fetch_mode: 'http', content_type: ct, proxy_profile: proxy.profile });
    return {
      status: 'success', url, title: extracted.title, text_preview: truncateText(extracted.text, Math.min(maxChars, 2500)),
      text_chars: extracted.extracted_chars, artifact_ref, fetch_mode: 'http',
      attempt: { mode: 'http', status: 'success', proxy_profile: proxy.profile, content_type: ct }
    };
  }

  async fetchPdf(url, resp, { maxChars, proxy } = {}) {
    const MAX_PDF_BYTES = 50 * 1024 * 1024;
    const PDF_BODY_TIMEOUT_MS = 30000;
    const chunks = [];
    let totalBytes = 0;
    let pdfTimerId;
    try {
      await Promise.race([
        (async () => {
          for await (const chunk of resp.body) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_PDF_BYTES) {
              throw Object.assign(new Error(`PDF exceeds ${MAX_PDF_BYTES} bytes`), { code: 'PDF_TOO_LARGE' });
            }
            chunks.push(chunk);
          }
        })(),
        new Promise((_, reject) => {
          pdfTimerId = setTimeout(() => {
            if (resp.body && typeof resp.body.cancel === 'function') resp.body.cancel().catch(() => {});
            reject(Object.assign(new Error('PDF body read timed out'), { code: 'PDF_BODY_TIMEOUT' }));
          }, PDF_BODY_TIMEOUT_MS);
          if (pdfTimerId?.unref) pdfTimerId.unref();
        })
      ]);
    } catch (err) {
      if (err.code === 'PDF_TOO_LARGE' || err.code === 'PDF_BODY_TIMEOUT') {
        return this.failure(url, 'http', err.code, err.message, proxy);
      }
      throw err;
    } finally {
      clearTimeout(pdfTimerId);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 5 || !buffer.slice(0, 5).toString().startsWith('%PDF')) {
      return this.failure(url, 'http', 'INVALID_PDF', 'file does not appear to be a valid PDF', proxy);
    }
    try {
      const { PDFParse } = await import('pdf-parse');
      const pdf = new PDFParse({ data: buffer, verbosity: 0 });
      await pdf.load();
      const textResult = await pdf.getText();
      const text = (typeof textResult === 'string' ? textResult : (textResult?.text || '')) || '';
      const info = await pdf.getInfo().catch(() => ({}));
      const cleaned = text.trim();
      if (!cleaned || cleaned.length < 20) {
        return this.failure(url, 'http', 'PDF_EXTRACTION_EMPTY', 'no text extracted from PDF (may be scanned images)', proxy);
      }
      const numpages = info?.NPages || info?.Pages || pdf.doc?.pages?.length || 1;
      const title = info?.Title || this._extractTitleFromUrl(url);
      const truncated = truncateText(normalizeWhitespace(cleaned), maxChars || 12000);
      const artifact_ref = this.artifactStore.writeText('pages', truncated, { url, title, fetch_mode: 'pdf', content_type: 'application/pdf', proxy_profile: proxy });
      return {
        status: 'success', url, title: normalizeWhitespace(title), text_preview: truncateText(cleaned, Math.min(maxChars || 12000, 2500)),
        text_chars: cleaned.length, artifact_ref, fetch_mode: 'pdf', pdf_pages: numpages,
        attempt: { mode: 'http', status: 'success', proxy_profile: proxy, content_type: 'application/pdf', pdf_pages: numpages }
      };
    } catch (err) {
      return this.failure(url, 'http', 'PDF_PARSE_ERROR', `failed to parse PDF: ${err.message}`, proxy);
    }
  }

  _extractTitleFromUrl(url) {
    try {
      const u = new URL(url);
      let basename = u.pathname.split('/').pop() || '';
      basename = basename.replace('.pdf', '').replace(/[-_]/g, ' ');
      if (basename.length > 0) return basename;
    } catch { /* ignore */ }
    return '';
  }

  async fetchBrowser(url, { maxChars, proxyProfile, timeoutMs } = {}) {
    const proxy = this.proxyRouter.resolve(proxyProfile, url);
    return await this.browserPool.withPage({
      proxyProfile,
      url,
      closeDelayMs: browserFetchCloseDelay(),
      timeoutMs: (timeoutMs || CONFIG.browserTimeoutMs) + 15000
    }, async (page) => {
      // Block slow, content-free resources — text extraction doesn't need them
      await page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico|avif|woff2?|eot|ttf|otf|mp4|webm|mp3|mpeg)(\?|$)/i, route => route.abort().catch(() => {}));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || CONFIG.browserTimeoutMs });
      // Wait for meaningful text content to appear (JS-rendered pages)
      try {
        await page.waitForFunction(
          () => (document.body?.innerText || '').trim().length > 80,
          { timeout: Math.min(timeoutMs || CONFIG.browserTimeoutMs, 15000) }
        );
      } catch {
        // content may still be sufficient; proceed
      }
      let text = await page.evaluate(() => document.body ? document.body.innerText : '');
      const title = await page.title().catch(() => '');
      text = normalizeWhitespace(text);
      if (!text || text.length < 80) {
        const hasCaptchaKeywords = text.length > 0 && (text.includes('captcha') || text.includes('verify') || text.includes('blocked') || text.includes('automated'));
        if (hasCaptchaKeywords || text.length < 20) {
          return {
            status: 'captcha', url, title: normalizeWhitespace(title),
            text_preview: '', text_chars: 0, artifact_ref: null,
            fetch_mode: 'browser', failure_code: 'PAGE_BLOCKED_OR_CAPTCHA',
            keepPageOpen: true,
            attempt: { mode: 'browser', status: 'failed', code: 'PAGE_BLOCKED_OR_CAPTCHA', message: 'page shows captcha/blocked check', proxy_profile: proxy.profile }
          };
        }
        return {
          status: 'failed', url, title: '', text_preview: '', text_chars: 0,
          artifact_ref: null, fetch_mode: 'browser',
          failure_code: 'EXTRACTION_EMPTY',
          attempt: { mode: 'browser', status: 'failed', code: 'EXTRACTION_EMPTY', message: 'extracted text too short', proxy_profile: proxy.profile }
        };
      }
      const saved = truncateText(text, Math.max(maxChars, 12000));
      const artifact_ref = this.artifactStore.writeText('pages', saved, { url, title, fetch_mode: 'browser', proxy_profile: proxy.profile });
      return {
        status: 'success', url, title: normalizeWhitespace(title), text_preview: truncateText(text, Math.min(maxChars, 2500)),
        text_chars: text.length, artifact_ref, fetch_mode: 'browser',
        attempt: { mode: 'browser', status: 'success', proxy_profile: proxy.profile }
      };
    });
  }

  failure(url, mode, code, message, proxy_profile) {
    return { status: 'failed', url, title: '', text_preview: '', text_chars: 0, artifact_ref: null, fetch_mode: mode, failure_code: code, attempt: { mode, status: 'failed', code, message, proxy_profile } };
  }
}
