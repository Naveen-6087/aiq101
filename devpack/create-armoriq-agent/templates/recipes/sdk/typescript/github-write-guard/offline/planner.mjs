// Offline stand-in for src/planner.js: turns a goal into tool calls with keyword rules instead of
// asking Gemini. One goal can name several actions, and they come out in the order written.

const mcp = process.env.GITHUB_MCP_NAME || 'github';
const owner = process.env.GITHUB_USER || 'acme';
const repo = 'acme-widgets';

const RULES = [
  [/search/i, () => ({ name: `${mcp}__search_repositories`, args: { query: `user:${owner}` } })],
  [/pull request/i, () => ({
    name: `${mcp}__create_pull_request`,
    args: { owner, repo, title: 'Update documentation', head: 'patch-1', base: 'main', body: 'Opened by the agent' },
  })],
  [/delete/i, () => ({ name: `${mcp}__delete_repository`, args: { owner, repo } })],
];

export async function planWithLlm(goal, providedToolCalls = null) {
  if (Array.isArray(providedToolCalls) && providedToolCalls.length > 0) return providedToolCalls;
  const hits = RULES.map(([pattern, toCall]) => ({ at: goal.search(pattern), toCall }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (hits.length === 0) throw new Error(`The offline planner has no rule for: ${goal}`);
  return hits.map((hit) => hit.toCall());
}
