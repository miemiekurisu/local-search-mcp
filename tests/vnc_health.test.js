// /health now reports whether the VNC half of noVNC is really serving, so these tests
// stand up plain TCP listeners and a stub kernel -- no browser is ever launched.
process.env.RATE_LIMIT_MAX_REQUESTS = '1';
process.env.RATE_LIMIT_WINDOW_MS = '600000';
process.env.TRUST_PROXY = '0';
process.env.MCP_BEARER_TOKEN = 'secret-token';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-vnc-health-'));
process.env.ARTIFACT_DIR = path.join(tmp, 'artifacts');
process.env.BROWSER_STATE_DIR = path.join(tmp, 'state');

const { VncHealth, probeTcpPort } = await import('../src/browser/vncHealth.js');
const { createApp } = await import('../src/http_server.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function envWith(over = {}) {
  return { VNC_HEALTH_TIMEOUT_MS: '500', ...over };
}

function listenOnLoopback(onConnection) {
  return new Promise((resolve) => {
    const sockets = new Set();
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      if (onConnection) onConnection();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      get connections() { return connections; },
      close: () => new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => done());
      })
    }));
  });
}

// A port nothing listens on: bind one, read it back, then let go of it.
async function closedPort() {
  const listener = await listenOnLoopback();
  const port = listener.port;
  await listener.close();
  return port;
}

function makeKernel() {
  return {
    engineStatus: async () => ({ engines: [], browser_status: 'closed' }),
    browserSessions: async () => ({ sessions: [] }),
    openBrowserSession: async () => ({}),
    saveBrowserSession: async () => ({}),
    searchWeb: async () => ({}),
    fetchPage: async () => ({}),
    searchAndFetch: async () => ({}),
    researchProblem: async () => ({}),
    getArtifact: () => ({ text: 'x' }),
    browserPool: null
  };
}

function listenServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverClose(server) {
  return new Promise(resolve => server.close(resolve));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// createApp() reads VNC configuration from process.env when it builds the probe, so an
// endpoint test patches the environment around the call and puts it back afterwards.
async function withApp(envPatch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(envPatch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    const { app } = createApp(makeKernel(), {});
    const server = await listenServer(app);
    try {
      await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await serverClose(server);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a service without a VNC password is healthy and says nothing is configured', async () => {
  const status = await new VncHealth(envWith()).status();
  assert.deepEqual(status, { configured: false, ok: true, reason: 'not_configured' });
});

test('VNC_HEALTH_CHECK=false silences the probe even with a password set', async () => {
  const status = await new VncHealth(envWith({ NOVNC_PASSWORD: 'pw', VNC_HEALTH_CHECK: 'false' })).status();
  assert.equal(status.configured, false);
  assert.equal(status.ok, true);
  assert.equal(status.reason, 'disabled');
});

test('both ports answering is ok', async () => {
  const rfbListener = await listenOnLoopback();
  const novncListener = await listenOnLoopback();
  try {
    const health = new VncHealth(envWith({
      NOVNC_PASSWORD: 'pw',
      LOCAL_SEARCH_VNC_PORT: rfbListener.port,
      LOCAL_SEARCH_NOVNC_PORT: novncListener.port
    }));
    const status = await health.status();
    assert.equal(status.configured, true);
    assert.equal(status.ok, true);
    assert.equal(status.host, '127.0.0.1');
    assert.equal(status.rfb.port, rfbListener.port);
    assert.equal(status.rfb.open, true);
    assert.equal(status.rfb.reason, undefined, 'an open port has nothing to explain');
    assert.equal(status.novnc.port, novncListener.port);
    assert.equal(status.novnc.open, true);
  } finally {
    await rfbListener.close();
    await novncListener.close();
  }
});

test('a dead x11vnc is not healthy even while websockify still answers', async () => {
  const novncListener = await listenOnLoopback();
  const deadRfbPort = await closedPort();
  try {
    const health = new VncHealth(envWith({
      NOVNC_PASSWORD: 'pw',
      LOCAL_SEARCH_VNC_PORT: deadRfbPort,
      LOCAL_SEARCH_NOVNC_PORT: novncListener.port
    }));
    const status = await health.status();
    assert.equal(status.ok, false);
    assert.equal(status.rfb.open, false);
    assert.equal(typeof status.rfb.reason, 'string');
    assert.equal(status.novnc.open, true);
  } finally {
    await novncListener.close();
  }
});

test('an unreachable host cannot delay the answer past the probe timeout', async () => {
  // TEST-NET-1 is not routable, so connect() never answers on its own and only the
  // deadline can end this. That is the whole point: /health must not hang.
  const health = new VncHealth(envWith({
    NOVNC_PASSWORD: 'pw',
    LOCAL_SEARCH_VNC_HEALTH_HOST: '10.255.255.1',
    VNC_HEALTH_TIMEOUT_MS: '150'
  }));
  const started = Date.now();
  const status = await health.status();
  const elapsed = Date.now() - started;
  assert.equal(status.ok, false);
  assert.ok(elapsed < 3000, `probe took ${elapsed}ms`);
});

test('the probe result is cached, then refreshed once the cache expires', async () => {
  const rfbListener = await listenOnLoopback();
  const novncListener = await listenOnLoopback();
  const base = {
    NOVNC_PASSWORD: 'pw',
    LOCAL_SEARCH_VNC_PORT: rfbListener.port,
    LOCAL_SEARCH_NOVNC_PORT: novncListener.port
  };
  try {
    const cached = new VncHealth(envWith({ ...base, VNC_HEALTH_CACHE_MS: '60000' }));
    const first = await cached.status();
    const second = await cached.status();
    assert.equal(first, second, 'a cached answer is reused, not re-probed');
    assert.equal(rfbListener.connections, 1);

    await rfbListener.close();
    const shortLived = new VncHealth(envWith({ ...base, VNC_HEALTH_CACHE_MS: '0' }));
    const after = await shortLived.status();
    assert.equal(after.ok, false, 'once the port is gone the next probe says so');
  } finally {
    await rfbListener.close();
    await novncListener.close();
  }
});

test('concurrent callers share one probe', async () => {
  const rfbListener = await listenOnLoopback();
  const novncListener = await listenOnLoopback();
  try {
    const health = new VncHealth(envWith({
      NOVNC_PASSWORD: 'pw',
      LOCAL_SEARCH_VNC_PORT: rfbListener.port,
      LOCAL_SEARCH_NOVNC_PORT: novncListener.port,
      VNC_HEALTH_CACHE_MS: '60000'
    }));
    const results = await Promise.all([
      health.status(), health.status(), health.status(), health.status(), health.status()
    ]);
    for (const status of results) assert.equal(status.ok, true);
    assert.equal(rfbListener.connections, 1);
    assert.equal(novncListener.connections, 1);
  } finally {
    await rfbListener.close();
    await novncListener.close();
  }
});

test('probeTcpPort answers once and reports a closed port as not open', async () => {
  const openListener = await listenOnLoopback();
  assert.deepEqual(await probeTcpPort('127.0.0.1', openListener.port, 500), { open: true });
  await openListener.close();
  const closed = await probeTcpPort('127.0.0.1', await closedPort(), 500);
  assert.equal(closed.open, false);
  assert.equal(typeof closed.reason, 'string');
});

test('GET /health turns a dead VNC into 503 so the container goes unhealthy', async () => {
  const deadRfbPort = await closedPort();
  const deadNovncPort = await closedPort();
  await withApp({
    NOVNC_PASSWORD: 'pw',
    LOCAL_SEARCH_VNC_HEALTH_HOST: '127.0.0.1',
    LOCAL_SEARCH_VNC_PORT: deadRfbPort,
    LOCAL_SEARCH_NOVNC_PORT: deadNovncPort,
    VNC_HEALTH_CACHE_MS: '0'
  }, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('x-local-search-ok'), 'false');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.vnc.configured, true);
    assert.equal(body.vnc.rfb.open, false);
    assert.equal(body.vnc.rfb.port, deadRfbPort);
  });
});

test('GET /health is ok while both VNC ports answer, and stays out of the limiter', async () => {
  const rfbListener = await listenOnLoopback();
  const novncListener = await listenOnLoopback();
  try {
    await withApp({
      NOVNC_PASSWORD: 'pw',
      LOCAL_SEARCH_VNC_HEALTH_HOST: '127.0.0.1',
      LOCAL_SEARCH_VNC_PORT: rfbListener.port,
      LOCAL_SEARCH_NOVNC_PORT: novncListener.port,
      VNC_HEALTH_CACHE_MS: '0'
    }, async (base) => {
      // RATE_LIMIT_MAX_REQUESTS is 1 for this process and MCP_BEARER_TOKEN is set: /health
      // is registered before both, or a 429/401 here would read as a dead container.
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-ratelimit-limit'), null);
        assert.equal((await res.json()).ok, true);
      }
      // ...and the limiter still applies to everything registered after /health.
      const unauthorized = await fetch(`${base}/engine_status`);
      assert.equal(unauthorized.status, 401, '/health sits above auth, this does not');
      const throttled = await fetch(`${base}/engine_status`);
      assert.equal(throttled.status, 429, 'the limiter itself is still live');
    });
  } finally {
    await rfbListener.close();
    await novncListener.close();
  }
});

test('GET /health reports nothing configured when there is no VNC password', async () => {
  await withApp({ NOVNC_PASSWORD: undefined }, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.vnc.configured, false);
  });
});
