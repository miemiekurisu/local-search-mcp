process.env.DEEPSEEK_VALIDATE = 'true';
process.env.DEEPSEEK_TRACE_ENABLED = 'true';
process.env.DEEPSEEK_RETRY = '1';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-chain-'));
process.env.DEEPSEEK_TRACE_DIR = traceDir;

const { searchDeepSeek } = await import('../src/engines/deepseek.js');

function makeChainPool({ googleReply, dsAnswers }) {
  let dsAskCount = 0;
  const log = { fills: [], googleFills: 0 };
  const pool = {
    log,
    withPage: async (opts, fn) => {
      const isGoogle = opts.url === 'https://www.google.com/aimode';
      const page = {
        url: () => (isGoogle ? 'https://www.google.com/aimode' : 'https://chat.deepseek.com/'),
        gotoLog: [],
        async goto(u) { page.gotoLog.push(u); return {}; },
        isClosed: () => false,
        async waitForSelector(sel) {
          if (isGoogle && sel.includes('ITIRGe')) return undefined;
          if (!isGoogle && sel.includes('Message DeepSeek')) return undefined;
          throw new Error('no selector ' + sel);
        },
        async fill(sel, value) {
          if (isGoogle) log.googleFills++;
          log.fills.push({ target: isGoogle ? 'google' : 'ds', value });
        },
        async press() {},
        async waitForTimeout() {},
        async evaluate() {
          if (isGoogle) return googleReply;
          const ans = dsAskCount < dsAnswers.length ? dsAnswers[dsAskCount] : dsAnswers[dsAnswers.length - 1];
          return { answer: ans, reasoning: '', isGenerating: false };
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

test('validation chain: google reply feeds deepseek synthesis', async () => {
  const pool = makeChainPool({
    googleReply: 'checked: it is mostly correct',
    dsAnswers: ['first deepseek answer', 'final synthesized answer']
  });
  const [res] = await searchDeepSeek('orig question', { browserPool: pool });
  assert.strictEqual(res.validate, 'done');
  assert.strictEqual(res.snippet, 'final synthesized answer');
  assert.strictEqual(res.title, 'final synthesized answer');
  assert.strictEqual(res.google_reply, 'checked: it is mostly correct');
  assert.ok(res.deepseek_initial.includes('first deepseek answer'));
  assert.strictEqual(pool.dsAskCount(), 2, 'deepseek asked twice');
  assert.strictEqual(pool.log.googleFills, 1, 'google prompt filled once');
  const synthFill = pool.log.fills.find(f => f.target === 'ds' && f.value.includes('别的模型是这样回答的'));
  assert.ok(synthFill, 'synthesis prompt references google reply');
  assert.ok(synthFill.value.includes('checked: it is mostly correct'));
  assert.ok(synthFill.value.includes('orig question'));
  // trace file written with full chain
  const lines = fs.readFileSync(path.join(traceDir, 'deepseek_traces.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.validate_status, 'done');
  assert.strictEqual(rec.google_reply, 'checked: it is mostly correct');
  assert.ok(rec.final_answer === 'final synthesized answer');
});

test('validation chain: google AI unavailable → disabled, plain answer kept, trace notes google_unavailable', async () => {
  const pool = makeChainPool({ googleReply: null, dsAnswers: ['plain answer'] });
  pool.withPage = ((orig) => async (opts, fn) => {
    if (opts.url === 'https://www.google.com/aimode') throw new Error('GOOGLE_AI_UNAVAILABLE boom');
    return orig(opts, fn);
  })(pool.withPage);
  const [res] = await searchDeepSeek('q2', { browserPool: pool });
  assert.strictEqual(res.validate, 'disabled');
  assert.ok(res.validate_reason.includes('Google AI Mode unavailable'));
  assert.strictEqual(res.snippet, 'plain answer');
  const lines = fs.readFileSync(path.join(traceDir, 'deepseek_traces.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.validate_status, 'google_unavailable');
  assert.ok(rec.google_error.includes('boom'));
});
