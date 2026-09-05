process.env.CDP_URL = 'ws://127.0.0.1:19223/devtools/browser/edge';
process.env.STATE_DIR_BASE = process.env.TEMP || process.cwd();

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { playwrightState } from './helpers/mocks.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cdp-pass-'));
process.env.BROWSER_STATE_DIR = stateDir;

const st = playwrightState();

const { PlaywrightPool } = await import('../src/browser/playwrightPool.js');

test('CDP passthrough: ws/devtools endpoint returned without version fetch', async () => {
  const pool = new PlaywrightPool({ resolve: () => null });
  const ep = await pool.resolveCdpEndpoint();
  assert.strictEqual(ep, 'ws://127.0.0.1:19223/devtools/browser/edge');
  await pool.close();
});
