// Offline stand-in for @armoriq/sdk. It offers the calls this agent makes (ArmorIQClient,
// forUser().startSession(), startPlan, check, awaitApproval, report, flushObservability, close)
// and decides every check from this recipe's own policy.yaml: the rule whose `tool` matches the
// action name wins, and anything without a rule gets `default_action`. Edit policy.yaml and the
// offline run changes with it.
//
// Like the real session, check() blocks a tool that is not in the captured plan, and a held call
// returns a delegationId for awaitApproval(). The approval is granted after a short pause, or
// rejected when OFFLINE_APPROVAL=reject. That stands in for a person deciding in the ArmorIQ console.

import { readFileSync } from 'node:fs';

// Reads the small subset of YAML that policy.yaml uses: name, default_action, and a rules list
// of `- tool:` / `action:` pairs. No YAML dependency needed.
function loadPolicy(file) {
  const policy = { name: 'policy', default_action: 'block', rules: [] };
  let rule = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^name:\s*(\S+)/))) policy.name = m[1];
    else if ((m = line.match(/^default_action:\s*(\S+)/))) policy.default_action = m[1];
    else if ((m = line.match(/^\s*-\s*tool:\s*(\S+)/))) policy.rules.push((rule = { tool: m[1] }));
    else if (rule && (m = line.match(/^\s+action:\s*(\S+)/))) rule.action = m[1];
  }
  return policy;
}

const policy = loadPolicy(new URL('../policy.yaml', import.meta.url));
const WORDS = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' };

const bareName = (tool) => (tool.includes('__') ? tool.split('__').slice(1).join('__') : tool);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decide(tool) {
  const name = bareName(tool);
  const rule = policy.rules.find((r) => r.tool === name);
  const action = rule?.action ?? policy.default_action;
  const normalized = action === 'allow' || action === 'hold' ? action : 'block';
  const reason = rule
    ? `policy ${policy.name}: ${name} -> ${normalized}`
    : `policy ${policy.name}: no rule for ${name}, default_action -> ${normalized}`;
  return { action: normalized, reason };
}

class OfflineSession {
  held = new Map();
  planKey = null;
  declared = new Set();

  constructor(userEmail) {
    this.userEmail = userEmail;
  }

  // Real SDK: capturePlan + getIntentToken on the first call, a reanchor when the plan grows,
  // and the cached token when the plan is unchanged.
  async startPlan(toolCalls, goal) {
    const key = JSON.stringify(toolCalls);
    if (key !== this.planKey) {
      this.planKey = key;
      this.declared = new Set(toolCalls.map((c) => c.name));
      console.log(`[armoriq] plan: ${goal} -> ${toolCalls.map((c) => c.name).join(', ')}`);
    }
    return { planId: 'offline-plan', tokenId: 'offline-token' };
  }

  async check(tool, args = {}) {
    let { action, reason } = decide(tool);
    if (!this.declared.has(tool)) {
      action = 'block';
      reason = `tool-not-in-plan: '${tool}' was not declared in the captured plan`;
    }
    console.log(`[armoriq] check ${tool}: ${WORDS[action]} (${reason})`);
    if (action !== 'allow') console.log(`[armoriq] args ${tool}: ${JSON.stringify(args)}`);
    const decision = { allowed: action === 'allow', action, reason, matchedPolicy: policy.name };
    if (action === 'hold') {
      decision.delegationId = `offline-delegation-${this.held.size + 1}`;
      this.held.set(decision.delegationId, tool);
    }
    return decision;
  }

  async awaitApproval(delegationId) {
    const tool = this.held.get(delegationId) ?? delegationId;
    await pause(300);
    const outcome = process.env.OFFLINE_APPROVAL === 'reject' ? 'rejected' : 'approved';
    console.log(`[armoriq] hold ${tool}: ${outcome.toUpperCase()}`);
    return outcome;
  }

  async report(tool, args, result, opts = {}) {
    console.log(`[armoriq] report ${tool}: ${opts.status ?? 'success'}`);
  }

  async flushObservability() {}

  async close() {}
}

export class ArmorIQClient {
  constructor(options = {}) {
    this.options = options;
  }

  forUser(userEmail) {
    return { userEmail, startSession: () => new OfflineSession(userEmail) };
  }

  close() {}
}
