// Offline test: runs the real src/agent.mjs twice in offline mode and checks both runs.
//
//   npm run test:offline
//
// Run 1 approves the held deploy, run 2 rejects it (OFFLINE_APPROVAL=reject). Exits 1 if the agent
// fails or any expected line is missing. Needs no API keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOAL = 'Ship 2.4.0 to production, then clean up the staging-old environment.';
const POLICY = 'policy release-assistant-policy';

const RUNS = [
  {
    label: 'approve',
    approval: 'approve',
    expected: [
      `[armoriq] plan: ${GOAL} -> release__list_releases, release__get_build_status, release__deploy_to_production, release__delete_environment`,
      `[armoriq] check release__list_releases: ALLOWED (${POLICY}: list_releases -> allow)`, // allow
      '[armoriq] report release__list_releases: success',
      `[armoriq] check release__get_build_status: ALLOWED (${POLICY}: get_build_status -> allow)`,
      `[armoriq] check release__deploy_to_production: HELD (${POLICY}: deploy_to_production -> hold)`, // hold
      '[armoriq] args release__deploy_to_production: {"version":"2.4.0"}',
      '[armoriq] hold release__deploy_to_production: APPROVED',
      '[armoriq] report release__deploy_to_production: success',
      '[tool] result: Deployed 2.4.0 (9f3c2ab) to production.',
      `[armoriq] check release__delete_environment: BLOCKED (${POLICY}: delete_environment -> block)`, // block
      '[tool] denied/error: Blocked by ArmorIQ policy',
      'deploy_to_production: done; delete_environment: denied',
      'RUN COMPLETED',
    ],
    unexpected: ['[armoriq] report release__delete_environment', 'Deleted environment'],
  },
  {
    label: 'reject',
    approval: 'reject',
    expected: [
      '[armoriq] check release__deploy_to_production: HELD',
      '[armoriq] hold release__deploy_to_production: REJECTED',
      '[tool] denied/error: A human rejected release__deploy_to_production. It was not run.',
      '[armoriq] check release__delete_environment: BLOCKED',
      'deploy_to_production: denied; delete_environment: denied',
      'RUN COMPLETED',
    ],
    unexpected: [
      '[armoriq] report release__deploy_to_production',
      '[armoriq] hold release__deploy_to_production: APPROVED',
      'Deployed 2.4.0',
    ],
  },
];

function run({ approval }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'src/agent.mjs', GOAL], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OFFLINE_APPROVAL: approval },
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
for (const r of RUNS) {
  const { code, output } = await run(r);
  console.log(`--- run: ${r.label} ---`);
  console.log(output);
  const missing = r.expected.filter((line) => !output.includes(line));
  const present = r.unexpected.filter((line) => output.includes(line));
  if (code !== 0 || missing.length > 0 || present.length > 0) {
    failed = true;
    console.error(`FAIL offline run ${r.label} (exit ${code})`);
    for (const line of missing) console.error(`  missing: ${line}`);
    for (const line of present) console.error(`  should not appear: ${line}`);
  } else {
    console.log(`PASS offline run ${r.label}: ${r.expected.length} expected lines seen`);
  }
}
process.exit(failed ? 1 : 0);
