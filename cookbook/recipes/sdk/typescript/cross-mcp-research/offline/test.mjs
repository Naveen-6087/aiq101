// Offline test: runs the real demo.js twice in offline mode and checks the log.
//
//   npm run test:offline
//
// Run 1 approves held calls (the default). Run 2 sets OFFLINE_APPROVAL=reject. Exits 1 if either run
// fails or an expected line is missing. Needs no API keys, no network, and no stdin.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMON = [
  '[armoriq] plan: Cross-MCP research session for ',
  '-> filesystem__read_file, memory__create_entities, memory__search_nodes',
  '[armoriq] check filesystem__read_file: ALLOWED (policy filesystem-notes-policy: read_file -> allow)',
  '[armoriq] report filesystem__read_file: success',
  '[armoriq] check memory__create_entities: HELD (policy memory-knowledge-policy: create_entities -> hold)',
  '[armoriq] check memory__search_nodes: ALLOWED (policy memory-knowledge-policy: search_nodes -> allow)',
  '[armoriq] report memory__search_nodes: success',
  'DEMO COMPLETED SUCCESSFULLY',
];
const RUNS = [
  { approval: 'approve', expected: [...COMMON, '[armoriq] hold memory__create_entities: APPROVED'] },
  { approval: 'reject', expected: [...COMMON, '[armoriq] hold memory__create_entities: REJECTED'] },
];

function run(approval) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'demo.js'], {
      cwd: recipe,
      env: { ...process.env, OFFLINE_APPROVAL: approval },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

let failed = false;
for (const { approval, expected } of RUNS) {
  const { code, output } = await run(approval);
  if (approval === 'approve') process.stdout.write(output);
  const missing = expected.filter((line) => !output.includes(line));
  if (code !== 0 || missing.length > 0) {
    failed = true;
    console.error(`\nFAIL offline run with OFFLINE_APPROVAL=${approval} (exit ${code})`);
    for (const line of missing) console.error(`  missing: ${line}`);
  } else {
    console.log(`PASS offline run with OFFLINE_APPROVAL=${approval}: ${expected.length} expected lines seen`);
  }
}
process.exit(failed ? 1 : 0);
