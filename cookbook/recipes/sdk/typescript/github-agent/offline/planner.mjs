// Offline stand-in for src/planner.js: turns each goal into one tool call with simple rules
// instead of asking Gemini. Overrides still win, exactly like the real planner.

const RULES = [
  [/^Search repositories for (.+)$/, (m) => ({ name: 'search_repositories', args: { query: `user:${m[1]}` } })],
  [/^List commits for /, () => ({ name: 'list_commits', args: {} })],
  [/^List issues for /, () => ({ name: 'list_issues', args: {} })],
  [/^List files in /, () => ({ name: 'get_file_contents', args: {} })],
  [/^Get contents of /, () => ({ name: 'get_file_contents', args: {} })],
];

export async function planWithLlm(goal, overrides = {}) {
  for (const [pattern, toCall] of RULES) {
    const match = goal.match(pattern);
    if (match) {
      const call = toCall(match);
      return [{ ...call, args: { ...call.args, ...overrides } }];
    }
  }
  throw new Error(`The model returned no usable tool call for: ${goal}`);
}
