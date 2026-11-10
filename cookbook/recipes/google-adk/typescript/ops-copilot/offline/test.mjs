// Offline test: runs the real agent in offline mode twice and checks the allow, hold, and block outcomes.
//
//   npm run test:offline
//
// Exits 1 if a run fails or an expected line is missing. Needs no API keys or network.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  {
    name: 'held refund is approved, injected export is blocked',
    env: {},
    expected: [
      'ALLOWED  get_ticket',
      'ALLOWED  issue_refund',
      'HOLD     issue_refund - waiting for a human to approve',
      'reason: $2388.00 exceeds the support_t1 refund limit of $500.00',
      'APPROVED issue_refund - carrying on',
      'BLOCKED  export_all_customers',
      '6 tool call(s), 1 refused.',
    ],
  },
  {
    name: 'held refund is rejected by the approver',
    env: { OFFLINE_APPROVAL: 'reject' },
    expected: ['REFUSED  issue_refund - approval rejected', 'BLOCKED  export_all_customers', '6 tool call(s), 2 refused.'],
  },
];

let failed = 0;
for (const c of CASES) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--import', './offline/register.mjs', 'src/index.ts'], {
    cwd: recipe,
    env: { ...process.env, ...c.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${run.stdout}${run.stderr}`;
  const missing = c.expected.filter((line) => !output.includes(line));
  if (run.status !== 0 || missing.length > 0) {
    failed++;
    console.log(`FAIL  ${c.name} (exit ${run.status})`);
    for (const line of missing) console.log(`      missing: ${line}`);
    console.log(output.replace(/^/gm, '      | '));
  } else {
    console.log(`PASS  ${c.name}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
