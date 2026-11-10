// Offline stand-in for src/mcpClient.js: answers weather-mcp's two tools from canned data, so no
// npx download or network is needed. Returns parsed results, like the real callTool does.

const PLACES = [
  { name: 'Bengaluru', country: 'India', latitude: 12.9716, longitude: 77.5946 },
  { name: 'Tokyo', country: 'Japan', latitude: 35.6762, longitude: 139.6503 },
];

const CONDITIONS = {
  '12.9716,77.5946': { temperature_c: 24, humidity_percent: 68, wind_kph: 11, summary: 'Partly cloudy' },
  '35.6762,139.6503': { temperature_c: 17, humidity_percent: 55, wind_kph: 14, summary: 'Clear' },
};

export async function connectWeatherServer() {
  return { async close() {} };
}

export async function listTools() {
  return [{ name: 'search_location' }, { name: 'get_current_conditions' }];
}

export async function callTool(client, name, args = {}) {
  switch (name) {
    case 'search_location': {
      const q = String(args.query ?? '').toLowerCase();
      return { results: PLACES.filter((p) => q.includes(p.name.toLowerCase())) };
    }
    case 'get_current_conditions': {
      const found = CONDITIONS[`${args.latitude},${args.longitude}`];
      if (!found) throw new Error(`Offline data has no observation for ${args.latitude}, ${args.longitude}`);
      return { latitude: args.latitude, longitude: args.longitude, ...found };
    }
    default:
      throw new Error(`The offline weather stand-in does not implement ${name}`);
  }
}
