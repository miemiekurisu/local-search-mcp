import { CONFIG } from '../config/index.js';
import { SearchEngineError, makeResult } from './base.js';

const HOME_URL = 'https://chat.deepseek.com';
const COMPOSER_SELECTOR = 'textarea[placeholder="Message DeepSeek"]';
const ANSWER_SELECTOR = '.ds-assistant-message-main-content';
const THINK_SELECTOR = '.ds-think-content';

function envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

// Configurable output knobs (see .env.example / docker-compose.yml).
const MAX_SNIPPET = envInt('DEEPSEEK_MAX_SNIPPET', 20000, 500);
const INCLUDE_REASONING = process.env.DEEPSEEK_INCLUDE_REASONING !== 'false';
const MAX_REASONING = envInt('DEEPSEEK_MAX_REASONING', 8000, 0);
const VERIFY = process.env.DEEPSEEK_VERIFY === 'true';
const TIMEOUT_MS = envInt('DEEPSEEK_TIMEOUT_MS', 150000, 20000);

// When VERIFY is on, ask DeepSeek to separate established facts from inference,
// cite evidence for key data, and flag uncertainty — so the output is checkable.
const VERIFY_SUFFIX = [
  '',
  '【正确性验证要求】',
  '在回答中请明确区分：1) 确凿事实（尽量附来源或依据）；2) 推断或不确定的内容。',
  '对关键数据、数字、流程给出依据或出处；若无法确定请明确标注"不确定"。',
  '最后用一段"正确性自检"说明哪些结论可靠、哪些需要进一步核验。'
].join('\n');

function loginRequired(page) {
  return new SearchEngineError(
    'LOGIN_REQUIRED',
    'DeepSeek needs an existing logged-in browser session. Open the shared browser, sign in to chat.deepseek.com, then save the session.',
    { session: 'deepseek', home_url: HOME_URL, current_url: page.url() }
  );
}

// Read the latest assistant message's answer + DeepThink reasoning chain.
function readReply(page) {
  return page.evaluate(({ answerSel, thinkSel }) => {
    const last = sel => {
      const els = document.querySelectorAll(sel);
      return els.length ? (els[els.length - 1].innerText || '').trim() : '';
    };
    const isGenerating = !!document.querySelector(
      'button[data-testid="stop-button"], button[aria-label*="stop" i]'
    );
    return {
      answer: last(answerSel),
      reasoning: last(thinkSel),
      isGenerating
    };
  }, { answerSel: ANSWER_SELECTOR, thinkSel: THINK_SELECTOR });
}

export async function searchDeepSeek(query, opts = {}) {
  const proxyProfile = opts.proxyProfile || 'auto';
  const prompt = VERIFY ? `${query}\n${VERIFY_SUFFIX}` : query;

  return await opts.browserPool.withPage({
    proxyProfile,
    url: HOME_URL,
    sessionKey: 'deepseek',
    reuseSession: true,
    closeDelayMs: [5000, 9000]
  }, async (page) => {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.browserTimeoutMs || 45000 });
    try {
      await page.waitForSelector(COMPOSER_SELECTOR, { timeout: 30000 });
    } catch {
      throw loginRequired(page);
    }
    await page.fill(COMPOSER_SELECTOR, prompt);
    await page.press(COMPOSER_SELECTOR, 'Enter');

    // Wait for the reply to appear and stop streaming.
    const deadline = Date.now() + TIMEOUT_MS;
    let last = { answer: '', reasoning: '' };
    let stable = 0;
    while (Date.now() < deadline) {
      const r = await readReply(page);
      if (r.answer.length > 0) {
        const unchanged = r.answer === last.answer && r.reasoning === last.reasoning;
        if (unchanged) {
          stable++;
          if (stable >= 3) break;
        } else {
          stable = 0;
          last = r;
        }
      }
      await page.waitForTimeout(2000);
    }
    if (!last.answer) {
      throw new SearchEngineError('NO_RESPONSE', 'Timed out waiting for DeepSeek response', { session: 'deepseek' });
    }

    const result = makeResult({
      title: last.answer.slice(0, 100),
      url: HOME_URL,
      snippet: last.answer.slice(0, MAX_SNIPPET),
      engine: 'deepseek',
      rank: 1
    });
    if (INCLUDE_REASONING && last.reasoning) {
      result.reasoning = last.reasoning.slice(0, MAX_REASONING);
      result.reasoning_included = true;
    }
    result.answer_chars = last.answer.length;
    result.verify_requested = VERIFY;
    return [result];
  });
}
