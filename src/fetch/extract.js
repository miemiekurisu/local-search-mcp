import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { htmlToText } from 'html-to-text';
import { normalizeWhitespace, truncateText } from '../utils/normalize.js';

// jsdom parses every inline <style> block with its own CSS parser, which does not
// know modern CSS -- @layer blocks and CSS nesting (both used by Chakra/AstroWind,
// which is what shipped here) make it throw. On failure jsdom emits a jsdomError
// (type 'css parsing') whose .detail is the whole stylesheet, and the default
// virtual console dumps the stack plus that stylesheet to stderr: one dump per
// <style> block, i.e. a dozen "Error: Could not parse CSS stylesheet" stacks per
// fetched page. Text extraction never touches the CSSOM, so those dumps are pure
// log noise; drop them and keep every other jsdomError visible on stderr.
export function buildExtractionVirtualConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (error?.type === 'css parsing') {
      if (process.env.EXTRACT_DEBUG_CSS_ERRORS === 'true') {
        console.error(`[extract] ignored CSS parse error (${String(error?.detail || '').length} chars)`);
      }
      return;
    }
    console.error(error?.stack || error);
  });
  return virtualConsole;
}

const EXTRACTION_VIRTUAL_CONSOLE = buildExtractionVirtualConsole();

export function extractTextFromHtml(html, url = '', maxChars = 12000) {
  let title = '';
  let text = '';
  try {
    const dom = new JSDOM(html, { url: url || 'https://example.com', virtualConsole: EXTRACTION_VIRTUAL_CONSOLE });
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
