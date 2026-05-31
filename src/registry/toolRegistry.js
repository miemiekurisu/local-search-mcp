import { z } from 'zod';

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  registerTool({ name, title, description, inputSchema, handler, zodSchema }) {
    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }
    this.tools.set(name, { name, title, description, inputSchema, handler, zodSchema });
  }

  listTools() {
    const result = [];
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      });
    }
    return result;
  }

  getTool(name) {
    return this.tools.get(name) || null;
  }

  callTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: '${name}'`);
    }
    return tool.handler(args);
  }

  toMcpSdk(mcpServer) {
    for (const tool of this.tools.values()) {
      const schema = tool.zodSchema || z.object({}).optional();
      mcpServer.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: schema
        },
        async (args, extra) => {
          try {
            const result = await tool.handler(args, extra);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          } catch (err) {
            const msg = err?.message || String(err);
            const details = err?.details || err?.code ? { code: err.code, ...err.details } : undefined;
            return {
              content: [{ type: 'text', text: details ? `${msg}\n${JSON.stringify(details, null, 2)}` : msg }],
              isError: true
            };
          }
        }
      );
    }
  }

  getMcpToolSchemas() {
    const result = [];
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      });
    }
    return result;
  }
}
