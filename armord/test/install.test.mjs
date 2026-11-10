import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHost, uninstallHost, hostStatus } from '../dist/install.js';

function env() {
  const root = mkdtempSync(join(tmpdir(), 'armord-install-'));
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, o: { scope: 'project', cwd, home } };
}
const j = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('claude-code: creates settings, idempotent, preserves user keys, uninstall removes only ours', () => {
  const { root, o } = env();
  const file = join(o.cwd, '.claude', 'settings.json');
  mkdirSync(join(o.cwd, '.claude'));
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }], Stop: [] } }));
  const r1 = installHost('claude-code', o);
  assert.equal(r1.changes[0].action, 'merge');
  const doc = j(file);
  assert.equal(doc.model, 'x');
  assert.equal(doc.hooks.PreToolUse.length, 2);
  assert.equal(doc.hooks.PreToolUse[1].hooks[0].command, 'armord hook claude-code');
  assert.ok(existsSync(file + '.armord-bak'));
  assert.equal(installHost('claude-code', o).changes[0].action, 'unchanged');
  assert.equal(hostStatus('claude-code', o).installed, true);
  uninstallHost('claude-code', o);
  const after = j(file);
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'mine');
  assert.equal(hostStatus('claude-code', o).installed, false);
  rmSync(root, { recursive: true, force: true });
});

test('cursor: four events with failClosed; file created then removed on uninstall', () => {
  const { root, o } = env();
  const file = join(o.cwd, '.cursor', 'hooks.json');
  const r = installHost('cursor', o);
  assert.equal(r.changes[0].action, 'create');
  const doc = j(file);
  assert.equal(doc.version, 1);
  for (const e of ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse']) {
    assert.equal(doc.hooks[e].length, 1);
    assert.equal(doc.hooks[e][0].failClosed, true);
    assert.equal(doc.hooks[e][0].command, 'armord hook cursor');
  }
  assert.equal(installHost('cursor', o).changes[0].action, 'unchanged');
  uninstallHost('cursor', o);
  assert.equal(existsSync(file), false);
  rmSync(root, { recursive: true, force: true });
});

test('codex and gemini write their documented shapes', () => {
  const { root, o } = env();
  installHost('codex', o);
  const c = j(join(o.cwd, '.codex', 'hooks.json'));
  assert.equal(c.hooks.PreToolUse[0].matcher, '*');
  assert.equal(c.hooks.PreToolUse[0].hooks[0].command, 'armord hook codex');
  installHost('gemini', o);
  const g = j(join(o.cwd, '.gemini', 'settings.json'));
  assert.equal(g.hooks.BeforeTool[0].hooks[0].name, 'armord');
  assert.equal(g.hooks.BeforeTool[0].hooks[0].timeout, 10000);
  assert.equal(hostStatus('gemini', o).installed, true);
  rmSync(root, { recursive: true, force: true });
});

test('dry run changes nothing; user scope uses home; custom command is used', () => {
  const { root, o } = env();
  const r = installHost('cursor', { ...o, dryRun: true });
  assert.equal(r.changes[0].action, 'create');
  assert.equal(existsSync(join(o.cwd, '.cursor', 'hooks.json')), false);
  installHost('codex', { ...o, scope: 'user', command: 'node /x/dist/cli.js' });
  assert.equal(j(join(o.home, '.codex', 'hooks.json')).hooks.PreToolUse[0].hooks[0].command, 'node /x/dist/cli.js hook codex');
  rmSync(root, { recursive: true, force: true });
});

test('a config that is not JSON is never overwritten', () => {
  const { root, o } = env();
  mkdirSync(join(o.cwd, '.claude'));
  writeFileSync(join(o.cwd, '.claude', 'settings.json'), '{ // comment\n}');
  assert.throws(() => installHost('claude-code', o), /not a JSON object/);
  assert.equal(readFileSync(join(o.cwd, '.claude', 'settings.json'), 'utf8'), '{ // comment\n}');
  rmSync(root, { recursive: true, force: true });
});

test('mcp: wraps stdio servers, skips http and wrapped ones, unwrap restores exactly', () => {
  const { root, o } = env();
  const file = join(o.cwd, '.mcp.json');
  const original = { mcpServers: { notes: { command: 'node', args: ['notes.js', '--x'], env: { A: '1' } }, bare: { command: 'tool' }, remote: { url: 'https://x.example/mcp' } }, other: 1 };
  writeFileSync(file, JSON.stringify(original));
  installHost('mcp', o);
  const doc = j(file);
  assert.deepEqual(doc.mcpServers.notes.args, ['mcp-proxy', '--name', 'notes', '--', 'node', 'notes.js', '--x']);
  assert.equal(doc.mcpServers.notes.command, 'armord');
  assert.deepEqual(doc.mcpServers.notes.env, { A: '1' });
  assert.deepEqual(doc.mcpServers.bare.args, ['mcp-proxy', '--name', 'bare', '--', 'tool']);
  assert.deepEqual(doc.mcpServers.remote, { url: 'https://x.example/mcp' });
  assert.equal(hostStatus('mcp', o).installed, true);
  const second = installHost('mcp', o).changes.find((c) => c.file === file);
  assert.equal(second.action, 'unchanged');
  uninstallHost('mcp', o);
  assert.deepEqual(j(file), original);
  assert.equal(hostStatus('mcp', o).installed, false);
  rmSync(root, { recursive: true, force: true });
});

test('openhands writes a snippet and removes it', () => {
  const { root, o } = env();
  const r = installHost('openhands', o);
  const file = r.changes[0].file;
  assert.match(readFileSync(file, 'utf8'), /ArmordSecurityAnalyzer/);
  assert.equal(installHost('openhands', o).changes[0].action, 'unchanged');
  uninstallHost('openhands', o);
  assert.equal(existsSync(file), false);
  rmSync(root, { recursive: true, force: true });
});

test('unknown host throws', () => {
  const { root, o } = env();
  assert.throws(() => installHost('nope', o), /unknown host/);
  rmSync(root, { recursive: true, force: true });
});
