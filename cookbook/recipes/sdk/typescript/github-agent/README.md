# Build a GitHub Agent with the ArmorIQ SDK

A step-by-step guide to building an AI agent that can search, read, and explore a GitHub repository, with every action checked against your organization's policy before it runs.

***

## What you'll build

A command-line agent that walks a GitHub repository interactively:

```
Search repositories → choose one → list its commits → list its issues
→ list its files → choose one → read its contents
```

Each step is planned by an LLM into a single tool call, checked against ArmorIQ policy, and executed against the GitHub MCP server. If a step is ever denied by policy, the agent shows you the denial instead of failing silently.

<!-- 📸 Screenshot placeholder: final terminal output of a complete run, top to bottom. -->

## Try it offline first

Want to see the agent loop before you create any accounts? Offline mode runs the real `agent.js` with local stand-ins for ArmorIQ, GitHub, and the LLM (in `offline/`), so it needs no keys and no network:

```bash
npm install
npm run demo:offline    # answer the prompts, e.g. 1 and README.md
npm run test:offline    # the same run, scripted, as a pass or fail check
```

Every step still goes through plan, check, execute, and report. The offline policy is the one from Step 5: the four read tools are allowed, and anything else is blocked.

## Before you start

You'll need:

| Requirement                                       | Why                                          |
| ------------------------------------------------- | -------------------------------------------- |
| Node.js v18 or later, and npm                     | Runs the agent                               |
| A GitHub account and a repository to test against | The agent's target                           |
| An ArmorIQ account                                | Policy enforcement and observability         |
| An LLM API key (this guide uses Gemini)           | Plans tool calls from natural-language goals |

Check your Node version before starting:

```bash
node --version   # v18.0.0 or higher
npm --version    # v8.0.0 or higher
```

***

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up, or log in if you already have an account.
2. Open **Settings → API Keys**.
3. Click **Generate new key**, and copy it somewhere safe; you won't be able to see it again.

<!-- 📸 Screenshot placeholder: the API Keys screen with the "Generate new key" button. -->

Keep this key handy; you'll add it to your `.env` file in Step 6.

## Step 2: Create a GitHub personal access token

The agent needs its own GitHub credential to read repositories on your behalf.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens).
2. Click **Generate new token → Generate new token (classic)**.
3. Give it a name like `armoriq-github-agent`.
4. Under **Scopes**, check `repo` (read access is enough for this guide; only widen scope if you extend the agent to writes).
5. Click **Generate token** and copy it immediately.

<!-- 📸 Screenshot placeholder: the token scopes screen with `repo` checked. -->

## Step 3: Get an LLM API key

This guide uses Gemini because it has a generous free tier, but the code isolates the LLM call to one function: swap in OpenAI, Claude, or anything else without touching the rest of the agent.

1. Go to [aistudio.google.com](https://aistudio.google.com/apikey).
2. Click **Create API key** and copy it.

## Step 4: Register the GitHub MCP server with ArmorIQ

MCP (Model Context Protocol) is the standard your agent uses to call GitHub's tools (search, list commits, read files, and so on) through one consistent interface instead of hand-rolling API calls. Before your code can use it, ArmorIQ needs to know it exists.

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Register MCP Server**.
3. Name it `github`; this guide's code assumes that name.
4. Paste your GitHub personal access token from Step 2 as the MCP's credential.
5. Save.

<!-- 📸 Screenshot placeholder: the MCP registration form, filled in. -->

Registering it here, once, at the organization level, is what lets policy reference it by name, and lets anyone on your team build against the same MCP without passing tokens around directly.

## Step 5: Write your first policy

1. In the console, open **Policies → New Policy**.
2. Set **Default enforcement action** to `block`. This is the setting that matters most: anything not explicitly named is denied.
3. Add an allowlist rule for the read-only tools this guide uses: `search_repositories`, `list_commits`, `list_issues`, `get_file_contents`.
4. Save the policy and apply it to your organization.

<!-- 📸 Screenshot placeholder: the policy editor showing the allowlist. -->

With this policy, the four tools above are allowed; every other GitHub tool (including anything destructive) is blocked by default, with no rule required to forbid it.

***

## Step 6: Scaffold the project

```bash
mkdir armoriq-github-agent
cd armoriq-github-agent
npm init -y
```

Open `package.json` and add `"type": "module"` so you can use `import` syntax:

```json
{
  "name": "armoriq-github-agent",
  "version": "1.0.0",
  "type": "module",
  "main": "agent.js"
}
```

Install dependencies:

```bash
npm install @armoriq/sdk @modelcontextprotocol/sdk dotenv
```

| Package                     | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `@armoriq/sdk`              | Policy checks, plan capture, observability |
| `@modelcontextprotocol/sdk` | Talks to the GitHub MCP server             |
| `dotenv`                    | Loads your `.env` file                     |

Create the file structure:

```bash
mkdir src
touch .env src/mcp.js src/planner.js agent.js
```

## Step 7: Configure environment variables

Paste your three keys from Steps 1–3 into `.env`:

```bash
# .env

# From platform.armoriq.ai → Settings → API Keys
ARMORIQ_API_KEY=ak_your_key_here

# From github.com/settings/tokens
GITHUB_PERSONAL_ACCESS_TOKEN=your_github_pat_here

# From aistudio.google.com/apikey
GEMINI_API_KEY=your_gemini_key_here

# Your GitHub username, used as the default account to search
GITHUB_USER=your-github-username

# Identifies this session in ArmorIQ's observability logs
USER_EMAIL=you@your-org.com
```

Add `.env` to `.gitignore` immediately, before you forget:

```bash
echo ".env" >> .gitignore
```

## Step 8: Connect to the GitHub MCP server

`src/mcp.js` owns the connection to GitHub's tools. It spawns the MCP server as a local child process over stdio, and gives you three functions: list the tools it exposes, call one, and disconnect when you're done.

```js
// src/mcp.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient = null;
let mcpTransport = null;

export async function connectGitHubMcp(githubToken) {
  if (mcpClient) return mcpClient;

  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
  });

  mcpClient = new Client(
    { name: "armoriq-github-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

export async function listTools() {
  const result = await mcpClient.listTools();
  return result.tools;
}

export async function callTool(toolName, args) {
  return mcpClient.callTool({ name: toolName, arguments: args });
}

export async function disconnectGitHubMcp() {
  if (mcpTransport) {
    await mcpTransport.close();
    mcpTransport = null;
    mcpClient = null;
  }
}
```

The first time this runs, `npx` downloads the GitHub MCP server package, so expect a short delay on the very first call.

## Step 9: Plan tool calls with an LLM

`src/planner.js` turns a plain-English goal, `"list commits for acme/widgets"`, into a structured tool call the MCP server understands: `{ name: "list_commits", args: { owner: "acme", repo: "widgets" } }`.

````js
// src/planner.js

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
````

> **Using a different LLM?** Only `planWithGemini` changes. Everything downstream expects the same return shape: an array of `{ name, args }` objects.

## Step 10: Build the agent loop

Every step follows the same four moves: **plan → check → execute → report**. Put that in one reusable function in `agent.js`.

```js
// agent.js
import readline from "node:readline/promises";
import dotenv from "dotenv";
import { ArmorIQClient } from "@armoriq/sdk";
import { connectGitHubMcp, callTool, disconnectGitHubMcp } from "./src/mcp.js";
import { planWithLlm } from "./src/planner.js";

dotenv.config();

const userEmail = process.env.USER_EMAIL;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askUser = (question) => rl.question(question);

async function runStep(session, goal, overrides) {
  const [call] = await planWithLlm(goal, overrides);

  // 1. Commit this step to the plan ArmorIQ is tracking.
  await session.startPlan([call], goal);

  // 2. Check policy before anything executes.
  const decision = await session.check(call.name, call.args, userEmail);
  if (!decision.allowed) {
    console.log(`[BLOCKED] ${call.name}: ${decision.reason}`);
    await session.report(call.name, call.args, null, { status: "failed", errorMessage: decision.reason });
    return null;
  }

  // 3. Execute the tool call yourself; this is what sdk mode means.
  const result = await callTool(call.name, call.args);
  const data = JSON.parse(result.content[0].text);

  // 4. Report the outcome for the audit trail.
  await session.report(call.name, call.args, data);
  return data;
}
```

Now use it to build the interactive walkthrough:

```js
async function main() {
  const armoriq = new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY });
  await armoriq.bootstrap();
  await connectGitHubMcp(process.env.GITHUB_PERSONAL_ACCESS_TOKEN);

  const session = armoriq.forUser(userEmail).startSession({
    mode: "sdk",
    defaultMcpName: "github",
    validitySeconds: 2400,
  });

  // Step 1: search, then let the user choose a repo.
  const search = await runStep(session, `Search repositories for ${process.env.GITHUB_USER}`, {});
  const repos = search.items;
  repos.forEach((r, i) => console.log(`  ${i + 1}. ${r.full_name}`));

  const choice = await askUser("\nWhich repository? ");
  const chosen = repos[Number(choice) - 1] ?? repos.find((r) => r.full_name.includes(choice));
  const owner = chosen.owner.login;
  const repo = chosen.name;

  // Step 2: list its commits.
  const commits = await runStep(session, `List commits for ${owner}/${repo}`, { owner, repo });
  commits.forEach((c) => console.log(`  ${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`));

  // Step 3: list its issues.
  const issues = await runStep(session, `List issues for ${owner}/${repo}`, { owner, repo });
  issues.forEach((iss) => console.log(`  #${iss.number} [${iss.state}] ${iss.title}`));

  // Step 4: list files, then read the one the user asks for.
  const files = await runStep(session, `List files in ${owner}/${repo}`, { owner, repo, path: "" });
  files.forEach((f, i) => console.log(`  ${i + 1}. [${f.type}] ${f.path}`));

  const filePath = await askUser("\nWhich file would you like to read? ");
  const file = await runStep(session, `Get contents of ${filePath}`, { owner, repo, path: filePath });
  console.log(`\n--- ${filePath} ---\n${file.content}`);

  await session.flushObservability();
  await session.close();
  await disconnectGitHubMcp();
  rl.close();
}

main();
```

`askUser` is the small `node:readline/promises` helper defined at the top of the file; swap in any prompt library you already have.

***

## Step 11: Run it

```bash
node agent.js
```

You'll be prompted at two points: once to choose a repository from the search results, and once to choose a file to read.

```
Which repository? acme-widgets

Commits Found: 12
  a1b2c3d Fix pagination bug
  e4f5a6b Add retry logic to sync job

Issues Found: 4
  #14 [open] Sync job times out on large payloads
  #9  [open] Pagination off by one on last page

Which file would you like to read? package.json

--- package.json ---
{ "name": "acme-widgets", "version": "2.1.0", ... }
```

<!-- 📸 Screenshot placeholder: a full terminal run, from the search results through the final file read. -->

If a step gets blocked, you'll see it inline instead of the agent silently doing nothing:

```
[BLOCKED] delete_repository: tool-not-allowlisted
```

That's the policy from Step 5 working as intended: nobody wrote a rule permitting deletion, so the closed default denies it.

## Step 12: See it in the ArmorIQ dashboard

Every step you just ran produced an audit row. In the console, open **Observability** and find your run by `USER_EMAIL`.

For each tool call you'll see the arguments, the decision, the matched policy, and a `proofPath` tying that specific execution back to the signed plan it was checked against.

<!-- 📸 Screenshot placeholder: the Observability table after a run. -->

Try changing the policy from Step 5 (move `list_issues` from the allowlist to a hold rule) and run the agent again without touching any code. That's the point of keeping policy in the console: behavior changes without a redeploy.

***

## Troubleshooting

| Symptom                                       | Likely cause                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Everything gets blocked                       | Default policy is `block` with no matching rule; check the allowlist in Step 5 covers the tool names your agent calls |
| MCP connection times out on first run         | `npx` is downloading the GitHub MCP server package for the first time; retry once it's cached                         |
| `401` from GitHub MCP calls                   | Personal access token is missing the `repo` scope, or was pasted with a trailing space in `.env`                      |
| Policy check always denies with "unknown MCP" | The tool name doesn't match the registered MCP's name; this guide assumes `github`, check Step 4                      |
| Gemini call fails silently                    | `GEMINI_API_KEY` missing or invalid; logs the raw API error to the console                                            |

## What's next

* **Move to a server.** This guide runs `sdk` mode locally: your process holds the GitHub token and executes tools itself. If you're building a service instead of a CLI tool, `proxy` mode routes the call through ArmorIQ instead; your service never touches the token. See *Working example: an Express agent on the GitHub MCP* for that version.
* **Add a hold for writes.** Extend the agent to open pull requests or create issues, and set `toolEnforcement` to `hold` on those tools instead of allowlisting them; a human approves before anything is written.
* **Use an agent framework.** This guide hand-rolls the plan → check → execute → report loop for clarity. If you're on Google ADK, LangChain, Strands, or CrewAI, the framework integration extracts tool calls for you automatically.
