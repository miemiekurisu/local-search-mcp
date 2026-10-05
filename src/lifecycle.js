import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';

const SHUTDOWN_STEP_TIMEOUT_MS = (() => {
  const n = Number(process.env.SHUTDOWN_STEP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3000;
})();

// Run one shutdown step for at most `timeoutMs`. Every step below is a close() that
// can block forever in practice -- page.close() on a wedged Chromium tab, or
// server.close() waiting for an MCP SSE / keep-alive client that never disconnects
// -- and a process that cannot exit keeps the whole browser resident, which on a
// small host is the difference between a restart and a supervisor SIGKILL.
// Errors still propagate; only "never answers" gets cut short.
async function withDeadline(label, run, timeoutMs) {
  let timer;
  const step = Promise.resolve().then(run);
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.log(`[shutdown] ${label} did not finish within ${timeoutMs}ms; leaving it behind`);
      resolve(undefined);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([step, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Shared graceful-shutdown sequence for the long-running entry points
// (http_server.js / mcp_server.js). The HTTP server's close() completion and
// the process exit are injectable so tests can exercise the full sequence
// without terminating the test runner.
export async function gracefulClose({ browserPool, server, exit, timeoutMs = SHUTDOWN_STEP_TIMEOUT_MS } = {}) {
  await withDeadline('chrome-devtools MCP close', () => closeChromeDevtoolsMcpClient().catch(() => {}), timeoutMs);
  if (browserPool) await withDeadline('browser pool close', () => browserPool.close(), timeoutMs);
  if (server) {
    await withDeadline('http server close', () => new Promise(resolve => {
      server.close(() => resolve());
    }), timeoutMs);
  }
  if (exit) exit();
}
