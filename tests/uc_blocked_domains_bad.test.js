import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const file = path.join(os.tmpdir(), `blocked-domains-bad-${Date.now()}.json`);
fs.writeFileSync(file, '{ not valid json !!');
process.env.BLOCKED_DOMAINS_FILE = file;

import { test } from 'node:test';
import assert from 'node:assert';

const normalize = await import('../src/utils/normalize.js');

test('invalid blocked domains file falls back to defaults', () => {
  const out = normalize.filterBlockedDomains([
    { url: 'https://a.example.com/x' },
    { url: 'https://sub.csdn.net/y' }
  ]);
  assert.deepStrictEqual(out, [{ url: 'https://a.example.com/x' }], 'default csdn.net block applied');
});
