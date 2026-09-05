import { registerHooks } from 'node:module';

let hooksInstalled = false;

function ensureHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(spec, ctx, nextResolve) {
      if (spec === 'undici') return { url: 'mock:undici', shortCircuit: true, importAttributes: {} };
      if (spec === 'playwright') return { url: 'mock:playwright', shortCircuit: true, importAttributes: {} };
      if (spec === 'pdf-parse') return { url: 'mock:pdf-parse', shortCircuit: true, importAttributes: {} };
      if (spec === 'node:dns/promises') return { url: 'mock:dns-promises', shortCircuit: true, importAttributes: {} };
      if (spec.startsWith('@modelcontextprotocol/sdk/client/')) {
        return { url: 'mock:mcp-client', shortCircuit: true, importAttributes: {} };
      }
      if (spec === 'child_process') return { url: 'mock:child_process', shortCircuit: true, importAttributes: {} };
      if (spec === './app.js' && ctx.parentURL && ctx.parentURL.split('?')[0].endsWith('/src/self_check.js')) {
        return { url: 'mock:app', shortCircuit: true, importAttributes: {} };
      }
      return nextResolve(spec, ctx);
    },
    load(url, ctx, nextLoad) {
      if (url === 'mock:undici') {
        const src = `
const S = () => globalThis.__mockUndiciState;
export const fetch = (...a) => S().fetch(...a);
export class ProxyAgent { constructor(u) { this.proxyUrl = u; } }
export const Dispatcher = class {};
const def = { fetch, ProxyAgent };
export default def;
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:playwright') {
        const src = `
const S = () => globalThis.__mockPlaywrightState;
export const chromium = {
  launch: (...a) => S().launch(...a),
  connectOverCDP: (...a) => S().connectOverCDP(...a),
};
export const firefox = chromium;
export const webkit = chromium;
export default { chromium, firefox, webkit };
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:pdf-parse') {
        const src = `
const S = () => globalThis.__mockPdfParseState;
export class PDFParse {
  constructor(opts) { this.opts = opts; return S().ctor(this, opts); }
  async load(...a) { return S().load(this, ...a); }
  async getText(...a) { return S().getText(this, ...a); }
  async getInfo(...a) { return S().getInfo(this, ...a); }
}
const def = async (buffer) => S().parse(buffer);
export { def as default };
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:dns-promises') {
        const src = `
const S = () => globalThis.__mockDnsState;
export const lookup = (...a) => S().lookup(...a);
const def = { lookup };
export { def as default };
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:mcp-client') {
        const src = `
const S = () => globalThis.__mockMcpClientState;
export class Client {
  constructor(info) { this.info = info; S().ctor && S().ctor(this); }
  async connect(transport) { S().connects.push(transport); return S().connect ? S().connect(this, transport) : undefined; }
  async callTool(msg) { return S().callTool(this, msg); }
  async close() { S().closes = (S().closes || 0) + 1; return S().close ? S().close(this) : undefined; }
}
export class StdioClientTransport {
  constructor(opts) { this.opts = opts; S().transports.push(this); }
  onclose = null;
  onerror = null;
  async close() { S().transportCloses = (S().transportCloses || 0) + 1; if (this.onclose) this.onclose(); }
}
export default { Client, StdioClientTransport };
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:app') {
        const src = `
const S = () => globalThis.__mockSelfCheckState;
export function createKernel() { return S().createKernelImpl(); }
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      if (url === 'mock:child_process') {
        const src = `
const S = () => globalThis.__mockChildProcessState;
export const exec = (cmd, opts, cb) => S().exec(cmd, opts, cb);
export const spawn = (...a) => S().spawn(...a);
export default { exec, spawn };
`;
        return { format: 'module', shortCircuit: true, source: src };
      }
      return nextLoad(url, ctx);
    }
  });
}

export function undiciState() {
  ensureHooks();
  if (!globalThis.__mockUndiciState) {
    globalThis.__mockUndiciState = {
      calls: [],
      responses: [],
      fetch: async (url, init) => {
        const st = globalThis.__mockUndiciState;
        st.calls.push({ url: String(url), init });
        const next = st.responses.length ? st.responses.shift() : null;
        if (typeof next === 'function') return next(url, init, st);
        if (next) return next;
        throw new Error('mock undici fetch: no queued response for ' + url);
      }
    };
  }
  return globalThis.__mockUndiciState;
}

export function playwrightState() {
  ensureHooks();
  if (!globalThis.__mockPlaywrightState) {
    globalThis.__mockPlaywrightState = {
      launches: [],
      launch: async (opts) => {
        const st = globalThis.__mockPlaywrightState;
        st.launches.push(opts);
        return st.launchImpl ? st.launchImpl(opts) : null;
      },
      connectOverCDP: async (endpoint) => {
        const st = globalThis.__mockPlaywrightState;
        st.cdpConnects = st.cdpConnects || [];
        st.cdpConnects.push(endpoint);
        return st.cdpImpl ? st.cdpImpl(endpoint) : null;
      }
    };
  }
  return globalThis.__mockPlaywrightState;
}

export function pdfParseState() {
  ensureHooks();
  if (!globalThis.__mockPdfParseState) {
    globalThis.__mockPdfParseState = {
      ctor: () => ({}),
      load: async () => ({}),
      getText: async () => ({ text: '' }),
      getInfo: async () => ({}),
      parse: async () => ({ text: '', numpages: 1 })
    };
  }
  return globalThis.__mockPdfParseState;
}

export function dnsState() {
  ensureHooks();
  if (!globalThis.__mockDnsState) {
    globalThis.__mockDnsState = {
      lookups: [],
      lookup: async (host, opts) => {
        const st = globalThis.__mockDnsState;
        st.lookups.push(host);
        if (typeof st.impl === 'function') return st.impl(host, opts);
        return [{ address: '93.184.216.34', family: 4 }];
      }
    };
  }
  return globalThis.__mockDnsState;
}

export function mcpClientState() {
  ensureHooks();
  if (!globalThis.__mockMcpClientState) {
    globalThis.__mockMcpClientState = {
      connects: [],
      transports: [],
      closes: 0,
      transportCloses: 0,
      callTool: async () => ({ content: [] })
    };
  }
  return globalThis.__mockMcpClientState;
}

export function childProcessState() {
  ensureHooks();
  if (!globalThis.__mockChildProcessState) {
    globalThis.__mockChildProcessState = {
      exec: (cmd, opts, cb) => cb(new Error('mock exec not configured')),
      spawn: () => { throw new Error('mock spawn not configured'); }
    };
  }
  return globalThis.__mockChildProcessState;
}

export function globalFetchState() {
  if (!globalThis.__mockGlobalFetchState) {
    globalThis.__mockGlobalFetchState = {
      calls: [],
      responses: [],
      router: null,
      fetch: async (url, init) => {
        const st = globalThis.__mockGlobalFetchState;
        st.calls.push({ url: String(url), init });
        if (typeof st.router === 'function') {
          return await st.router(url, init, st);
        }
        const next = st.responses.length ? st.responses.shift() : null;
        if (typeof next === 'function') return next(url, init, st);
        if (next) return next;
        throw new Error('mock global fetch: no queued response for ' + url);
      }
    };
    globalThis.__mockGlobalFetchState.originalFetch = globalThis.fetch;
    globalThis.fetch = globalThis.__mockGlobalFetchState.fetch;
  }
  return globalThis.__mockGlobalFetchState;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return makeResp({ status, headers, json: body });
}

export function makeResp({ status = 200, headers = {}, chunks = null, text = null, json = null, url = 'http://mock.local/response', hang = false } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  let i = 0;
  if (chunks === null && !hang && text === null && json !== null) {
    text = JSON.stringify(json);
  }
  const iterChunks = chunks ?? (text !== null && text !== undefined ? [Buffer.from(String(text))] : null);
  const body = {
    cancelled: false,
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (hang) return new Promise(() => {});
          if (iterChunks) {
            if (i < iterChunks.length) return { value: iterChunks[i++], done: false };
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        }
      };
    },
    cancel: async () => { body.cancelled = true; }
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'ST' + status,
    url,
    headers: {
      get: k => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null),
      entries: function* () { for (const [k, v] of h) yield [k, v]; }
    },
    json: async () => (json !== null && json !== undefined ? json : JSON.parse(text ?? 'null')),
    text: async () => (text !== null && text !== undefined ? text : JSON.stringify(json ?? null)),
    body
  };
}

export function selfCheckState() {
  ensureHooks();
  if (!globalThis.__mockSelfCheckState) {
    globalThis.__mockSelfCheckState = {
      calls: [],
      closes: 0,
      failNext: false,
      createKernelImpl: () => {
        const st = globalThis.__mockSelfCheckState;
        return {
          kernel: {
            searchAndFetch: async (args) => {
              st.calls.push(args);
              if (st.failNext) throw new Error('selfcheck boom');
              return { ok: true, artifact_ref: 'artifact://books/x.txt' };
            }
          },
          browserPool: {
            close: async () => { st.closes += 1; }
          },
          toolRegistry: { stub: true }
        };
      }
    };
  }
  return globalThis.__mockSelfCheckState;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
export { sleep };

// Install hooks and initialize every mock state eagerly at import time.
// Individual state objects are lazy otherwise, but mocked modules (e.g. ssrf's
// dns/promises import) can be invoked by src code before the test file ever
// calls the matching state factory, which would crash on undefined state.
ensureHooks();
undiciState();
playwrightState();
pdfParseState();
dnsState();
mcpClientState();
childProcessState();
selfCheckState();
