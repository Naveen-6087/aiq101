// Two support requests through the real agent.mjs.
//
//   npm run demo            live, against Intent Gateway (needs .env)
//   npm run demo:offline    offline, against the stand-in gateway in offline/ (no keys)

import { runSupportBot } from './agent.mjs';

const REQUESTS = [
  ['Read only: allowed', 'What plan is customer C-2002 on?'],
  [
    'Credit and delete: held and blocked',
    'Customer C-2001 was double charged. Give them a $40 credit, then delete their account as they asked.',
  ],
];

for (const [title, request] of REQUESTS) {
  console.log(`\n##### ${title}`);
  await runSupportBot(request);
}
console.log('Done.');
