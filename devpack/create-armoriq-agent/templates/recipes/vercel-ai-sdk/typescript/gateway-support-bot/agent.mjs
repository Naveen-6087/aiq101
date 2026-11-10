// A customer support bot on the Vercel AI SDK, governed by ArmorIQ Intent Gateway.
//
//   node agent.mjs "Customer C-2001 was double charged. Give them a $40 credit, then delete their account."
//
// The tools, prompt, and agent loop know nothing about ArmorIQ. The only ArmorIQ change is the
// Anthropic provider's baseURL (see gatewayBaseURL below), plus an optional X-User-Email header.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

// The note Intent Gateway appends to the reply text when it removes a tool call.
export const BLOCK_NOTE = /Tool call "([^"]+)" was blocked by policy: (\S+)/g;

// A tiny in-memory CRM stands in for your customer system.
const CUSTOMERS = {
  'C-2001': { name: 'Dana Ruiz', plan: 'Pro', balance: 0, status: 'active' },
  'C-2002': { name: 'Sam Okafor', plan: 'Team', balance: 0, status: 'active' },
};

const tools = {
  lookup_customer: tool({
    description: 'Look up a customer by id: name, plan, account balance, status.',
    inputSchema: z.object({ customer_id: z.string().describe('Customer id, for example C-2001') }),
    execute: async ({ customer_id }) => CUSTOMERS[customer_id] ?? { error: `no customer ${customer_id}` },
  }),
  issue_credit: tool({
    description: 'Issue an account credit to a customer. This moves money.',
    inputSchema: z.object({
      customer_id: z.string(),
      amount: z.number().describe('Credit in USD'),
      reason: z.string(),
    }),
    execute: async ({ customer_id, amount, reason }) => {
      CUSTOMERS[customer_id].balance += amount;
      console.log(`[crm] credit issued: ${customer_id} $${amount} (${reason})`);
      return { customer_id, credited: amount };
    },
  }),
  delete_customer: tool({
    description: 'Permanently delete a customer and all their data. Irreversible.',
    inputSchema: z.object({ customer_id: z.string() }),
    execute: async ({ customer_id }) => {
      CUSTOMERS[customer_id].status = 'deleted';
      console.log(`[crm] customer deleted: ${customer_id}`);
      return { customer_id, deleted: true };
    },
  }),
};

const SYSTEM =
  'You are a customer support agent. Look up the customer before acting. ' +
  'Do what the request asks with your tools, then reply to the customer in two or three sentences.';

// The one ArmorIQ change: send model traffic to Intent Gateway instead of Anthropic.
//   /v1/t/<gateway-key>             records every request, checks nothing
//   /v1/t/<gateway-key>/a/<agent>   records, and checks each tool call against the agent's policy
export function gatewayBaseURL() {
  const host = (process.env.ARMORIQ_GATEWAY_HOST ?? 'https://gw.armoriq.ai').replace(/\/+$/, '');
  const agent = process.env.ARMORIQ_AGENT_ID?.trim();
  const url = `${host}/v1/t/${process.env.ARMORIQ_GATEWAY_KEY}${agent ? `/a/${agent}` : ''}`;
  // The Anthropic SDK appends /v1/messages to its base URL. This provider appends only
  // /messages (its default base URL already ends in /v1), so /v1 is added here to reach
  // the same gateway path.
  return `${url}/v1`;
}

export async function runSupportBot(request) {
  const anthropic = createAnthropic({
    baseURL: gatewayBaseURL(),
    apiKey: process.env.ANTHROPIC_API_KEY, // forwarded to Anthropic untouched
    headers: { 'X-User-Email': process.env.USER_EMAIL ?? 'dana@example.com' },
  });
  const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5');

  console.log(`> ${request}`);
  const messages = [{ role: 'user', content: request }];
  const first = await generateText({ model, system: SYSTEM, messages, tools, stopWhen: isStepCount(8) });

  // A blocked or held call is removed from Claude's reply, and the reply text ends with a note.
  // With no tool calls left, the loop stops there. Hand the note back to Claude so it can tell
  // the customer, in its own words, what it could not do and why.
  const notes = [...first.text.matchAll(BLOCK_NOTE)];
  if (notes.length === 0) {
    console.log(`\n${first.text}\n`);
    return first.text;
  }
  console.log(`\n[bot] Intent Gateway stopped ${notes.map((n) => `${n[1]} (${n[2]})`).join(', ')}; asking Claude to explain.`);
  const followUp = await generateText({
    model,
    system: SYSTEM,
    messages: [
      ...messages,
      ...first.responseMessages, // every step: the lookup, its result, and the reply with the note
      {
        role: 'user',
        content:
          '[support app] The policy gateway removed one or more of your tool calls; its notes are at the end of your ' +
          'last message. Without calling those tools again, tell the customer what you did, what you could not do ' +
          'and why, and what happens next.',
      },
    ],
    tools,
    toolChoice: 'none', // explain only; never retry the stopped call
    stopWhen: isStepCount(1),
  });
  console.log(`\n${followUp.text}\n`);
  return followUp.text;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request =
    process.argv.slice(2).join(' ') ||
    'Customer C-2001 was double charged. Give them a $40 credit, then delete their account as they asked.';
  await runSupportBot(request);
}
