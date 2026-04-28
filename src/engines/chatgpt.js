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

const TURN_COMPLETION_ACTION_PATTERNS = [
  /\bcopy response\b/i,
  /\bgood response\b/i,
  /\bbad response\b/i,
  /\bread aloud\b/i,
  /复制(响应|回答)/,
  /好的(回复|回答)/,
  /不好的(回复|回答)/
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
      {
        session: 'chatgpt',
        login_url: CHATGPT_SESSION.loginUrl,
        current_url: url,
        cdp_url: CONFIG.chromeDevtoolsMcpBrowserUrl,
        retry_hint: 'Open the chatgpt session in noVNC, finish the human/2FA/security check in the visible Chromium, then retry.'
      }
    );
  }

  return new SearchEngineError(
    'LOGIN_REQUIRED',
    'ChatGPT needs an existing logged-in browser session. Open the shared browser session and sign in manually, then save the session state.',
    {
      session: 'chatgpt',
      login_url: CHATGPT_SESSION.loginUrl,
      current_url: url,
      cdp_url: CONFIG.chromeDevtoolsMcpBrowserUrl,
      retry_hint: 'Open the chatgpt session in noVNC, sign in to ChatGPT in the visible Chromium, save the session, then retry.'
    }
  );
}

function chatGptErrorDetails(extra = {}) {
  return {
    session: 'chatgpt',
    login_url: CHATGPT_SESSION.loginUrl,
    home_url: CHATGPT_SESSION.homeUrl,
    cdp_url: CONFIG.chromeDevtoolsMcpBrowserUrl,
    retry_hint: 'Open the chatgpt session in noVNC and make sure the visible Chromium is logged in and past any human verification.',
    ...extra
  };
}

function classifyMcpFailure(err) {
  const message = String(err?.message || err || '');
  if (/ECONNREFUSED|fetch failed|browser.*closed|Target page, context or browser has been closed|connect/i.test(message)) {
    return 'BROWSER_UNAVAILABLE';
  }
  return 'CHROME_DEVTOOLS_MCP_ERROR';
}

async function getChatState(client) {
  return await client.evaluateJson(`() => {
    const completionPattern = /copy response|good response|bad response|read aloud|复制(响应|回答)|好的(回复|回答)|不好的(回复|回答)/i;
    const buttonLabel = button =>
      (button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim();
    const collectButtonLabels = root =>
      Array.from(root?.querySelectorAll?.('button') || [])
        .map(buttonLabel)
        .filter(Boolean)
        .slice(0, 40);
    const assistantNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const latestAssistant = assistantNodes[assistantNodes.length - 1];
    const candidateSet = new Set();
    const candidates = [];
    const pushCandidate = candidate => {
      if (candidate instanceof HTMLElement && !candidateSet.has(candidate)) {
        candidateSet.add(candidate);
        candidates.push(candidate);
      }
    };
    pushCandidate(latestAssistant?.closest?.('[data-testid^="conversation-turn-"]'));
    pushCandidate(latestAssistant?.closest?.('[data-message-id]'));
    for (let node = latestAssistant; node instanceof HTMLElement; node = node.parentElement) {
      pushCandidate(node);
      if (candidates.length >= 8) break;
    }

    let latestTurnActionLabels = [];
    let latestTurnHasCompletionActions = false;
    for (const candidate of candidates) {
      const labels = collectButtonLabels(candidate);
      const hasCompletionActions = labels.some(label => completionPattern.test(label));
      if (hasCompletionActions) {
        latestTurnActionLabels = labels;
        latestTurnHasCompletionActions = true;
        break;
      }
      if (!latestTurnActionLabels.length && labels.length) {
        latestTurnActionLabels = labels;
      }
    }

    const composer =
      document.querySelector('div[contenteditable="true"][id*="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]');
    const stopButton =
      document.querySelector('button[data-testid="stop-button"]') ||
      Array.from(document.querySelectorAll('button')).find(button => /stop/i.test(buttonLabel(button)));
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 8000),
      composerVisible: Boolean(composer && (composer.getClientRects().length || composer.offsetWidth || composer.offsetHeight)),
      isGenerating: Boolean(stopButton),
      assistantCount: assistantNodes.length,
      latestAssistantText: latestAssistant instanceof HTMLElement ? latestAssistant.innerText.trim() : '',
      latestTurnActionLabels,
      latestTurnHasCompletionActions
    };
  }`);
}

function hasTurnCompletionActions(state) {
  if (state?.latestTurnHasCompletionActions) {
    return true;
  }
  return (state?.latestTurnActionLabels || []).some(label =>
    TURN_COMPLETION_ACTION_PATTERNS.some(pattern => pattern.test(label))
  );
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
  let stablePolls = 0;
  let completionActionPolls = 0;
  let settledPolls = 0;

  while (Date.now() < deadline) {
    const state = await getChatState(client);
    if (state.composerVisible) {
      const latest = String(state.latestAssistantText || '').trim();
      if (state.assistantCount > baselineCount && latest) {
        const textUnchanged = latest === lastSeen;
        stablePolls = textUnchanged ? stablePolls + 1 : 0;
        completionActionPolls = hasTurnCompletionActions(state) ? completionActionPolls + 1 : 0;
        settledPolls = state.isGenerating ? 0 : settledPolls + 1;

        if (completionActionPolls >= 2 && stablePolls >= 1) {
          return latest;
        }

        if (settledPolls >= 2 && stablePolls >= 2) {
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
  try {
    const client = getChromeDevtoolsMcpClient();

    await ensureSelectedChatPage(client);
    const readyState = await waitForComposer(client, 30000);
    const baselineCount = Number(readyState.assistantCount || 0);

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
  } catch (err) {
    if (err instanceof SearchEngineError) {
      err.details = chatGptErrorDetails(err.details);
      throw err;
    }
    throw new SearchEngineError(
      classifyMcpFailure(err),
      `ChatGPT Chromium session failed: ${err?.message || err}`,
      chatGptErrorDetails()
    );
  }
}
