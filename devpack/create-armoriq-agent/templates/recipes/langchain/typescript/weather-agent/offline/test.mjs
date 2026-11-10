// Offline test: runs the real agent.js in offline mode and checks the run.
//
//   npm run test:offline
//
// Exits 1 if the agent fails or any expected line is missing. Needs no API keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOAL = "What's the weather like right now in Bengaluru, India?";
const EXPECTED = [
  `[armoriq] plan: ${GOAL} -> weather__search_location`,
  '[armoriq] check weather__search_location: ALLOWED (policy weather-policy: search_location -> allow)', // allow
  '[armoriq] check weather__get_current_conditions: ALLOWED (policy weather-policy: get_current_conditions -> allow)', // allow
  '[armoriq] report weather__search_location: success',
  '[armoriq] report weather__get_current_conditions: success',
  'Tool result (weather__get_current_conditions)',
  'Final answer: It is partly cloudy at 24 C',
  'DEMO COMPLETED',
];
const UNEXPECTED = ['HELD', 'BLOCKED', '[ERROR]'];

const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'agent.js'], {
  cwd: recipe,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

const timer = setTimeout(() => child.kill(), 30_000);

child.on('close', (code) => {
  clearTimeout(timer);
  console.log(output);
  const missing = EXPECTED.filter((line) => !output.includes(line));
  const present = UNEXPECTED.filter((line) => output.includes(line));
  if (code !== 0 || missing.length > 0 || present.length > 0) {
    console.error(`FAIL offline run (exit ${code})`);
    for (const line of missing) console.error(`  missing: ${line}`);
    for (const line of present) console.error(`  should not appear: ${line}`);
    process.exit(1);
  }
  console.log(`PASS offline run: ${EXPECTED.length} expected lines seen`);
});
