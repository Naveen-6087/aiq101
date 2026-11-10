// Offline mode: run the real agent.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps three imports for local stand-ins:
//   @armoriq/sdk            -> offline/armoriq-sdk.mjs (reads policy.yaml and decides locally)
//   @langchain/google-genai -> offline/model.mjs       (a scripted tool calling chat model, no Gemini key)
//   ./src/mcpClient.js      -> offline/weather-mcp.mjs (canned weather data, no npx download)
// agent.js, src/tools.js, createAgent, and the real ArmorIQLangChain callback handler all run
// unchanged. The handler checks every tool call the scripted model makes.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.GEMINI_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ, the chat model, and weather data are local stand-ins.');
console.log('[offline] The real ArmorIQLangChain callback handler is running.\n');
