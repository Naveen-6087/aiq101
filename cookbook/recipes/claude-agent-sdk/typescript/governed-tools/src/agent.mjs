// A release assistant built on the Claude Agent SDK, with every tool call governed by ArmorIQ.
//
//   npm start -- "Ship 2.4.0 to production and clean up the staging-old environment"
//
// Needs ARMORIQ_API_KEY and Claude credentials (ANTHROPIC_API_KEY) in .env. See README.md.

import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ArmorIQClient } from '@armoriq/sdk';
import { createGovernor } from './governance.mjs';
import { SERVER, createReleaseServer } from './tools.mjs';

const prompt = process.argv.slice(2).join(' ') || 'Ship 2.4.0 to production, then clean up the staging-old environment.';
const userEmail = process.env.USER_EMAIL || 'developer@example.com';

const armoriq = new ArmorIQClient({
  apiKey: process.env.ARMORIQ_API_KEY,
  userId: process.env.ARMORIQ_USER_ID || 'release-assistant',
  agentId: process.env.ARMORIQ_AGENT_ID || 'claude-agent-sdk-release-assistant',
});

const governor = createGovernor({
  armoriq,
  server: SERVER,
  userEmail,
  approvalWaitSeconds: Number(process.env.ARMORIQ_APPROVAL_WAIT_SECONDS ?? 300),
});
const releaseServer = createReleaseServer(governor.report);

console.log(`[agent] user: ${userEmail}`);
console.log(`[agent] prompt: ${prompt}\n`);
governor.startTurn(prompt);

const run = query({
  prompt,
  options: {
    systemPrompt:
      'You are a release assistant. Use the release tools to check builds, deploy, and manage environments. ' +
      'If a tool call is denied, say so plainly and do not try to work around it.',
    mcpServers: { [SERVER]: releaseServer },
    // No built-in tools at all (no Bash, file edits, or web access): only the governed release tools.
    tools: [],
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
    // The release tools are deliberately NOT in allowedTools: anything listed there skips
    // canUseTool, and so would skip ArmorIQ.
    allowedTools: [],
    permissionMode: 'default',
    canUseTool: governor.canUseTool,
    // Ignore ~/.claude and project settings so no local "always allow" rule bypasses canUseTool.
    settingSources: [],
    maxTurns: 12,
    ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
  },
});

let ok = true;
for await (const message of run) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) console.log(`[claude] ${block.text.trim()}`);
      if (block.type === 'tool_use') console.log(`[claude] wants ${block.name} ${JSON.stringify(block.input)}`);
    }
  } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue;
      const body = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join(' ') : String(block.content ?? '');
      console.log(`[tool] ${block.is_error ? 'denied/error' : 'result'}: ${body.slice(0, 300)}`);
    }
  } else if (message.type === 'result') {
    ok = message.subtype === 'success';
    console.log(`\n[agent] finished: ${message.subtype} after ${message.num_turns} turns`);
  }
}

await governor.close();
armoriq.close();
console.log(ok ? 'RUN COMPLETED' : 'RUN ENDED WITH AN ERROR');
process.exit(ok ? 0 : 1);
