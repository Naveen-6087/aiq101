// Offline mode: run the real demo.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps three imports for local stand-ins:
//   @armoriq/sdk       -> offline/armoriq-sdk.mjs   (reads policy.yaml and decides locally)
//   ./src/mcpClient.js -> offline/coingecko-mcp.mjs (canned CoinGecko data, no network)
//   ./src/planner.js   -> offline/planner.mjs       (rule based planning, no Gemini key needed)
// demo.js itself runs unchanged, so what you see is the same plan, check, execute, report loop.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ, CoinGecko, and the planner are local stand-ins.\n');
