process.env.BRAVE_API_KEY = 'k-brave';
process.env.TAVILY_API_KEY = 'k-tavily';
process.env.EXA_API_KEY = 'k-exa';
process.env.ENABLE_GOOGLE_API_FALLBACK = 'true';
process.env.GOOGLE_API_KEY = 'k-google';
process.env.GOOGLE_SEARCH_ENGINE_ID = 'cse-123';

import { test } from 'node:test';
import assert from 'node:assert';
import { undiciState, dnsState, makeResp } from './helpers/mocks.mjs';

const st = undiciState();
dnsState();

test('api_fallback with keys at import time', async () => {
  const { searchViaApi, searchWithFallbacks } = await import('../src/engines/api_fallback.js');
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { web: { results: [{ title: 'B', url: 'https://b.com', description: 'd' }] } } }));
  const brave = await searchViaApi('brave', 'q', 5);
  assert.strictEqual(brave[0].engine, 'brave');
  assert.ok(st.calls.at(-1).url.startsWith('https://api.search.brave.com'));

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 401, json: { error: 'x' } }));
  assert.deepStrictEqual(await searchViaApi('brave', 'q', 5), []);

  st.responses.length = 0;
  st.responses.push(makeResp({ json: { noResults: true } }));
  assert.deepStrictEqual(await searchViaApi('brave', 'q', 5), []);

  st.responses.length = 0;
  st.responses.push(makeResp({ json: { results: [{ title: 'T', url: 'https://t.com', content: 'c' }] } }));
  const tavily = await searchViaApi('tavily', 'q', 5);
  assert.strictEqual(tavily[0].engine, 'tavily');
  const tavilyInit = st.calls.at(-1).init;
  assert.strictEqual(tavilyInit.method, 'POST');
  assert.strictEqual(tavilyInit.body.includes('"api_key":"k-tavily"'), true);

  st.responses.length = 0;
  st.responses.push(makeResp({ json: { results: [{ title: 'E', url: 'https://e.com', text: 't' }] } }));
  const exa = await searchViaApi('exa', 'q', 5);
  assert.strictEqual(exa[0].engine, 'exa');

  st.responses.length = 0;
  st.responses.push(makeResp({ json: { items: [{ title: 'G', link: 'https://g.com', snippet: 's' }] } }));
  const g = await searchViaApi('google', 'q', 5);
  assert.strictEqual(g[0].engine, 'google');
  assert.ok(st.calls.at(-1).url.includes('key=k-google'));

  // json parse error → catch(()=>({})) → [] branch
  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: 'not-json{{' }));
  assert.deepStrictEqual(await searchViaApi('brave', 'q', 5), []);

  // searchWithFallbacks: first empty, second returns
  st.responses.length = 0;
  st.responses.push(
    makeResp({ status: 200, text: '{}' }),   // brave: no results
    makeResp({ json: { results: [{ title: 'E2', url: 'https://e2.com', text: 'x' }] } })
  );
  const wf = await searchWithFallbacks('q', 10, []);
  assert.strictEqual(wf.via, 'tavily');
  assert.strictEqual(wf.results[0].engine, 'tavily');

  // all others in failed list → falls through to google
  st.responses.length = 0;
  st.responses.push(makeResp({ json: { items: [{ title: 'G2', link: 'https://g2.com' }] } }));
  const wf2 = await searchWithFallbacks('q', 10, ['brave', 'tavily', 'exa']);
  assert.strictEqual(wf2.via, 'google');
  assert.strictEqual(wf2.results[0].engine, 'google');

  st.responses.length = 0;
  st.responses.push(makeResp({ status: 200, text: '{}' })); // google returns nothing
  assert.strictEqual(await searchWithFallbacks('q', 10, ['brave', 'tavily', 'exa']), null);

  // every fallback disabled by failed list → null
  st.responses.length = 0;
  assert.strictEqual(await searchWithFallbacks('q', 10, ['brave', 'tavily', 'exa', 'google']), null);
});
