#!/usr/bin/env node
// Runs the schema fixtures (spec 0002).
//
//   node schema/check.mjs                 valid/ must pass, invalid/ must fail
//   node schema/check.mjs <file>...       check the shape of the given recipe.yaml files
//
// Each invalid fixture starts with `# expect: <field>`; it must fail with an error naming that field.
// Taxonomy, paths, lockfiles, and the allowlist are checked by tools/validate.mjs.

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest } from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function fieldNamed(errors, expected) {
  return errors.some((e) => e.field === expected || e.field.startsWith(`${expected}.`));
}

function yamlFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(dir, f));
}

const show = (file) => relative(process.cwd(), file);
let failed = 0;
const files = process.argv.slice(2);

if (files.length > 0) {
  for (const file of files) {
    const { errors } = checkManifest(file);
    if (errors.length === 0) {
      console.log(`ok    ${show(file)}`);
      continue;
    }
    failed++;
    console.log(`FAIL  ${show(file)}`);
    for (const e of errors) console.log(`      ${e.field}: ${e.message}`);
  }
} else {
  for (const file of yamlFiles(join(here, 'fixtures', 'valid'))) {
    const { errors } = checkManifest(file);
    if (errors.length === 0) {
      console.log(`ok    ${show(file)} passes`);
      continue;
    }
    failed++;
    console.log(`FAIL  ${show(file)} should pass but failed:`);
    for (const e of errors) console.log(`      ${e.field}: ${e.message}`);
  }
  for (const file of yamlFiles(join(here, 'fixtures', 'invalid'))) {
    const { text, errors } = checkManifest(file);
    const expected = text.match(/^# expect: (\S+)/)?.[1];
    if (!expected) {
      failed++;
      console.log(`FAIL  ${show(file)} has no "# expect: <field>" first line`);
    } else if (errors.length === 0) {
      failed++;
      console.log(`FAIL  ${show(file)} should fail on "${expected}" but passed`);
    } else if (!fieldNamed(errors, expected)) {
      failed++;
      console.log(`FAIL  ${show(file)} failed, but no error names "${expected}":`);
      for (const e of errors) console.log(`      ${e.field}: ${e.message}`);
    } else {
      console.log(`ok    ${show(file)} fails on ${expected}`);
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} problem${failed === 1 ? '' : 's'}`);
  process.exit(1);
}
