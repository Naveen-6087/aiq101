// Offline stand-in for src/mcpClient.js: an in memory research folder and an in memory knowledge
// graph instead of two spawned MCP server processes. Same exports, same result shapes.

const SOURCE = '# Notes on ArmorIQ\n\nArmorIQ checks every agent tool call against policy before it runs.\nOne signed plan can cover tools on several MCP servers.\n';

export async function connectFilesystemServer(allowedDir) {
  return { allowedDir, close: async () => {} };
}

export async function connectMemoryServer() {
  return { entities: [], close: async () => {} };
}

export async function callTool(client, name, args = {}) {
  switch (name) {
    case 'read_file':
      if (!String(args.path).endsWith('source.md')) throw new Error(`ENOENT: no such file: ${args.path}`);
      return SOURCE;
    case 'list_directory':
      return '[FILE] source.md';
    case 'read_graph':
      return { entities: client.entities, relations: [] };
    case 'search_nodes': {
      const q = String(args.query ?? '').toLowerCase();
      return { entities: client.entities.filter((e) => e.name.toLowerCase().includes(q)), relations: [] };
    }
    case 'create_entities':
      client.entities.push(...(args.entities ?? []));
      return args.entities ?? [];
    default:
      throw new Error(`Offline stand-in does not implement ${name}`);
  }
}

// Same router as src/mcpClient.js: "<mcp>__<action>" goes to the client that owns it.
export function makeRouter({ filesystemMcpName, filesystemClient, memoryMcpName, memoryClient }) {
  return async function callRoutedTool(toolName, args) {
    const idx = toolName.indexOf('__');
    const mcp = idx === -1 ? null : toolName.slice(0, idx);
    const action = idx === -1 ? toolName : toolName.slice(idx + 2);

    if (mcp === filesystemMcpName) return callTool(filesystemClient, action, args);
    if (mcp === memoryMcpName) return callTool(memoryClient, action, args);
    throw new Error(`No local MCP client wired up for "${toolName}" (mcp="${mcp}")`);
  };
}
