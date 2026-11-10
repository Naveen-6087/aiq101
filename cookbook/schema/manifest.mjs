// Loads a recipe.yaml and checks it against recipe.schema.json (spec 0002).
// Shared by schema/check.mjs (fixtures) and tools/validate.mjs (the repo wide check).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'recipe.schema.json'), 'utf8'));
// strictRequired is off because the linked rules (allOf if/then) list `required` fields that are
// defined in the top level properties, which is valid JSON Schema but trips that one Ajv lint.
const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema);

// js-yaml 4 loads the YAML 1.2 core schema, so `no` and `yes` stay strings. load() throws on
// more than one document.
export function loadYaml(file) {
  return yaml.load(readFileSync(file, 'utf8'), { filename: file });
}

// Returns { text, data, errors }. errors is [] when the file is a valid manifest shape.
export function checkManifest(file) {
  const text = readFileSync(file, 'utf8');
  let data;
  try {
    data = yaml.load(text, { filename: file });
  } catch (err) {
    return { text, data: null, errors: [{ field: '(yaml)', message: err.message }] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { text, data: null, errors: [{ field: '(root)', message: 'the file must hold one YAML mapping' }] };
  }
  if (validate(data)) return { text, data, errors: [] };
  // The `if` wrapper error ("must match else schema") only repeats the field error under it.
  return { text, data, errors: validate.errors.filter((e) => e.keyword !== 'if').map(describe) };
}

// Turns an Ajv error into the field it is about plus a readable message.
function describe(err) {
  const path = err.instancePath.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const named = err.params.additionalProperty ?? err.params.missingProperty;
  if (named) path.push(named);
  const field = path.join('.') || '(root)';
  let message = err.message;
  if (err.keyword === 'additionalProperties') message = `unknown key "${named}"`;
  if (err.keyword === 'false schema') message = 'is not allowed here';
  if (err.keyword === 'enum') message += `: ${err.params.allowedValues.join(', ')}`;
  return { field, message };
}
