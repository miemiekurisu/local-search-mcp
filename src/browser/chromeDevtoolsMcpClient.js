import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONFIG } from '../config/index.js';

function sanitizeEnv() {
  const env = { ...process.env };
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    if (env[key] && !String(env[key]).includes('://')) {
      delete env[key];
    }
  }
  return env;
}

function joinTextContent(result) {
  return (result?.content || [])
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

function parsePages(text) {
  const pages = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^(\d+):\s+(.+?)(\s+\[selected\])?$/);
    if (!match) continue;
    pages.push({
      index: Number(match[1]),
      url: match[2],
      selected: Boolean(match[3])
    });
  }
  return pages;
}

function parseJsonCodeBlock(text) {
  const match = String(text || '').match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    throw new Error('chrome-devtools-mcp did not return a JSON code block');
  }
  return JSON.parse(match[1]);
}

export class ChromeDevtoolsMcpClient {
  constructor() {
    this.client = null;
    this.transport = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: CONFIG.chromeDevtoolsMcpCommand,
        args: ['--browserUrl', CONFIG.chromeDevtoolsMcpBrowserUrl],
        cwd: process.cwd(),
        env: sanitizeEnv(),
        stderr: 'ignore'
      });
      const client = new Client({
        name: 'local-search-mcp-browser-client',
        version: '0.1.0'
      });
      transport.onclose = () => {
        this.client = null;
        this.transport = null;
      };
      transport.onerror = () => {
        this.client = null;
        this.transport = null;
      };
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      return client;
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async callTool(name, args = {}) {
    try {
      const client = await this.connect();
      const result = await client.callTool({ name, arguments: args });
      if (result?.isError) {
        const message = joinTextContent(result) || `chrome-devtools-mcp tool failed: ${name}`;
        throw Object.assign(new Error(message), {
          code: 'CHROME_DEVTOOLS_MCP_TOOL_ERROR',
          details: { tool: name }
        });
      }
      return result;
    } catch (err) {
      await this.close().catch(() => {});
      if (err && typeof err === 'object' && !err.details) {
        err.details = { tool: name };
      }
      throw err;
    }
  }

  async callToolText(name, args = {}) {
    return joinTextContent(await this.callTool(name, args));
  }

  async callToolJson(name, args = {}) {
    return parseJsonCodeBlock(await this.callToolText(name, args));
  }

  async listPages() {
    return parsePages(await this.callToolText('list_pages'));
  }

  async selectPage(pageIdx) {
    await this.callTool('select_page', { pageIdx });
  }

  async newPage(url) {
    await this.callTool('new_page', { url });
  }

  async navigatePage(url) {
    await this.callTool('navigate_page', { url });
  }

  async takeSnapshot() {
    return await this.callToolText('take_snapshot');
  }

  async waitForText(text) {
    return await this.callToolText('wait_for', { text });
  }

  async fill(uid, value) {
    return await this.callToolText('fill', { uid, value });
  }

  async click(uid, dblClick = false) {
    return await this.callToolText('click', { uid, dblClick });
  }

  async evaluateJson(functionSource, args = []) {
    return await this.callToolJson('evaluate_script', { function: functionSource, args });
  }

  async close() {
    try {
      await this.client?.close();
    } finally {
      await this.transport?.close?.().catch(() => {});
      this.client = null;
      this.transport = null;
      this.connecting = null;
    }
  }
}

const sharedClient = new ChromeDevtoolsMcpClient();

export function getChromeDevtoolsMcpClient() {
  return sharedClient;
}

export async function closeChromeDevtoolsMcpClient() {
  await sharedClient.close();
}
