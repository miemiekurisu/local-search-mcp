import { test } from 'node:test';
import assert from 'node:assert';
import { mcpClientState } from './helpers/mocks.mjs';

const st = mcpClientState();
const { ChromeDevtoolsMcpClient } = await import('../src/browser/chromeDevtoolsMcpClient.js');

test('cdp client: malformed proxy env stripped from transport env', async () => {
  process.env.http_proxy = '127.0.0.1:8888';
  process.env.https_proxy = 'http://ok:1234';
  const c = new ChromeDevtoolsMcpClient();
  st.callTool = async () => ({ content: [{ type: 'text', text: 'hi' }] });
  await c.connect();
  const transport = st.transports.at(-1);
  assert.equal(transport.opts.env.http_proxy, undefined, 'proxy without scheme removed');
  assert.equal(transport.opts.env.https_proxy, 'http://ok:1234', 'well-formed proxy kept');
  transport.onerror();
  assert.equal(c.client, null, 'onerror clears client');
  assert.equal(c.transport, null, 'onerror clears transport');
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  await c.close();
});

test('cdp client: evaluateJson without json block rejects; isError raises tool error', async () => {
  const c = new ChromeDevtoolsMcpClient();
  st.callTool = async (client, msg) => {
    if (msg.name === 'evaluate_script') return { content: [{ type: 'text', text: 'plain text no json block' }] };
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  await assert.rejects(c.evaluateJson('() => 1'), /did not return a JSON code block/);

  st.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'boom text' }] });
  let caught;
  try { await c.callTool('take_snapshot'); } catch (e) { caught = e; }
  assert.equal(caught.code, 'CHROME_DEVTOOLS_MCP_TOOL_ERROR');
  assert.equal(caught.details.tool, 'take_snapshot');

  st.callTool = async () => ({ isError: true, content: [] });
  await assert.rejects(c.callTool('fill'), /chrome-devtools-mcp tool failed: fill/);

  st.callTool = async (client, msg) => ({ content: [{ type: 'text', text: `waited for ${msg.name}` }] });
  assert.equal(await c.waitForText('hello'), 'waited for wait_for');
  await c.close();
});
