// Offline mode: run the real src/agent.mjs with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @anthropic-ai/claude-agent-sdk -> offline/claude-agent-sdk.mjs  (scripted Claude: replays tool
//                                     calls through the real canUseTool and the real tool handlers)
//   @armoriq/sdk                   -> offline/armoriq-sdk.mjs       (reads policy.yaml, decides locally)
// src/agent.mjs, src/governance.mjs, and src/tools.mjs run unchanged, so the governance code you
// see working is the code that runs live.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';
process.env.ARMORIQ_APPROVAL_WAIT_SECONDS ??= '5';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: Claude and ArmorIQ are local stand-ins.');
console.log(`[offline] Held calls will be ${process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED'} (set OFFLINE_APPROVAL=reject or approve).\n`);
