import { CONFIG } from '../config/index.js';
import { SearchEngineError, makeResult } from './base.js';

const HOME_URL = 'https://chat.deepseek.com';
const COMPOSER_SELECTOR = 'textarea[placeholder="Message DeepSeek"]';
const ASSISTANT_CONTENT_SELECTOR = '.ds-assistant-message-main-content';

function loginRequired(page) {
  return new SearchEngineError(
    'LOGIN_REQUIRED',
    'DeepSeek needs an existing logged-in browser session. Open the shared browser, sign in to chat.deepseek.com, then save the session.',
    { session: 'deepseek', home_url: HOME_URL, current_url: page.url() }
  );
}

// DeepSeek web chat: type into the composer textarea and press Enter (no send
// button is exposed). Reply text lives in .ds-assistant-message-main-content.
// Uses the shared browser pool (CDP/visible Chromium) so the user's login state
// is inherited.
export async function searchDeepSeek(query, opts = {}) {
  const proxyProfile = opts.proxyProfile || 'auto';
  return await opts.browserPool.withPage({
    proxyProfile,
    url: HOME_URL,
    sessionKey: 'deepseek',
    reuseSession: true,
    closeDelayMs: [5000, 9000]
  }, async (page) => {
    try {
      await page.waitForSelector(COMPOSER_SELECTOR, { timeout: 30000 });
    } catch {
      throw loginRequired(page);
    }
    // Give the page a moment to settle, then type the query and send.
    await page.fill(COMPOSER_SELECTOR, query);
    await page.press(COMPOSER_SELECTOR, 'Enter');

    // Wait for the assistant reply to appear and stop changing (streaming done).
    const deadline = Date.now() + 150000;
    let lastText = '';
    let stable = 0;
    while (Date.now() < deadline) {
      const text = await page.evaluate((sel) => {
        const els = document.querySelectorAll(sel);
        return els.length > 0 ? (els[els.length - 1].innerText || '').trim() : '';
      }, ASSISTANT_CONTENT_SELECTOR);
      if (text.length > 0) {
        if (text === lastText) {
          stable++;
          if (stable >= 3) break;
        } else {
          stable = 0;
          lastText = text;
        }
      }
      await page.waitForTimeout(2000);
    }
    if (!lastText) {
      throw new SearchEngineError('NO_RESPONSE', 'Timed out waiting for DeepSeek response', { session: 'deepseek' });
    }
    return [makeResult({
      title: lastText.slice(0, 100),
      url: HOME_URL,
      snippet: lastText.slice(0, 1800),
      engine: 'deepseek',
      rank: 1
    })];
  });
}
