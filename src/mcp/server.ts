#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../shared/config.js';
import { openDb } from '../db/client.js';
import { registerTools } from './tools.js';

const cfg = loadConfig();
const db = openDb(cfg.dataDir);

const server = new McpServer(
  { name: 'ai-growth', version: '1.1.0' },
  {
    instructions:
      'AI Growth — agent-driven personal growth system. Call growth_status first; it tells you the suggested next operation (onboarding / replan / daily planning / continue).',
  }
);

registerTools(server, db, cfg);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[ai-growth] MCP server ready (data: ${cfg.dataDir})\n`);
