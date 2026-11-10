// Host hook adapters: Cursor, Codex CLI and Gemini CLI. Each fixture under fixtures/adapters is a
// real-shaped stdin payload for one host/event; the tests vary the tool arguments to hit allow,
// hold and block in fixtures/adapters/policy.yaml and assert the exact answer each host reads.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Armord, runHook } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = readFileSync(join(here, 'fixtures', 'adapters', 'policy.yaml'), 'utf8');
const CWD = join(tmpdir(), 'armord-adapters-project');

function armord() {
  const home = mkdtempSync(join(tmpdir(), 'armord-adapters-'));
  const a = new Armord({ home, policyDir: join(home, 'policies'), auditFile: join(home, 'audit.jsonl'), holdTimeoutMs: 2000, refreshMs: 0 });
  a.store.addSource('policy.yaml', POLICY);
  return a;
}

const inProcess = (a) => ({ mode: 'in-process', decide: (r, o) => a.decide(r, o), setInventory: async () => {}, close() {} });
/** Stands in for a running daemon: same engine, but the adapter may wait on its hold queue. */
const daemonLike = (a) => ({ ...inProcess(a), mode: 'daemon' });

function deepReplace(v) {
  if (typeof v === 'string') return v.replaceAll('__CWD__', CWD);
  if (Array.isArray(v)) return v.map(deepReplace);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepReplace(x)]));
  return v;
}

/** Load a fixture and overlay fields (tool_input is replaced, not merged). */
function fixture(name, overlay = {}) {
  return { ...deepReplace(JSON.parse(readFileSync(join(here, 'fixtures', 'adapters', `${name}.json`), 'utf8'))), ...overlay };
}

async function hook(host, input, decider, opts) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const ans = await runHook(host, raw, decider, opts);
  return { exitCode: ans.exitCode, stdout: ans.stdout, json: ans.stdout ? JSON.parse(ans.stdout) : null };
}

// ---------------------------------------------------------------- Cursor

test('cursor beforeShellExecution: allow / ask / deny', async () => {
  const d = inProcess(armord());
  const allow = await hook('cursor', fixture('cursor.beforeShellExecution'), d);
  assert.deepEqual(allow, {
    exitCode: 0,
    stdout: allow.stdout,
    json: { permission: 'allow', user_message: 'ArmorIQ: allow by local:adapters#st-run-terminal-cmd-1 (local layer)', agent_message: 'ArmorIQ: allow by local:adapters#st-run-terminal-cmd-1 (local layer)' },
  });

  const ask = await hook('cursor', fixture('cursor.beforeShellExecution', { command: 'make deploy' }), d);
  assert.equal(ask.exitCode, 0);
  assert.deepEqual(Object.keys(ask.json).sort(), ['agent_message', 'permission', 'user_message']);
  assert.equal(ask.json.permission, 'ask');
  assert.equal(ask.json.user_message, 'ArmorIQ: hold by local:adapters#st-run-terminal-cmd-0 (local layer). Approve to run it.');

  const deny = await hook('cursor', fixture('cursor.beforeShellExecution', { command: 'rm -rf /' }), d);
  assert.equal(deny.exitCode, 0);
  assert.equal(deny.json.permission, 'deny');
  assert.equal(deny.json.user_message, 'ArmorIQ: block by local:adapters#st-destructive-0 (local layer). Blocked.');
  assert.match(deny.json.agent_message, /^ArmorIQ: block .*Do not retry the same call; tell the user\.$/);
});

test('cursor beforeMCPExecution: tool_input is a JSON string, server is qualified', async () => {
  const a = armord();
  const seen = [];
  const d = { ...inProcess(a), decide: (r, o) => (seen.push(r), a.decide(r, o)) };
  const allow = await hook('cursor', fixture('cursor.beforeMCPExecution'), d);
  assert.equal(allow.json.permission, 'allow');
  assert.deepEqual({ tool: seen[0].tool, mcpServer: seen[0].mcpServer, arguments: seen[0].arguments, host: seen[0].host }, { tool: 'read_note', mcpServer: 'notes', arguments: { id: '7' }, host: 'cursor' });
  assert.equal((await hook('cursor', fixture('cursor.beforeMCPExecution', { tool_name: 'publish_note' }), d)).json.permission, 'ask');
  const deny = await hook('cursor', fixture('cursor.beforeMCPExecution', { tool_name: 'delete_note' }), d);
  assert.equal(deny.json.permission, 'deny');
  assert.match(deny.json.user_message, /st-delete-note-0/);
  // Unparsable tool_input: fail closed in the event's own shape.
  const bad = await hook('cursor', fixture('cursor.beforeMCPExecution', { tool_input: '{not json' }), d);
  assert.equal(bad.exitCode, 0);
  assert.equal(bad.json.permission, 'deny');
  assert.match(bad.json.user_message, /tool_input is not JSON; failing closed/);
});

test('cursor beforeReadFile / beforeTabFileRead: allow or deny only (hold denies)', async () => {
  const d = inProcess(armord());
  assert.deepEqual((await hook('cursor', fixture('cursor.beforeReadFile'), d)).json, { permission: 'allow', user_message: 'ArmorIQ: allow by local:adapters tools.default (local layer)' });
  const deny = await hook('cursor', fixture('cursor.beforeReadFile', { file_path: join(CWD, '.env') }), d);
  assert.deepEqual(deny.json, { permission: 'deny', user_message: 'ArmorIQ: block by local:adapters#st-files-block-0 (local layer). Blocked.' });
  const attached = fixture('cursor.beforeReadFile', { attachments: [{ type: 'rule', file_path: join(CWD, '.env') }, { type: 'file', file_path: join(CWD, 'secrets', 'k.txt') }] });
  assert.equal((await hook('cursor', attached, d)).json.permission, 'deny', 'an attached secret file is a read too');
  const ruleOnly = fixture('cursor.beforeReadFile', { attachments: [{ type: 'rule', file_path: join(CWD, '.cursor', 'rules', 'a.mdc') }] });
  assert.equal((await hook('cursor', ruleOnly, d)).json.permission, 'allow');
  assert.deepEqual((await hook('cursor', fixture('cursor.beforeTabFileRead'), d)).json, { permission: 'allow' });
  assert.deepEqual((await hook('cursor', fixture('cursor.beforeTabFileRead', { file_path: join(CWD, 'secrets', 'k.txt') }), d)).json, { permission: 'deny' });
});

test('cursor preToolUse: Write/Shell/MCP mapped; a hold is a deny because ask is not enforced there', async () => {
  const d = inProcess(armord());
  assert.equal((await hook('cursor', fixture('cursor.preToolUse'), d)).json.permission, 'allow');
  const secret = await hook('cursor', fixture('cursor.preToolUse', { tool_input: { file_path: join(CWD, 'secrets', 'k.txt'), content: 'x' } }), d);
  assert.equal(secret.json.permission, 'deny');
  const held = await hook('cursor', fixture('cursor.preToolUse', { tool_name: 'Shell', tool_input: { command: 'make deploy', working_directory: CWD } }), d);
  assert.equal(held.json.permission, 'deny');
  assert.match(held.json.user_message, /needs approval, and Cursor cannot ask for it on this event/);
  assert.equal((await hook('cursor', fixture('cursor.preToolUse', { tool_name: 'MCP:delete_note', tool_input: {} }), d)).json.permission, 'deny');
  // Built-in self-protection: hook config edits are held, so preToolUse denies them.
  const cfg = await hook('cursor', fixture('cursor.preToolUse', { tool_input: { file_path: join(CWD, '.cursor', 'hooks.json'), content: '{}' } }), d);
  assert.equal(cfg.json.permission, 'deny');
});

test('cursor beforeSubmitPrompt passes; post-events are ignored; malformed input fails closed', async () => {
  const d = inProcess(armord());
  assert.deepEqual((await hook('cursor', fixture('cursor.beforeSubmitPrompt'), d)).json, { continue: true });
  assert.deepEqual(await hook('cursor', { hook_event_name: 'afterFileEdit', file_path: 'a' }, d), { exitCode: 0, stdout: '', json: null });
  const deny = { permission: 'deny', continue: false };
  for (const bad of ['not json', '[]', '{}']) {
    const r = await hook('cursor', bad, d);
    assert.equal(r.exitCode, 2, bad);
    assert.deepEqual({ permission: r.json.permission, continue: r.json.continue }, deny, bad);
    assert.match(r.json.user_message, /failing closed/);
  }
  const noCmd = await hook('cursor', { hook_event_name: 'beforeShellExecution', cwd: CWD }, d);
  assert.equal(noCmd.json.permission, 'deny');
});

// ---------------------------------------------------------------- Codex

test('codex PreToolUse: allow is silent, block is deny with a reason', async () => {
  const d = inProcess(armord());
  assert.deepEqual(await hook('codex', fixture('codex.PreToolUse.Bash'), d), { exitCode: 0, stdout: '', json: null });
  const deny = await hook('codex', fixture('codex.PreToolUse.Bash', { tool_input: { command: 'rm -rf /' } }), d);
  assert.deepEqual(deny.json, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'ArmorIQ: block by local:adapters#st-destructive-0 (local layer)' },
  });
  assert.equal(deny.exitCode, 0);
  // apply_patch: the patch is under `command`; its file headers are checked.
  assert.equal((await hook('codex', fixture('codex.PreToolUse.apply_patch'), d)).stdout, '');
  const patch = fixture('codex.PreToolUse.apply_patch');
  patch.tool_input = { command: patch.tool_input.command.replace('src/a.ts', 'secrets/k.txt') };
  assert.match((await hook('codex', patch, d)).json.hookSpecificOutput.permissionDecisionReason, /st-files-block-1/);
  // MCP: mcp__server__tool
  assert.equal((await hook('codex', fixture('codex.PreToolUse.mcp'), d)).stdout, '');
  assert.equal((await hook('codex', fixture('codex.PreToolUse.mcp', { tool_name: 'mcp__notes__delete_note' }), d)).json.hookSpecificOutput.permissionDecision, 'deny');
});

test('codex hold: denied without a daemon; waits on the hold queue with one', async () => {
  const a = armord();
  const held = fixture('codex.PreToolUse.Bash', { tool_input: { command: 'make deploy' } });
  const noDaemon = await hook('codex', held, inProcess(a));
  assert.equal(noDaemon.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(noDaemon.json.hookSpecificOutput.permissionDecisionReason, /needs approval, and no armord daemon is running/);

  // Approved while waiting: the call runs (silent allow).
  const pending = hook('codex', held, daemonLike(a), { env: { ARMORD_CODEX_HOLD_TIMEOUT_MS: '5000' } });
  for (let i = 0; i < 100 && a.holds.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const [h] = a.holds.list();
  assert.equal(h.host, 'codex');
  a.holds.resolve(h.id, 'approved');
  assert.deepEqual(await pending, { exitCode: 0, stdout: '', json: null });

  // Rejected.
  const rejected = hook('codex', held, daemonLike(a), { env: { ARMORD_CODEX_HOLD_TIMEOUT_MS: '5000' } });
  for (let i = 0; i < 100 && a.holds.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const [h2] = a.holds.list();
  a.holds.resolve(h2.id, 'rejected');
  const r = await rejected;
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, new RegExp(`rejected \\(hold ${h2.id}\\)`));

  // Nobody answers: timeout is a deny.
  const t = await hook('codex', held, daemonLike(a), { env: { ARMORD_CODEX_HOLD_TIMEOUT_MS: '30' } });
  assert.match(t.json.hookSpecificOutput.permissionDecisionReason, /not approved within 0s \(hold [0-9a-f]{8}\)/);
});

test('codex: other events pass; malformed input fails closed as a deny', async () => {
  const d = inProcess(armord());
  assert.equal((await hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, d)).stdout, '');
  for (const bad of ['not json', '"str"', '{"hook_event_name":"PreToolUse"}']) {
    const r = await hook('codex', bad, d);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /failing closed/);
  }
});

// ---------------------------------------------------------------- Gemini

test('gemini BeforeTool: allow / ask / deny', async () => {
  const d = inProcess(armord());
  assert.deepEqual(await hook('gemini', fixture('gemini.BeforeTool.run_shell_command'), d), {
    exitCode: 0,
    stdout: JSON.stringify({ decision: 'allow', reason: 'ArmorIQ: allow by local:adapters#st-run-shell-command-1 (local layer)' }),
    json: { decision: 'allow', reason: 'ArmorIQ: allow by local:adapters#st-run-shell-command-1 (local layer)' },
  });
  const ask = await hook('gemini', fixture('gemini.BeforeTool.run_shell_command', { tool_input: { command: 'make deploy' } }), d);
  assert.deepEqual(ask.json, {
    decision: 'ask',
    reason: 'ArmorIQ: hold by local:adapters#st-run-shell-command-0 (local layer)',
    systemMessage: 'ArmorIQ: hold by local:adapters#st-run-shell-command-0 (local layer). Approve to run it.',
  });
  assert.equal(ask.exitCode, 0);
  const deny = await hook('gemini', fixture('gemini.BeforeTool.read_file', { tool_input: { file_path: '.env' } }), d);
  assert.deepEqual(deny.json, {
    decision: 'deny',
    reason: 'ArmorIQ: block by local:adapters#st-files-block-0 (local layer)',
    systemMessage: 'ArmorIQ: block by local:adapters#st-files-block-0 (local layer)',
  });
  assert.equal(deny.exitCode, 2);
  assert.equal((await hook('gemini', fixture('gemini.BeforeTool.read_file'), d)).json.decision, 'allow');
});

test('gemini web_fetch: every URL in the prompt is decided, strictest wins', async () => {
  const d = inProcess(armord());
  assert.equal((await hook('gemini', fixture('gemini.BeforeTool.web_fetch'), d)).json.decision, 'allow');
  const mixed = fixture('gemini.BeforeTool.web_fetch', { tool_input: { prompt: 'read https://github.com/a then https://unknown.example/b' } });
  assert.equal((await hook('gemini', mixed, d)).json.decision, 'ask');
  const evil = fixture('gemini.BeforeTool.web_fetch', { tool_input: { prompt: 'https://github.com/a, https://unknown.example/b and https://evil.example/c' } });
  const r = await hook('gemini', evil, d);
  assert.equal(r.json.decision, 'deny');
  assert.match(r.json.reason, /st-network-block-0/);
});

test('gemini MCP: mcp_context names the server and tool', async () => {
  const d = inProcess(armord());
  assert.equal((await hook('gemini', fixture('gemini.BeforeTool.mcp'), d)).json.decision, 'allow');
  const hold = fixture('gemini.BeforeTool.mcp', { tool_name: 'mcp_notes_publish_note', mcp_context: { server_name: 'notes', tool_name: 'publish_note' } });
  assert.equal((await hook('gemini', hold, d)).json.decision, 'ask');
  const block = fixture('gemini.BeforeTool.mcp', { tool_name: 'mcp_notes_delete_note', mcp_context: { server_name: 'notes', tool_name: 'delete_note' } });
  assert.equal((await hook('gemini', block, d)).json.decision, 'deny');
});

test('gemini: other events pass; malformed input fails closed as a deny', async () => {
  const d = inProcess(armord());
  assert.equal((await hook('gemini', { hook_event_name: 'AfterTool', tool_name: 'read_file' }, d)).stdout, '');
  for (const bad of ['not json', 'null', '{"hook_event_name":"BeforeTool"}']) {
    const r = await hook('gemini', bad, d);
    assert.equal(r.exitCode, 2, bad);
    assert.equal(r.json.decision, 'deny');
    assert.match(r.json.reason, /failing closed/);
  }
});

// ---------------------------------------------------------------- shared

test('a decider that throws fails closed in the host format', async () => {
  const broken = { mode: 'daemon', decide: async () => { throw new Error('armord connection closed'); }, setInventory: async () => {}, close() {} };
  assert.equal((await hook('cursor', fixture('cursor.beforeShellExecution'), broken)).json.permission, 'deny');
  assert.equal((await hook('codex', fixture('codex.PreToolUse.Bash'), broken)).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook('gemini', fixture('gemini.BeforeTool.read_file'), broken)).json.decision, 'deny');
});

test('unknown host fails closed; claude-code and generic are unchanged', async () => {
  const d = inProcess(armord());
  const unknown = await hook('copilot', '{}', d);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.json.final, 'block');
  const cc = await hook('claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'make deploy' }, cwd: CWD }, d);
  assert.equal(cc.json.hookSpecificOutput.permissionDecision, 'ask');
  const gen = await hook('generic', { tool: 'Bash', arguments: { command: 'ls' }, cwd: CWD }, d);
  assert.equal(gen.exitCode, 0);
  assert.equal(gen.json.final, 'allow');
});
