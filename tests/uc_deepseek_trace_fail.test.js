import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const badDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-trace-')), 'blocker.txt');
fs.writeFileSync(badDir, 'x');
process.env.DEEPSEEK_TRACE_DIR = badDir;
process.env.DEEPSEEK_TRACE_ENABLED = 'true';
process.env.DEEPSEEK_VALIDATE = 'false';
process.env.DEEPSEEK_RETRY = '1';

import { test } from 'node:test';
import assert from 'node:assert';

const { searchDeepSeek } = await import('../src/engines/deepseek.js');

test('saveTrace mkdir failure logged, search still succeeds', async () => {
  const pool = {
    withPage: async (opts, fn) => {
      const page = {
        url: () => 'https://chat.deepseek.com/',
        async goto() { return {}; },
        isClosed: () => false,
        async waitForSelector(sel) {
          if (sel.includes('Message DeepSeek')) return undefined;
          throw new Error('no selector ' + sel);
        },
        async fill() {},
        async press() {},
        async waitForTimeout(ms) { return new Promise(r => setTimeout(r, Math.min(ms, 3))); },
        async evaluate() { return { answer: 'trace fail answer', reasoning: '', isGenerating: false }; },
        mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} }
      };
      return await fn(page);
    }
  };
  const [res] = await searchDeepSeek('q with failing trace dir', { browserPool: pool });
  assert.strictEqual(res.snippet, 'trace fail answer');
});
