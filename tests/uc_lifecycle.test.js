import './helpers/mocks.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { gracefulClose } = await import('../src/lifecycle.js');

test('gracefulClose closes pool, server, and calls exit', async () => {
  const log = [];
  let serverClosed = false;
  await gracefulClose({
    browserPool: { close: async () => { log.push('pool'); } },
    server: { close: (cb) => { serverClosed = true; cb(); } },
    exit: () => { log.push('exit'); }
  });
  assert.equal(serverClosed, true);
  assert.deepEqual(log, ['pool', 'exit']);
});

test('gracefulClose tolerates missing pool/server and close callbacks', async () => {
  await gracefulClose();
  let exitCalled = false;
  await gracefulClose({ exit: () => { exitCalled = true; } });
  assert.equal(exitCalled, true);
});

test('gracefulClose propagates pool close errors (only chrome-devtools close is swallowed)', async () => {
  await assert.rejects(
    gracefulClose({ browserPool: { close: async () => { throw new Error('pool boom'); } } }),
    /pool boom/
  );
});

// A wedged page.close() or an MCP SSE client that never disconnects used to hang
// shutdown forever, which keeps the whole browser resident on a small host.
test('gracefulClose leaves a shutdown step that never answers', async () => {
  const log = [];
  const startedAt = Date.now();
  await gracefulClose({
    timeoutMs: 30,
    browserPool: { close: () => new Promise(() => {}) },
    server: { close: () => {} },
    exit: () => { log.push('exit'); }
  });
  assert.deepEqual(log, ['exit']);
  assert.ok(Date.now() - startedAt < 1000, 'shutdown is bounded by the per-step deadline');
});

test('a shutdown step that fails after its deadline is not an unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await gracefulClose({
      timeoutMs: 5,
      browserPool: { close: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20)) },
      exit: () => {}
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, []);
});
