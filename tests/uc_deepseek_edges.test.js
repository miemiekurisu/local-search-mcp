process.env.DEEPSEEK_VALIDATE = 'true';
process.env.DEEPSEEK_TRACE_ENABLED = 'true';
process.env.DEEPSEEK_RETRY = '1';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-edge-'));
process.env.DEEPSEEK_TRACE_DIR = traceDir;

const { searchDeepSeek } = await import('../src/engines/deepseek.js');

function makeChainPool({ googleReply, dsAnswers }) {
  let dsAskCount = 0;
  const pool = {
    withPage: async (opts, fn) => {
      const isGoogle = opts.url === 'https://www.google.com/aimode';
      const page = {
        url: () => (isGoogle ? 'https://www.google.com/aimode' : 'https://chat.deepseek.com/'),
        async goto() { return {}; },
        isClosed: () => false,
        async waitForSelector(sel) {
          if (isGoogle && sel.includes('ITIRGe')) return undefined;
          if (!isGoogle && sel.includes('Message DeepSeek')) return undefined;
          throw new Error('no selector ' + sel);
        },
        async fill() {},
        async press() {},
        async waitForTimeout(ms) { return new Promise(r => setTimeout(r, Math.min(ms, 3))); },
        async evaluate() {
          if (isGoogle) return googleReply;
          const ans = dsAskCount < dsAnswers.length ? dsAnswers[dsAskCount] : dsAnswers[dsAnswers.length - 1];
          return { answer: ans.answer ?? ans, reasoning: ans.reasoning ?? '', isGenerating: false };
        },
        mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} }
      };
      const out = await fn(page);
      if (!isGoogle) dsAskCount++;
      return out;
    }
  };
  pool.dsAskCount = () => dsAskCount;
  return pool;
}

test('validated synthesis keeps second answer reasoning in result', async () => {
  const pool = makeChainPool({
    googleReply: 'mostly right, one caveat',
    dsAnswers: [{ answer: 'initial answer' }, { answer: 'final synthesized text here', reasoning: 'deep think chain for synthesis' }]
  });
  const [res] = await searchDeepSeek('question about quantization', { browserPool: pool });
  assert.strictEqual(res.validate, 'done');
  assert.equal(res.reasoning, 'deep think chain for synthesis');
  assert.strictEqual(res.snippet, 'final synthesized text here');
});

test('saveTrace failure is logged not thrown', async () => {
  const badDir = path.join(traceDir, 'not-a-dir.txt');
  fs.writeFileSync(badDir, 'x');
  process.env.DEEPSEEK_TRACE_DIR = badDir;
  const pool = makeChainPool({
    googleReply: null,
    dsAnswers: [{ answer: 'plain edge answer' }]
  });
  pool.withPage = ((orig) => async (opts, fn) => {
    if (opts.url === 'https://www.google.com/aimode') throw new Error('GOOGLE_AI_UNAVAILABLE edge');
    return orig(opts, fn);
  })(pool.withPage);
  const [res] = await searchDeepSeek('q trace boom', { browserPool: pool });
  assert.strictEqual(res.validate, 'disabled');
  assert.strictEqual(res.snippet, 'plain edge answer');
});
