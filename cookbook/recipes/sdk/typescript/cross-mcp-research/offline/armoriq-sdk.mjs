// Offline stand-in for @armoriq/sdk. It exposes the calls the demo makes (bootstrap, forUser, startSession,
// startPlan, check, report, flushObservability, completePlan) and decides each check from this recipe's own
// policy file: a rule that names the tool wins, otherwise default_action applies. Edit the policy and the
// offline result changes with it.
//
// A held call is resolved on the spot: OFFLINE_APPROVAL=approve (the default) approves it,
// OFFLINE_APPROVAL=reject rejects it. Either way the agent code sees the hold decision, as it does live.

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const POLICY_FILES = ['../policy.filesystem.yaml','../policy.memory.yaml'];

const policies = POLICY_FILES.map((file) => yaml.load(readFileSync(new URL(file, import.meta.url), 'utf8')));
const approval = process.env.OFFLINE_APPROVAL === 'reject' ? 'reject' : 'approve';

function normalize(action) {
  if (action === 'allow_log') return 'allow';
  if (action === 'deny') return 'block';
  return action;
}

function splitName(toolName) {
  const idx = toolName.indexOf('__');
  return idx === -1 ? { mcp: null, action: toolName } : { mcp: toolName.slice(0, idx), action: toolName.slice(idx + 2) };
}

function policyFor(mcp) {
  if (policies.length === 1) return policies[0];
  return policies.find((policy) => policy.scope?.target === mcp);
}

function decide(toolName) {
  const { mcp, action } = splitName(toolName);
  const policy = policyFor(mcp);
  if (!policy) return { action: 'block', reason: `no policy for server ${mcp}`, policy: 'none' };
  const rule = (policy.rules ?? []).find((r) => r.tool === action);
  const decided = normalize(rule ? rule.action : policy.default_action);
  const matched = rule ? action : 'default_action';
  return { action: decided, reason: `policy ${policy.name}: ${matched} -> ${decided}`, policy: policy.name };
}

class OfflineSession {
  holds = 0;

  async startPlan(toolCalls, goal) {
    console.log(`[armoriq] plan: ${goal} -> ${toolCalls.map((c) => c.name).join(', ')}`);
    return { planId: 'offline-plan' };
  }

  async check(toolName, args = {}) {
    const decision = decide(toolName);
    const label = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' }[decision.action] ?? 'BLOCKED';
    console.log(`[armoriq] check ${toolName}: ${label} (${decision.reason})`);
    console.log(`[armoriq] args ${toolName}: ${JSON.stringify(args).slice(0, 400)}`);
    const result = { allowed: decision.action === 'allow', action: decision.action, reason: decision.reason, matchedPolicy: decision.policy };
    if (decision.action === 'hold') {
      console.log(`[armoriq] hold ${toolName}: ${approval === 'reject' ? 'REJECTED' : 'APPROVED'}`);
      result.delegationId = `offline-delegation-${++this.holds}`;
    }
    return result;
  }

  async report(toolName, args, result, opts = {}) {
    console.log(`[armoriq] report ${toolName}: ${opts.status ?? 'success'}`);
  }

  async flushObservability() {}

  async close() {}
}

export class ArmorIQClient {
  constructor() {}

  async bootstrap() {}

  forUser() {
    return { startSession: () => new OfflineSession() };
  }

  async completePlan() {}
}
