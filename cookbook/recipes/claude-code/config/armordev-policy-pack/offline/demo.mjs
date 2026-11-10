#!/usr/bin/env node
// A short walk through the ArmorDev pack: one coding session, each tool call checked the way
// ArmorClaude would check it. No plugin, keys, or network needed.
//
//   node offline/demo.mjs
//   OFFLINE_APPROVAL=reject node offline/demo.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateClaude } from './evaluate.mjs';
import { cases } from './cases.mjs';

const PACK = 'armordev';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(join(root, 'armorclaude', `${PACK}.json`), 'utf8'));
const WORD = { ALLOWED: 'allow', HELD: 'hold', BLOCKED: 'block' };
const approval = process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED';
const steps = cases.filter((c) => c.demo);

console.log(`[armoriq] plan: fix the failing test, ship a release -> ${steps.map((c) => c.tool).join(', ')}`);
for (const c of steps) {
  const { verdict, rule } = evaluateClaude(policy, c.tool, c.args);
  console.log(`[armoriq] check ${c.tool}: ${verdict} (policy ${PACK}: ${rule} -> ${WORD[verdict]})`);
  console.log(`[armoriq] args ${c.tool}: ${JSON.stringify(c.args)}`);
  if (verdict === 'HELD') {
    console.log(`[armoriq] hold ${c.tool}: ${approval}`);
    console.log(`[armoriq] report ${c.tool}: ${approval === 'APPROVED' ? 'ran after approval' : 'not run'}`);
  } else {
    console.log(`[armoriq] report ${c.tool}: ${verdict === 'ALLOWED' ? 'ran' : 'not run'}`);
  }
}
