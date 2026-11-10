// Shared helpers for the repo tools: find recipes on disk and load the taxonomy (specs 0001, 0002).

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadYaml } from '../schema/manifest.mjs';

export const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// Tracked files plus untracked files that are not ignored, so node_modules and .env never count.
export function repoFiles(prefix = 'recipes/') {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

// A recipe is a folder exactly three levels under recipes/: recipes/<framework>/<language>/<slug>/.
export function recipeIds(files = repoFiles()) {
  const ids = new Set();
  for (const file of files) {
    const parts = file.split('/').slice(1);
    if (parts.length >= 4) ids.add(parts.slice(0, 3).join('/'));
  }
  return [...ids].sort();
}

export const recipeDir = (id) => join(root, 'recipes', id);

export function loadTaxonomy() {
  return loadYaml(join(root, 'schema', 'taxonomy.yaml'));
}

export const ALLOWLIST = '.github/official-recipes.txt';

// Returns [{ line, id }] for every ID line, skipping blank lines and # comments.
export function readAllowlistLines(text) {
  return text
    .split('\n')
    .map((raw, i) => ({ line: i + 1, id: raw.trim() }))
    .filter(({ id }) => id !== '' && !id.startsWith('#'));
}
