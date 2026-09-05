import * as cheerio from 'cheerio';
import { CONFIG } from '../config/index.js';
import { canonicalUrl, normalizeWhitespace, stripTrackingUrl, uniqueByUrl } from '../utils/normalize.js';
import { makeResult, SearchEngineError } from './base.js';

function parseBingHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];

  // Bing 有两种产物：标准页有 #b_results 容器；部分跳转变体页直接把
  // li.b_algo 散在 body 里（没有 #b_results 包装）——两种都要能解析。
  let items = $('#b_results > li');
  if (items.length === 0) items = $('li.b_algo');
  items.each((i, elem) => {
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
  const limit = Math.max(1, Math.min(20, Number(opts.limit || CONFIG.defaultSearchLimit)));
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
    /* c8 ignore next 4 -- BING_DEBUG: manual live-debug aid, exercised only on real devices */
    if (process.env.BING_DEBUG === '1') {
      const dbg = cheerio.load(html);
      console.error(`[bing][debug] url=${page.url().slice(0, 100)} htmlLen=${html.length} lis=${dbg('.b_results > li').length} liAlgo=${dbg('li.b_algo').length} parsed=${parsed.length}`);
    }
    if (parsed.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', 'Bing returned no results');
    return parsed;
  });
}
