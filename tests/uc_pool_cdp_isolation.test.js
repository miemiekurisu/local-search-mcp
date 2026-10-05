process.env.USE_EXISTING_CHROME = 'true';
process.env.CDP_URL = 'http://127.0.0.1:19321';
process.env.EXISTING_CHROME_CONNECT_TIMEOUT_MS = '3000';
process.env.EXISTING_CHROME_CONNECT_RETRY_MS = '100';
process.env.BROWSER_SIMULATE_BROWSING = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState, globalFetchState, makeResp } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cdp-iso-'));
process.env.BROWSER_STATE_DIR = stateDir;

// One Chromium profile shared by every session, which is exactly what CDP mode is.
class FakeContext {
  constructor() {
    this.jar = [];
    this.pages_ = [];
    this.closed = false;
    this.added = [];
  }
  pages() { if (this.closed) throw new Error('context closed'); return this.pages_.filter(p => !p.closed); }
  async newPage() {
    const page = {
      curr: '',
      closed: false,
      handlers: {},
      url: () => page.curr,
      setDefaultTimeout() {},
      addInitScript() {},
      on(event, cb) { page.handlers[event] = cb; },
      emit(event, arg) { if (page.handlers[event]) page.handlers[event](arg); },
      route() {},
      async goto(u) { page.curr = u; return {}; },
      async close() { page.closed = true; },
      isClosed() { return page.closed; }
    };
    this.pages_.push(page);
    return page;
  }
  async cookies() { return this.jar.map(c => ({ ...c })); }
  async addCookies(list) {
    for (const cookie of list) {
      this.added.push({ ...cookie });
      const key = (c) => `${c.name}|${c.domain}|${c.path}`;
      const idx = this.jar.findIndex(c => key(c) === key(cookie));
      if (idx >= 0) this.jar[idx] = { ...cookie };
      else this.jar.push({ ...cookie });
    }
  }
  async storageState() { return { cookies: this.jar.map(c => ({ ...c })), origins: [] }; }
  async close() { this.closed = true; }
}

class FakeCdpBrowser {
  constructor(context) {
    this.context = context;
    this.closed = false;
    this.handlers = {};
  }
  on(event, cb) { this.handlers[event] = cb; }
  isConnected() { return !this.closed; }
  contexts() { return [this.context]; }
  async newContext() { throw new Error('cdp browser must not create contexts'); }
}

const st = playwrightState();
st.launchImpl = () => { throw new Error('launch must not be called in CDP mode'); };
const gfs = globalFetchState();
let currentBrowser = null;
st.cdpImpl = async () => currentBrowser;

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

function newPool() {
  gfs.responses.length = 0;
  gfs.responses.push(makeResp({ json: { webSocketDebuggerUrl: 'ws://127.0.0.1:19321/devtools/browser/x' } }));
  return new PlaywrightPool({ resolve: () => null });
}

function writeState(sessionKey, state) {
  fs.writeFileSync(path.join(stateDir, `${sessionKey}.json`), JSON.stringify(state));
}

function readState(sessionKey) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, `${sessionKey}.json`), 'utf8'));
}

function names(state) {
  return (state.cookies || []).map(c => c.name).sort();
}

async function search(pool, sessionKey, url) {
  return await pool.withPage({ sessionKey, reuseSession: true, url }, async (page) => {
    await page.goto(`${url}/search?q=x`);
    return sessionKey;
  });
}

test('CDP: sessions sharing one profile keep domain-scoped state files', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [
    { name: 'NID', value: 'g-live', domain: '.google.com', path: '/' },
    { name: '_u', value: 'b-live', domain: '.bing.com', path: '/' },
    { name: 'anon', value: 'x', domain: '.elsewhere.test', path: '/' }
  ];
  assert.strictEqual(await search(pool, 'google', 'https://www.google.com'), 'google');
  assert.strictEqual(await search(pool, 'bing', 'https://www.bing.com'), 'bing');

  assert.deepStrictEqual(names(readState('google')), ['NID'], 'google.json holds google cookies only');
  assert.deepStrictEqual(names(readState('bing')), ['_u'], 'bing.json holds bing cookies only');
  await pool.close();
});

test('CDP: a whole-profile dump seeds only its own domains', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  // Written by the old code: bing.json contains every cookie in the browser.
  writeState('dumped', {
    cookies: [
      { name: '_u', value: 'b-saved', domain: '.bing.com', path: '/' },
      { name: 'NID', value: 'g-saved', domain: '.google.com', path: '/' },
      { name: 'oai', value: 'c-saved', domain: '.chatgpt.com', path: '/' }
    ],
    origins: [{ origin: 'https://chatgpt.com', localStorage: [] }]
  });
  ctx.jar = [];
  await search(pool, 'dumped', 'https://www.bing.com');

  assert.deepStrictEqual(ctx.added.map(c => c.name), ['_u'], 'no foreign cookies injected into the shared jar');
  assert.deepStrictEqual(names(readState('dumped')), ['_u'], 'the rewrite purges the leaked entries');
  await pool.close();
});

test('CDP: live profile cookies win over a stale snapshot', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [{ name: '_u', value: 'live-from-profile', domain: '.bing.com', path: '/' }];
  writeState('fresh', { cookies: [{ name: '_u', value: 'stale-snapshot', domain: '.bing.com', path: '/' }] });
  await search(pool, 'fresh', 'https://www.bing.com');

  const values = (await ctx.cookies()).filter(c => c.name === '_u').map(c => c.value);
  assert.deepStrictEqual(values, ['live-from-profile'], 'stale snapshot must not overwrite the profile');
  assert.deepStrictEqual(readState('fresh').cookies[0].value, 'live-from-profile', 'the file learns the live value');
  await pool.close();
});

test('CDP: interactive session page widens its own scope', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [];
  const info = await pool.openSessionPage({ sessionKey: 'chatgpt', url: 'https://chatgpt.com/auth/login' });
  assert.strictEqual(info.mode, 'shared-cdp');
  const pinned = pool.sessionPages.get('chatgpt').page;
  pinned.emit('framenavigated', { url: () => 'https://auth.openai.com/sign_in' });
  pinned.emit('framenavigated', { url: () => 'garbage without a scheme' });
  // The login the human just finished set cookies on both sites it touched.
  ctx.jar.push({ name: 'oai', value: 'new', domain: '.openai.com', path: '/' });
  ctx.jar.push({ name: 'sessionToken', value: 'new', domain: '.chatgpt.com', path: '/' });
  ctx.jar.push({ name: '_u', value: 'someone else', domain: '.bing.com', path: '/' });

  const saved = await pool.saveSessionState('chatgpt');
  assert.strictEqual(saved.saved, true);
  assert.deepStrictEqual(names(readState('chatgpt')), ['oai', 'sessionToken']);
  await pool.close();
});

test('CDP: an unvisited session saves nothing instead of the whole profile', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [{ name: 'NID', value: 'g', domain: '.google.com', path: '/' }];
  const saved = await pool.saveSessionState('stranger');
  assert.strictEqual(saved.saved, false);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'stranger.json')), false);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'stranger.json.1.tmp')), false, 'no temp litter on the skip path');
  await pool.close();
});

test('CDP: hydrate is revisited when a session starts visiting a new host', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [];
  // First task: the session has no snapshot yet, so nothing is restored.
  await search(pool, 'grew', 'https://www.bing.com');
  writeState('grew', { cookies: [{ name: '_u', value: 'b', domain: '.bing.com', path: '/' }, { name: 'dd', value: 'd', domain: 'duckduckgo.com', path: '/' }] });
  ctx.added.length = 0;
  // Same host, snapshot appeared: already restored for this scope, so no re-hydrate.
  await search(pool, 'grew', 'https://www.bing.com');
  assert.deepStrictEqual(ctx.added.map(c => c.name), [], 'scope unchanged means no re-hydrate churn');
  // New host for the same session: the snapshot is consulted again.
  await search(pool, 'grew', 'https://duckduckgo.com');
  assert.deepStrictEqual(ctx.added.map(c => c.name).sort(), ['_u', 'dd'],
    'new host re-opens the scoped restore, and both scoped hosts were still missing from the jar');
  // Everything the jar already has stays out of the next restore.
  ctx.added.length = 0;
  await search(pool, 'grew', 'https://html.duckduckgo.com');
  assert.deepStrictEqual(ctx.added.map(c => c.name), [], 'live cookies are never re-added');
  await pool.close();
});

// The snapshot is a fallback, not an oracle: an unreadable live jar must not lose the
// login we already have on disk, and a failed save must not destroy the snapshot we have.
test('CDP: an unreadable cookie jar is still seeded from the snapshot', async () => {
  const ctx = new FakeContext();
  ctx.cookies = async () => { throw new Error('jar locked'); };
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  writeState('locked', { cookies: [{ name: '_u', value: 'from-snapshot', domain: '.bing.com', path: '/' }] });
  await search(pool, 'locked', 'https://www.bing.com');
  assert.deepStrictEqual(ctx.added.map(c => c.name), ['_u'],
    'a jar we cannot read is better seeded from the file than left empty');
  await pool.close();
});

test('CDP: a failed snapshot keeps the previous file', async () => {
  const ctx = new FakeContext();
  currentBrowser = new FakeCdpBrowser(ctx);
  const pool = newPool();
  ctx.jar = [{ name: '_u', value: 'b-live', domain: '.bing.com', path: '/' }];
  await search(pool, 'broken', 'https://www.bing.com');
  const before = readState('broken');
  ctx.storageState = async () => { throw new Error('target closed'); };

  const saved = await pool.saveSessionState('broken');
  assert.strictEqual(saved.saved, false);
  assert.strictEqual(saved.state_path, null);
  assert.deepStrictEqual(readState('broken'), before, 'a failed save must not empty a usable snapshot');
  await pool.close();
});
