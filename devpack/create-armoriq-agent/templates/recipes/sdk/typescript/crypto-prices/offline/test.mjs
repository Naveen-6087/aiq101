// Offline test: runs the real demo.js in offline mode and checks the run.
//
//   npm run test:offline
//
// Exits 1 if the agent fails or any expected line is missing. Needs no API keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOAL = "how's Solana doing today, in EUR?";
const EXPECTED = [
  `[armoriq] plan: ${GOAL} -> coingecko__search_coin, coingecko__get_price`,
  '[armoriq] check coingecko__search_coin: ALLOWED (policy coingecko-policy: search_coin -> allow)', // allow
  '[armoriq] check coingecko__get_price: ALLOWED (policy coingecko-policy: get_price -> allow)', // allow
  '[armoriq] report coingecko__search_coin: success',
  '[armoriq] report coingecko__get_price: success',
  '"eur_24h_change": 2.9',
  'DEMO COMPLETED SUCCESSFULLY',
];
const UNEXPECTED = ['HELD', 'BLOCKED', 'Execution Error'];

const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'demo.js', GOAL], {
  cwd: recipe,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

const timer = setTimeout(() => child.kill(), 20_000);

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
