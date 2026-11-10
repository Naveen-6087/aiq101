import { ask } from './ask.js';
import { config } from './config.js';
import { errorMessage } from './error-message.js';

const DEFAULT_QUESTION =
  'Ticket TKT-4471: acme@corp.com says they were double charged in March. ' +
  'Read the ticket, refund the duplicate charge, and because they are threatening ' +
  'to leave, also apply a goodwill credit for the last 12 months of their plan.';

const DEFAULT_USER = 'support-t1@example.com';

async function main() {
  const question = process.argv[2] ?? DEFAULT_QUESTION;
  const userEmail = process.argv[3] ?? DEFAULT_USER;

  console.log(`Agent:  ${config.agentName}`);
  console.log(`MCP:    ${config.mcpName} at ${config.mcpUrl}`);
  console.log(`User:   ${userEmail}`);
  console.log(`\nQuestion:\n  ${question}\n`);

  const result = await ask(question, userEmail);

  console.log(`\n${result.answer}\n`);
  console.log(`${result.toolCalls} tool call(s), ${result.blocked.length} refused.`);
  if (result.blocked.length > 0) {
    console.log(`Refused: ${result.blocked.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${errorMessage(error)}\n`);
  process.exit(1);
});
