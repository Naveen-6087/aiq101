#!/usr/bin/env node
// Prints the recipe IDs a change touches, as a JSON array, for the CI build matrix (feature 8).
//
//   node tools/changed-recipes.mjs <base-ref>
//
// A changed file under recipes/<framework>/<language>/<slug>/ selects that recipe (if it still exists).
// A change to the build tooling or the workflow selects every recipe.

import { execFileSync } from 'node:child_process';
import { recipeIds, root } from './recipes.mjs';

const ALL_TRIGGERS = ['tools/check-recipe.mjs', 'tools/recipes.mjs', '.github/workflows/recipes.yml'];

const base = process.argv[2];
if (!base) {
  console.error('usage: node tools/changed-recipes.mjs <base-ref>');
  process.exit(2);
}

const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const existing = recipeIds();

let selected;
if (changed.some((f) => ALL_TRIGGERS.includes(f))) {
  selected = existing;
} else {
  const touched = new Set(
    changed
      .filter((f) => f.startsWith('recipes/'))
      .map((f) => f.split('/').slice(1, 4))
      .filter((parts) => parts.length === 3)
      .map((parts) => parts.join('/')),
  );
  selected = existing.filter((id) => touched.has(id));
}

console.log(JSON.stringify(selected));
