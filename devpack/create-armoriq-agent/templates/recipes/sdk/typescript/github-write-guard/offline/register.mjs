// Offline mode: run the real demo.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps three imports for local stand-ins:
//   @armoriq/sdk       -> offline/armoriq-sdk.mjs  (reads policy.yaml and decides locally)
//   ./src/mcpClient.js -> offline/github-mcp.mjs   (canned GitHub data, no token needed)
//   ./src/planner.js   -> offline/planner.mjs      (rule based planning, no Gemini key needed)
// demo.js itself runs unchanged, so what you see is the same plan, check, approve, execute, report loop.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.GITHUB_PERSONAL_ACCESS_TOKEN ??= 'offline';
process.env.GITHUB_USER ??= 'acme';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ, GitHub, and the planner are local stand-ins.');
console.log(`[offline] Held calls will be ${process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED'} (set OFFLINE_APPROVAL=reject or approve).\n`);
