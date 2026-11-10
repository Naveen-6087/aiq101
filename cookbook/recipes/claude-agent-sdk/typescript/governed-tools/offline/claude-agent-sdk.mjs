// Offline stand-in for @anthropic-ai/claude-agent-sdk. The real SDK spawns Claude Code and needs
// Claude credentials; this one replays a scripted model turn instead, with no keys and no network.
//
// What stays real: the agent's own options. query() runs every scripted tool call through the
// SAME options.canUseTool callback (src/governance.mjs) and the SAME tool handlers that
// createSdkMcpServer() received (src/tools.mjs), with the inputs validated by the tools' own zod
// schemas. It follows the real permission order too: a tool removed by disallowedTools does not
// exist, a tool listed in allowedTools runs without asking canUseTool, and anything else asks.
//
// What is scripted: the model. It always plays this turn, whatever the prompt says:
//   list_releases -> get_build_status(2.4.0) -> deploy_to_production(2.4.0) -> delete_environment(staging-old)

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const SCRIPT = [
  { tool: 'list_releases', input: {}, say: 'Let me look at the release candidates.' },
  { tool: 'get_build_status', input: { version: '2.4.0' }, say: 'Checking that 2.4.0 built cleanly.' },
  { tool: 'deploy_to_production', input: { version: '2.4.0' }, say: 'The build passed. Deploying 2.4.0 to production.' },
  { tool: 'delete_environment', input: { environment: 'staging-old' }, say: 'Now removing the staging-old environment.' },
];

// Same shapes as the real SDK: tool() returns an SdkMcpToolDefinition, createSdkMcpServer()
// returns an sdk server config. The stand-in keeps the tool list on `instance`.
export function tool(name, description, inputSchema, handler, extras = {}) {
  return { name, description, inputSchema, handler, ...extras };
}

export function createSdkMcpServer({ name, version = '1.0.0', tools = [] }) {
  return { type: 'sdk', name, instance: { name, version, tools } };
}

const sessionId = randomUUID();
const envelope = (type, extra) => ({ type, uuid: randomUUID(), session_id: sessionId, ...extra });
const assistant = (content) => envelope('assistant', { message: { role: 'assistant', content }, parent_tool_use_id: null });
const toolResult = (id, text, isError) =>
  envelope('user', {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] },
    parent_tool_use_id: null,
  });

export function query({ prompt, options = {} }) {
  const controller = new AbortController();

  async function* run() {
    const servers = Object.entries(options.mcpServers ?? {});
    const registry = new Map();
    for (const [key, server] of servers) {
      for (const t of server.instance?.tools ?? []) registry.set(`mcp__${key}__${t.name}`, { server: key, def: t });
    }
    const disallowed = new Set(options.disallowedTools ?? []);
    for (const name of disallowed) registry.delete(name);
    const allowed = new Set(options.allowedTools ?? []);

    yield envelope('system', { subtype: 'init', tools: [...registry.keys()], mcp_servers: servers.map(([name]) => ({ name, status: 'connected' })), model: 'offline-scripted-claude', permissionMode: options.permissionMode ?? 'default' });

    const [serverKey] = servers.map(([key]) => key);
    const outcomes = [];
    let turns = 0;

    for (const step of SCRIPT) {
      turns++;
      const toolName = `mcp__${serverKey}__${step.tool}`;
      const id = `toolu_offline_${turns}`;
      yield assistant([{ type: 'text', text: step.say }, { type: 'tool_use', id, name: toolName, input: step.input }]);

      const entry = registry.get(toolName);
      if (!entry) {
        outcomes.push(`${step.tool}: not available`);
        yield toolResult(id, `No such tool available: ${toolName}`, true);
        continue;
      }

      let decision = { behavior: 'allow', updatedInput: step.input };
      if (!allowed.has(toolName) && options.permissionMode !== 'bypassPermissions') {
        if (!options.canUseTool) {
          decision = { behavior: 'deny', message: 'No permission handler and the tool is not pre-approved.' };
        } else {
          decision = await options.canUseTool(toolName, step.input, {
            signal: controller.signal,
            toolUseID: id,
            mcpServer: { name: entry.server, source: 'sdk' },
          });
        }
      }

      if (decision.behavior !== 'allow') {
        outcomes.push(`${step.tool}: denied`);
        yield toolResult(id, decision.message, true);
        continue;
      }

      const args = z.object(entry.def.inputSchema).parse(decision.updatedInput ?? step.input);
      const result = await entry.def.handler(args, {});
      const text = (result.content ?? []).map((c) => c.text ?? '').join(' ');
      outcomes.push(`${step.tool}: ${result.isError ? 'failed' : 'done'}`);
      yield toolResult(id, text, Boolean(result.isError));
    }

    turns++;
    const summary = `Summary for "${typeof prompt === 'string' ? prompt : 'your request'}": ${outcomes.join('; ')}.`;
    yield assistant([{ type: 'text', text: summary }]);
    yield envelope('result', { subtype: 'success', is_error: false, num_turns: turns, result: summary, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0 });
  }

  const iterator = run();
  iterator.interrupt = async () => controller.abort();
  iterator.close = () => controller.abort();
  return iterator;
}
