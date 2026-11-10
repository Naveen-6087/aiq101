/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  This is the file to read.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Google ADK agent, governed by ArmorIQ, in four steps:
 *
 *   Step 1  Get the tools from the MCP server
 *   Step 2  Build the ADK agent
 *   Step 3  Wrap the run in ArmorIQ          <-- the integration
 *   Step 4  Run it and print what happened
 *
 * Only step 3 is ArmorIQ. Steps 1, 2 and 4 are ordinary ADK code. If you
 * deleted step 3 the agent would still work, it just would not be governed.
 *
 * How ArmorIQ governs the agent: `scope.install(agent)` attaches three
 * callbacks to the agent.
 *
 *   afterModelCallback   after the model picks tools, describe them as a
 *                        "plan" and get it cryptographically signed
 *   beforeToolCallback   before each tool runs, ask ArmorIQ: allow, hold
 *                        (wait for a human), or block?
 *   afterToolCallback    after each tool runs, record what happened
 *
 * The important part: enforcement happens in `beforeToolCallback`, which is
 * outside the model. It does not matter what the model was persuaded to do.
 */
import {
  InMemorySessionService,
  LlmAgent,
  MCPToolset,
  Runner,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
} from '@google/adk';
import { ArmorIQADK, ArmorIQADKBundle } from '@armoriq/sdk/dist/integrations/google_adk';

import { config } from './config.js';

const APP_NAME = 'ops-copilot';

const INSTRUCTIONS = `
You are the internal operations copilot for a SaaS company. You help support
staff resolve customer billing problems.

How to work:
- Look up the customer and their charges before you act.
- Read the support ticket that was referenced, so you know what was asked.
- If you find a duplicate charge, refund exactly the duplicated amount.
- Be brief. Say what you did, and what you could not do.

Some actions are governed by company policy. A tool may come back refused or
held for human approval. If that happens, do not retry it and do not look for a
way around it. Explain it plainly and carry on with what you can do.
`.trim();

export type AskResult = {
  answer: string;
  toolCalls: number;
  blocked: string[];
};

/**
 * Ask the agent one question.
 *
 * @param question    What the support person is asking for.
 * @param userEmail   Who is asking. ArmorIQ applies THAT person's policy, so
 *                    the same question can be allowed for one user and held for
 *                    another.
 */
export async function ask(question: string, userEmail: string): Promise<AskResult> {
  // ── Step 1: get the tools from the MCP server ─────────────────────────────
  // ADK connects to the MCP server and asks it what tools it has. We never
  // hand-write the tool list.
  const toolset = new MCPToolset({
    type: 'StreamableHTTPConnectionParams',
    url: config.mcpUrl,
  });
  const tools = await toolset.getTools();
  console.log(`Found ${tools.length} tools on the MCP server.\n`);

  // ── Step 2: build the ADK agent ───────────────────────────────────────────
  const agent = new LlmAgent({
    name: 'ops_copilot',
    model: config.model,
    instruction: INSTRUCTIONS,
    tools,
  });

  const sessionService = new InMemorySessionService();
  const runner = new Runner({ appName: APP_NAME, agent, sessionService });
  const session = await sessionService.createSession({ appName: APP_NAME, userId: userEmail });

  // ── Step 3: wrap the run in ArmorIQ ───────────────────────────────────────
  const blocked: string[] = [];

  // If ArmorIQ is disabled, `armoriq` stays undefined and nothing below runs.
  let armoriq: ArmorIQADK | undefined;
  if (!config.disableArmoriq) {
    armoriq = new ArmorIQADK({
      apiKey: config.armoriqApiKey,
      agentName: config.agentName,
      defaultMcpName: config.mcpName,
      approvalWaitSeconds: config.approvalWaitSeconds,
    });
  }

  // `scope` is only set when ArmorIQ is enabled. Everything below that uses
  // it is guarded by `if (scope)`.
  let scope: ArmorIQADKBundle | undefined;

  if (armoriq) {
    // `forUser` binds this run to one person, so policy is applied per user.
    scope = await armoriq.forUser(userEmail, {
      goal: question,
      // Optional. ArmorIQ calls this as it makes decisions, so an app can show
      // "waiting for approval" instead of appearing frozen.
      onEvent: (kind, payload) => {
        const tool = String(payload.tool ?? '');
        if (kind === 'hold') {
          console.log(`HOLD     ${tool} - waiting for a human to approve`);
          console.log(`         reason: ${payload.reason}`);
        } else if (kind === 'approved') {
          console.log(`APPROVED ${tool} - carrying on`);
        } else if (kind === 'block') {
          blocked.push(tool);
          console.log(`BLOCKED  ${tool}`);
          console.log(`         reason: ${payload.reason}`);
        } else if (kind === 'timeout' || kind === 'rejected') {
          blocked.push(tool);
          console.log(`REFUSED  ${tool} - approval ${kind}`);
        }
      },
    });

    scope.install(agent);
  } else {
    console.log('ArmorIQ is NOT installed. Nothing will be checked.\n');
  }

  // ── Step 4: run it ────────────────────────────────────────────────────────
  let answer = '';
  let toolCalls = 0;

  try {
    for await (const event of runner.runAsync({
      userId: userEmail,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: question }] },
    })) {
      // Log each tool the model decided to call.
      for (const call of getFunctionCalls(event)) {
        toolCalls += 1;
        console.log(`CALL     ${call.name} ${JSON.stringify(call.args ?? {})}`);
      }

      // Log each result. A refused tool comes back with an `armoriq_enforcement`
      // field instead of real data. ArmorIQ returns the refusal to the model
      // rather than throwing, so the agent can explain itself.
      for (const response of getFunctionResponses(event)) {
        const result = response.response as Record<string, unknown> | undefined;
        if (result && !result.armoriq_enforcement) {
          console.log(`ALLOWED  ${response.name}`);
        }
      }

      if (isFinalResponse(event)) {
        let text = '';
        if (event.content?.parts) {
          text = event.content.parts.map((p) => p.text ?? '').join('');
        }
        if (text.trim()) answer = text.trim();
      }
    }
  } finally {
    // Always clean up, even if the run failed.
    if (scope) {
      scope.uninstall(agent);
      await scope.close();
    }
    await toolset.close();
  }

  return { answer, toolCalls, blocked };
}
