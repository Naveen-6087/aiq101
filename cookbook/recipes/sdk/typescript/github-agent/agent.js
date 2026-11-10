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
