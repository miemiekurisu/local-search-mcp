import { getChromeDevtoolsMcpClient } from '../browser/chromeDevtoolsMcpClient.js';
import { getBrowserSession } from '../browser/sessionCatalog.js';
import { CONFIG } from '../config/index.js';
import { makeResult, SearchEngineError } from './base.js';

const CHATGPT_SESSION = getBrowserSession('chatgpt');

const CHAT_COMPOSER_PATTERNS = [
  /uid=([^\s]+)\s+textbox\s+"Chat with ChatGPT"/i,
  /uid=([^\s]+)\s+textbox\s+"Ask anything"/i,
  /uid=([^\s]+)\s+textbox\s+".*ChatGPT.*"/i,
  /uid=([^\s]+)\s+textbox\s+".*"\s+.*multiline/i
];

const SEND_BUTTON_PATTERNS = [
  /uid=([^\s]+)\s+button\s+"Send prompt"/i,
  /uid=([^\s]+)\s+button\s+"Send"/i
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pageContent(snapshotText) {
  const marker = '## Page content\n';
  const idx = String(snapshotText || '').indexOf(marker);
  return idx >= 0 ? String(snapshotText).slice(idx + marker.length) : String(snapshotText || '');
}

function findUid(snapshotText, patterns) {
  const content = pageContent(snapshotText);
  for (const line of content.split('\n')) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

function isChallengeState(state) {
  const url = String(state?.url || '');
  const text = `${state?.title || ''}\n${state?.bodyText || ''}`.toLowerCase();
  return (
    url.includes('__cf_chl_rt_tk=') ||
    url.includes('/cdn-cgi/challenge-platform/') ||
    text.includes('just a moment') ||
    text.includes('checking your browser') ||
    text.includes('verify you are human') ||
    text.includes('security check') ||
    text.includes('cloudflare')
  );
}

function classifyLoginFailure(state) {
  const url = String(state?.url || CHATGPT_SESSION.loginUrl);
  const text = `${state?.title || ''}\n${state?.bodyText || ''}`.toLowerCase();

  if (
    text.includes('wrong authentication method') ||
    text.includes('use the same social login') ||
    text.includes('already have an account using')
  ) {
    return new SearchEngineError(
      'AUTH_METHOD_MISMATCH',
      'ChatGPT account uses a different sign-in method. Use the original Google/Apple/Microsoft login in the shared browser session.',
      { session: 'chatgpt', login_url: CHATGPT_SESSION.loginUrl, current_url: url }
    );
  }

  if (
    isChallengeState(state) ||
    text.includes('captcha') ||
    text.includes('verification code') ||
    text.includes('two-factor')
  ) {
    return new SearchEngineError(
      'INTERACTIVE_LOGIN_REQUIRED',
      'ChatGPT requires interactive verification in the shared browser session. Complete the check manually in noVNC, then retry.',
      { session: 'chatgpt', login_url: CHATGPT_SESSION.loginUrl, current_url: url }
    );
  }

  return new SearchEngineError(
    'LOGIN_REQUIRED',
    'ChatGPT needs an existing logged-in browser session. Open the shared browser session and sign in manually, then save the session state.',
    { session: 'chatgpt', login_url: CHATGPT_SESSION.loginUrl, current_url: url }
  );
}

async function getChatState(client) {
  return await client.evaluateJson(`() => {
    const composer =
      document.querySelector('div[contenteditable="true"][id*="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]');
    const sendButton =
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]');
    const assistantMessages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
      .map(node => (node instanceof HTMLElement ? node.innerText.trim() : ''))
      .filter(Boolean)
      .slice(-8);
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 8000),
      composerVisible: Boolean(composer && (composer.getClientRects().length || composer.offsetWidth || composer.offsetHeight)),
      sendEnabled: Boolean(sendButton && !sendButton.disabled),
      assistantMessages
    };
  }`);
}

async function ensureSelectedChatPage(client) {
  const pages = await client.listPages();
  let target = pages.find(page => page.url.includes('chatgpt.com'));

  if (!target) {
    await client.newPage(CHATGPT_SESSION.homeUrl);
    const refreshed = await client.listPages();
    target = refreshed.find(page => page.url.includes('chatgpt.com')) || refreshed[refreshed.length - 1];
  }

  if (!target) {
    throw new SearchEngineError('ENGINE_ERROR', 'chrome-devtools-mcp could not open a ChatGPT page');
  }

  await client.selectPage(target.index);
  if (!target.url.startsWith(CHATGPT_SESSION.homeUrl)) {
    await client.navigatePage(CHATGPT_SESSION.homeUrl);
  }
}

async function waitForComposer(client, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await getChatState(client).catch(() => lastState);
    if (lastState?.composerVisible) {
      return lastState;
    }
    await sleep(isChallengeState(lastState) ? 1500 : 1000);
  }

  throw classifyLoginFailure(lastState);
}

async function sendPrompt(client, query) {
  const snapshot = await client.takeSnapshot();
  const composerUid = findUid(snapshot, CHAT_COMPOSER_PATTERNS);
  if (!composerUid) {
    throw new SearchEngineError('NO_INPUT', 'ChatGPT input box was not found in the browser snapshot');
  }

  await client.fill(composerUid, query);

  const snapshotAfterFill = await client.takeSnapshot();
  const sendButtonUid = findUid(snapshotAfterFill, SEND_BUTTON_PATTERNS);
  if (sendButtonUid) {
    await client.click(sendButtonUid);
    return;
  }

  const sent = await client.evaluateJson(`() => {
    const button =
      document.querySelector('button[data-testid="send-button"]:not([disabled])') ||
      document.querySelector('button[aria-label*="Send"]:not([disabled])');
    if (button instanceof HTMLElement) {
      button.click();
      return { sent: true, via: 'dom-click' };
    }
    return { sent: false };
  }`);

  if (!sent?.sent) {
    throw new SearchEngineError('NO_SUBMIT', 'ChatGPT submit button was not found after filling the prompt');
  }
}

async function waitForAssistantReply(client, baselineCount) {
  const deadline = Date.now() + Math.max(CONFIG.browserTimeoutMs * 3, 90000);
  let lastSeen = '';

  while (Date.now() < deadline) {
    const state = await getChatState(client);
    if (state.composerVisible && Array.isArray(state.assistantMessages)) {
      const latest = state.assistantMessages[state.assistantMessages.length - 1] || '';
      if (state.assistantMessages.length > baselineCount && latest.trim()) {
        if (latest === lastSeen) {
          return latest;
        }
        lastSeen = latest;
      }
    } else if (!state.composerVisible && (state.url.includes('/auth/') || isChallengeState(state))) {
      throw classifyLoginFailure(state);
    }

    await sleep(1500);
  }

  throw new SearchEngineError('NO_RESPONSE', 'Timed out waiting for ChatGPT response');
}

export async function searchChatGPT(query) {
  const client = getChromeDevtoolsMcpClient();

  await ensureSelectedChatPage(client);
  const readyState = await waitForComposer(client, 30000);
  const baselineCount = Array.isArray(readyState.assistantMessages) ? readyState.assistantMessages.length : 0;

  await sendPrompt(client, query);
  const response = await waitForAssistantReply(client, baselineCount);
  const snippet = response.slice(0, 1800);

  return [makeResult({
    title: response.slice(0, 100),
    url: CHATGPT_SESSION.homeUrl,
    snippet,
    engine: 'chatgpt',
    rank: 1
  })];
}
