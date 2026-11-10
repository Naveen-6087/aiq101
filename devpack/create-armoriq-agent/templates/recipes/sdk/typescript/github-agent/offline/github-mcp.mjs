// Offline stand-in for src/mcp.js: answers the four read only GitHub tools from canned data,
// shaped like the GitHub MCP server's responses.

const REPOS = [
  { full_name: 'acme/acme-widgets', name: 'acme-widgets', owner: { login: 'acme' } },
  { full_name: 'acme/acme-docs', name: 'acme-docs', owner: { login: 'acme' } },
];

const COMMITS = [
  { sha: 'a1b2c3d4e5f6', commit: { message: 'Fix pagination bug' } },
  { sha: 'e4f5a6b7c8d9', commit: { message: 'Add retry logic to sync job\n\nRetries three times with backoff.' } },
];

const ISSUES = [
  { number: 14, state: 'open', title: 'Sync job times out on large payloads' },
  { number: 9, state: 'open', title: 'Pagination off by one on last page' },
];

const FILES = {
  'README.md': '# acme-widgets\n\nWidgets for the Acme sync service.\n',
  'package.json': '{ "name": "acme-widgets", "version": "2.1.0" }\n',
};

function respond(tool, args) {
  switch (tool) {
    case 'search_repositories':
      return { total_count: REPOS.length, items: REPOS };
    case 'list_commits':
      return COMMITS;
    case 'list_issues':
      return ISSUES;
    case 'get_file_contents':
      if (!args.path) return Object.keys(FILES).map((path) => ({ type: 'file', path }));
      if (Object.hasOwn(FILES, args.path)) return { path: args.path, content: FILES[args.path] };
      throw new Error(`No file ${args.path} in ${args.owner}/${args.repo} (offline data has: ${Object.keys(FILES).join(', ')})`);
    default:
      throw new Error(`The offline GitHub stand-in does not implement ${tool}`);
  }
}

export async function connectGitHubMcp() {}

export async function listTools() {
  return ['search_repositories', 'list_commits', 'list_issues', 'get_file_contents'].map((name) => ({ name }));
}

export async function callTool(toolName, args) {
  return { content: [{ type: 'text', text: JSON.stringify(respond(toolName, args)) }] };
}

export async function disconnectGitHubMcp() {}
