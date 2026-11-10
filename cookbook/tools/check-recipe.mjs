#!/usr/bin/env node
// Builds and tests recipes by lane (feature 8). Needs no secrets: it runs each recipe's offline test.
//
//   node tools/check-recipe.mjs                     every recipe
//   node tools/check-recipe.mjs <recipe-id>...      only these, e.g. sdk/typescript/github-agent
//   node tools/check-recipe.mjs --ci <ids>          clean install (npm ci) instead of reusing node_modules
//
// typescript lane: install, typecheck (tsconfig.json) or syntax check (plain JS), then npm run test:offline
// python lane:     install requirements into a venv, compile, then run offline/test.py if present
// config lane:     nothing to build; the metadata validator covers it
// other lanes:     skipped until that lane has a convention

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../schema/manifest.mjs';
import { loadTaxonomy, recipeDir, recipeIds, repoFiles } from './recipes.mjs';

const args = process.argv.slice(2);
const ci = args.includes('--ci');
const requested = args.filter((a) => !a.startsWith('--'));
const taxonomy = loadTaxonomy();
const allIds = recipeIds();
const ids = requested.length > 0 ? requested : allIds;

function run(cmd, cmdArgs, cwd) {
  console.log(`  $ ${[cmd === process.execPath ? 'node' : cmd, ...cmdArgs].join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`"${cmd} ${cmdArgs.join(' ')}" exited with ${result.status ?? result.signal}`);
}

function checkTypescript(id, dir) {
  if (!existsSync(join(dir, 'package-lock.json'))) throw new Error('no package-lock.json; run npm install and commit it');
  if (ci || !existsSync(join(dir, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], dir);
  if (existsSync(join(dir, 'tsconfig.json'))) {
    run('npx', ['--no-install', 'tsc', '--noEmit', '-p', '.'], dir);
  } else {
    const prefix = `recipes/${id}/`;
    const sources = repoFiles(prefix)
      .map((f) => f.slice(prefix.length))
      .filter((f) => /\.(c|m)?js$/.test(f));
    for (const file of sources) run(process.execPath, ['--check', file], dir);
  }
  const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
  if (scripts['test:offline']) run('npm', ['run', '-s', 'test:offline'], dir);
  else console.log('  (no test:offline script; add one so this recipe is tested without keys)');
}

function checkPython(dir) {
  // PYTHON overrides the interpreter, e.g. PYTHON=python3.12 when the default python3 is too new for a recipe.
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const venvPython = join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(venvPython)) run(python, ['-m', 'venv', '.venv'], dir);
  if (existsSync(join(dir, 'requirements.txt'))) run(venvPython, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], dir);
  else if (existsSync(join(dir, 'pyproject.toml'))) run(venvPython, ['-m', 'pip', 'install', '-q', '.'], dir);
  run(venvPython, ['-m', 'compileall', '-q', '-x', '[/\\\\]\\.venv', '.'], dir);
  if (existsSync(join(dir, 'offline', 'test.py'))) run(venvPython, ['offline/test.py'], dir);
  else console.log('  (no offline/test.py; add one so this recipe is tested without keys)');
}

let failed = 0;
for (const id of ids) {
  console.log(`\n== ${id}`);
  const dir = recipeDir(id);
  try {
    if (!allIds.includes(id)) throw new Error('not a recipe folder (expected recipes/<framework>/<language>/<slug>/)');
    const manifest = loadYaml(join(dir, 'recipe.yaml'));
    const lane = taxonomy.languages[manifest.language]?.lane ?? 'other';
    if (lane === 'typescript') checkTypescript(id, dir);
    else if (lane === 'python') checkPython(dir);
    else if (lane === 'config') console.log('  config lane: nothing to build');
    else console.log(`  ${lane} lane: no build convention yet, skipped`);
    console.log(`ok  ${id}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${id}: ${err.message}`);
  }
}

console.log(`\n${ids.length - failed}/${ids.length} recipe${ids.length === 1 ? '' : 's'} passed`);
process.exit(failed > 0 ? 1 : 0);
