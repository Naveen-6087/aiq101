// Offline test: runs the real demo.js twice in offline mode and checks both runs.
//
//   npm run test:offline
//
// Run 1 approves the held call, run 2 rejects it (OFFLINE_APPROVAL=reject). Exits 1 if the agent
// fails or any expected line is missing. Needs no API keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOAL = 'Search repositories for acme, open a pull request, then delete the repository';

const RUNS = [
  {
    label: 'approve',
    approval: 'approve',
    expected: [
      '[armoriq] plan: ' + GOAL + ' -> github__search_repositories, github__create_pull_request, github__delete_repository',
      '[armoriq] check github__search_repositories: ALLOWED (policy github-policy: search_repositories -> allow)', // allow
      '[armoriq] check github__create_pull_request: HELD (policy github-policy: create_pull_request -> hold)', // hold
      '[armoriq] args github__create_pull_request: {',
      '[armoriq] hold github__create_pull_request: APPROVED',
      '[armoriq] report github__create_pull_request: success',
      '[armoriq] check github__delete_repository: BLOCKED (policy github-policy: delete_repository -> block)', // block
      'acme/acme-widgets',
      'STATUS     : [APPROVED] by a human, executing',
      'DEMO COMPLETED',
    ],
    unexpected: ['[armoriq] report github__delete_repository'],
  },
  {
    label: 'reject',
    approval: 'reject',
    expected: [
      '[armoriq] check github__create_pull_request: HELD',
      '[armoriq] hold github__create_pull_request: REJECTED',
      '[armoriq] check github__delete_repository: BLOCKED',
      'STATUS     : [REJECTED] not executed',
      'DEMO COMPLETED',
    ],
    unexpected: ['[armoriq] report github__create_pull_request', '[armoriq] hold github__create_pull_request: APPROVED'],
  },
];

function run({ approval }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'demo.js', GOAL], {
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
