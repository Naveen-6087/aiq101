// Offline mode: run the real agent.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps three imports for local stand-ins:
//   @armoriq/sdk     -> offline/armoriq-sdk.mjs   (the Step 5 policy, checked locally)
//   ./src/mcp.js     -> offline/github-mcp.mjs    (canned GitHub data, no token needed)
//   ./src/planner.js -> offline/planner.mjs       (rule based planning, no Gemini key needed)
// agent.js itself runs unchanged, so what you see is the same plan, check, execute, report loop.

import { register } from 'node:module';

process.env.GITHUB_USER ??= 'acme';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ, GitHub, and the LLM are local stand-ins.\n');
