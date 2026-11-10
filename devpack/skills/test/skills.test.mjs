import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, parseSkill, skillNames } from '../install.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'devpack-skills-'));

test('every skill has valid frontmatter and a body', () => {
  const names = skillNames(here);
  assert.deepEqual(names, ['armord-setup', 'armoriq-debug-block', 'armoriq-integrate', 'armoriq-write-policy']);
  for (const n of names) {
    const { meta, body } = parseSkill(readFileSync(join(here, n, 'SKILL.md'), 'utf8'));
    assert.equal(meta.name, n);
    assert.ok(meta.description.length > 40 && meta.description.length <= 1024, n);
    assert.ok(body.length > 500, n);
  }
});

test('skills contain no API keys and only mention real armord commands', () => {
  const real = new Set(['init', 'start', 'status', 'decide', 'hook', 'mcp-proxy', 'holds', 'approve', 'reject', 'policy', 'pins', 'audit', 'keygen', 'plan', 'mcp-plan', 'service', 'install', 'uninstall', 'hosts', 'doctor', 'logs', 'watch', 'remote', 'export-policy', 'completions', 'templates', 'migrate']);
  for (const n of skillNames(here)) {
    const text = readFileSync(join(here, n, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /ak_live_[0-9a-f]{8}/, n);
    const code = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((b) => b[1]).join('\n');
    for (const m of code.matchAll(/^\s*(?:\$ )?armord ([a-z-]+)/gm)) assert.ok(real.has(m[1]), `${n}: unknown armord command "${m[1]}"`);
  }
});

test('claude: install, dry run, uninstall', () => {
  const home = tmp();
  const dry = install('claude', { home, dryRun: true });
  assert.equal(dry.changes.length, 4);
  assert.ok(!existsSync(join(home, '.claude', 'skills')));
  install('claude', { home });
  assert.ok(existsSync(join(home, '.claude', 'skills', 'armoriq-integrate', 'SKILL.md')));
  install('claude', { home, uninstall: true });
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'armoriq-integrate')));
});

test('cursor: writes agent-requested rules into the project', () => {
  const cwd = tmp();
  install('cursor', { cwd });
  const mdc = readFileSync(join(cwd, '.cursor', 'rules', 'armoriq-write-policy.mdc'), 'utf8');
  assert.match(mdc, /^---\ndescription: .+\nalwaysApply: false\n---/);
  install('cursor', { cwd, uninstall: true });
  assert.ok(!existsSync(join(cwd, '.cursor', 'rules', 'armoriq-write-policy.mdc')));
});

test('codex: managed block is idempotent, preserves user text and uninstalls cleanly', () => {
  const home = tmp();
  const file = join(home, '.codex', 'AGENTS.md');
  install('codex', { home }); // creates
  writeFileSync(file, 'my own notes\n\n' + readFileSync(file, 'utf8'));
  install('codex', { home });
  install('codex', { home });
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('armoriq-devpack:begin').length - 1, 1);
  assert.match(text, /^my own notes/);
  install('codex', { home, uninstall: true });
  assert.equal(readFileSync(file, 'utf8').trim(), 'my own notes');
});
