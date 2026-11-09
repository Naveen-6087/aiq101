// `armord mcp-plan`: a tiny stdio MCP server that gives any MCP-capable agent a
// `register_intent_plan` tool. The agent declares its plan before acting; armord then holds
// the session to it (drift and argument binding, see plans.ts). The plan is registered as
// pending for the host and binds to the next hook call from that host that carries a session id,
// the same hand-off ArmorClaude uses between its MCP tool and its PreToolUse hook.

import { createInterface } from 'node:readline';
import type { ArmordClient } from './ipc.js';

const TOOL = {
  name: 'register_intent_plan',
  description:
    'Declare what you are about to do before calling any other tool. List every tool you will call as a step; ' +
    'pin argument values you already know (exact strings, or globs like "src/**"). Calls outside the plan are refused. ' +
    'If the task changes, register a new plan.',
  inputSchema: {
    type: 'object',
    required: ['goal', 'steps'],
    properties: {
      goal: { type: 'string', description: "The user's request in one sentence." },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['tool'],
          properties: {
            tool: { type: 'string', description: 'Tool name exactly as you will call it, or a glob such as mcp__github__*' },
            args: { type: 'object', description: 'Argument values this call must use (optional).' },
          },
        },
      },
      intent_token: { type: 'object', description: 'An ArmorIQ intent token for this plan, when you have one (verified against the IAP key).' },
    },
  },
};

export function runPlanServer(client: ArmordClient, host: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (m: unknown) => output.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    let m: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.id === undefined) return; // notifications
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'armord-plan', version: '0.1.0' } } });
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [TOOL] } });
    if (m.method === 'tools/call') {
      const args = (m.params?.arguments ?? {}) as { goal?: string; steps?: unknown; intent_token?: unknown };
      try {
        const params: Record<string, unknown> = { host, goal: args.goal ?? '', steps: args.steps };
        if (args.intent_token !== undefined) params.intentToken = args.intent_token;
        const plan = await client.call<{ id: string; steps: unknown[]; token: { verified: boolean } | null }>('plan.register', params);
        return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Plan ${plan.id} registered with ${plan.steps.length} step(s)${plan.token?.verified ? ', intent token verified' : ''}. Calls outside it will be refused.` }] } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: `Plan not registered: ${(err as Error).message}` }] } });
      }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  });
  return new Promise((r) => rl.on('close', () => r()));
}
