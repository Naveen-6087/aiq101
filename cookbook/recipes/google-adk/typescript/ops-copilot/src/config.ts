import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value;
}

/**
 * Where the MCP server is running.
 *
 * The MCP server is a separate repo and a separate deployment, so set MCP_URL
 * to its public URL with /mcp on the end:
 *
 *   MCP_URL=https://ops-mcp.onrender.com/mcp
 *
 * MCP_HOST is a convenience: if you happen to run both services in the same
 * Render workspace you can point it at the MCP service and we build the URL
 * from it. MCP_URL always wins.
 */
function resolveMcpUrl(): string {
  if (process.env.MCP_URL) {
    return process.env.MCP_URL;
  }
  if (process.env.MCP_HOST) {
    return `https://${process.env.MCP_HOST}/mcp`;
  }
  return 'http://localhost:8788/mcp';
}

export const config = {
  /** Your ArmorIQ API key. Starts with ak_live_ or ak_test_. */
  armoriqApiKey: required('ARMORIQ_API_KEY'),

  /** The agent name you registered on platform.armoriq.ai. */
  agentName: process.env.ARMORIQ_AGENT_NAME ?? 'ops-copilot',

  /** The MCP name you registered on platform.armoriq.ai. Must match exactly. */
  mcpName: process.env.ARMORIQ_MCP_NAME ?? 'ops-mcp',

  mcpUrl: resolveMcpUrl(),

  /** Which Gemini model to use. */
  model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',

  /**
   * How long to wait for a human to approve a held action, in seconds.
   *
   * The SDK's default is 300. We use 60 because waiting five minutes for a
   * click is painful. If nobody approves in time, the action is refused.
   * ArmorIQ fails closed.
   */
  approvalWaitSeconds: Number(process.env.APPROVAL_WAIT_SECONDS ?? 60),

  /** Set to "1" to run with no enforcement at all, to see the difference. */
  disableArmoriq: process.env.DISABLE_ARMORIQ === '1',
};
