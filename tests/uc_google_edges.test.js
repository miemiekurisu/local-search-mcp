process.env.GOOGLE_MIN_INTERVAL_MS = '0';

import { test } from 'node:test';
import assert from 'node:assert';
import { playwrightState } from './helpers/mocks.mjs';

playwrightState();

const SERP = '<html><body>' +
  '<div><div><div><a href="/url?q=https%3A%2F%2Fone.example.com%2Fa&amp;sa=U"><h3>Google Edge One</h3>padding text snippet context around the link block</a></div></div></div>' +
  '<div><div><div><a href="https://two.example.com/b"><h3>Google Edge Two</h3>second block body text to form a distinct snippet</a></div></div></div>' +
  '</body></html>';

const EMPTY = '<html><body><p>nothing here</p></body></html>';

function makePage({ html = EMPTY, serpHtml = SERP, searchBoxWorks = false } = {}) {
  const page = {
    curr: '',
    gotoLog: [],
    url: () => page.curr,
    async goto(u) { page.gotoLog.push(u); page.curr = u; return {}; },
    async waitForTimeout() {},
    async waitForLoadState() {},
    async content() {
      return page.gotoLog.some(u => String(u).includes('/search?q=') || String(u).includes('/search?')) ? serpHtml : html;
    },
    locator(sel) {
      return {
        first() {
          return {
            async waitFor() { if (!searchBoxWorks) throw new Error('searchbox missing'); },
            async click() {}
          };
        }
      };
    },
    keyboard: { type: async () => {}, press: async () => {} },
    mouse: { move: async () => {}, wheel: async () => {} }
  };
  return page;
}

function makePool(page) {
  return { withPage: async (opts, fn) => fn(page) };
}

test('google homepage failure falls back to direct-url parse', async () => {
  const { searchGoogleBrowser } = await import('../src/engines/google.js');
  const page = makePage({ searchBoxWorks: false });
  const results = await searchGoogleBrowser('edge query', { browserPool: makePool(page), limit: 5 });
  assert.ok(results.length >= 2, JSON.stringify(results));
  assert.equal(results[0].engine, 'google');
  assert.ok(page.gotoLog.some(u => u.includes('/search?q=') && u.includes('hl=en')));
});

test('google homepage typing covers both human pause branches', async () => {
  const { searchGoogleBrowser } = await import('../src/engines/google.js');
  const realRandom = Math.random.bind(Math);
  try {
    // constant rolls keep the pause branch deterministic (short pause arm < 0.08)
    Math.random = () => 0.001;
    const pageA = makePage({ html: SERP, searchBoxWorks: true });
    const resA = await searchGoogleBrowser('hex', { browserPool: makePool(pageA), limit: 5 });
    assert.ok(resA.length >= 2);
    assert.equal(pageA.gotoLog.some(u => u.includes('/search?q=')), false, 'homepage direct hit (short pause)');

    // medium pause arm (0.08 <= roll < 0.12)
    Math.random = () => 0.11;
    const pageB = makePage({ html: SERP, searchBoxWorks: true });
    const resB = await searchGoogleBrowser('hex2', { browserPool: makePool(pageB), limit: 5 });
    assert.ok(resB.length >= 2);
    assert.equal(pageB.gotoLog.some(u => u.includes('/search?q=')), false, 'homepage direct hit (medium pause)');
  } finally {
    Math.random = realRandom;
  }
});

test('google empty homepage + empty direct url throws SERP_PARSE_FAILED', async () => {
  const { searchGoogle } = await import('../src/engines/google.js');
  const page = makePage({ html: EMPTY, serpHtml: EMPTY });
  await assert.rejects(searchGoogle('no results query', { browserPool: makePool(page) }), (err) => {
    assert.equal(err.code, 'SERP_PARSE_FAILED');
    return true;
  });
});

function fakeAiPage({ evaluate }) {
  return {
    async goto() { return {}; },
    async waitForSelector(sel) {
      if (sel.includes('ITIRGe')) return undefined;
      throw new Error('no selector ' + sel);
    },
    async fill() {},
    async press() {},
    evaluate,
    async waitForTimeout() {}
  };
}

test('googleAI returns last text at deadline and throws NO_REPLY when silent', async () => {
  const { searchGoogleAI } = await import('../src/engines/googleAIMode.js');
  const realNow = Date.now.bind(Date);
  // Case 1: some text seen, then deadline jumps → returns last text
  {
    let evals = 0;
    Date.now = () => (evals >= 2 ? realNow() + 70000 : realNow());
    try {
      const text = await searchGoogleAI('q', {
        browserPool: { withPage: async (o, fn) => fn(fakeAiPage({ evaluate: async () => { evals++; return 'partial answer'; } })) }
      });
      assert.equal(text, 'partial answer');
    } finally {
      Date.now = realNow;
    }
  }
  // Case 2: silence all along → deadline jumps → NO_REPLY
  {
    Date.now = () => realNow() + 70000;
    try {
      await assert.rejects(searchGoogleAI('q', {
        browserPool: { withPage: async (o, fn) => fn(fakeAiPage({ evaluate: async () => '' })) }
      }), { code: 'GOOGLE_AI_NO_REPLY' });
    } finally {
      Date.now = realNow;
    }
  }
});
