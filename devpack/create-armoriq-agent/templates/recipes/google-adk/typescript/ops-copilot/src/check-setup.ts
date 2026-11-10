//   npm run check
//
// This only reads. It does not create plans, tokens, or approval requests, so
// it is safe to run against a real account.
import { ArmorIQClient } from '@armoriq/sdk';
import { config } from './config.js';
import { errorMessage } from './error-message.js';

type NamedEntry = { name?: string };

/** Turns [{name:"a"},{name:"b"}] into ["a","b"]. Unnamed entries become "?". */
function namesOf(entries: NamedEntry[] | undefined): string[] {
  if (!entries) {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    names.push(entry.name ?? '?');
  }
  return names;
}

/** Pulls the tool list out of the MCP server's response text. */
function parseToolsList(text: string): Array<{ name: string }> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return [];
  }
  const parsed = JSON.parse(match[0]);
  return parsed.result?.tools ?? [];
}

async function main() {
  console.log('Checking your setup...\n');

  // ── 1. Can we reach the MCP server? ──────────────────────────────────────
  try {
    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await response.text();
    const tools = parseToolsList(text);
    console.log(`MCP server:  OK - ${tools.length} tools at ${config.mcpUrl}`);
    for (const tool of tools) console.log(`               ${tool.name}`);
  } catch (error: unknown) {
    console.log(`MCP server:  FAILED - cannot reach ${config.mcpUrl}`);
    console.log(`               ${errorMessage(error)}`);
    console.log('               Is the MCP server running? cd ../armoriq-adk-ops-mcp && npm start');
  }
  console.log();

  // ── 2. Is the ArmorIQ key valid, and do the names match? ─────────────────
  const client = new ArmorIQClient({
    apiKey: config.armoriqApiKey,
    userId: 'agent',
    agentId: config.agentName,
    useProduction: true,
  });

  try {
    const account = await client.bootstrap();
    const agentNames = namesOf(account.agents);
    const mcpNames = namesOf(account.mcps);

    console.log(`ArmorIQ:     OK - org "${account.org?.name ?? 'unknown'}"`);
    console.log(`Agents:      ${agentNames.length ? agentNames.join(', ') : 'none registered'}`);
    console.log(`MCPs:        ${mcpNames.length ? mcpNames.join(', ') : 'none registered'}`);
    console.log();

    // The two mismatches that cause "my policies aren't firing".
    if (agentNames.includes(config.agentName)) {
      console.log(`Agent name:  OK - "${config.agentName}" is registered`);
    } else {
      console.log(`Agent name:  MISMATCH - .env says "${config.agentName}", which is not registered.`);
      console.log('               Register it, or change ARMORIQ_AGENT_NAME to one of the above.');
    }

    if (mcpNames.includes(config.mcpName)) {
      console.log(`MCP name:    OK - "${config.mcpName}" is registered`);
    } else {
      console.log(`MCP name:    MISMATCH - .env says "${config.mcpName}", which is not registered.`);
      console.log('               Register it, or change ARMORIQ_MCP_NAME to one of the above.');
    }
  } catch (error: unknown) {
    console.log(`ArmorIQ:     FAILED - ${errorMessage(error)}`);
    console.log('               Check ARMORIQ_API_KEY in .env.');
  }

  console.log();
  client.close();
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
