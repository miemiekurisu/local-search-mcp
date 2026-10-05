// Unit tests for the bounded cancellable mutex that serialises non-parallelisable
// engines (ChatGPT shares one CDP client and one selected tab).
import { test } from 'node:test';
import assert from 'node:assert';
import { ExclusiveQueue } from '../src/common/exclusiveQueue.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('exclusive queue serialises holders and hands the lock over', async () => {
  const queue = new ExclusiveQueue({ name: 'chatgpt', maxQueued: 4, busyCode: 'CHATGPT_BUSY' });
  const order = [];
  let holders = 0;
  let peak = 0;
  const turn = async (name, holdMs) => {
    const release = await queue.acquire();
    holders++;
    peak = Math.max(peak, holders);
    order.push('start:' + name);
    await sleep(holdMs);
    holders--;
    order.push('end:' + name);
    release();
  };
  await Promise.all([turn('a', 30), turn('b', 20), turn('c', 10)]);
  assert.strictEqual(peak, 1, 'two holders were active at once');
  assert.deepStrictEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.deepStrictEqual(queue.status(), { name: 'chatgpt', busy: false, queued: 0, max_queued: 4 });
});

test("release is idempotent and cannot free the current holder", async () => {
  const queue = new ExclusiveQueue({ name: 'res' });
  const first = await queue.acquire();
  first();
  first();
  assert.strictEqual(queue.busy, false, 'double release stays a no-op');
  const second = await queue.acquire();
  assert.strictEqual(queue.busy, true);
  first();
  assert.strictEqual(queue.busy, true, 'a stale release must not free the current holder');
  second();
  assert.strictEqual(queue.busy, false);
});

test('overflow rejects with the configured code and status details', async () => {
  const queue = new ExclusiveQueue({ name: 'chatgpt', maxQueued: 1, busyCode: 'CHATGPT_BUSY' });
  const holder = await queue.acquire();
  const waiting = queue.acquire();
  await assert.rejects(queue.acquire(), (err) => {
    assert.strictEqual(err.code, 'CHATGPT_BUSY');
    assert.strictEqual(err.details.queued, 1);
    assert.strictEqual(err.details.max_queued, 1);
    assert.strictEqual(err.details.busy, true);
    assert.match(err.message, /try again later/);
    return true;
  });
  assert.strictEqual(queue.status().queued, 1, 'the rejected caller did not join the queue');
  holder();
  const handed = await waiting;
  assert.strictEqual(typeof handed, 'function');
  assert.strictEqual(queue.busy, true);
  handed();
  assert.strictEqual(queue.busy, false);
});

test('a waiting caller can abort without eating the hand-off', async () => {
  const queue = new ExclusiveQueue({ name: 'chatgpt' });
  const holder = await queue.acquire();
  const dying = new AbortController();
  const abandoned = queue.acquire(dying.signal);
  const survivor = queue.acquire();
  assert.strictEqual(queue.status().queued, 2);
  dying.abort();
  await assert.rejects(abandoned, { code: 'ABORTED' });
  assert.strictEqual(queue.status().queued, 1, 'the aborted waiter left the queue');
  holder();
  const release = await survivor;
  assert.strictEqual(typeof release, 'function', 'the lock still reached the surviving waiter');
  release();
  assert.strictEqual(queue.busy, false);
});

test('an already-aborted signal is rejected up front', async () => {
  const queue = new ExclusiveQueue({ name: 'chatgpt' });
  const ac = new AbortController();
  ac.abort(new Error('client gone'));
  await assert.rejects(queue.acquire(ac.signal), (err) => {
    assert.strictEqual(err.code, 'ABORTED');
    assert.strictEqual(err.message, 'client gone', 'the abort reason surfaces');
    return true;
  });
  assert.strictEqual(queue.busy, false, 'a dead caller never takes the lock');
});

test('a queued waiter that never had a signal still waits normally', async () => {
  const queue = new ExclusiveQueue({ name: 'x', maxQueued: 2 });
  const holder = await queue.acquire();
  let started = false;
  const pending = queue.acquire(null).then((release) => { started = true; return release; });
  await sleep(10);
  assert.strictEqual(started, false, 'the lock is exclusive even with no abort wiring');
  holder();
  const release = await pending;
  assert.strictEqual(started, true);
  release();
});
