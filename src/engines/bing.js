import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

function parseBingHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  
  $('#b_results > li').each((i, elem) => {
    if (results.length >= limit) return;
    const el = $(elem);
    const a = el.find('h2 a').first();
    let title = a.text().trim();
    let href = a.attr('href') || el.find('a').first()?.attr('href');
    href = canonicalUrl(stripTrackingUrl(href));
    const snippet = el.find('.b_caption p').text().trim() || el.text().trim();
    
    if (title && title.length > 5 && href && href.startsWith('http')) {
      results.push(makeResult({ title, url: href, snippet: snippet.slice(0, 300), engine: 'bing', rank: results.length + 1 }));
    }
  });
  
  return uniqueByUrl(results, limit).slice(0, limit);
}

export async function searchBing(query, opts = {}) {
  const limit = opts.limit || CONFIG.defaultSearchLimit;
  const proxyProfile = opts.proxyProfile || 'auto';
  
  return await opts.browserPool.withPage({
    proxyProfile,
    url: 'https://www.bing.com',
    sessionKey: 'bing',
    reuseSession: true
  }, async (page) => {
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&num=${limit}`, { 
      waitUntil: 'networkidle', 
      timeout: 45000 
    });
    await page.waitForTimeout(1500);
    
    let html = await page.content();
    
    if (page.url().includes('cn.bing.com')) {
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&num=${limit}&setlang=en`, { 
        waitUntil: 'networkidle', 
        timeout: 45000 
      });
      await page.waitForTimeout(1500);
      html = await page.content();
    }
    
    const parsed = parseBingHtml(html, limit);
    if (parsed.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', 'Bing returned no results');
    return parsed;
  });
}
