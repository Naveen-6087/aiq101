// Offline mode: run the real demo.mjs with no API keys and no network beyond 127.0.0.1.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It starts the stand-in gateway in offline/gateway.mjs
// on a free localhost port and points the agent at it by setting ARMORIQ_GATEWAY_HOST, the same
// setting that names the real gateway. Unlike the SDK recipes there is no module to swap: the
// agent's only ArmorIQ touch point is a base URL, so the stand-in is a server, not a hook.

import { startGateway } from './gateway.mjs';

process.env.ANTHROPIC_API_KEY = 'offline';
process.env.ARMORIQ_GATEWAY_KEY = 'offline-gateway-key';
process.env.ARMORIQ_AGENT_ID ??= 'support-bot';
process.env.USER_EMAIL ??= 'dana@example.com';

const { url } = await startGateway();
process.env.ARMORIQ_GATEWAY_HOST = url;

console.log(`[offline] stand-in gateway on ${url}; Claude is scripted, no keys used.`);
console.log('[offline] A hold works like a block at the gateway today, so OFFLINE_APPROVAL changes nothing here.');
