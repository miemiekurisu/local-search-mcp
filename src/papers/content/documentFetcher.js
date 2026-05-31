import { fetch } from 'undici';
import crypto from 'crypto';
import { CONFIG } from '../../config/index.js';
import { detectContentType } from './contentTypeDetector.js';

export class DocumentFetcher {
  constructor(config = CONFIG.paperCache) {
    this.config = config;
    this.userAgent = 'local-search-mcp/1.0 (paper content fetcher)';
  }

  async fetch(url, options = {}) {
    const {
      timeoutMs = 30000,
      maxBytes = this.config.fetchMaxBytes || 50 * 1024 * 1024,
      expectedType = null
    } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': this.userAgent,
          'accept': 'application/pdf,text/html,application/xml,text/xml,application/tei+xml,*/*;q=0.8'
        },
        signal: controller.signal,
        redirect: 'follow'
      });

      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status} fetching ${url}`), {
          code: 'FETCH_FAILED',
          status: res.status,
          url
        });
      }

      const contentType = res.headers.get('content-type') || '';
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

      if (contentLength > maxBytes) {
        throw Object.assign(new Error(`Content too large: ${contentLength} bytes (max ${maxBytes})`), {
          code: 'FILE_TOO_LARGE',
          size: contentLength,
          maxSize: maxBytes,
          url
        });
      }

      const chunks = [];
      let totalBytes = 0;

      for await (const chunk of res.body) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          throw Object.assign(new Error(`Download exceeded ${maxBytes} bytes`), {
            code: 'FILE_TOO_LARGE',
            size: totalBytes,
            maxSize: maxBytes,
            url
          });
        }
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const variant = detectContentType(url, contentType, buffer);

      if (expectedType && variant !== expectedType && variant !== 'raw/pdf') {
        console.warn(`[document-fetcher] expected ${expectedType}, got ${variant} for ${url}`);
      }

      return {
        buffer,
        hash,
        variant,
        mimeType: contentType.split(';')[0].trim().toLowerCase(),
        size: buffer.length,
        url: res.url || url,
        headers: Object.fromEntries(res.headers.entries())
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
