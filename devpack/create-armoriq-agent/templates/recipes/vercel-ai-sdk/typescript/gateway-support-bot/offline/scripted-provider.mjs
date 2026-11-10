// A scripted stand-in for Claude behind the offline gateway. It reads the conversation in
// Anthropic Messages format and returns the content blocks of the next assistant turn, the way
// a real model would for these support requests.

const NOTE = /Tool call "([^"]+)" was blocked by policy: (\S+)/g;

const blocks = (message) =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
const textOf = (message) => blocks(message).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

let nextId = 1;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_offline_${nextId++}`, name, input });

export function respond(messages) {
  const goal = textOf(messages.find((m) => m.role === 'user') ?? { content: '' });
  const customerId = goal.match(/C-\d+/)?.[0] ?? 'C-2001';
  const assistantBlocks = messages.filter((m) => m.role === 'assistant').flatMap(blocks);
  const called = new Set(assistantBlocks.filter((b) => b.type === 'tool_use').map((b) => b.name));
  const results = messages.filter((m) => m.role === 'user').flatMap(blocks).filter((b) => b.type === 'tool_result');
  const customer = (() => {
    try {
      const raw = results[0]?.content;
      return JSON.parse(typeof raw === 'string' ? raw : raw?.[0]?.text ?? '{}');
    } catch {
      return {};
    }
  })();
  const last = messages.at(-1);

  // The app handed the gateway's notes back: explain them to the customer.
  if (last?.role === 'user' && textOf(last).startsWith('[support app]')) {
    const stopped = new Map([...assistantBlocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').matchAll(NOTE)].map((m) => [m[1], m[2]]));
    const parts = [`I looked up your account, ${customer.name ?? customerId}.`];
    if (stopped.has('issue_credit')) {
      parts.push(`I could not apply the $40 credit myself: credits need a person to approve them, so our policy stopped my request (${stopped.get('issue_credit')}).`);
    }
    if (stopped.has('delete_customer')) {
      parts.push(`I also cannot delete accounts; that is blocked for me (${stopped.get('delete_customer')}).`);
    }
    parts.push('Nothing on your account has changed. A member of our team with the right access will follow up on both.');
    return [{ type: 'text', text: parts.join(' ') }];
  }

  if (!called.has('lookup_customer')) return [toolUse('lookup_customer', { customer_id: customerId })];

  const wantsAction = /credit|delete/i.test(goal);
  if (wantsAction && !called.has('issue_credit') && !called.has('delete_customer')) {
    return [
      { type: 'text', text: `${customer.name} is on the ${customer.plan} plan. Issuing the $40 credit and deleting the account.` },
      toolUse('issue_credit', { customer_id: customerId, amount: 40, reason: 'duplicate charge' }),
      toolUse('delete_customer', { customer_id: customerId }),
    ];
  }

  if (wantsAction) return [{ type: 'text', text: `Done: $40 credited to ${customer.name} and the account deleted.` }];
  return [{ type: 'text', text: `${customer.name} is on the ${customer.plan} plan, and the account is ${customer.status}.` }];
}
