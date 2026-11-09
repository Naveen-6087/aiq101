// Gemini CLI hooks (settings.json "hooks" -> BeforeTool). Contract: google-gemini/gemini-cli
// docs/hooks/reference.md and packages/core/src/hooks/{types,hookRunner,hookAggregator}.ts,
// packages/core/src/scheduler/hook-utils.ts.
//
// BeforeTool stdin: {session_id, transcript_path, cwd, hook_event_name: "BeforeTool", timestamp,
// tool_name, tool_input, mcp_context?: {server_name, tool_name, ...}, original_request_name?}.
// MCP tools arrive as tool_name "mcp_<server>_<tool>"; the real server/tool names are in mcp_context.
// web_fetch has no url argument: URLs are embedded in `prompt`, so each one is decided.
//
// Answer: {decision: "allow" | "ask" | "deny", reason, systemMessage}. "ask" makes Gemini show its
// own confirmation (systemMessage is the prompt text); "deny" blocks with reason. "allow" does not
// skip Gemini's own approval policy. Deny exits 2 as well, which Gemini treats as blocking even if
// the JSON were lost.

import type { DecisionResult } from '../daemon.js';
import type { Decider } from '../decider.js';
import type { DecideRequest } from '../engine.js';
import { PASS, decideStrictest, obj, reasonText, str, urlsIn, type HookAnswer, type Json } from './common.js';

export function geminiDeny(reason: string): HookAnswer {
  return { stdout: JSON.stringify({ decision: 'deny', reason, systemMessage: reason }), exitCode: 2 };
}

function answer(d: DecisionResult): HookAnswer {
  const reason = reasonText(d);
  if (d.verdict === 'allow') return { stdout: JSON.stringify({ decision: 'allow', reason }), exitCode: 0 };
  if (d.verdict === 'hold') return { stdout: JSON.stringify({ decision: 'ask', reason, systemMessage: `${reason}. Approve to run it.` }), exitCode: 0 };
  return geminiDeny(reason);
}

function geminiRequests(input: Json, toolName: string): DecideRequest[] {
  const args = obj(input.tool_input) ?? {};
  const mcp = obj(input.mcp_context);
  const base: DecideRequest = { host: 'gemini', tool: toolName, arguments: args };
  const server = mcp ? str(mcp.server_name) : undefined;
  const mcpTool = mcp ? str(mcp.tool_name) : undefined;
  if (server && mcpTool) {
    base.tool = mcpTool;
    base.mcpServer = server;
  }
  const cwd = str(input.cwd);
  if (cwd) base.cwd = cwd;
  const session = str(input.session_id);
  if (session) base.sessionId = session;
  if (toolName === 'web_fetch' && typeof args.prompt === 'string' && args.url === undefined) {
    const urls = urlsIn(args.prompt);
    if (urls.length > 0) return urls.map((url) => ({ ...base, arguments: { ...args, url } }));
  }
  return [base];
}

export async function geminiHook(input: Json, decider: Decider): Promise<HookAnswer> {
  const event = str(input.hook_event_name);
  if (event && event !== 'BeforeTool') return PASS;
  const tool = str(input.tool_name);
  if (!tool) return geminiDeny('ArmorIQ: Gemini hook input has no tool_name; failing closed');
  const d = await decideStrictest(decider, geminiRequests(input, tool));
  return d ? answer(d) : geminiDeny('ArmorIQ: nothing to decide; failing closed');
}
