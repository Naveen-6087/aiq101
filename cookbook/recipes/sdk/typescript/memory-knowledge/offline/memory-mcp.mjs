// Offline stand-in for src/mcpClient.js: an in memory knowledge graph instead of a spawned
// @modelcontextprotocol/server-memory process. Same two exports, same result shapes.

export async function connectMemoryServer() {
  return { entities: [{ name: 'ArmorIQ', entityType: 'product', observations: ['Checks every agent tool call against policy'] }], close: async () => {} };
}

export async function callTool(client, name, args = {}) {
  switch (name) {
    case 'read_graph':
      return { entities: client.entities, relations: [] };
    case 'search_nodes': {
      const q = String(args.query ?? '').toLowerCase();
      const hit = (e) => [e.name, e.entityType, ...e.observations].some((s) => s.toLowerCase().includes(q));
      return { entities: client.entities.filter(hit), relations: [] };
    }
    case 'open_nodes':
      return { entities: client.entities.filter((e) => (args.names ?? []).includes(e.name)), relations: [] };
    case 'create_entities':
      client.entities.push(...(args.entities ?? []));
      return args.entities ?? [];
    case 'delete_entities':
      client.entities = client.entities.filter((e) => !(args.entityNames ?? []).includes(e.name));
      return 'Entities deleted successfully';
    default:
      throw new Error(`Offline memory stand-in does not implement ${name}`);
  }
}
