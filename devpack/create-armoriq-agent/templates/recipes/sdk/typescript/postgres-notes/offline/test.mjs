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
  '[armoriq] plan: Postgres notes session for ',
  '-> postgres__query, postgres__query, postgres__query',
  '[armoriq] check postgres__query: HELD (policy postgres-policy: query -> hold)',
  '[armoriq] args postgres__query: {"sql":"SELECT id, title, body FROM notes ORDER BY id"}',
  '[armoriq] args postgres__query: {"sql":"SELECT name, department, salary FROM employees ORDER BY salary DESC"}',
  '[armoriq] args postgres__query: {"sql":"DELETE FROM notes WHERE id = 1"}',
  'DEMO COMPLETED SUCCESSFULLY',
];
const RUNS = [
  { approval: 'approve', expected: [...COMMON, '[armoriq] hold postgres__query: APPROVED'] },
  { approval: 'reject', expected: [...COMMON, '[armoriq] hold postgres__query: REJECTED'] },
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
