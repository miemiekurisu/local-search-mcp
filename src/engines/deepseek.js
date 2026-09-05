import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config/index.js';
import { SearchEngineError, makeResult } from './base.js';
import { searchGoogleAI } from './googleAIMode.js';

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
// Network can be flaky (long prompts, browser sessions); retry each step so a
// transient failure does not drop the whole result. Attempts = number of tries.
const RETRY = envInt('DEEPSEEK_RETRY', 3, 1);
// DeepSeek web chat cannot handle very long prompts reliably; reject oversized
// queries up front with a clear error instead of timing out / hanging.
const MAX_INPUT_CHARS = envInt('DEEPSEEK_MAX_INPUT_CHARS', 2000, 100);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, attempts, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.error(`[deepseek] ${label} attempt ${i + 1}/${attempts} failed, retrying: ${err?.message}`);
        await sleep(3000 * (i + 1));
      }
    }
  }
  throw lastErr;
}
// Cross-validation chain: DeepSeek answer -> Google AI cross-check -> DeepSeek
// final synthesis. If Google AI is unavailable, validation is skipped and the
// plain DeepSeek answer is returned (never blocks the caller).
const VALIDATE = process.env.DEEPSEEK_VALIDATE === 'true';
// Conversation-trajectory capture: when enabled, each completed DeepSeek turn
// (prompt / reasoning / answer, plus the validation chain if used) is appended
// to a JSONL file for later processing.
const TRACE_ENABLED = process.env.DEEPSEEK_TRACE_ENABLED === 'true';
const TRACE_DIR = process.env.DEEPSEEK_TRACE_DIR || '/data/traces';

function saveTrace(record) {
  if (!TRACE_ENABLED) return;
  try {
    const dir = TRACE_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'deepseek_traces.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8'
    );
  } catch (err) {
    console.error('[deepseek] trace save failed:', err.message);
  }
}

// When VERIFY is on, ask DeepSeek to separate established facts from inference,
// cite evidence for key data, and flag uncertainty — so the output is checkable.
const VERIFY_SUFFIX = [
  '',
  '【正确性验证要求】',
  '在回答中请明确区分：1) 确凿事实（尽量附来源或依据）；2) 推断或不确定的内容。',
  '对关键数据、数字、流程给出依据或出处；若无法确定请明确标注"不确定"。',
  '最后用一段"正确性自检"说明哪些结论可靠、哪些需要进一步核验。'
].join('\n');

const GOOGLE_VALIDATE_SUFFIX =
  '请使用 AI 模式搜索网络（联网核实），求证以下内容是不是存在问题：\n';
const DEEPSEEK_SYNTHESIS_SUFFIX = (googleReply, originalQuery) =>
  `别的模型是这样回答的：\n${googleReply}\n\n` +
  `你参考和求证，再综合求证一下，真正的答案是什么。原始问题：${originalQuery}`;

function loginRequired(page) {
  return new SearchEngineError(
    'LOGIN_REQUIRED',
    'DeepSeek needs an existing logged-in browser session. Open the shared browser, sign in to chat.deepseek.com, then save the session.',
    { session: 'deepseek', home_url: HOME_URL, current_url: page.url() }
  );
}

// Read the latest assistant message's answer + DeepThink reasoning chain.
function readReply(page) {
  /* c8 ignore start -- body only executes inside the real Chromium page context */
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
  /* c8 ignore stop */
}

// Ask DeepSeek once (a fresh chat) for the given prompt.
async function askDeepSeek(prompt, opts) {
  const proxyProfile = opts.proxyProfile || 'auto';
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
    return last;
  });
}

export async function searchDeepSeek(query, opts = {}) {
  if (query.length > MAX_INPUT_CHARS) {
    throw new SearchEngineError(
      'INPUT_TOO_LONG',
      `DeepSeek query too long (${query.length} chars, max ${MAX_INPUT_CHARS}). Please shorten or split the question.`,
      { session: 'deepseek', max_input_chars: MAX_INPUT_CHARS }
    );
  }
  const prompt1 = VERIFY ? `${query}\n${VERIFY_SUFFIX}` : query;
  const r1 = await withRetry(() => askDeepSeek(prompt1, opts), RETRY, 'deepseek first answer');

  const result = makeResult({
    title: r1.answer.slice(0, 100),
    url: HOME_URL,
    snippet: r1.answer.slice(0, MAX_SNIPPET),
    engine: 'deepseek',
    rank: 1
  });
  if (INCLUDE_REASONING && r1.reasoning) {
    result.reasoning = r1.reasoning.slice(0, MAX_REASONING);
    result.reasoning_included = true;
  }
  result.answer_chars = r1.answer.length;
  result.verify_requested = VERIFY;

  const trace = {
    timestamp: new Date().toISOString(),
    engine: 'deepseek',
    query,
    prompt: prompt1,
    answer: r1.answer,
    reasoning: r1.reasoning || '',
    verify: VERIFY
  };

  if (VALIDATE) {
    // Step 2: ask Google AI to cross-check the DeepSeek answer.
    let googleReply = null;
    let googleError = null;
    try {
      googleReply = await withRetry(
        () => searchGoogleAI(`${GOOGLE_VALIDATE_SUFFIX}${r1.answer}`, opts),
        RETRY,
        'google ai cross-check'
      );
    } catch (err) {
      googleError = err?.message || String(err);
    }

    if (googleReply) {
      // Step 3: feed Google's reply back to DeepSeek for final synthesis.
      const finalPrompt = DEEPSEEK_SYNTHESIS_SUFFIX(googleReply, query);
      const r2 = await withRetry(() => askDeepSeek(finalPrompt, opts), RETRY, 'deepseek synthesis');

      result.snippet = r2.answer.slice(0, MAX_SNIPPET);
      result.title = r2.answer.slice(0, 100);
      result.answer_chars = r2.answer.length;
      if (INCLUDE_REASONING && r2.reasoning) {
        result.reasoning = r2.reasoning.slice(0, MAX_REASONING);
      }
      result.validate = 'done';
      result.google_reply = googleReply.slice(0, 4000);
      result.deepseek_initial = r1.answer.slice(0, 2000);

      trace.validate_status = 'done';
      trace.google_reply = googleReply;
      trace.final_prompt = finalPrompt;
      trace.final_answer = r2.answer;
      trace.final_reasoning = r2.reasoning || '';
    } else {
      // Google unavailable: surface a notice and force-disable validation, but
      // still return the plain DeepSeek answer (never block).
      result.validate = 'disabled';
      result.validate_reason =
        `Google AI Mode unavailable; validation skipped, returning DeepSeek answer. ${googleError || ''}`.trim();
      trace.validate_status = 'google_unavailable';
      trace.google_error = googleError || '';
    }
  }

  if (TRACE_ENABLED) saveTrace(trace);
  return [result];
}
