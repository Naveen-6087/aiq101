// Offline mode: run the real src/index.ts and src/ask.ts with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @google/adk                                 -> offline/adk.mjs (the real ADK, but with a scripted
//                                                  model instead of Gemini and local ops tools instead
//                                                  of the MCP server)
//   @armoriq/sdk/dist/integrations/google_adk   -> offline/armoriq-adk.mjs (the Step 9 policy, checked
//                                                  locally: allow, hold, block)
// The ADK Runner, the agent loop, and ask.ts all run unchanged.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'ak_test_offline';
process.env.MCP_URL ??= 'offline://ops-mcp';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: Gemini, the ops MCP server, and ArmorIQ are local stand-ins.\n');
