// Offline mode: run the real demo.js with no API keys, no network, and no MCP server process.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @armoriq/sdk         -> offline/armoriq-sdk.mjs   (decides from policy.yaml, locally)
//   ./src/mcpClient.js   -> offline/postgres-mcp.mjs    (canned rows seeded from db/init.sql, no Docker)
// demo.js and the rest of src/ run unchanged. OFFLINE_APPROVAL=reject rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';
process.env.DATABASE_URL ??= 'postgresql://offline:offline@localhost:5432/offline';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ and the MCP server are local stand-ins.\n');
