/**
 * Runs the Mandate MCP server over stdio, for an MCP client such as Claude Desktop or Claude Code.
 *
 *   MANDATE_API_URL=http://localhost:8787 MANDATE_AGENT_ID=research-bot npm run mcp -w server
 *
 * Client config example:
 *   { "mcpServers": { "mandate": { "command": "npx", "args": ["tsx", "server/scripts/mcp.ts"],
 *       "env": { "MANDATE_API_URL": "http://localhost:8787", "MANDATE_AGENT_ID": "research-bot" } } } }
 *
 * stdout is the protocol channel, so anything diagnostic must go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, httpClient } from '../src/mcp';

const api = process.env.MANDATE_API_URL ?? 'http://localhost:8787';
const server = createMcpServer(httpClient(api), { defaultAgentId: process.env.MANDATE_AGENT_ID });

await server.connect(new StdioServerTransport());
console.error(`[mandate-mcp] request_spend ready, calling ${api}`);
