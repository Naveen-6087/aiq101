#!/usr/bin/env node
// Offline check for the ArmorOps pack. Node 20, no dependencies, no network, no plugin.
//
//   node offline/test.mjs
//
// 1. Validates armorclaude/armorops.json the way `/armorclaude:armor policy stage` does.
// 2. Validates the rules in armorcodex/policy-profiles.json the way ArmorCodex loads them.
// 3. Checks policy.yaml (the summary the recipe browser shows) names the same rules.
// 4. Runs every call in offline/cases.mjs through both evaluators, prints the log contract
//    lines, and exits 1 on any verdict that differs from the table.
//
// OFFLINE_APPROVAL=reject turns every held call into a rejected one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateClaude, evaluateCodex, validateClaudePolicy, validateCodexRules } from './evaluate.mjs';
import { cases } from './cases.mjs';

const PACK = 'armorops';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const claudePolicy = JSON.parse(readFileSync(join(root, 'armorclaude', `${PACK}.json`), 'utf8'));
const codexRules = JSON.parse(readFileSync(join(root, 'armorcodex', 'policy-profiles.json'), 'utf8')).profiles[PACK].rules;
const WORD = { ALLOWED: 'allow', HELD: 'hold', BLOCKED: 'block' };
const approval = process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED';

let failures = 0;
let mismatches = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

// 1 + 2: the files load in the real plugins.
for (const e of validateClaudePolicy(claudePolicy)) fail(`armorclaude/${PACK}.json: ${e}`);
for (const e of validateCodexRules(codexRules)) fail(`armorcodex/policy-profiles.json: ${e}`);

// 3: policy.yaml stays in step with the real files (line based, so no YAML parser is needed).
const EFFECT = { allow: 'permit', hold: 'require_approval', block: 'forbid' };
const summary = readFileSync(join(root, 'policy.yaml'), 'utf8');
const summaryRules = summary.split(/\n\s*- id:\s*/).slice(1).map((block) => ({
  id: block.split('\n')[0].trim(),
  action: block.match(/\n\s*action:\s*(\S+)/)?.[1],
  codex: block.match(/\n\s*codex:\s*(\S+)/)?.[1],
}));
const statementIds = claudePolicy.statements.map((s) => s.id);
for (const r of summaryRules) {
  const s = claudePolicy.statements.find((x) => x.id === r.id);
  if (!s) fail(`policy.yaml rule ${r.id} is not a statement in armorclaude/${PACK}.json`);
  else if (EFFECT[r.action] !== s.effect) fail(`policy.yaml rule ${r.id} says ${r.action}, the profile says ${s.effect}`);
  if (r.codex && r.codex !== 'none' && !codexRules.some((x) => x.id === r.codex)) fail(`policy.yaml rule ${r.id} names codex rule ${r.codex}, which does not exist`);
}
for (const id of statementIds) if (!summaryRules.some((r) => r.id === id)) fail(`statement ${id} is missing from policy.yaml`);

// 4: the table.
const counts = { ALLOWED: 0, HELD: 0, BLOCKED: 0 };
console.log(`== ArmorClaude: armorclaude/${PACK}.json (default ${claudePolicy.defaults.decision}, deny overrides)`);
for (const c of cases.filter((x) => x.claude)) {
  const { verdict, rule } = evaluateClaude(claudePolicy, c.tool, c.args);
  counts[verdict]++;
  console.log(`[armoriq] check ${c.tool}: ${verdict} (policy ${PACK}: ${rule} -> ${WORD[verdict]})${c.gap ? '  [known gap]' : ''}`);
  console.log(`[armoriq] args ${c.tool}: ${JSON.stringify(c.args)}`);
  if (verdict === 'HELD') console.log(`[armoriq] hold ${c.tool}: ${approval}`);
  if (verdict !== c.claude) mismatches++, fail(`ArmorClaude ${c.tool} ${JSON.stringify(c.args)}: expected ${c.claude}, got ${verdict} (${rule})`);
}

console.log(`\n== ArmorCodex: armorcodex/policy-profiles.json profile "${PACK}" (first match wins, default allow)`);
for (const c of cases.filter((x) => x.codex)) {
  const tool = c.tool === 'Bash' ? 'bash' : c.tool;
  const { verdict, rule } = evaluateCodex(codexRules, tool, c.args);
  console.log(`[armoriq] check ${tool}: ${verdict} (policy ${PACK}: ${rule} -> ${WORD[verdict]})${c.gap ? '  [known gap]' : ''}`);
  if (verdict !== c.codex) mismatches++, fail(`ArmorCodex ${tool} ${JSON.stringify(c.args)}: expected ${c.codex}, got ${verdict} (${rule})`);
}

// Every outcome the manifest lists in `demonstrates` has to show up.
for (const v of ['ALLOWED', 'HELD', 'BLOCKED']) if (!counts[v]) fail(`no ${v} call in the ArmorClaude run`);

const total = cases.filter((x) => x.claude).length + cases.filter((x) => x.codex).length;
console.log(`\n${failures ? 'FAILED' : 'ok'}: ${total - mismatches}/${total} sample calls match (ArmorClaude ${counts.ALLOWED} allowed, ${counts.HELD} held, ${counts.BLOCKED} blocked)`);
process.exit(failures ? 1 : 0);
