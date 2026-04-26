import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { htmlToText } from 'html-to-text';
import { normalizeWhitespace, truncateText } from '../utils/normalize.js';

export function extractTextFromHtml(html, url = '', maxChars = 12000) {
  let title = '';
  let text = '';
  try {
    const dom = new JSDOM(html, { url: url || 'https://example.com' });
    const parsed = new Readability(dom.window.document).parse();
    if (parsed?.textContent && parsed.textContent.trim().length > 300) {
      title = parsed.title || '';
      text = parsed.textContent;
    }
  } catch {}
  if (!text || text.trim().length < 300) {
    try {
      const $ = cheerio.load(html);
      title = title || normalizeWhitespace($('title').first().text() || $('h1').first().text());
      $('script,style,noscript,svg,canvas,iframe,nav,footer,header,form,aside').remove();
      text = htmlToText($.html(), {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' }
        ]
      });
    } catch {
      text = String(html || '').replace(/<[^>]+>/g, ' ');
    }
  }
  text = normalizeWhitespace(text);
  return { title: normalizeWhitespace(title), text: truncateText(text, maxChars), extracted_chars: text.length };
}
