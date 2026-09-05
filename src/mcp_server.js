import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKernel } from './app.js';
import { gracefulClose } from './lifecycle.js';
import { createMcpServer } from './mcp/server.js';

const { kernel, browserPool } = createKernel();
const server = createMcpServer(kernel, browserPool);

const shutdown = () => gracefulClose({ browserPool, exit: () => process.exit(0) });
process.on('unhandledRejection', (reason) => {
  console.error('[mcp-server] Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// MCP stdio convention: when the parent closes the pipe, the server must exit.
process.stdin.on('end', shutdown);

await server.connect(new StdioServerTransport());
