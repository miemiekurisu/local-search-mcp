import { CONFIG } from '../config/index.js';
import { SearchEngineError } from './base.js';

const AIMODE_URL = 'https://www.google.com/aimode';
const INPUT_SELECTOR = 'textarea.ITIRGe';
const REPLY_SELECTOR = 'div.mZJni.Dn7Fzd';
const COMPLETE_SELECTOR = 'div.v4bSkd';

// Google AI Mode (www.google.com/aimode) — conversational AI search. Used by the
// DeepSeek validation chain to cross-check a DeepSeek answer. Requires a logged-in
// Google session (shared visible Chromium). Returns the last AI-mode reply text.
export async function searchGoogleAI(query, opts = {}) {
  const proxyProfile = opts.proxyProfile || 'auto';
  return await opts.browserPool.withPage({
    proxyProfile,
    url: AIMODE_URL,
    sessionKey: 'google',
    reuseSession: true,
    closeDelayMs: [3000, 6000],
    timeoutMs: 90000
  }, async (page) => {
    await page.goto(AIMODE_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.browserTimeoutMs || 45000 });
    try {
      await page.waitForSelector(INPUT_SELECTOR, { timeout: 30000 });
    } catch {
      throw new SearchEngineError('GOOGLE_AI_UNAVAILABLE', 'Google AI Mode not available (need a logged-in Google session)', { session: 'google' });
    }
    await page.fill(INPUT_SELECTOR, query);
    await page.press(INPUT_SELECTOR, 'Enter');

    const deadline = Date.now() + 60000;
    let lastText = '';
    while (Date.now() < deadline) {
      /* c8 ignore start -- body only executes inside the real Chromium page context */
      const text = await page.evaluate(({ replySel }) => {
        const els = document.querySelectorAll(replySel);
        return els.length ? (els[els.length - 1].innerText || '').trim() : '';
      }, { replySel: REPLY_SELECTOR });
      /* c8 ignore stop */
      if (text.length > 0) {
        if (text === lastText) return text; // stable → done
        lastText = text;
      }
      await page.waitForTimeout(2000);
    }
    if (lastText) return lastText;
    throw new SearchEngineError('GOOGLE_AI_NO_REPLY', 'Google AI Mode returned no reply', { session: 'google' });
  });
}
