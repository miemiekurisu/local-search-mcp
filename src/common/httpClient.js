import { fetch, ProxyAgent } from 'undici';

function isInternalHost(hostname) {
  if (!hostname) return true;
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.startsWith('192.168.')) return true;
  if (hostname.startsWith('10.')) return true;
  if (hostname.startsWith('172.16.') || hostname.startsWith('172.17.') || hostname.startsWith('172.18.') ||
      hostname.startsWith('172.19.') || hostname.startsWith('172.2') || hostname.startsWith('172.30') || hostname.startsWith('172.31')) return true;
  if (hostname === '169.254.169.254') return true;
  if (hostname === '0.0.0.0') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  if (hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb')) return true;
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return true;
  if (hostname === 'host.docker.internal') return true;
  return false;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9',
  'zh-CN,zh;q=0.9,en-US;q=0.8',
  'zh-TW,zh;q=0.9,en-US;q=0.8',
];

export class HttpClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpClientError';
    if (options.status !== undefined) this.status = options.status;
    if (options.statusText !== undefined) this.statusText = options.statusText;
    if (options.url !== undefined) this.url = options.url;
    if (options.body !== undefined) this.body = options.body;
  }
}

export class HttpClient {
  constructor({ proxyRouter } = {}) {
    this._proxyRouter = proxyRouter;
  }

  async request(opts = {}) {
    const {
      method = 'GET',
      url,
      query,
      headers = {},
      body,
      responseType = 'json',
      timeoutMs = 15000,
      proxyProfile = null,
      rateLimitKey = null,
      rateLimiter = null,
      retryPolicy = null,
    } = opts;

    if (!url) throw new Error('HttpClient.request requires url');

    const targetUrl = query ? this._buildUrl(url, query) : url;

    const requestHeaders = {
      'user-agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      'accept-language': ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)],
      ...headers,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init = {
        method,
        headers: requestHeaders,
        signal: controller.signal,
        redirect: 'manual',
      };

      if (body !== undefined && body !== null) {
        init.body = body;
        if (typeof body === 'string' && !requestHeaders['content-type'] && !headers['content-type']) {
          requestHeaders['content-type'] = 'application/json';
        }
      }

      if (proxyProfile && this._proxyRouter) {
        const resolved = this._proxyRouter.resolve(proxyProfile, targetUrl);
        if (resolved && resolved.proxyUrl) {
          init.dispatcher = new ProxyAgent(resolved.proxyUrl);
        }
      }

      const executeFetch = async () => {
        if (rateLimitKey && rateLimiter) {
          await rateLimiter.acquire(rateLimitKey);
        }
        try {
          return await fetch(targetUrl, init);
        } finally {
          if (rateLimitKey && rateLimiter) {
            rateLimiter.release(rateLimitKey);
          }
        }
      };

      let response;
      let currentUrl = targetUrl;
      const maxRedirects = 5;
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        response = retryPolicy
          ? await retryPolicy.execute(() => fetch(currentUrl, init))
          : await fetch(currentUrl, init);

        const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
        if (!isRedirect) break;

        const location = response.headers.get('location');
        if (!location) break;

        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          break;
        }

        if (isInternalHost(nextUrl.hostname)) {
          throw new HttpClientError(`Redirect to internal address blocked: ${nextUrl.hostname}`, { url: currentUrl });
        }

        if (redirectCount >= maxRedirects) {
          throw new HttpClientError(`Too many redirects (${redirectCount})`, { url: currentUrl });
        }

        currentUrl = nextUrl.toString();
      }

      return await this._parseResponse(response, responseType, currentUrl);
    } finally {
      clearTimeout(timer);
    }
  }

  _buildUrl(base, query) {
    const urlObj = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        urlObj.searchParams.set(key, String(value));
      }
    }
    return urlObj.toString();
  }

  async _parseResponse(response, responseType, url) {
    const type = responseType === 'auto' ? this._detectContentType(response) : responseType;

    let data;
    if (type === 'json') {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      throw new HttpClientError(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`, {
        status: response.status,
        statusText: response.statusText,
        url,
        body: data,
      });
    }

    return { status: response.status, data };
  }

  _detectContentType(response) {
    const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct.includes('/json') || ct.endsWith('+json')) return 'json';
    return 'text';
  }

  async get(url, opts = {}) {
    return this.request({ ...opts, method: 'GET', url });
  }

  async post(url, opts = {}) {
    return this.request({ ...opts, method: 'POST', url });
  }

  async head(url, opts = {}) {
    return this.request({ ...opts, method: 'HEAD', url });
  }
}
