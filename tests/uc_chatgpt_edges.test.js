import { test } from 'node:test';
import assert from 'node:assert';
import { mcpClientState } from './helpers/mocks.mjs';

const mcp = mcpClientState();

function jsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function baseState() {
  return {
    url: 'https://chatgpt.com/', title: 'ChatGPT', bodyText: '',
    composerVisible: false, isGenerating: false, assistantCount: 0,
    latestAssistantText: '', latestTurnActionLabels: [],
    latestTurnHasCompletionActions: false, notLoggedIn: false, loginIntercept: false
  };
}

const SNAPSHOT_COMPOSER_ONLY = '## Page content\nuid=cmp1 textbox "Chat with ChatGPT" multiline';

function installClient({ evalStates, fallbackJson = null, listPagesText = '1: https://chatgpt.com/ [selected]' }) {
  const nav = [];
  let listCall = 0;
  mcp.callTool = async (client, msg) => {
    const name = msg.name;
    if (name === 'list_pages') {
      const text = typeof listPagesText === 'function' ? listPagesText(++listCall) : listPagesText;
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'new_page') return { content: [{ type: 'text', text: 'made page' }] };
    if (name === 'select_page') return { content: [{ type: 'text', text: 'ok' }] };
    if (name === 'navigate_page') { nav.push(JSON.stringify(msg.arguments || {})); return { content: [{ type: 'text', text: 'ok' }] }; }
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: SNAPSHOT_COMPOSER_ONLY }] };
    if (name === 'fill' || name === 'click') return { content: [{ type: 'text', text: 'did ' + name }] };
    if (name === 'evaluate_script') {
      if (fallbackJson && mcp.evalCount === 1) {
        mcp.evalCount = 2;
        return { content: [{ type: 'text', text: jsonBlock(fallbackJson) }] };
      }
      const spec = evalStates.shift();
      mcp.evalCount += 1;
      const state = typeof spec === 'function' ? spec() : spec;
      return { content: [{ type: 'text', text: jsonBlock(state) }] };
    }
    throw new Error('unexpected tool ' + name);
  };
  mcp.evalCount = 0;
  return nav;
}

test('chatgpt sendPrompt falls back to dom-click and labels-path completes reply', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 2;
  const polls = [
    baseState(), baseState(), baseState(), baseState(), baseState()
  ];
  for (const s of polls) {
    s.composerVisible = true; s.assistantCount = 3; s.latestAssistantText = 'answer via dom click'; s.latestTurnActionLabels = ['Read aloud'];
  }
  installClient({ evalStates: [ready, ...polls], fallbackJson: { sent: true, via: 'dom-click' } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('query needed');
  assert.ok(res.snippet.includes('answer via dom click'));
});

test('chatgpt settled polls without completion actions return text', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 2;
  const mk = (over = {}) => { const s = baseState(); s.composerVisible = true; s.assistantCount = 3; s.isGenerating = false; s.latestAssistantText = 'stable settled answer text'; Object.assign(s, over); return s; };
  installClient({ evalStates: [ready, mk(), mk(), mk()], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('query needed 2');
  assert.ok(res.snippet.includes('stable settled answer text'));
});

test('chatgpt NO_SUBMIT when dom fallback cannot find button', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1;
  installClient({ evalStates: [ready], fallbackJson: { sent: false } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('query x'), { code: 'NO_SUBMIT' });
});

test('chatgpt login intercept after send throws LOGIN_REQUIRED', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1;
  const after = baseState(); after.composerVisible = false; after.loginIntercept = true;
  installClient({ evalStates: [ready, after], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q inter'), (err) => {
    assert.equal(err.code, 'LOGIN_REQUIRED');
    assert.ok(String(err.details.retry_hint).includes('noVNC'));
    return true;
  });
});

test('chatgpt challenge state mid-reply throws INTERACTIVE_LOGIN_REQUIRED', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1;
  const after = baseState(); after.composerVisible = false; after.url = 'https://chatgpt.com/auth/login'; after.bodyText = 'checking your browser';
  installClient({ evalStates: [ready, after], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q auth'), { code: 'INTERACTIVE_LOGIN_REQUIRED' });
});

test('chatgpt notLoggedIn ready state proceeds anonymously with mode note', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 2; ready.notLoggedIn = true;
  // reply polls: assistant answered and turn settled
  const replyState = baseState(); replyState.composerVisible = true; replyState.assistantCount = 3;
  replyState.latestAssistantText = 'anonymous lightweight answer';
  replyState.latestTurnHasCompletionActions = true; replyState.latestTurnActionLabels = ['Copy response'];
  installClient({ evalStates: [ready, replyState, replyState, replyState], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('q nl');
  assert.strictEqual(res.engine, 'chatgpt');
  assert.strictEqual(res.mode, 'anonymous');
  assert.ok(res.auth_note.includes('匿名'), res.auth_note);
});

test('chatgpt navigates non-home selected page', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1;
  const after = baseState(); after.composerVisible = false; after.loginIntercept = true;
  const nav = installClient({ evalStates: [ready, after], fallbackJson: null, listPagesText: '1: https://www.chatgpt.com-mirror.org/chat/deep-conversation2 [selected]' });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q nav2'), { code: 'NO_SUBMIT' });
  assert.ok(nav.length >= 1, 'navigate_page invoked');
});

test('chatgpt opens new page when no chatgpt tab exists', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1;
  const after = baseState(); after.composerVisible = false; after.loginIntercept = true;
  installClient({
    evalStates: [ready, after],
    fallbackJson: { sent: true },
    listPagesText: (n) => n === 1 ? '1: chrome://version [selected]' : '1: chrome://version\n2: https://chatgpt.com/ [selected]'
  });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q newpage'), { code: 'LOGIN_REQUIRED' });
});

test('chatgpt ENGINE_ERROR when even new page cannot be found', async () => {
  installClient({ evalStates: [], listPagesText: '' });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  await assert.rejects(searchChatGPT('q void'), { code: 'ENGINE_ERROR' });
});

test('chatgpt anonymous backend failure falls fast with CHATGPT_BACKEND_ERROR', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1; ready.notLoggedIn = true;
  const failState = baseState(); failState.composerVisible = false;
  failState.bodyText = 'You said: q\nUnable to connect\nRetry';
  installClient({ evalStates: [ready, failState, failState, failState], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  let thrown;
  try { await searchChatGPT('q backend'); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected rejection');
  assert.strictEqual(thrown.code, 'CHATGPT_BACKEND_ERROR');
  assert.ok(String(thrown.message).includes('Unable to connect'));
});


test('chatgpt detects new reply in old conversation by text change even when count stays same', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 1; ready.latestAssistantText = 'old prior answer';
  const replyState = baseState(); replyState.composerVisible = true; replyState.assistantCount = 1;
  replyState.latestAssistantText = 'totally new answer text';
  replyState.latestTurnHasCompletionActions = true; replyState.latestTurnActionLabels = ['Copy response'];
  installClient({ evalStates: [ready, replyState, replyState], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  const [res] = await searchChatGPT('q oldconvo');
  assert.strictEqual(res.engine, 'chatgpt');
  assert.ok(res.title.includes('totally new answer text'));
});


test('chatgpt two-factor or plain auth page classifies pieces of classifyLoginFailure', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 2;
  const twofa = baseState(); twofa.composerVisible = false; twofa.url = 'https://chatgpt.com/auth/login?x=1'; twofa.bodyText = 'Two-factor authentication is required to continue.';
  installClient({ evalStates: [ready, twofa], fallbackJson: { sent: true } });
  const { searchChatGPT } = await import('../src/engines/chatgpt.js');
  let thrown2fa;
  try { await searchChatGPT('q 2fa', 0); } catch (e) { thrown2fa = e; }
  assert.ok(thrown2fa, 'expected rejection');
  assert.strictEqual(thrown2fa.code, 'INTERACTIVE_LOGIN_REQUIRED');
  assert.ok(String(thrown2fa.message).includes('CAPTCHA'));

  const plain = baseState(); plain.composerVisible = false; plain.url = 'https://chatgpt.com/auth/login?x=2'; plain.bodyText = 'Welcome back to ChatGPT.';
  installClient({ evalStates: [ready, plain], fallbackJson: { sent: true } });
  let thrown;
  try { await searchChatGPT('q plain'); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected rejection');
  assert.strictEqual(thrown.code, 'LOGIN_REQUIRED');
});

test('chatgpt poll debug logging emits when CHATGPT_DEBUG=1', async () => {
  const ready = baseState(); ready.composerVisible = true; ready.assistantCount = 2;
  const replyState = baseState(); replyState.composerVisible = true; replyState.assistantCount = 3;
  replyState.latestAssistantText = 'debug logged answer';
  replyState.latestTurnHasCompletionActions = true; replyState.latestTurnActionLabels = ['Copy response'];
  installClient({ evalStates: [ready, replyState, replyState], fallbackJson: { sent: true } });
  const orig = process.env.CHATGPT_DEBUG;
  process.env.CHATGPT_DEBUG = '1';
  try {
    const { searchChatGPT } = await import('../src/engines/chatgpt.js');
    const [res] = await searchChatGPT('q dbg');
    assert.ok(res.title.length > 0);
  } finally {
    if (orig === undefined) delete process.env.CHATGPT_DEBUG; else process.env.CHATGPT_DEBUG = orig;
  }
});

