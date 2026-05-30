import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKernel } from './app.js';
import { closeChromeDevtoolsMcpClient } from './browser/chromeDevtoolsMcpClient.js';
import { createMcpServer } from './mcp/server.js';

const { kernel, browserPool } = createKernel();
const server = createMcpServer(kernel, browserPool);

process.on('unhandledRejection', (reason) => {
  console.error('[mcp-server] Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('SIGTERM', async () => {
  await closeChromeDevtoolsMcpClient().catch(() => {});
  await browserPool.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeChromeDevtoolsMcpClient().catch(() => {});
  await browserPool.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
