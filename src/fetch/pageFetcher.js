import { CONFIG } from '../config/index.js';
import { fetchWithTimeout, contentTypeOf } from '../utils/http.js';
import { extractTextFromHtml } from './extract.js';
import { normalizeWhitespace, truncateText, isLikelyBlockedText } from '../utils/normalize.js';

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
      let h = u.hostname;
      if (!h) return false;
      // Strip square brackets from IPv6 hostnames (e.g. "[::1]" -> "::1")
      if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
      if (h.startsWith('192.168.')) return false;
      if (h.startsWith('10.')) return false;
      if (h.startsWith('172.16.') || h.startsWith('172.17.') || h.startsWith('172.18.') ||
          h.startsWith('172.19.') || h.startsWith('172.2') || h.startsWith('172.30') || h.startsWith('172.31')) return false;
      if (h === '169.254.169.254') return false;
      if (h === '0.0.0.0') return false;
      if (h.startsWith('fc') || h.startsWith('fd')) return false; // IPv6 Unique Local Address (fc00::/7)
      if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return false; // IPv6 Link-Local (fe80::/10)
      if (h.endsWith('.internal') || h.endsWith('.local')) return false;
      if (h === 'host.docker.internal') return false;
      return true;
    } catch {
      return false;
    }
  }

  async fetchHttp(url, { maxChars, proxyProfile, timeoutMs } = {}) {
    const proxy = this.proxyRouter.resolve(proxyProfile, url);
    const resp = await fetchWithTimeout(url, { timeoutMs: timeoutMs || CONFIG.defaultTimeoutMs, proxyUrl: proxy.proxyUrl });
    const ct = contentTypeOf(resp);
    const raw = await Promise.race([
      resp.text(),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error('body read timed out'), { code: 'BODY_TIMEOUT' })),
        30000
      ))
    ]);
    if (!resp.ok) return this.failure(url, 'http', `HTTP_${resp.status}`, `HTTP ${resp.status}`, proxy.profile);
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

  async fetchBrowser(url, { maxChars, proxyProfile, timeoutMs } = {}) {
    const proxy = this.proxyRouter.resolve(proxyProfile, url);
    return await this.browserPool.withPage({ proxyProfile, url }, async (page) => {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs || CONFIG.browserTimeoutMs });
      } catch (e) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || CONFIG.browserTimeoutMs });
        await page.waitForTimeout(3000);
      }
      await page.waitForTimeout(2000);
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
