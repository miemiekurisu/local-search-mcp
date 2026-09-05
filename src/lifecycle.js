import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';

// Shared graceful-shutdown sequence for the long-running entry points
// (http_server.js / mcp_server.js). The HTTP server's close() completion and
// the process exit are injectable so tests can exercise the full sequence
// without terminating the test runner.
export async function gracefulClose({ browserPool, server, exit } = {}) {
  await closeChromeDevtoolsMcpClient().catch(() => {});
  if (browserPool) await browserPool.close();
  if (server) {
    await new Promise(resolve => {
      server.close(() => resolve());
    });
  }
  if (exit) exit();
}
