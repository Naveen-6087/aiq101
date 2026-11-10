// Offline test: runs the real demo.mjs against the stand-in gateway and checks the output.
//
//   npm run test:offline
//
// Runs 1 and 2 use policy.yaml as shipped, with OFFLINE_APPROVAL=approve and =reject: a hold acts
// as a block at the gateway today, so the credit must stay unissued either way. Run 3 uses a copy
// of the policy that allows everything, to prove the stand-in decides from the policy file.
// Exits 1 if the demo fails or a line is missing. No keys, no network beyond 127.0.0.1.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHIPPED = {
  expected: [
    '[armoriq] check lookup_customer: ALLOWED (policy support-bot-policy: lookup_customer -> allow)',
    'Sam Okafor is on the Team plan',
    '[armoriq] plan: Customer C-2001 was double charged.',
    '[armoriq] check issue_credit: HELD (policy support-bot-policy: issue_credit -> hold; hold acts as block at the gateway today)',
    '[armoriq] args issue_credit: {"customer_id":"C-2001","amount":40,"reason":"duplicate charge"}',
    '[armoriq] check delete_customer: BLOCKED (policy support-bot-policy: delete_customer -> block)',
    '[bot] Intent Gateway stopped issue_credit (hold:issue_credit#0), delete_customer (block:delete_customer#0)',
    'I could not apply the $40 credit myself',
    'I also cannot delete accounts',
    '[gateway] request from dana@example.com',
    'Done.',
  ],
  unexpected: ['[crm] credit issued', '[crm] customer deleted', '[armoriq] hold issue_credit', 'Error'],
};

const LOOSENED = {
  expected: [
    '[armoriq] check issue_credit: ALLOWED (policy support-bot-policy: issue_credit -> allow)',
    '[armoriq] check delete_customer: ALLOWED (policy support-bot-policy: delete_customer -> allow)',
    '[crm] credit issued: C-2001 $40',
    '[crm] customer deleted: C-2001',
    'Done: $40 credited to Dana Ruiz',
  ],
  unexpected: ['was blocked by policy'],
};

function run(env) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ARMORIQ_GATEWAY_KEY', 'ARMORIQ_GATEWAY_HOST', 'ARMORIQ_AGENT_ID', 'OFFLINE_POLICY']) {
      delete clean[key];
    }
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'demo.mjs'], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...clean, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function verify(label, { code, output }, spec) {
  process.stdout.write(output);
  const problems = [];
  if (code !== 0) problems.push(`demo exited ${code}`);
  for (const line of spec.expected) if (!output.includes(line)) problems.push(`missing: ${line}`);
  for (const line of spec.unexpected) if (output.includes(line)) problems.push(`unexpected: ${line}`);
  if (problems.length > 0) {
    console.log(`FAIL offline run (${label})`);
    for (const problem of problems) console.log(`  ${problem}`);
    return false;
  }
  console.log(`PASS offline run (${label}): ${spec.expected.length} expected lines seen`);
  return true;
}

let ok = true;
for (const approval of ['approve', 'reject']) {
  console.log(`\n=== policy.yaml as shipped, OFFLINE_APPROVAL=${approval}`);
  ok = verify(`shipped policy, ${approval}`, await run({ OFFLINE_APPROVAL: approval }), SHIPPED) && ok;
}

console.log('\n=== policy.yaml with every rule set to allow');
const tmp = mkdtempSync(join(tmpdir(), 'gateway-support-bot-'));
try {
  const loosened = join(tmp, 'policy.yaml');
  writeFileSync(loosened, readFileSync(join(recipe, 'policy.yaml'), 'utf8').replace(/action:\s*(hold|block)/g, 'action: allow'));
  ok = verify('everything allowed', await run({ OFFLINE_POLICY: loosened }), LOOSENED) && ok;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
