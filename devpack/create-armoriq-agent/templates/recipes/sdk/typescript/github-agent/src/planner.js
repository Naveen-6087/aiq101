const GITHUB_MCP_TOOLS = [
  { name: "search_repositories", description: "Search repositories (args: { query })" },
  { name: "list_commits", description: "List commits in a repository (args: { owner, repo })" },
  { name: "list_issues", description: "List issues in a repository (args: { owner, repo })" },
  { name: "get_file_contents", description: "Get a file or directory (args: { owner, repo, path })" },
];

async function planWithGemini(goal, geminiApiKey) {
  const prompt = `Convert this goal into GitHub MCP tool calls.
Available tools: ${JSON.stringify(GITHUB_MCP_TOOLS)}
Goal: "${goal}"
Return ONLY a JSON array like [{ "name": "tool_name", "args": {} }]. No markdown, no extra text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiApiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

/**
 * `overrides` carries values you already know exactly (a repo the user
 * picked from a list, a file path they typed) and always wins over
 * whatever the LLM extracted from free text. Never trust free-text
 * extraction alone for a value your policy needs to be exact.
 */
export async function planWithLlm(goal, overrides = {}) {
  const [call] = await planWithGemini(goal, process.env.GEMINI_API_KEY);
  if (!call?.name) throw new Error(`The model returned no usable tool call for: ${goal}`);
  return [{ ...call, args: { ...call.args, ...overrides } }];
}
