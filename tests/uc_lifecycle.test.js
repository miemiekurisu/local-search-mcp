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
