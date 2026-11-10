// Offline stand-in for src/mcpClient.js: answers GitHub tool calls from canned data, so no token,
// npx download, or network is needed. Returns parsed results, like the real callTool does.

const REPOS = [
  { full_name: 'acme/acme-widgets', name: 'acme-widgets', owner: { login: 'acme' } },
  { full_name: 'acme/acme-docs', name: 'acme-docs', owner: { login: 'acme' } },
];

function respond(tool, args) {
  switch (tool) {
    case 'search_repositories':
      return { total_count: REPOS.length, items: REPOS };
    case 'create_pull_request':
      return { number: 27, state: 'open', title: args.title, html_url: `https://github.com/${args.owner}/${args.repo}/pull/27` };
    case 'create_or_update_file':
      return { content: { path: args.path }, commit: { sha: 'c0ffee123456' } };
    case 'delete_repository':
      return { message: 'The offline stand-in deleted nothing.' };
    default:
      throw new Error(`The offline GitHub stand-in does not implement ${tool}`);
  }
}

export async function connectGithubServer() {
  return { async close() {} };
}

export async function callTool(client, name, args) {
  return respond(name, args ?? {});
}
