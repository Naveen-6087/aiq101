// Offline test: runs the real agent.js in offline mode, answers its two prompts, and checks the run.
//
//   npm run test:offline
//
// Exits 1 if the agent fails or any expected step is missing. Needs no API keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANSWERS = [
  ['Which repository?', '1'],
  ['Which file would you like to read?', 'README.md'],
];
const EXPECTED = [
  '[armoriq] check search_repositories: ALLOWED',
  '[armoriq] check list_commits: ALLOWED',
  '[armoriq] check list_issues: ALLOWED',
  '[armoriq] check get_file_contents: ALLOWED',
  'acme/acme-widgets',
  'Fix pagination bug',
  '#14 [open] Sync job times out on large payloads',
  '--- README.md ---',
  'Widgets for the Acme sync service.',
];

const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'agent.js'], {
  cwd: recipe,
  env: { ...process.env, GITHUB_USER: 'acme', USER_EMAIL: 'you@example.com' },
});

let output = '';
let next = 0;
child.stderr.on('data', (chunk) => (output += chunk));
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
  // Answer each prompt only once it is on screen, the way a person would.
  while (next < ANSWERS.length && output.includes(ANSWERS[next][0])) {
    child.stdin.write(`${ANSWERS[next][1]}\n`);
    process.stdout.write(`${ANSWERS[next][1]}\n`);
    next++;
  }
});

const timer = setTimeout(() => {
  console.error('\nFAIL offline run timed out after 20s');
  child.kill();
  process.exit(1);
}, 20_000);

child.on('close', (code) => {
  clearTimeout(timer);
  const missing = EXPECTED.filter((line) => !output.includes(line));
  if (code !== 0 || missing.length > 0) {
    console.error(`\nFAIL offline run (exit ${code})`);
    for (const line of missing) console.error(`  missing: ${line}`);
    process.exit(1);
  }
  console.log(`\nPASS offline run: ${EXPECTED.length} expected steps seen`);
});
