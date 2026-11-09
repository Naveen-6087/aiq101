// Cursor agent hooks (.cursor/hooks.json, ~/.cursor/hooks.json). Contract: https://cursor.com/docs/agent/hooks
//
// Every hook gets the common fields {conversation_id, generation_id, hook_event_name,
// workspace_roots, ...} plus event fields, and answers with snake_case JSON on stdout:
//   beforeShellExecution {command, cwd}                          -> {permission: allow|deny|ask, user_message, agent_message}
//   beforeMCPExecution   {tool_name, tool_input (JSON string), mcp_server_name?, url? | command?}
//                                                                -> {permission: allow|deny|ask, user_message, agent_message}
//   beforeReadFile       {file_path, content, attachments}       -> {permission: allow|deny, user_message}
//   beforeTabFileRead    {file_path, content}                    -> {permission: allow|deny}
//   preToolUse           {tool_name: Shell|Read|Write|Grep|Delete|Task|MCP:<name>, tool_input, cwd}
//                                                                -> {permission: allow|deny, user_message, agent_message}
//   beforeSubmitPrompt   {prompt, attachments}                   -> {continue: bool, user_message}
// Only beforeShellExecution and beforeMCPExecution honor "ask", so a hold becomes Cursor's own
// approval prompt there and a deny everywhere else (preToolUse accepts "ask" but does not
// enforce it, which would let a held call run).
// Exit code 2 also blocks; armord uses it for malformed input so the call is stopped even if
// Cursor cannot read the JSON answer.

import type { DecisionResult } from '../daemon.js';
import type { Decider } from '../decider.js';
import type { DecideRequest } from '../engine.js';
import { PASS, decideStrictest, firstWorkspaceRoot, obj, reasonText, str, type HookAnswer, type Json } from './common.js';

type Permission = 'allow' | 'deny' | 'ask';

const ASK_EVENTS = new Set(['beforeShellExecution', 'beforeMCPExecution']);

/** Cursor's preToolUse tool types to the tool names armord's derivation understands. */
const PRE_TOOL_NAMES: Record<string, string> = {
  Shell: 'run_terminal_cmd',
  Read: 'read_file',
  Write: 'edit_file',
  Grep: 'grep',
  Delete: 'delete_file',
  Task: 'task',
};

function out(body: Json, exitCode = 0): HookAnswer {
  return { stdout: JSON.stringify(body), exitCode };
}

function answer(event: string, d: DecisionResult): HookAnswer {
  const permission: Permission = d.verdict === 'allow' ? 'allow' : d.verdict === 'hold' && ASK_EVENTS.has(event) ? 'ask' : 'deny';
  const reason = reasonText(d);
  if (event === 'beforeTabFileRead') return out({ permission: permission === 'allow' ? 'allow' : 'deny' });
  const user =
    permission === 'allow' ? reason
    : permission === 'ask' ? `${reason}. Approve to run it.`
    : d.verdict === 'hold' ? `${reason}. This needs approval, and Cursor cannot ask for it on this event, so it was not run.`
    : `${reason}. Blocked.`;
  if (event === 'beforeReadFile') return out({ permission, user_message: user });
  return out({ permission, user_message: user, agent_message: permission === 'allow' ? reason : `${user} Do not retry the same call; tell the user.` });
}

export function cursorDeny(reason: string): HookAnswer {
  // Malformed input: we may not know the event, so answer in every pre-hook's deny shape at once.
  return out({ permission: 'deny', continue: false, user_message: reason, agent_message: reason }, 2);
}

function baseRequest(input: Json, tool: string, args: Json, cwd?: string): DecideRequest {
  const req: DecideRequest = { host: 'cursor', tool, arguments: args };
  const dir = cwd ?? firstWorkspaceRoot(input);
  if (dir) req.cwd = dir;
  const root = firstWorkspaceRoot(input);
  if (root) req.workspace = root;
  const session = str(input.conversation_id);
  if (session) req.sessionId = session;
  return req;
}

/** Build the request for an event, or a string explaining why the input can't be judged. */
function requestFor(event: string, input: Json): DecideRequest | string | null {
  switch (event) {
    case 'beforeShellExecution': {
      const command = typeof input.command === 'string' ? input.command : undefined;
      if (command === undefined) return 'beforeShellExecution without a command';
      return baseRequest(input, 'run_terminal_cmd', { command }, str(input.cwd));
    }
    case 'beforeMCPExecution': {
      const tool = str(input.tool_name);
      if (!tool) return 'beforeMCPExecution without a tool_name';
      let args: Json = {};
      if (typeof input.tool_input === 'string' && input.tool_input.trim() !== '') {
        try {
          const parsed = JSON.parse(input.tool_input) as unknown;
          const o = obj(parsed);
          if (!o) return 'beforeMCPExecution tool_input is not a JSON object';
          args = o;
        } catch {
          return 'beforeMCPExecution tool_input is not JSON';
        }
      } else if (obj(input.tool_input)) {
        args = input.tool_input as Json;
      }
      const req = baseRequest(input, tool, args);
      const server = str(input.mcp_server_name) ?? str(input.server_name);
      if (server) req.mcpServer = server;
      return req;
    }
    case 'beforeReadFile':
    case 'beforeTabFileRead': {
      const path = str(input.file_path);
      if (!path) return `${event} without a file_path`;
      return baseRequest(input, 'read_file', { file_path: path });
    }
    case 'preToolUse': {
      const type = str(input.tool_name);
      if (!type) return 'preToolUse without a tool_name';
      const args = obj(input.tool_input) ?? {};
      const cwd = str(input.cwd) ?? str(args.working_directory);
      if (type.startsWith('MCP:')) return baseRequest(input, type.slice(4), args, cwd);
      return baseRequest(input, PRE_TOOL_NAMES[type] ?? type, args, cwd);
    }
    default:
      return null;
  }
}

export async function cursorHook(input: Json, decider: Decider): Promise<HookAnswer> {
  const event = str(input.hook_event_name);
  if (!event) return cursorDeny('ArmorIQ: Cursor hook input has no hook_event_name; failing closed');
  // A prompt is not a tool call; armord has nothing to decide, so let it through explicitly.
  if (event === 'beforeSubmitPrompt') return out({ continue: true });
  const req = requestFor(event, input);
  if (req === null) return PASS; // post-events and anything else armord does not gate
  if (typeof req === 'string') return answer(event, blockResult(`ArmorIQ: ${req}; failing closed`));
  const reqs = [req];
  // beforeReadFile also lists attached files being sent to the model; each one is a read.
  if (event === 'beforeReadFile' && Array.isArray(input.attachments)) {
    for (const a of input.attachments) {
      const o = obj(a);
      const path = o && o.type !== 'rule' ? str(o.file_path) : undefined;
      if (path && path !== req.arguments?.file_path) reqs.push(baseRequest(input, 'read_file', { file_path: path }));
    }
  }
  const d = await decideStrictest(decider, reqs);
  return answer(event, d ?? blockResult('ArmorIQ: nothing to decide; failing closed'));
}

/** A synthetic block for input armord could not judge, answered in the event's own deny shape. */
function blockResult(reason: string): DecisionResult {
  return {
    id: '', verdict: 'block', final: 'block', reason: reason.replace(/^ArmorIQ: /, ''), policyId: null, statementId: null, ruleKey: null,
    layer: null, approval: null, obligations: [], policySetHash: '', latencyUs: 0, tool: '', capabilities: [], derived: {},
  };
}
