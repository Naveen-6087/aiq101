import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFrameworks, listPolicies, pickRecipe, scaffold, envExample } from '../lib/scaffold.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'create.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'create-armoriq-'));
const cli = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8', stdin: 'ignore' });

test('every supported framework resolves to a bundled recipe', () => {
  const fws = listFrameworks().map((f) => f.framework);
  assert.deepEqual(fws.sort(), ['claude-agent-sdk', 'crewai', 'langchain', 'langgraph', 'mcp', 'openai-agents', 'vercel-ai-sdk']);
  for (const f of listFrameworks()) for (const lang of f.languages) assert.ok(pickRecipe({ framework: f.framework, language: lang }).path, `${f.framework}/${lang}`);
});

test('a python framework scaffolds recipe, armord policy, config, env and README', () => {
  const dir = join(tmp(), 'my-agent');
  const r = scaffold({ dir, framework: 'langchain', language: 'python', policy: 'armordev' });
  assert.equal(r.recipe, 'langchain/python/sql-analyst');
  for (const f of ['agent.py', 'policy.yaml', 'RECIPE.md', 'README.md', 'armord.config', '.env.example', '.gitignore', 'offline/demo.py', 'armord/armordev.yaml', 'armord/armordev.cases.yaml', '.armoriq-scaffold.json']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /offline\/demo\.py/);
  assert.match(readme, /OFFLINE_APPROVAL=reject/);
  assert.match(readme, /armord policy test armord\/armordev\.cases\.yaml/);
  assert.match(readFileSync(join(dir, 'armord.config'), 'utf8'), /ARMORD_POLICY_DIR=\.\/armord/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.ok(!existsSync(join(dir, '.venv')) && !existsSync(join(dir, '.env')));
});

test('a typescript framework gets npm steps from its package.json scripts', () => {
  const dir = join(tmp(), 'bot');
  scaffold({ dir, framework: 'vercel-ai-sdk' });
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /npm ci/);
  assert.match(readme, /npm run demo:offline/);
  assert.ok(existsSync(join(dir, 'package-lock.json')));
  assert.ok(!existsSync(join(dir, 'node_modules')));
  assert.ok(existsSync(join(dir, 'armord', 'armor-balanced.yaml'))); // default policy
});

test('the scaffolded armord policy compiles and its cases pass', () => {
  // Uses the armord checkout next to the devpack when it is built; skipped otherwise.
  const armordCli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'armord', 'dist', 'cli.js');
  if (!existsSync(armordCli)) return;
  const dir = join(tmp(), 'p');
  scaffold({ dir, framework: 'crewai', policy: 'armorops' });
  const r = spawnSync(process.execPath, [armordCli, 'policy', 'test', join(dir, 'armord', 'armorops.cases.yaml'), join(dir, 'armord', 'armorops.yaml')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('errors: unknown framework, language, policy, non-empty dir', () => {
  assert.throws(() => scaffold({ dir: join(tmp(), 'a'), framework: 'cobol' }), /unknown framework/);
  assert.throws(() => scaffold({ dir: join(tmp(), 'b'), framework: 'crewai', language: 'typescript' }), /no typescript recipe/);
  assert.throws(() => scaffold({ dir: join(tmp(), 'c'), framework: 'crewai', policy: 'nope' }), /unknown policy/);
  const full = tmp();
  writeFileSync(join(full, 'x'), '1');
  assert.throws(() => scaffold({ dir: full, framework: 'crewai' }), /not empty/);
  assert.doesNotThrow(() => scaffold({ dir: full, framework: 'crewai', force: true }));
});

test('dry run writes nothing; --recipe picks a specific recipe', () => {
  const dir = join(tmp(), 'd');
  assert.equal(scaffold({ dir, framework: 'mcp', language: 'python', dryRun: true }).dryRun, true);
  assert.ok(!existsSync(dir));
  assert.equal(scaffold({ dir, recipe: 'sdk/typescript/postgres-notes' }).recipe, 'sdk/typescript/postgres-notes');
});

test('env example has placeholders only', () => {
  const e = envExample(['armoriq', 'gemini']);
  assert.match(e, /ARMORIQ_API_KEY=ak_your_key_here/);
  assert.doesNotMatch(e, /ak_live_/);
});

test('policy list includes the armord templates', () => {
  const ps = listPolicies();
  for (const p of ['armordev', 'armorops', 'armor-readonly', 'armor-balanced']) assert.ok(ps.includes(p), p);
});

test('CLI: --list, scaffold with flags, missing framework without a terminal', () => {
  assert.match(cli('--list').stdout, /langchain\s+python, typescript/);
  const dir = join(tmp(), 'cli-out');
  const r = cli(dir, '--framework', 'langgraph', '--yes', '--policy', 'armor-readonly');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'armord', 'armor-readonly.yaml')));
  const bad = cli(join(tmp(), 'x'));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing --framework/);
  assert.match(cli(join(tmp(), 'y'), '--framework', 'nope').stderr, /unknown framework/);
});
