// Codex CLI hooks (~/.codex/hooks.json or <repo>/.codex/hooks.json). Contract: openai/codex
// codex-rs/hooks (schema/generated/pre-tool-use.command.{input,output}.schema.json,
// src/events/pre_tool_use.rs) and https://developers.openai.com/codex/hooks.
//
// PreToolUse stdin: {session_id, turn_id, transcript_path, cwd, hook_event_name: "PreToolUse",
// model, permission_mode, tool_name, tool_input, tool_use_id}. tool_name is "Bash" for shell
// ({command}), "apply_patch" for edits ({command: <patch text>}), "mcp__<server>__<tool>" for MCP,
// or another function tool's own name.
//
// Codex supports exactly one blocking answer: permissionDecision "deny" with a non-empty reason.
// "allow" (without updatedInput) and "ask" are rejected as unsupported and the call runs anyway,
// as do crashes, timeouts and unparsable JSON. So: allow = empty stdout (no opinion, Codex's own
// approval policy applies); block = deny; hold = wait on armord's local hold queue (so
// `armord approve <id>` can release it) when a daemon is running, else deny. Codex has no
// approval UI a hook can trigger.

import type { DecideOptions } from '../daemon.js';
import type { Decider } from '../decider.js';
import type { DecideRequest } from '../engine.js';
import { PASS, obj, str, type HookAnswer, type Json } from './common.js';

export const CODEX_DEFAULT_HOLD_TIMEOUT_MS = 60_000;

export function codexDeny(reason: string): HookAnswer {
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason || 'ArmorIQ: blocked' } }),
    exitCode: 0,
  };
}

function codexRequest(input: Json, tool: string): DecideRequest {
  let args: Json = obj(input.tool_input) ?? (typeof input.tool_input === 'string' ? { input: input.tool_input } : {});
  // apply_patch carries the patch under `command`; armord's patch parser reads `input`.
  if (tool === 'apply_patch' && typeof args.command === 'string' && args.input === undefined) args = { ...args, input: args.command };
  const req: DecideRequest = { host: 'codex', tool, arguments: args };
  // MCP tools arrive as mcp__<server>__<tool>. Split them so a rule keyed by the bare tool name
  // and one keyed by the qualified name both match (the engine qualifies tool + mcpServer).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    req.mcpServer = mcp[1] as string;
    req.tool = mcp[2] as string;
  }
  const cwd = str(input.cwd);
  if (cwd) req.cwd = cwd;
  const session = str(input.session_id);
  if (session) req.sessionId = session;
  return req;
}

export async function codexHook(input: Json, decider: Decider, env: NodeJS.ProcessEnv): Promise<HookAnswer> {
  const event = str(input.hook_event_name);
  if (event && event !== 'PreToolUse') return PASS;
  const tool = str(input.tool_name);
  if (!tool) return codexDeny('ArmorIQ: Codex hook input has no tool_name; failing closed');

  const timeout = Number(env.ARMORD_CODEX_HOLD_TIMEOUT_MS ?? CODEX_DEFAULT_HOLD_TIMEOUT_MS);
  // Waiting only helps when a daemon owns the hold queue; an in-process engine has no one to approve.
  const opts: DecideOptions = decider.mode === 'daemon' ? { waitOnHold: true, holdTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : CODEX_DEFAULT_HOLD_TIMEOUT_MS } : { waitOnHold: false };
  const d = await decider.decide(codexRequest(input, tool), opts);

  if (d.final === 'allow') return PASS;
  if (d.verdict === 'hold') {
    const why =
      d.holdOutcome === 'approved' ? 'approved'
      : d.holdOutcome === 'rejected' ? `rejected (hold ${d.holdId})`
      : d.holdOutcome === 'timeout' ? `not approved within ${Math.round((opts.holdTimeoutMs ?? 0) / 1000)}s (hold ${d.holdId})`
      : 'needs approval, and no armord daemon is running to hold it (start `armord start`, then retry)';
    return codexDeny(`ArmorIQ: ${d.reason}; ${why}`);
  }
  return codexDeny(`ArmorIQ: ${d.reason}`);
}
