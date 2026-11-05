import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** What `request_spend` sends to the Mandate API. */
export interface SpendRequest {
  agentId: string;
  amount: string;
  currency: string;
  recipient: string;
  category: string;
}

/** Anything that can call `POST /authorize`. Injected so tests don't need HTTP. */
export interface AuthorizeClient {
  authorize(request: SpendRequest): Promise<Record<string, unknown>>;
}

/** The real client: calls a running Mandate server over HTTP. */
export function httpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): AuthorizeClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async authorize(request) {
      const res = await fetchImpl(`${base}/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(`Mandate API ${res.status}: ${String(body.message ?? body.error ?? res.statusText)}`);
      return body;
    },
  };
}

/**
 * An MCP server exposing one tool, `request_spend`, so an AI agent can ask for permission to pay.
 *
 * The answer is returned whether the verdict is allow or deny: a deny is a normal result the agent
 * should read and act on (`reason`), not a tool failure. Only transport/validation problems set
 * `isError`. The signed `token` is what the agent hands to the seller.
 */
export function createMcpServer(client: AuthorizeClient, opts: { defaultAgentId?: string } = {}): McpServer {
  const server = new McpServer({ name: 'mandate', version: '0.1.0' });

  server.registerTool(
    'request_spend',
    {
      title: 'Request spend',
      description:
        'Ask Mandate whether you may pay an amount of USDC to a recipient for a category of spend. ' +
        'Returns allow or deny with a reason. On allow, `token` is a signed verdict (valid 5 minutes, single use) ' +
        'to present to the seller. Do not pay unless the verdict is allow.',
      inputSchema: {
        agentId: z.string().min(1).optional().describe('Your agent id. Defaults to the server configuration.'),
        amount: z.string().describe('Decimal USDC amount, at most 6 places, e.g. "12.5".'),
        recipient: z.string().describe('0x address of the seller being paid.'),
        category: z.string().describe('Spend category, e.g. "cloud", "data", "api-credits".'),
        currency: z.string().default('USDC').describe('Only USDC is supported.'),
      },
    },
    async ({ agentId, amount, recipient, category, currency }) => {
      const id = agentId ?? opts.defaultAgentId;
      if (!id) {
        return { isError: true, content: [{ type: 'text', text: 'agentId is required (none configured on the server).' }] };
      }
      try {
        const d = await client.authorize({ agentId: id, amount, currency, recipient, category });
        const result = {
          verdict: d.verdict,
          reason: d.reason,
          reasonCode: d.reasonCode,
          decisionId: d.id,
          expiresAt: d.expiresAt,
          token: d.token,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }
    },
  );

  return server;
}
