process.env.BRAVE_API_KEY = 'k-brave';
process.env.ENGINE_TIMEOUT_MS = '100';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from 'node:test';
import assert from 'node:assert';
import { undiciState, makeResp } from './helpers/mocks.mjs';

const enginesFile = path.join(os.tmpdir(), `custom-engines-${Date.now()}.json`);
fs.writeFileSync(enginesFile, JSON.stringify([
  { id: 'slowpoke', url_template: 'https://slow.example.com/{{query}}', selectors: { result: 'li', url: 'a' } },
  { id: 'fastpoke', url_template: 'https://fast.example.com/{{query}}', selectors: { result: 'li', url: 'a' } }
]));
process.env.CUSTOM_ENGINES_FILE = enginesFile;

const st = undiciState();
const { EngineRegistry } = await import('../src/engines/index.js');

function makeRegistry() {
  return new EngineRegistry({
    proxyRouter: {
      resolveForEngine: () => ({ profile: 'direct' }),
      resolve: () => null,
      status: () => ({ profiles: {}, engine_proxies: {} })
    },
    browserPool: { sessionStatus: () => ({}) }
  });
}

test('searchMany: fallback API supplies results with warning; normalizeEngines default/merge', async () => {
  // unknown engine fails without any fetch; brave fallback supplies results
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { web: { results: [{ title: 'B1', url: 'https://b.example.com/x', description: 'd1' }] } } }));
  const reg = makeRegistry();
  const res = await reg.searchMany('q', { engines: ['nonexistent-engine'], limit: 5 });
  assert.strictEqual(res.failures.length, 1);
  assert.deepStrictEqual(res.fallback_attempted_for, ['nonexistent-engine']);
  assert.deepStrictEqual(res.fallback_skipped, []);
  assert.ok(res.fallback && res.fallback.includes('brave'), String(res.fallback));
  assert.ok(res.results.some(r => r.url === 'https://b.example.com/x'), 'fallback result merged');

  // normalizeEngines: [] → auto default chain including custom engines
  st.responses.length = 0;
  const res2 = await reg.searchMany('q', { engines: [] });
  assert.deepStrictEqual(res2.engines_tried, ['duckduckgo', 'wikipedia', 'slowpoke', 'fastpoke']);

  // 'default' merged with extra engines, deduped
  const res3 = await reg.searchMany('q', { engines: ['default', 'duckduckgo'] });
  assert.deepStrictEqual(res3.engines_tried, ['duckduckgo', 'wikipedia', 'slowpoke', 'fastpoke']);
});

test('buildFailure injects chromium retry hint and normalizes string errors', () => {
  const reg = makeRegistry();
  const f = reg.buildFailure('chatgpt', Object.assign(new Error('boom'), { code: 'E1' }));
  assert.ok(f.retry_hint.includes('noVNC'));
  assert.strictEqual(f.code, 'E1');
  assert.ok(f.details.browser_session);

  const f2 = reg.buildFailure('nonexistent-engine', 'string error');
  assert.strictEqual(f2.code, 'ENGINE_ERROR');
  assert.strictEqual(f2.message, 'string error');
  assert.strictEqual(f2.details.browser_session, undefined);
  assert.strictEqual(f2.retry_hint, null);
});

test('engine success path and ENGINE_TIMEOUT via custom html engines', async () => {
  st.responses.length = 0;
  st.responses.push(makeResp({ text: '<html><body>slow</body></html>', hang: true }));
  st.responses.push(makeResp({ text: '<ul><li><a href="https://f.example.com/a">Fast title</a></li></ul>' }));
  const res = await makeRegistry().searchMany('q', { engines: ['slowpoke', 'fastpoke'] });
  const fail = res.failures.find(f => f.engine === 'slowpoke');
  assert.strictEqual(fail.code, 'ENGINE_TIMEOUT', JSON.stringify(res.failures));
  assert.ok(res.results.some(r => r.url === 'https://f.example.com/a'), JSON.stringify(res.results));
  assert.deepStrictEqual(res.engines_tried, ['slowpoke', 'fastpoke']);
});

test('searchMany interleaves dominant engine with later engines (no starvation)', async () => {
  const reg = makeRegistry();
  // monkey-patch one engine to return several results, another to return one
  const orig = reg.searchOne.bind(reg);
  let calls = 0;
  reg.searchOne = async (engine, ...rest) => {
    if (engine === 'dominant') {
      return [1, 2, 3, 4, 5, 6].map(n => ({ title: `d${n}`, url: `https://dom.example.com/${n}`, engine: 'dominant' }));
    }
    return await orig(engine, ...rest);
  };
  // 'wikipedia' passes through orig: its engine fetch will fail-fast in mocked env? ensure stub instead:
  reg.searchOne = async (engine, query, opts) => {
    if (engine === 'dominant') {
      return [1, 2, 3, 4, 5, 6].map(n => ({ title: `d${n}`, url: `https://dom.example.com/${n}`, engine: 'dominant' }));
    }
    return [{ title: 's1', url: 'https://side.example.com/1', engine }];
  };
  const res = await reg.searchMany('q', { engines: ['dominant', 'sidekick'], limit: 3 });
  const urls = res.results.map(r => r.url);
  // round-robin: dom1, side1, dom2, dom3, dom4 ... NOT dom1..dom6 first
  assert.strictEqual(urls[0], 'https://dom.example.com/1', JSON.stringify(urls));
  assert.strictEqual(urls[1], 'https://side.example.com/1', 'second slot must come from the later engine');
  assert.ok(urls.includes('https://dom.example.com/2'), 'dominant results still present');
});

