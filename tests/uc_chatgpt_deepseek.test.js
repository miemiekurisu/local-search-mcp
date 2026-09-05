process.env.DEEPSEEK_RETRY = '2';
process.env.DEEPSEEK_TIMEOUT_MS = '20000';
process.env.DEEPSEEK_VALIDATE = 'false';
process.env.DEEPSEEK_TRACE_ENABLED = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { mcpClientState, childProcessState } from './helpers/mocks.mjs';

const mcp = mcpClientState();
const cp = childProcessState();

// ── deepseek (plain, no validation/trace) ───────────────────
const mkFakePool = () => {
  const log = { fills: [], evals: 0, selectors: [], pressed: null };
  const pool = {
    withPage: async (opts, fn) => {
      const page = {
        curr: '',
        gotoLog: [],
        url: () => page.curr,
        async goto(u, o = {}) { page.gotoLog.push(u); page.curr = u; return {}; },
        isClosed: () => false,
        async waitForSelector(sel, o = {}) {
          log.selectors.push(sel);
          if (sel.includes('Message DeepSeek')) return undefined;
          throw new Error('no such selector: ' + sel);
        },
        async fill(sel, value) { log.fills.push({ sel, value }); },
        async press(sel, key) { log.pressed = key; },
        async waitForTimeout(ms) { return new Promise(r => setTimeout(r, Math.min(ms, 3))); },
        async evaluate(src, args) {
          log.evals++;
          return log.replyState || { answer: '', reasoning: '', isGenerating: false };
        },
        mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} }
      };
      return await fn(page);
    }
  };
  pool.log = log;
  return pool;
};

test('deepseek plain answer + reasoning', async () => {
  const { searchDeepSeek } = await import('../src/engines/deepseek.js');
  const pool = mkFakePool();
  pool.log.replyState = { answer: 'DeepSeek final answer here', reasoning: 'chain of thought x1 chain of thought', isGenerating: false };
  const [res] = await searchDeepSeek('what is rust language', { browserPool: pool });
  assert.strictEqual(res.engine, 'deepseek');
  assert.strictEqual(res.title, 'DeepSeek final answer here');
  assert.ok(res.snippet.startsWith('DeepSeek final answer'));
  assert.strictEqual(res.reasoning_included, true);
  assert.ok(res.reasoning.includes('chain of thought'));
  assert.strictEqual(res.verify_requested, false);
  assert.strictEqual(pool.log.fills[0].value, 'what is rust language');
  assert.strictEqual(pool.log.pressed, 'Enter');
});

test('deepseek input too long', async () => {
  const { searchDeepSeek } = await import('../src/engines/deepseek.js');
  await assert.rejects(searchDeepSeek('x'.repeat(2500), {}), err => {
    assert.strictEqual(err.code, 'INPUT_TOO_LONG');
    assert.strictEqual(err.details.max_input_chars, 2000);
    return true;
  });
});

test('deepseek login required when composer missing', async () => {
  const { searchDeepSeek } = await import('../src/engines/deepseek.js');
  const pool = {
    withPage: async (opts, fn) => fn({
      url: () => 'https://chat.deepseek.com/',
      async goto() {},
      async waitForSelector() { throw new Error('timeout'); },
      async waitForTimeout() {}
    })
  };
  await assert.rejects(searchDeepSeek('q', { browserPool: pool }), { code: 'LOGIN_REQUIRED' });
});

test('deepseek NO_RESPONSE when no answer arrives', async () => {
  const { searchDeepSeek } = await import('../src/engines/deepseek.js');
  const pool = mkFakePool();
  pool.log.replyState = { answer: '', reasoning: '', isGenerating: true };
  await assert.rejects(searchDeepSeek('q', { browserPool: pool }), { code: 'NO_RESPONSE' });
});

// ── chatgpt ─────────────────────────────────────────────────
function jsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

const SNAPSHOT_OK = '## Page content\nuid=cmp1 textbox "Chat with ChatGPT" multiline\nuid=send1 button "Send prompt"';

function defaultChatGptState() {
  return {
    url: 'https://chatgpt.com/', title: 'ChatGPT', bodyText: '',
    composerVisible: false, isGenerating: false, assistantCount: 0,
    latestAssistantText: '', latestTurnActionLabels: [],
    latestTurnHasCompletionActions: false, notLoggedIn: false, loginIntercept: false
  };
}

test('chatgpt happy path full state machine', async () => {
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') return { content: [{ type: 'text', text: '1: https://chatgpt.com/ [selected]' }] };
    if (name === 'select_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'navigate_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'take_snapshot') {
      return { content: [{ type: 'text', text: SNAPSHOT_OK }] };
    }
    if (name === 'fill' || name === 'click') return { content: [{ type: 'text', text: 'did ' + name }] };
    if (name === 'evaluate_script') {
      mcp.evalCount = (mcp.evalCount || 0) + 1;
      const state = defaultChatGptState();
      if (mcp.evalCount === 1) {
        state.composerVisible = true;
        state.assistantCount = 2;
        state.latestAssistantText = 'old';
      } else {
        state.composerVisible = true;
        state.assistantCount = 3;
        state.latestAssistantText = 'the answer about rust';
        state.latestTurnActionLabels = ['Copy response', 'Good response'];
        state.latestTurnHasCompletionActions = true;
      }
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  mcp.evalCount = 0;
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('tell me about rust', 10);
  assert.strictEqual(res.engine, 'chatgpt');
  assert.strictEqual(res.url, 'https://chatgpt.com');
  assert.ok(res.snippet.includes('the answer about rust'));
});

test('chatgpt no target page → opens new page at home url', async () => {
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') {
      mcp.listCalls = (mcp.listCalls || 0) + 1;
      if (mcp.listCalls === 1) return { content: [{ type: 'text', text: '0: https://example.com/other' }] };
      return { content: [{ type: 'text', text: '0: https://example.com/other\n1: https://chatgpt.com/' }] };
    }
    if (name === 'select_page' || name === 'new_page' || name === 'navigate_page') {
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: SNAPSHOT_OK }] };
    if (name === 'fill' || name === 'click') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'evaluate_script') {
      mcp.evalCount = (mcp.evalCount || 0) + 1;
      const state = defaultChatGptState();
      state.composerVisible = true;
      state.assistantCount = mcp.evalCount; // grows each poll? keep stable
      state.latestAssistantText = 'answer';
      state.latestTurnHasCompletionActions = true;
      state.latestTurnActionLabels = ['Copy response'];
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  mcp.listCalls = 0;
  mcp.evalCount = 0;
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('q', 10);
  assert.strictEqual(res.engine, 'chatgpt');
});

test('chatgpt anonymous lightweight chat succeeds with mode note; challenge → INTERACTIVE_LOGIN_REQUIRED', async () => {
  let mode = 'anonymous';
  let evals = 0;
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') return { content: [{ type: 'text', text: '0: https://chatgpt.com/ [selected]' }] };
    if (name === 'select_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: SNAPSHOT_OK }] };
    if (name === 'fill' || name === 'click') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'evaluate_script') {
      evals++;
      const state = defaultChatGptState();
      if (mode === 'challenge') {
        state.composerVisible = false;
        state.bodyText = 'Just a moment... enabling javascript and cookies are needed';
        state.url = 'https://chatgpt.com/__cf_chl_rt_tk=abc';
        return { content: [{ type: 'text', text: jsonBlock(state) }] };
      }
      if (evals === 1) {
        state.composerVisible = true;
        state.notLoggedIn = true;
        state.assistantCount = 0;
        return { content: [{ type: 'text', text: jsonBlock(state) }] };
      }
      // reply polls: assistant answered and turn settled
      state.composerVisible = true;
      state.assistantCount = 1;
      state.latestAssistantText = 'anonymous answer text';
      state.latestTurnHasCompletionActions = true;
      state.latestTurnActionLabels = ['Copy response'];
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  mcp.listCalls = 0;
  mcp.evalCount = 0;
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('q anonymous', 10);
  assert.strictEqual(res.engine, 'chatgpt');
  assert.strictEqual(res.mode, 'anonymous');
  assert.ok(res.auth_note.includes('匿名'), res.auth_note);
  mode = 'challenge';
  await assert.rejects(searchChatGPT('q', 10), { code: 'INTERACTIVE_LOGIN_REQUIRED' });
});

test('chatgpt auth mismatch classification', async () => {
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') return { content: [{ type: 'text', text: '0: https://chatgpt.com/ [selected]' }] };
    if (name === 'select_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: SNAPSHOT_OK }] };
    if (name === 'fill' || name === 'click') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'evaluate_script') {
      const state = defaultChatGptState();
      state.url = 'https://chatgpt.com/auth/login';
      state.title = 'Sign in';
      state.bodyText = 'You already have an account using Google sign-in. use the same social login';
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q', 10), { code: 'AUTH_METHOD_MISMATCH' });
});

test('chatgpt mcp connection failure → BROWSER_UNAVAILABLE', async () => {
  let phase = 0;
  mcp.callTool = async (client, msg) => {
    if (msg.name === 'list_pages') { phase++; return { content: [{ type: 'text', text: '0: https://chatgpt.com/ [selected]' }] }; }
    if (phase >= 1) throw new Error('fetch failed: ECONNREFUSED from browser');
    throw new Error('backend socket error');
  };
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q', 10), { code: 'BROWSER_UNAVAILABLE' });
});

test('chatgpt NO_INPUT when snapshot lacks composer', async () => {
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') return { content: [{ type: 'text', text: '0: https://chatgpt.com/ [selected]' }] };
    if (name === 'select_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: '## Page content\nuid=send1 button "Send prompt"' }] };
    if (name === 'evaluate_script') {
      const state = defaultChatGptState();
      state.composerVisible = true;
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q', 10), { code: 'NO_INPUT' });
});

test('chatgpt mcp failure without tool error gives CHROME_DEVTOOLS_MCP_ERROR', async () => {
  let first = true;
  mcp.callTool = async (client, msg) => {
    if (msg.name === 'list_pages' && first) { first = false; return { content: [{ type: 'text', text: '0: https://chatgpt.com/ [selected]' }] }; }
    throw Object.assign(new Error('weird crash'), { isError: false });
  };
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q', 10), { code: 'CHROME_DEVTOOLS_MCP_ERROR' });
});

// ── chrome engine ───────────────────────────────────────────
test('chrome searchViaChromeDevTools parses ndjson via mocked exec', async () => {
  cp.exec = (cmd, opts, cb) => {
    assert.ok(cmd.includes('search --query'));
    assert.strictEqual(opts.timeout, 30000);
    cb(null, { stdout: '{"title":"T1","url":"https://a.com/1","snippet":"s"}\nnotjson\n{"url":"https://b.com/2"}\n', stderr: '' });
  };
  const { searchViaChromeDevTools } = await import('../src/engines/chrome.js');
  const res = await searchViaChromeDevTools('q', { limit: 2 });
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].engine, 'chrome');
  assert.strictEqual(res[1].url, 'https://b.com/2');
});

test('chrome exec failure → empty list, dangerous chars stripped', async () => {
  cp.exec = (cmd, opts, cb) => {
    assert.strictEqual(cmd.includes('|'), false);
    cb(new Error('spawn failed'));
  };
  const { searchViaChromeDevTools, searchGoogleViaChrome } = await import('../src/engines/chrome.js');
  assert.deepStrictEqual(await searchViaChromeDevTools('x|y;rm'), []);
  assert.deepStrictEqual(await searchGoogleViaChrome('alias test'), []);
});

test('chrome engine: non-string query, stderr log, non-string stdout parse fallback', async () => {
  cp.exec = (cmd, opts, cb) => cb(null, { stdout: '{"title":"T","url":"https://a.com/3"}', stderr: 'some warning text' });
  const { searchViaChromeDevTools } = await import('../src/engines/chrome.js');
  assert.deepStrictEqual(await searchViaChromeDevTools(123), []);
  const res = await searchViaChromeDevTools('q2');
  assert.strictEqual(res[0].url, 'https://a.com/3');
  cp.exec = (cmd, opts, cb) => cb(null, { stdout: null, stderr: '' });
  assert.deepStrictEqual(await searchViaChromeDevTools('q3'), []);
});
