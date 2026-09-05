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

    // Bing 的 rdr=1 跳转变体页是渐进渲染：networkidle 后 #b_results / li.b_algo
    // 仍可能尚未挂进 DOM（35 号机实测），解析要带 hydrate 轮询等待。
    let parsed = [];
    if (!page.url().includes('cn.bing.com')) {
      parsed = await parseWithHydrationWait(page, limit);
    }

    if (parsed.length === 0 && page.url().includes('cn.bing.com')) {
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&num=${limit}&setlang=en`, {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      parsed = await parseWithHydrationWait(page, limit);
    }

    if (parsed.length === 0) throw new SearchEngineError('SERP_PARSE_FAILED', 'Bing returned no results');
    return parsed;
  });
}

async function parseWithHydrationWait(page, limit) {
  // Bing 的 rdr=1 变体页在弱机（ARM/低资源）上 hydrate 很慢：networkidle 后
  // #b_results / li.b_algo 可能 8+ 秒才挂进 DOM。等到结果节点出现再解析。
  await page.waitForSelector('li.b_algo, #b_results > li', { timeout: 20000 }).catch(() => null);
  const html = await page.content();
  return parseBingHtml(html, limit);
}
