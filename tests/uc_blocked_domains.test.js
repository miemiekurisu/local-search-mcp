import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const file = path.join(os.tmpdir(), `blocked-domains-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(['example-blocked.org', 42, 'CaseExample.ORG']));
process.env.BLOCKED_DOMAINS_FILE = file;

import { test } from 'node:test';
import assert from 'node:assert';

const normalize = await import('../src/utils/normalize.js');

test('custom blocked domains file loads, filters non-strings, lowercases', () => {
  const out = normalize.filterBlockedDomains([
    { url: 'https://a.example.com/x' },
    { url: 'https://sub.example-blocked.org/y' },
    { url: 'https://caseexample.org/low' }
  ]);
  assert.deepStrictEqual(out, [{ url: 'https://a.example.com/x' }]);
});
