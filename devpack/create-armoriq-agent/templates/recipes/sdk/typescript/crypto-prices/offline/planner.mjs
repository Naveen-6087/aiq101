// Offline stand-in for src/planner.js: turns a goal into tool calls with keyword rules instead of
// asking Gemini. Like the real model, it resolves a coin id with search_coin before pricing a coin
// it does not already know, and it can chain the lookups in one plan.

const mcp = process.env.COINGECKO_MCP_NAME || 'coingecko';
const KNOWN_IDS = ['bitcoin', 'ethereum'];
const NAMES = { bitcoin: /bitcoin|btc/i, ethereum: /ethereum|eth\b/i, solana: /solana|sol\b/i };

export async function planWithLlm(goal, providedToolCalls = null) {
  if (Array.isArray(providedToolCalls) && providedToolCalls.length > 0) return providedToolCalls;

  const ids = Object.keys(NAMES).filter((id) => NAMES[id].test(goal));
  if (ids.length === 0) ids.push('bitcoin');
  const vs_currency = /\beur\b/i.test(goal) ? 'eur' : 'usd';
  const tool = /market cap|rank|\bath\b/i.test(goal) ? 'get_market_data' : 'get_price';

  const calls = [];
  for (const id of ids) {
    if (!KNOWN_IDS.includes(id)) calls.push({ name: `${mcp}__search_coin`, args: { query: id } });
  }
  calls.push({ name: `${mcp}__${tool}`, args: { ids: ids.join(','), vs_currency } });
  return calls;
}
