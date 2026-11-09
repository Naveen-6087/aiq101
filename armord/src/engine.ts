// The decision engine: one call in, one verdict out, evaluated in memory with the official
// @armoriq/policy-ir evaluator. No network on the decision path.
//
// Order of checks, strictest result wins:
//   1. self-protection   armord's own files, keys and the hosts' hook configs (built in)
//   2. remote bundle     the agent's document from the control plane, exactly as the SDK's
//                        local decision does it (unavailable/stale/unresolved/inactive -> block)
//   3. local documents   every armor.io/v2 file in the policy dir
//   4. intent plan       when the session registered one: drift and argument binding

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { evaluate, stricter } from '@armoriq/policy-ir';
import type { Approval, CallInput, Evaluation, Obligation, PolicyDocument, Principal, Verdict } from '@armoriq/policy-ir';
import { matchGlob } from '@armoriq/policy-ir/document';
import { deriveCall, normalizePath, type DerivedCall, type RawCall } from './derive.js';
import { PLAN_TOOLS, type PlanRegistry } from './plans.js';
import type { PolicyStore } from './store.js';

export interface DecideRequest extends RawCall {
  host?: string;
  member?: Principal;
  /** Live input-schema hash of the tool, when the caller knows it (MCP proxy does). */
  schemaHash?: string | null;
  sessionId?: string;
}

export interface Decision {
  id: string;
  verdict: Verdict;
  reason: string;
  policyId: string | null;
  statementId: string | null;
  ruleKey: string | null;
  layer: string | null;
  approval: Approval | null;
  obligations: Obligation[];
  policySetHash: string;
  latencyUs: number;
  tool: string;
  capabilities: string[];
  derived: Record<string, unknown>;
  planId?: string;
}

export interface EngineOptions {
  /** Verdict when no policy source is configured at all. Default block (fail closed). */
  noPolicy?: Verdict;
  /** Apply a document's `defaults.network` / `defaults.files` to calls no network/files statement decided. Default true. */
  capabilityDefaults?: boolean;
  /** Verdict floor for a call whose tool schema drifted from the one the policy was compiled against. Default hold. */
  onSchemaDrift?: Verdict;
  /** Remote bundle stale: block (SDK behaviour, default) or keep using the last known document. */
  onStale?: 'block' | 'last-known';
  /** Built-in protection of armord's files and the hosts' hook configs. Default true. */
  selfProtect?: boolean;
  /** armord's home directory, protected by selfProtect. */
  home?: string;
  /** Verdict for a call outside the session's plan. Default block. */
  onPlanDrift?: Verdict;
  /** Block calls from sessions that never registered a plan. Default false. */
  requirePlan?: boolean;
}

interface Candidate {
  verdict: Verdict;
  reason: string;
  ev?: Evaluation;
  doc?: PolicyDocument | null;
  planId?: string;
}

const CAPABILITY_DEFAULTS: Array<'network' | 'files'> = ['network', 'files'];

/** Hook and MCP configs an agent could edit to switch enforcement off. Writes are held. */
const HOST_CONFIGS = ['**/.claude/settings.json', '**/.claude/settings.local.json', '**/.cursor/hooks.json', '**/.codex/hooks.json', '**/.codex/config.toml', '**/.gemini/settings.json', '**/.mcp.json', '**/claude_desktop_config.json', '**/.cursor/mcp.json'];

export class Engine {
  constructor(
    private readonly store: PolicyStore,
    private readonly options: EngineOptions = {},
    private readonly plans?: PlanRegistry,
  ) {}

  decide(req: DecideRequest): Decision {
    const start = process.hrtime.bigint();
    const call = deriveCall(req);
    const candidates: Candidate[] = [];

    const guard = this.options.selfProtect === false ? null : this.selfProtect(call);
    if (guard) candidates.push(guard);

    if (!this.store.hasPolicy()) {
      const v = this.options.noPolicy ?? 'block';
      candidates.push({ verdict: v, reason: `no policy loaded; armord fails ${v === 'allow' ? 'open' : 'closed'}` });
    }
    if (this.store.remoteConfigured()) candidates.push(this.remote(req, call));
    for (const doc of this.store.localDocuments()) candidates.push(this.evaluateDoc(this.inputs(req, call, []), doc));

    const plan = this.planCandidate(req, call);
    if (plan) candidates.push(plan);

    let winner = candidates[0] as Candidate;
    for (const c of candidates.slice(1)) if (stricter(c.verdict, winner.verdict) === c.verdict && c.verdict !== winner.verdict) winner = c;
    const ev = winner.ev;
    const d: Decision = {
      id: randomUUID(),
      verdict: winner.verdict,
      reason: winner.reason,
      policyId: ev?.provenance.policyId ?? null,
      statementId: ev?.provenance.statementId ?? null,
      ruleKey: ev?.provenance.ruleKey ?? null,
      layer: ev?.provenance.layer ?? null,
      approval: winner.verdict === 'hold' ? (ev?.approval ?? winner.doc?.defaults.approval ?? null) : null,
      obligations: ev?.obligations ?? [],
      policySetHash: this.store.policySetHash(),
      latencyUs: 0,
      tool: call.tool,
      capabilities: call.capabilities,
      derived: call.derived,
    };
    const planId = winner.planId ?? plan?.planId;
    if (planId) d.planId = planId;
    d.latencyUs = Number((process.hrtime.bigint() - start) / 1000n);
    return d;
  }

  /** CallInputs for one call: one base input, plus one per env var it reads (so `secrets` sees each). */
  private inputs(req: DecideRequest, call: DerivedCall, extra: Array<{ capabilities?: string[]; schemaHash?: string | null }>): CallInput[] {
    const base: CallInput = { tool: call.tool, arguments: call.arguments, derived: call.derived, capabilities: call.capabilities, timestamp: new Date().toISOString() };
    if (call.qualifiedName) {
      base.qualifiedName = call.qualifiedName;
      // The evaluator matches a rule key against the bare name or the qualified one, so a call that
      // arrives as `mcp__notes__delete_note` must carry `delete_note` as its tool name.
      const parts = call.tool.split('__');
      if (parts.length >= 3 && parts[0] === 'mcp') base.tool = parts.slice(2).join('__');
    }
    if (req.member) base.member = req.member;
    if (req.schemaHash !== undefined) base.schemaHash = req.schemaHash;
    const variants = extra.length
      ? extra.map((t) => ({ ...base, capabilities: [...new Set([...(base.capabilities ?? []), ...(t.capabilities ?? [])])], ...(base.schemaHash === undefined && t.schemaHash !== undefined ? { schemaHash: t.schemaHash } : {}) }))
      : [base];
    // The evaluator reads one `path`, so every other path the call touches gets its own input:
    // each written/deleted path (file.write), and each path a shell command reads (file.read).
    const d = call.derived;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const pathInputs = (v: CallInput): CallInput[] => {
      const seen = new Set<string>(typeof d.path === 'string' ? [d.path] : []);
      const out: CallInput[] = [];
      const add = (p: string, caps: string[]) => {
        if (seen.has(p)) return;
        seen.add(p);
        out.push({ ...v, derived: { ...v.derived, path: p }, capabilities: [...new Set([...(v.capabilities ?? []), 'files', ...caps])] });
      };
      for (const p of [...strings(d.paths), ...strings(d.writes)]) add(p, ['file.write']);
      for (const p of strings(d.deletes)) add(p, ['file.delete']);
      for (const p of strings(d.reads)) add(p, ['file.read']);
      return out;
    };
    return variants.flatMap((v) => [v, ...pathInputs(v), ...call.envVars.map((env) => ({ ...v, derived: { ...v.derived, env }, capabilities: [...(v.capabilities ?? []), 'secrets'] }))]);
  }

  /** The SDK's decide_locally, plus armord's derived fields and capabilities. */
  private remote(req: DecideRequest, call: DerivedCall): Candidate {
    const status = this.store.remoteStatus();
    const doc = this.store.remoteDocument();
    if (status === 'unavailable') return { verdict: 'block', reason: 'policy-bundle-unavailable: no bundle fetched yet' };
    if (status === 'stale' && !(this.options.onStale === 'last-known' && doc)) return { verdict: 'block', reason: 'policy-bundle-stale: not confirmed by the control plane in the last 5 minutes' };
    const agent = this.store.remoteAgent();
    if (!agent) return { verdict: 'block', reason: 'agent_unresolved: the bundle has no agent with this id or name' };
    if (!doc) return agent.inactive ? { verdict: 'block', reason: 'agent_inactive' } : { verdict: 'allow', reason: 'no_active_policy for this agent' };
    const member = req.member?.email && !req.member.membershipId ? { ...req.member, ...(this.store.memberId(req.member.email) ? { membershipId: this.store.memberId(req.member.email) as string } : {}) } : req.member;
    const known = this.store.bundleTools(call.tool, req.mcpServer);
    const r = member ? { ...req, member } : req;
    return this.evaluateDoc(this.inputs(r, call, known.map((t) => ({ capabilities: t.capabilities ?? [], schemaHash: t.schemaHash ?? null }))), doc);
  }

  private evaluateDoc(inputs: CallInput[], doc: PolicyDocument): Candidate {
    let best: Candidate | null = null;
    for (const input of inputs) {
      const ev = evaluate(input, { agent: doc });
      let verdict = ev.verdict;
      let note: string | undefined;
      if (this.options.capabilityDefaults ?? true) {
        for (const cap of CAPABILITY_DEFAULTS) {
          if (!input.capabilities?.includes(cap) || ev.provenance.ruleKey === cap) continue;
          // Only when the author wrote that section: a document with no network statements says nothing about the network.
          if (!doc.statements.some((s) => 'capability' in s.match && s.match.capability === cap)) continue;
          const d = doc.defaults[cap];
          if (stricter(d, verdict) === d && d !== verdict) {
            verdict = d;
            note = `${cap}.default`;
          }
        }
      }
      if (ev.obligations.some((o) => o.type === 'schema_drift')) {
        const floor = this.options.onSchemaDrift ?? 'hold';
        if (stricter(floor, verdict) === floor && floor !== verdict) {
          verdict = floor;
          note = 'tool schema changed since the policy was compiled';
        }
      }
      const p = ev.provenance;
      const where = p.statementId ? `${p.policyId}#${p.statementId}` : `${p.policyId} ${p.ruleKey}`;
      const c: Candidate = { verdict, reason: `${verdict} by ${where} (${p.layer} layer${note ? `, ${note}` : ''})`, ev, doc };
      if (!best || (stricter(c.verdict, best.verdict) === c.verdict && c.verdict !== best.verdict)) best = c;
    }
    return best as Candidate;
  }

  private planCandidate(req: DecideRequest, call: DerivedCall): Candidate | null {
    if (!this.plans || PLAN_TOOLS.has(call.tool)) return null;
    const plan = this.plans.forSession(req.sessionId, req.host);
    if (!plan) return this.options.requirePlan ? { verdict: 'block', reason: 'no intent plan registered for this session (requirePlan)' } : null;
    const check = this.plans.check(plan, call.qualifiedName ?? call.tool, call.arguments);
    if (check.ok) return { verdict: 'allow', reason: check.reason, planId: plan.id };
    return { verdict: this.options.onPlanDrift ?? 'block', reason: check.reason, planId: plan.id };
  }

  /** Built-in floor no policy can loosen: armord's own state, signing keys, and enforcement configs. */
  private selfProtect(call: DerivedCall): Candidate | null {
    const home = normalizePath(this.options.home ?? `${homedir()}/.armoriq/armord`, process.cwd());
    const creds = normalizePath(`${homedir()}/.armoriq/credentials.json`, process.cwd());
    const d = call.derived;
    const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const reads = list(d.reads);
    for (const p of reads) if (under(p, `${home}/keys`) || p === creds) return { verdict: 'block', reason: `self-protection: ${p} holds signing keys or credentials` };
    const paths = [d.path, ...list(d.paths), ...list(d.writes), ...list(d.deletes)].filter((p): p is string => typeof p === 'string');
    const writes = call.capabilities.includes('file.write') || call.capabilities.includes('file.delete') || d.writeRedirection === true || call.capabilities.includes('destructive');
    for (const p of paths) {
      if (under(p, `${home}/keys`) || p === creds) return { verdict: 'block', reason: `self-protection: ${p} holds signing keys or credentials` };
      if (writes && under(p, home)) return { verdict: 'block', reason: `self-protection: agents may not change armord's state (${p})` };
      if (writes && HOST_CONFIGS.some((g) => matchGlob(g, p))) return { verdict: 'hold', reason: `self-protection: ${p} configures the enforcement hooks; a human must approve changes` };
    }
    const command = typeof d.command === 'string' ? d.command : '';
    if (command) {
      const homeRaw = home.replace(/^~\//, '');
      const touchesHome = command.includes('.armoriq') || command.includes(homeRaw);
      if (touchesHome && (writes || /\b(rm|del|rmdir|mv|move|cp|copy|tee|sed\s+-i|truncate|chmod|Remove-Item|Set-Content|Out-File)\b/i.test(command))) {
        return { verdict: 'block', reason: "self-protection: shell command changes armord's state" };
      }
      if (/\b(kill|pkill|killall|taskkill|Stop-Process)\b/i.test(command) && /armord|cli\.js\s+start/i.test(command)) return { verdict: 'block', reason: 'self-protection: shell command stops armord' };
      if (/\bkeys[\\/][^\s]*private/i.test(command)) return { verdict: 'block', reason: 'self-protection: shell command reads a signing key' };
    }
    return null;
  }
}
