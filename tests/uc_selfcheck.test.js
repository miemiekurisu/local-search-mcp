process.env.ARTIFACT_DIR = path.join(os.tmpdir(), 'uc-selfcheck-artifacts');
process.env.BROWSER_STATE_DIR = path.join(os.tmpdir(), 'uc-selfcheck-state');
process.env.PAPER_CACHE_ENABLED = 'false';
delete process.env.ENABLE_PAPER_TOOLS;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { selfCheckState } from './helpers/mocks.mjs';

const appM = await import('../src/app.js');
const { SearchKernel } = await import('../src/kernel/searchKernel.js');
const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');
selfCheckState();
const sc = selfCheckState();


test('app.js createKernel without paper tools returns null paper parts', async () => {
  const k = appM.createKernel();
  assert.ok(k.kernel instanceof SearchKernel);
  assert.ok(k.browserPool instanceof PlaywrightPool);
  assert.equal(typeof k.toolRegistry, 'object');
  assert.equal(k.paperKernel, null);
  assert.equal(k.paperContentKernel, null);
  assert.equal(k.paperCacheStore, null);
  assert.equal(k.paperCacheCleanup, null);
  await k.browserPool.close();
});

test('app.js createKernel with ENABLE_PAPER_TOOLS builds paper parts, warns on missing keys', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  process.env.ENABLE_PAPER_TOOLS = 'true';
  let k;
  try {
    k = appM.createKernel();
  } finally {
    console.warn = origWarn;
    delete process.env.ENABLE_PAPER_TOOLS;
  }
  assert.equal(k.paperKernel !== null, true);
  assert.equal(k.paperContentKernel !== null, true);
  assert.equal(k.paperCacheStore, null);
  assert.equal(k.paperCacheCleanup, null);
  const joined = warns.join('\n');
  assert.ok(joined.includes('OpenAlex'));
  assert.ok(joined.includes('CROSSREF_MAILTO'));
  await k.browserPool.close();
});

test('self_check happy path calls kernel then closes browser pool', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  sc.calls = [];
  sc.closes = 0;
  try {
    await import('../src/self_check.js?happy');
  } finally {
    console.log = origLog;
  }
  assert.equal(sc.calls.length, 1);
  assert.equal(sc.closes, 1);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('"ok"'));
});

test('self_check closes browser pool even when search fails', async () => {
  sc.failNext = true;
  const mark = sc.closes;
  await assert.rejects(import('../src/self_check.js?failure'), /selfcheck boom/);
  assert.equal(sc.closes, mark + 1);
});
