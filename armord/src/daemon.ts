// armord: store + engine + holds + audit, behind one async `decide`. Front doors (the IPC
// server, hook adapters, the MCP proxy) all call this, so every host gets the same verdict
// from the same policy.

import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InventoryTool } from '@armoriq/policy-ir';
import { loadPublicKey, loadTrustedKeys } from './keys.js';
import { PlanRegistry } from './plans.js';
import { credentialsApiKey } from './service.js';
import { AuditLog } from './audit.js';
import { Engine, type DecideRequest, type Decision, type EngineOptions } from './engine.js';
import { HoldQueue, type HoldOutcome } from './holds.js';
import { PolicyStore, type RemoteOptions } from './store.js';

export interface ArmordConfig {
  home: string;
  policyDir: string;
  auditFile: string | null;
  remote?: RemoteOptions;
  engine?: EngineOptions;
  /** How long a held call waits for a human before it is rejected. */
  holdTimeoutMs: number;
  /** How often to refetch the remote bundle. */
  refreshMs: number;
  /** Only load local policy files that carry a valid `.sig` from a trusted key. */
  requireSigned: boolean;
  /** Trusted Ed25519 public keys (`*.pub` / `*.pem` / `*.jwk`). */
  trustedKeysDir: string;
  /** Where `armord keygen` writes private signing keys (owner-only). */
  keysDir: string;
  /** Control plane, for the IAP public key even when no remote bundle is configured. */
  endpoint: string;
}

export interface DecideOptions {
  /** Wait for a human on a hold. Hosts with their own approval UI (Claude Code "ask") pass false. */
  waitOnHold?: boolean;
  holdTimeoutMs?: number;
}

export interface DecisionResult extends Decision {
  holdId?: string;
  holdOutcome?: HoldOutcome;
  /** The verdict the caller should act on: a hold resolves to allow (approved) or block. */
  final: 'allow' | 'block' | 'hold';
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ArmordConfig {
  const home = env.ARMORD_HOME ?? join(homedir(), '.armoriq', 'armord');
  const config: ArmordConfig = {
    home,
    policyDir: env.ARMORD_POLICY_DIR ?? join(home, 'policies'),
    auditFile: env.ARMORD_AUDIT === 'off' ? null : (env.ARMORD_AUDIT ?? join(home, 'audit.jsonl')),
    holdTimeoutMs: Number(env.ARMORD_HOLD_TIMEOUT_MS ?? 120_000),
    refreshMs: Number(env.ARMORD_REFRESH_MS ?? 60_000),
    requireSigned: env.ARMORD_REQUIRE_SIGNED === '1',
    trustedKeysDir: env.ARMORD_TRUSTED_KEYS ?? join(home, 'trusted_keys'),
    keysDir: join(home, 'keys'),
    endpoint: env.ARMORIQ_BACKEND_ENDPOINT ?? 'https://api.armoriq.ai',
    engine: {
      noPolicy: (env.ARMORD_NO_POLICY as 'allow' | 'hold' | 'block' | undefined) ?? 'block',
      onStale: env.ARMORD_ON_STALE === 'last-known' ? 'last-known' : 'block',
      selfProtect: env.ARMORD_SELF_PROTECT !== 'off',
      home,
      onPlanDrift: (env.ARMORD_PLAN_DRIFT as 'hold' | 'block' | undefined) ?? 'block',
      requirePlan: env.ARMORD_REQUIRE_PLAN === '1',
    },
  };
  // API key: ARMORIQ_API_KEY, else the `armoriq login` profile (so service files never hold a key).
  const login = env.ARMORIQ_API_KEY ? null : credentialsApiKey(env);
  const apiKey = env.ARMORIQ_API_KEY ?? login?.apiKey;
  if (!env.ARMORIQ_BACKEND_ENDPOINT && login) config.endpoint = login.backend;
  if (apiKey && env.ARMORD_AGENT_ID) {
    config.remote = {
      endpoint: config.endpoint,
      apiKey,
      agentId: env.ARMORD_AGENT_ID,
      cacheDir: join(home, 'cache'),
      staleSeconds: Number(env.ARMORD_BUNDLE_STALE_S ?? 300),
      requireSigned: env.ARMORD_REQUIRE_SIGNED_BUNDLE === '1',
    };
  }
  return config;
}

export class Armord {
  readonly store: PolicyStore;
  readonly engine: Engine;
  readonly holds = new HoldQueue();
  readonly plans: PlanRegistry;
  private iapKey: KeyObject | null = null;
  readonly audit: AuditLog;
  readonly startedAt = new Date().toISOString();
  private counts = { allow: 0, hold: 0, block: 0 };
  private latencies: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly config: ArmordConfig) {
    const trustedKeys = loadTrustedKeys(config.trustedKeysDir);
    const storeOptions: ConstructorParameters<typeof PolicyStore>[0] = { dir: config.policyDir, requireSigned: config.requireSigned, trustedKeys };
    if (config.remote) storeOptions.remote = config.remote;
    this.store = new PolicyStore(storeOptions);
    this.plans = new PlanRegistry(() => this.iapPublicKey());
    this.engine = new Engine(this.store, config.engine, this.plans);
    this.audit = new AuditLog(config.auditFile);
  }

  /** Load local policy and the cached remote bundle, then refresh the remote one in the background. */
  /** The trusted IAP key: ARMORIQ_IAP_PUBLIC_KEY, else the copy fetched from the control plane. */
  iapPublicKey(): KeyObject | null {
    if (this.iapKey) return this.iapKey;
    const configured = process.env.ARMORIQ_IAP_PUBLIC_KEY;
    if (configured) return (this.iapKey = loadPublicKey(configured));
    const cached = join(this.config.home, 'iap-public-key.json');
    if (existsSync(cached)) this.iapKey = loadPublicKey(JSON.parse(readFileSync(cached, 'utf8')));
    return this.iapKey;
  }

  /** Fetch GET /iap/public-key once and keep it (it needs no API key). Best effort. */
  async fetchIapPublicKey(fetchImpl: typeof fetch = fetch): Promise<void> {
    if (process.env.ARMORIQ_IAP_PUBLIC_KEY || this.iapPublicKey()) return;
    try {
      const res = await fetchImpl(`${this.config.endpoint.replace(/\/$/, '')}/iap/public-key`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      const key = loadPublicKey(body);
      if (!key) return;
      this.iapKey = key;
      mkdirSync(this.config.home, { recursive: true });
      writeFileSync(join(this.config.home, 'iap-public-key.json'), JSON.stringify(body));
    } catch {
      // offline: plans with tokens are refused until the key is known
    }
  }

  async start(): Promise<void> {
    this.store.loadLocal();
    if (process.env.ARMORD_OFFLINE !== '1') await this.fetchIapPublicKey();
    if (this.config.remote) {
      this.store.loadRemoteCache();
      await this.store.refreshRemote();
      this.timer = setInterval(() => void this.store.refreshRemote(), this.config.refreshMs);
      this.timer.unref();
    }
    this.audit.append('start', { policySetHash: this.store.policySetHash(), problems: this.store.problems.length });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  reload(): void {
    this.store.loadLocal();
    this.audit.append('reload', { policySetHash: this.store.policySetHash() });
  }

  setInventory(tools: InventoryTool[]): void {
    this.store.setInventory(tools);
  }

  async decide(req: DecideRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const d = this.engine.decide(req);
    this.counts[d.verdict]++;
    this.latencies.push(d.latencyUs);
    if (this.latencies.length > 5000) this.latencies.splice(0, 1000);
    const result: DecisionResult = { ...d, final: d.verdict };
    if (d.verdict === 'hold' && opts.waitOnHold) {
      const hold = this.holds.create(d, req.host ?? 'unknown', req.arguments ?? {});
      result.holdId = hold.id;
      this.audit.append('hold', { holdId: hold.id, tool: d.tool, host: req.host, reason: d.reason });
      result.holdOutcome = await this.holds.wait(hold.id, opts.holdTimeoutMs ?? this.config.holdTimeoutMs);
      result.final = result.holdOutcome === 'approved' ? 'allow' : 'block';
    }
    this.audit.append('decision', {
      decisionId: d.id,
      host: req.host ?? null,
      session: req.sessionId ?? null,
      tool: d.tool,
      verdict: d.verdict,
      final: result.final,
      holdOutcome: result.holdOutcome ?? null,
      reason: d.reason,
      statementId: d.statementId,
      planId: d.planId ?? null,
      policySetHash: d.policySetHash,
      capabilities: d.capabilities,
      derived: d.derived,
      latencyUs: d.latencyUs,
    });
    return result;
  }

  status(): Record<string, unknown> {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    return {
      startedAt: this.startedAt,
      policySetHash: this.store.policySetHash(),
      localPolicies: this.store.localDocuments().map((d) => ({ policyId: d.policyId, statements: d.statements.length, policyHash: d.policyHash ?? null })),
      remote: this.config.remote
        ? { agentId: this.config.remote.agentId, status: this.store.remoteStatus(), fetchedAt: this.store.remoteFetchedAt, fromCache: this.store.remoteFromCache, error: this.store.remoteError, policyId: this.store.remoteDocument()?.policyId ?? null, agentFound: !!this.store.remoteAgent() }
        : null,
      problems: this.store.problems,
      inventoryTools: this.store.getInventory().length,
      decisions: this.counts,
      latencyUs: { p50: pct(50), p99: pct(99), samples: sorted.length },
      pendingHolds: this.holds.list().length,
      holdTimeoutMs: this.config.holdTimeoutMs,
      plans: this.plans.list().map((p) => ({ id: p.id, sessionId: p.sessionId, host: p.host, steps: p.steps.length, tokenVerified: p.token?.verified ?? false })),
      requireSigned: this.config.requireSigned,
      iapPublicKey: this.iapKey ? 'pinned' : 'unknown',
    };
  }
}
