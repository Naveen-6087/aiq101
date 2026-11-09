// Intent plans: what an agent said it would do, checked against what it then tries.
//
// A host registers a plan (goal + steps, optionally with the IAP-signed intent token for it).
// While a session has a plan, a call to a tool the plan doesn't name is intent drift, and a step
// that pins argument values (exactly, or with a glob for strings) refuses other values. This is
// the argument-level binding a tool-level plan check misses: `read_file(README.md)` in the plan
// does not let `read_file(~/.ssh/id_rsa)` through.

import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalJson } from '@armoriq/policy-ir';
import { matchGlob } from '@armoriq/policy-ir/document';
import { verifyIntentToken } from './keys.js';

export interface PlanStep {
  /** Tool name: bare (`read_file`), qualified (`mcp__fs__read_file`), or a glob (`mcp__github__*`). */
  tool: string;
  /** Argument values the call must have. Strings may be globs (`src/**`). */
  args?: Record<string, unknown>;
}

export interface Plan {
  id: string;
  sessionId: string | null;
  host: string | null;
  goal: string;
  steps: PlanStep[];
  registeredAt: string;
  /** Unix seconds; a plan past this is gone. */
  expiresAt: number | null;
  token: { verified: boolean; reason: string; planHash?: string; planHashMatches?: boolean } | null;
}

export interface PlanCheck {
  ok: boolean;
  reason: string;
  planId?: string;
}

/** Tools a host must always be able to call to declare or inspect a plan. */
export const PLAN_TOOLS = new Set(['register_intent_plan', 'mcp__armord__register_intent_plan', 'mcp__armord-plan__register_intent_plan', 'ExitPlanMode', 'TodoWrite']);

function nameMatches(stepTool: string, tool: string): boolean {
  const bare = (t: string) => (t.startsWith('mcp__') ? t.split('__').slice(2).join('__') : t);
  if (stepTool === tool || bare(stepTool) === bare(tool) || stepTool.toLowerCase() === tool.toLowerCase()) return true;
  return /[*?]/.test(stepTool) && (matchGlob(stepTool, tool) || matchGlob(stepTool, bare(tool)));
}

function valueMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string' && typeof actual === 'string') return /[*?]/.test(expected) ? matchGlob(expected, actual) : expected === actual;
  return canonicalJson(expected) === canonicalJson(actual);
}

export class PlanRegistry {
  private bySession = new Map<string, Plan>();
  private pending = new Map<string, Plan>();
  private next = 1;

  constructor(private readonly trustedIapKey: () => KeyObject | null) {}

  register(input: { sessionId?: string; host?: string; goal?: string; steps: PlanStep[]; intentToken?: unknown; ttlSeconds?: number }): Plan {
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('a plan needs at least one step');
    for (const s of input.steps) if (!s || typeof s.tool !== 'string' || !s.tool) throw new Error('every plan step needs a tool name');
    let token: Plan['token'] = null;
    let expiresAt = input.ttlSeconds ? Date.now() / 1000 + input.ttlSeconds : null;
    if (input.intentToken !== undefined) {
      const v = verifyIntentToken(input.intentToken, this.trustedIapKey());
      if (!v.ok) throw new Error(`intent token refused: ${v.reason}`);
      // The IAP computes plan_hash server side; when it is a plain hash of the step list we can tie the two.
      const local = 'sha256:' + createHash('sha256').update(canonicalJson(input.steps)).digest('hex');
      token = { verified: true, reason: v.reason, planHash: v.planHash as string, planHashMatches: v.planHash === local || v.planHash === local.slice(7) };
      if (v.expiresAt) expiresAt = expiresAt ? Math.min(expiresAt, v.expiresAt) : v.expiresAt;
    }
    const plan: Plan = {
      id: `plan-${this.next++}`,
      sessionId: input.sessionId ?? null,
      host: input.host ?? null,
      goal: input.goal ?? '',
      steps: input.steps,
      registeredAt: new Date().toISOString(),
      expiresAt,
      token,
    };
    if (plan.sessionId) this.bySession.set(plan.sessionId, plan);
    else this.pending.set(plan.host ?? '*', plan);
    return plan;
  }

  /** The session's live plan. A pending plan registered by the same host (no session id known yet) binds to the first session that asks. */
  forSession(sessionId: string | undefined, host: string | undefined): Plan | null {
    const key = host ?? '*';
    if (sessionId) {
      const pending = this.pending.get(key) ?? this.pending.get('*');
      if (pending) {
        this.pending.delete(pending.host ?? '*');
        pending.sessionId = sessionId;
        this.bySession.set(sessionId, pending);
      }
    }
    const plan = (sessionId ? this.bySession.get(sessionId) : undefined) ?? this.pending.get(key) ?? null;
    if (plan?.expiresAt && plan.expiresAt * 1000 < Date.now()) {
      if (plan.sessionId) this.bySession.delete(plan.sessionId);
      return null;
    }
    return plan;
  }

  check(plan: Plan, tool: string, args: Record<string, unknown>): PlanCheck {
    const candidates = plan.steps.filter((s) => nameMatches(s.tool, tool));
    if (candidates.length === 0) return { ok: false, reason: `intent drift: "${tool}" is not in plan ${plan.id}`, planId: plan.id };
    const fits = candidates.find((s) => Object.entries(s.args ?? {}).every(([k, v]) => valueMatches(v, args[k])));
    if (!fits) {
      const pinned = candidates.flatMap((s) => Object.keys(s.args ?? {}));
      return { ok: false, reason: `intent mismatch: "${tool}" arguments differ from plan ${plan.id} (${[...new Set(pinned)].join(', ')})`, planId: plan.id };
    }
    return { ok: true, reason: `in plan ${plan.id}`, planId: plan.id };
  }

  clear(sessionId: string): boolean {
    return this.bySession.delete(sessionId);
  }

  list(): Plan[] {
    return [...this.bySession.values(), ...this.pending.values()];
  }
}
