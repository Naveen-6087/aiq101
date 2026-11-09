// Hook adapters: read a host's pre-tool-use hook JSON on stdin, ask armord, answer in the
// host's own format. A hold maps to the host's native approval prompt where it has one, so a
// held call is decided by the person at the keyboard instead of silently blocked.

import type { DecideRequest } from './engine.js';
import type { Decider } from './decider.js';
import { codexDeny, codexHook } from './adapters/codex.js';
import type { HookAnswer } from './adapters/common.js';
import { cursorDeny, cursorHook } from './adapters/cursor.js';
import { geminiDeny, geminiHook } from './adapters/gemini.js';

export type { HookAnswer } from './adapters/common.js';

export type HookHost = 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'generic';

export const HOOK_HOSTS: readonly HookHost[] = ['claude-code', 'cursor', 'codex', 'gemini', 'generic'];

export interface HookOptions {
  /** Environment for adapter knobs (ARMORD_CODEX_HOLD_TIMEOUT_MS). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Claude Code PreToolUse: {session_id, cwd, hook_event_name, tool_name, tool_input}. */
function claudeRequest(input: Record<string, unknown>): DecideRequest {
  const req: DecideRequest = {
    host: 'claude-code',
    tool: String(input.tool_name ?? ''),
    arguments: (input.tool_input ?? {}) as Record<string, unknown>,
  };
  if (typeof input.cwd === 'string') req.cwd = input.cwd;
  if (typeof input.session_id === 'string') req.sessionId = input.session_id;
  return req;
}

export async function runHook(host: HookHost, stdin: string, decider: Decider, opts: HookOptions = {}): Promise<HookAnswer> {
  if (!HOOK_HOSTS.includes(host)) return deny('generic', `armord: unknown hook host "${String(host)}"; failing closed`);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin) as Record<string, unknown>;
  } catch {
    return deny(host, 'armord: hook input was not JSON; failing closed');
  }
  if (host !== 'claude-code' && host !== 'generic' && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    return deny(host, 'armord: hook input was not a JSON object; failing closed');
  }

  try {
    if (host === 'cursor') return await cursorHook(input, decider);
    if (host === 'codex') return await codexHook(input, decider, opts.env ?? process.env);
    if (host === 'gemini') return await geminiHook(input, decider);
  } catch (err) {
    return deny(host, `armord: ${(err as Error).message}; failing closed`);
  }

  if (host === 'claude-code') {
    if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return { stdout: '', exitCode: 0 };
    const d = await decider.decide(claudeRequest(input), { waitOnHold: false });
    const permissionDecision = d.verdict === 'allow' ? 'allow' : d.verdict === 'hold' ? 'ask' : 'deny';
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `ArmorIQ: ${d.reason}` },
      }),
      exitCode: 0,
    };
  }

  // generic: {tool, arguments, cwd?, mcpServer?} in; decision JSON out; exit 2 means "do not run".
  const req = input as unknown as DecideRequest;
  const d = await decider.decide({ ...req, host: req.host ?? 'generic' }, { waitOnHold: true });
  return { stdout: JSON.stringify(d), exitCode: d.final === 'allow' ? 0 : 2 };
}

function deny(host: HookHost, reason: string): HookAnswer {
  if (host === 'cursor') return cursorDeny(reason);
  if (host === 'codex') return codexDeny(reason);
  if (host === 'gemini') return geminiDeny(reason);
  if (host === 'claude-code') {
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), exitCode: 0 };
  }
  return { stdout: JSON.stringify({ verdict: 'block', final: 'block', reason }), exitCode: 2 };
}
