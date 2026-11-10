// Offline stand-in for src/mcpClient.js: answers the three CoinGecko tools from canned data, shaped
// like the real server's responses. Returns parsed results, like the real callTool does.

const COINS = {
  bitcoin: { name: 'Bitcoin', symbol: 'btc', rank: 1, usd: 67250, eur: 61890, change: 1.4, cap: 1329000000000 },
  ethereum: { name: 'Ethereum', symbol: 'eth', rank: 2, usd: 3480, eur: 3203, change: -0.6, cap: 418000000000 },
  solana: { name: 'Solana', symbol: 'sol', rank: 5, usd: 158.2, eur: 145.6, change: 2.9, cap: 73500000000 },
};

function coin(id) {
  if (!Object.hasOwn(COINS, id)) throw new Error(`Offline data has no coin "${id}" (has: ${Object.keys(COINS).join(', ')})`);
  return COINS[id];
}

function respond(tool, args) {
  const ids = String(args.ids ?? '').split(',').filter(Boolean);
  const cur = args.vs_currency === 'eur' ? 'eur' : 'usd';
  switch (tool) {
    case 'search_coin': {
      const q = String(args.query ?? '').toLowerCase();
      return Object.entries(COINS)
        .filter(([id, c]) => id.includes(q) || c.symbol === q)
        .map(([id, c]) => ({ id, name: c.name, symbol: c.symbol, market_cap_rank: c.rank }));
    }
    case 'get_price':
      return Object.fromEntries(ids.map((id) => {
        const c = coin(id);
        return [id, { [cur]: c[cur], [`${cur}_market_cap`]: c.cap, [`${cur}_24h_change`]: c.change }];
      }));
    case 'get_market_data':
      return ids.map((id) => {
        const c = coin(id);
        return { id, symbol: c.symbol, name: c.name, current_price: c[cur], market_cap: c.cap, market_cap_rank: c.rank, price_change_percentage_24h: c.change };
      });
    default:
      throw new Error(`The offline CoinGecko stand-in does not implement ${tool}`);
  }
}

export async function connectCoingeckoServer() {
  return { async close() {} };
}

export async function callTool(client, name, args) {
  return respond(name, args ?? {});
}
