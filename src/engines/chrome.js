import { exec } from 'child_process';
import { promisify } from 'util';
import { CONFIG } from '../config/index.js';
import { makeResult } from './base.js';
import { hostOf } from '../utils/normalize.js';

const execAsync = promisify(exec);

const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL || 'http://host.docker.internal:9222';

export async function searchViaChromeDevTools(query, opts = {}) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit || 10)));
  
  try {
    const safeQuery = query.replace(/[&|;`$(){}<>!#"\']/g, '');
    const npxCmd = `npx -y chrome-devtools-mcp@latest search --query "${safeQuery}" --limit ${limit} --browser-url ${CHROME_DEBUG_URL}`;
    const { stdout, stderr } = await execAsync(npxCmd, { timeout: 30000 });
    
    if (stderr && !stderr.includes('deprecated')) {
      console.error('[chrome-devtools] stderr:', stderr);
    }
    
    const results = parseChromeSearchResults(stdout, limit);
    return results;
  } catch (err) {
    console.error('[chrome-devtools] error:', err.message);
    return [];
  }
}

function parseChromeSearchResults(output, limit) {
  try {
    const lines = output.split('\n').filter(l => l.trim());
    const results = [];
    
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.url || item.title) {
          results.push(makeResult({
            title: item.title || '',
            url: item.url || '',
            snippet: item.snippet || item.description || '',
            engine: 'chrome',
            rank: results.length + 1
          }));
        }
      } catch {
        continue;
      }
    }
    
    return results.slice(0, limit);
  } catch (err) {
    console.error('[chrome-devtools] parse error:', err.message);
    return [];
  }
}

export async function searchGoogleViaChrome(query, opts = {}) {
  return searchViaChromeDevTools(query, opts);
}