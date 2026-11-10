// Offline stand-in for src/mcpClient.js: a small in memory notes folder instead of a spawned
// @modelcontextprotocol/server-filesystem process. Same two exports, same result shapes.

const files = new Map([
  ['ideas.md', '# Ideas\n\n- Try the ArmorIQ cookbook offline.\n'],
  ['todo.md', '# Todo\n\n- Review the policy file.\n'],
]);
const dirs = new Set(['archive']);

export async function connectFilesystemServer(allowedDir) {
  return { allowedDir, close: async () => {} };
}

function rel(client, p) {
  return String(p ?? '').replace(client.allowedDir, '').replace(/^\/+/, '');
}

export async function callTool(client, name, args = {}) {
  switch (name) {
    case 'list_directory':
      return [...[...dirs].map((d) => `[DIR] ${d}`), ...[...files.keys()].map((f) => `[FILE] ${f}`)].join('\n');
    case 'read_file': {
      const content = files.get(rel(client, args.path));
      if (content === undefined) throw new Error(`ENOENT: no such file: ${args.path}`);
      return content;
    }
    case 'search_files':
      return [...files.keys()].map((f) => `${client.allowedDir}/${f}`).join('\n');
    case 'write_file':
      files.set(rel(client, args.path), args.content ?? '');
      return `Successfully wrote to ${args.path}`;
    case 'move_file': {
      const from = rel(client, args.source);
      files.set(rel(client, args.destination), files.get(from) ?? '');
      files.delete(from);
      return `Successfully moved ${args.source} to ${args.destination}`;
    }
    default:
      throw new Error(`Offline filesystem stand-in does not implement ${name}`);
  }
}
