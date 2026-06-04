#!/usr/bin/env node

const SERVER_URL = String(process.env.LOCAL_SEARCH_SERVER_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const NOVNC_PORT = Number(process.env.LOCAL_SEARCH_NOVNC_HOST_PORT || 6082);
const NOVNC_URL = process.env.LOCAL_SEARCH_NOVNC_URL || `http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote`;

async function main() {
  const [action = 'status', ...rawTargets] = process.argv.slice(2);
  const targets = rawTargets.length > 0 ? rawTargets : ['all'];

  if (!['status', 'open', 'save'].includes(action)) {
    usage(`Unknown action: ${action}`);
  }

  const sessions = await request('/browser_sessions', { method: 'GET' });
  const knownIds = sessions.sessions.map(session => session.id);
  const selectedIds = expandTargets(targets, knownIds);

  if (action === 'status') {
    printSessions(sessions.sessions.filter(session => selectedIds.includes(session.id)));
    return;
  }

  for (const sessionId of selectedIds) {
    const result = await request(`/browser_sessions/${action === 'open' ? 'open' : 'save'}`, {
      method: 'POST',
      body: JSON.stringify({ session: sessionId }),
      headers: { 'Content-Type': 'application/json' }
    });

    if (action === 'open') {
      console.log(`[open] ${sessionId}: ${result.current_url || result.loginUrl || result.homeUrl}`);
    } else {
      console.log(`[save] ${sessionId}: ${result.saved ? 'saved' : 'not-saved'} ${result.state_path || ''}`.trim());
    }
  }

  if (action === 'open') {
    console.log(`\nnoVNC: ${NOVNC_URL}`);
    console.log('在容器浏览器里完成登录后，再执行: npm run browser:sessions -- save all');
  }
}

function expandTargets(targets, knownIds) {
  const resolved = new Set();
  for (const target of targets) {
    if (target === 'all') {
      for (const id of knownIds) resolved.add(id);
      continue;
    }
    if (!knownIds.includes(target)) {
      usage(`Unknown session: ${target}`);
    }
    resolved.add(target);
  }
  return Array.from(resolved);
}

function printSessions(sessions) {
  for (const session of sessions) {
    console.log([
      `${session.id}:`,
      `engine=${session.engine}`,
      `saved=${session.saved_state_exists ? 'yes' : 'no'}`,
      `page=${session.interactive_page_url || '-'}`,
      `state=${session.state_path || '-'}`
    ].join(' '));
  }
  console.log(`\nnoVNC: ${NOVNC_URL}`);
}

async function request(path, init) {
  const bearerToken = process.env.MCP_BEARER_TOKEN || process.env.LOCAL_SEARCH_BEARER_TOKEN || '';
  if (bearerToken) {
    init = { ...init, headers: { ...init.headers, 'Authorization': `Bearer ${bearerToken}` } };
  }
  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, init);
  } catch (err) {
    throw new Error(`Failed to reach ${SERVER_URL}${path}: ${err.message}. Start the service with: docker compose up --build -d`);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Unexpected non-JSON response from ${SERVER_URL}${path}`);
  }

  if (!response.ok || !payload.ok) {
    const message = payload?.error?.message || response.statusText || 'request failed';
    throw new Error(`${path} failed: ${message}`);
  }

  return payload.result;
}

function usage(message) {
  if (message) {
    console.error(message);
  }
  console.error('Usage: npm run browser:sessions -- <status|open|save> [all|google|chatgpt|bing ...]');
  process.exit(1);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
