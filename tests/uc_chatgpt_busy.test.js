// One shared Chrome-DevTools-MCP client and one selected ChatGPT tab: turns must
// never overlap, and the queue in front of them must stay bounded.
// CHATGPT_MAX_QUEUED is read when the engine module loads, hence the env-first layout.
process.env.CHATGPT_MAX_QUEUED = '1';

import { test } from 'node:test';
import assert from 'node:assert';
import { mcpClientState } from './helpers/mocks.mjs';

const mcp = mcpClientState();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBlock = (value) => '```json\n' + JSON.stringify(value) + '\n```';
const SNAPSHOT = '## Page content\nuid=cmp1 textbox "Chat with ChatGPT" multiline';

const events = [];
let filled = 0;

mcp.callTool = async (client, msg) => {
  await sleep(8); // make an overlapping turn observable in `events`
  const name = msg.name;
  if (name === 'list_pages') return { content: [{ type: 'text', text: '1: https://chatgpt.com/ [selected]' }] };
  if (name === 'select_page' || name === 'navigate_page' || name === 'click') {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  if (name === 'take_snapshot') return { content: [{ type: 'text', text: SNAPSHOT }] };
  if (name === 'fill') {
    filled += 1;
    events.push('fill:' + msg.arguments.value);
    return { content: [{ type: 'text', text: 'filled' }] };
  }
  if (name === 'evaluate_script') {
    const source = JSON.stringify(msg.arguments || {});
    if (source.includes('send-button')) {
      return { content: [{ type: 'text', text: jsonBlock({ sent: true, via: 'dom-click' }) }] };
    }
    return { content: [{ type: 'text', text: jsonBlock({
      url: 'https://chatgpt.com/', title: 'ChatGPT', bodyText: '', composerVisible: true,
      isGenerating: false, assistantCount: filled,
      latestAssistantText: filled ? 'answer-' + filled : '',
      latestTurnActionLabels: ['Read aloud'], latestTurnHasCompletionActions: true,
      notLoggedIn: false, loginIntercept: false
    }) }] };
  }
  throw new Error('unexpected tool ' + name);
};

const { searchChatGPT } = await import('../src/engines/chatgpt.js');

test('concurrent chatgpt searches run one at a time on the shared tab', async () => {
  const first = searchChatGPT('Q-alpha').then((results) => { events.push('end:Q-alpha'); return results; });
  await sleep(25);
  const second = searchChatGPT('Q-beta').then((results) => { events.push('end:Q-beta'); return results; });
  await sleep(25);

  // Q-alpha holds the lock and Q-beta is the single allowed waiter.
  await assert.rejects(searchChatGPT('Q-gamma'), (err) => {
    assert.strictEqual(err.code, 'CHATGPT_BUSY');
    assert.strictEqual(err.details.queued, 1);
    assert.strictEqual(err.details.max_queued, 1);
    assert.match(err.details.retry_hint, /CHATGPT_MAX_QUEUED/);
    return true;
  });
  const [firstResults, secondResults] = await Promise.all([first, second]);
  assert.strictEqual(filled, 2, 'the rejected search never touched the shared composer');
  assert.ok(firstResults[0].snippet.includes('answer-1'));
  assert.ok(secondResults[0].snippet.includes('answer-2'), 'the second turn saw the first one finish');
  assert.deepStrictEqual(events, ['fill:Q-alpha', 'end:Q-alpha', 'fill:Q-beta', 'end:Q-beta'],
    'turns did not interleave on the shared tab');
});

test('an aborted caller gives its chatgpt queue slot back', async () => {
  const holder = searchChatGPT('Q-holder');
  await sleep(25);
  const ac = new AbortController();
  const waiting = searchChatGPT('Q-abort', { signal: ac.signal });
  await sleep(15);
  ac.abort();
  await assert.rejects(waiting, (err) => {
    assert.strictEqual(err.code, 'ABORTED');
    assert.match(err.details.retry_hint, /one at a time/);
    return true;
  });
  // The abandoned waiter left the queue, so the next caller may take that slot.
  const queuedAgain = searchChatGPT('Q-next');
  await assert.rejects(searchChatGPT('Q-overflow'), { code: 'CHATGPT_BUSY' });
  const [held, next] = await Promise.all([holder, queuedAgain]);
  assert.ok(held[0].snippet.startsWith('answer-'));
  assert.ok(next[0].snippet.startsWith('answer-'));
});
