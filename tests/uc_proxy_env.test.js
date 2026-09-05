import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), `proxy-profiles-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({
  corp2: {
    type: 'http',
    server: '${CORP_HOST:-http://fallback:9}/tenant',
    username: '${PROXY_USER}',
    password: 1234,
    tags: ['alpha', 'beta'],
    nested: { flag: true }
  },
  engine_proxies: { google: 'corp2' }
}));
process.env.CORP_HOST = 'http://real:8888';
process.env.PROXY_PROFILES_FILE = file;

import { test } from 'node:test';
import assert from 'node:assert';

const { ProxyRouter } = await import('../src/config/proxy.js');

test('proxy profiles env expansion: arrays, scalars, defaults, precedence', () => {
  const router = new ProxyRouter();
  const corp = router.profiles.corp2;
  assert.strictEqual(corp.server, 'http://real:8888/tenant', 'env value preferred over default');
  assert.strictEqual(corp.username, '', 'unset env falls back to default');
  assert.strictEqual(corp.password, 1234, 'non-string passes through untouched');
  assert.deepStrictEqual(corp.tags, ['alpha', 'beta'], 'array values expanded recursively');
  assert.deepStrictEqual(corp.nested, { flag: true }, 'nested objects expanded recursively');
  assert.strictEqual(router.resolveForEngine('google').proxyUrl, 'http://real:8888/tenant');
  assert.strictEqual(router.engineProxies.google, 'corp2');
});
