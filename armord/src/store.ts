// Policy store: the armor.io/v2 documents armord evaluates, held in memory.
//
// Two sources, merged at decision time (the stricter verdict wins):
//   local   armor.io/v2 YAML sources (compiled here, against the live tool inventory when one is
//           known) and compiled armor.policy.v2 JSON documents, from a directory. With
//           requireSigned, a file loads only with a `<file>.sig` from a trusted key.
//   remote  the agent's entry from the control plane's policy bundle, fetched exactly as the
//           Python SDK's PolicyBundleCache does (GET /policy/bundles/current?agent=<id>, ETag,
//           60 s revalidation, stale after 300 s), cached on disk for restarts.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { compile, verifyPolicyHash } from '@armoriq/policy-ir';
import type { InventoryTool, PolicyDocument } from '@armoriq/policy-ir';
import { parseYaml } from '@armoriq/policy-ir/document';
import { loadPublicKey, verifyDetached } from './keys.js';

export interface PolicyProblem {
  file: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface RemoteOptions {
  endpoint: string;
  apiKey: string;
  agentId: string;
  cacheDir: string;
  /** Seconds after the last confirmed fetch before the bundle counts as stale (SDK: 300). */
  staleSeconds?: number;
  /** Refuse a bundle response that lacks a valid `x-armoriq-bundle-signature`. */
  requireSigned?: boolean;
  fetchImpl?: typeof fetch;
}

/** One tool the bundle's inventory knows about (SDK local_decision `tools`). */
export interface BundleTool {
  name: string;
  qualifiedName?: string;
  server?: string;
  schemaHash?: string | null;
  capabilities?: string[];
}

export interface BundleAgent {
  agentId?: string;
  name?: string;
  inactive?: boolean;
  policy?: { name?: string; policyId?: string; document?: PolicyDocument } | null;
  tools?: BundleTool[];
  members?: Array<{ email?: string; membershipId?: string }>;
}

export type RemoteStatus = 'disabled' | 'unavailable' | 'stale' | 'current';

interface LocalSource {
  file: string;
  kind: 'yaml' | 'json';
  text: string;
  signature?: string;
}

export const SIGNATURE_HEADER = 'x-armoriq-bundle-signature';

export class PolicyStore {
  private localSources: LocalSource[] = [];
  private local: PolicyDocument[] = [];
  private agent: BundleAgent | null = null;
  private remoteDoc: PolicyDocument | null = null;
  private etag = '';
  private confirmedAt = 0;
  private inventory: InventoryTool[] = [];
  problems: PolicyProblem[] = [];
  remoteFetchedAt: string | null = null;
  remoteError: string | null = null;
  remoteFromCache = false;

  constructor(
    private readonly options: { dir?: string; remote?: RemoteOptions; requireSigned?: boolean; trustedKeys?: KeyObject[] } = {},
  ) {}

  /** Read every policy file in the local directory and compile it. */
  loadLocal(): void {
    this.localSources = [];
    const dir = this.options.dir;
    if (dir && existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        const kind = /\.ya?ml$/i.test(name) ? 'yaml' : /\.json$/i.test(name) ? 'json' : null;
        if (!kind) continue;
        const file = join(dir, name);
        const src: LocalSource = { file, kind, text: readFileSync(file, 'utf8') };
        if (existsSync(`${file}.sig`)) src.signature = readFileSync(`${file}.sig`, 'utf8');
        this.localSources.push(src);
      }
    }
    this.compileLocal();
  }

  /** Add an in-memory source (tests, `armord policy check`). Signed when `signature` is given. */
  addSource(file: string, text: string, signature?: string): void {
    const src: LocalSource = { file, kind: /\.json$/i.test(file) ? 'json' : 'yaml', text };
    if (signature !== undefined) src.signature = signature;
    this.localSources.push(src);
    this.compileLocal();
  }

  /** The tools the agent can reach. Recompiles local YAML so exact keys bind to real schemas. */
  setInventory(tools: InventoryTool[]): void {
    this.inventory = tools;
    this.compileLocal();
  }

  getInventory(): InventoryTool[] {
    return this.inventory;
  }

  private compileLocal(): void {
    const docs: PolicyDocument[] = [];
    const problems: PolicyProblem[] = this.problems.filter((p) => p.file === 'remote');
    const trusted = this.options.trustedKeys ?? [];
    for (const src of this.localSources) {
      if (this.options.requireSigned && !verifyDetached(src.text, src.signature, trusted)) {
        problems.push({ file: src.file, severity: 'error', code: 'unsigned_policy', message: src.signature ? 'signature does not verify against any trusted key; not loaded' : 'no .sig file and signed policies are required; not loaded' });
        continue;
      }
      if (src.kind === 'json') {
        const doc = parseCompiled(src, problems);
        if (doc) docs.push(doc);
        continue;
      }
      const parsed = parseYaml(src.text);
      for (const d of parsed.diagnostics.items) problems.push({ file: src.file, severity: d.severity as 'error' | 'warning', code: d.code, message: `${d.path} ${d.message}` });
      if (!parsed.source) continue;
      const result = compile(parsed.source, this.inventory, { policyId: `local:${parsed.source.metadata.name}` });
      for (const d of result.diagnostics.items) problems.push({ file: src.file, severity: d.severity as 'error' | 'warning', code: d.code, message: `${d.path} ${d.message}` });
      if (result.document && !result.diagnostics.hasErrors) docs.push(result.document);
    }
    this.local = docs;
    this.problems = problems;
  }

  localDocuments(): PolicyDocument[] {
    return this.local;
  }

  remoteConfigured(): boolean {
    return !!this.options.remote;
  }

  /** SDK BundleState: unavailable before the first good fetch, stale once unconfirmed for staleSeconds. */
  remoteStatus(now = Date.now()): RemoteStatus {
    const r = this.options.remote;
    if (!r) return 'disabled';
    if (this.confirmedAt === 0) return 'unavailable';
    return now - this.confirmedAt >= (r.staleSeconds ?? 300) * 1000 ? 'stale' : 'current';
  }

  remoteAgent(): BundleAgent | null {
    return this.agent;
  }

  remoteDocument(): PolicyDocument | null {
    return this.remoteDoc;
  }

  /** The bundle inventory entries for a call, preferring the named MCP server's own tool (SDK `_candidate_tools`). */
  bundleTools(tool: string, mcpServer?: string): BundleTool[] {
    const tools = this.agent?.tools ?? [];
    const named = tools.filter((t) => t.name === tool || t.qualifiedName === tool);
    const owned = mcpServer ? named.filter((t) => t.server === mcpServer) : [];
    return owned.length ? owned : named;
  }

  memberId(email: string): string | undefined {
    const wanted = email.trim().toLowerCase();
    return this.agent?.members?.find((m) => m.email === wanted)?.membershipId;
  }

  hasPolicy(): boolean {
    return this.local.length > 0 || this.options.remote !== undefined;
  }

  /** Hash over every active document's policyHash, so a decision names the exact policy set. */
  policySetHash(): string {
    const parts = [this.remoteDoc, ...this.local].filter((d): d is PolicyDocument => !!d).map((d) => `${d.policyId}:${d.policyHash ?? 'unhashed'}`);
    return 'sha256:' + createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  /** Load the last bundle saved to disk. Its confirmation time is the time it was fetched. */
  loadRemoteCache(): boolean {
    const r = this.options.remote;
    if (!r) return false;
    const file = cacheFile(r);
    if (!existsSync(file)) return false;
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; etag?: string; body: unknown };
      if (!this.accept(cached.body, r)) return false;
      this.etag = cached.etag ?? '';
      this.confirmedAt = Date.parse(cached.fetchedAt);
      this.remoteFetchedAt = cached.fetchedAt;
      this.remoteFromCache = true;
      return true;
    } catch (err) {
      this.remoteError = `cache unreadable: ${(err as Error).message}`;
      return false;
    }
  }

  /** Fetch or revalidate the bundle. On any failure the last good bundle stays (until it goes stale). */
  async refreshRemote(): Promise<void> {
    const r = this.options.remote;
    if (!r) return;
    const doFetch = r.fetchImpl ?? fetch;
    try {
      const url = `${r.endpoint.replace(/\/$/, '')}/policy/bundles/current?agent=${encodeURIComponent(r.agentId)}`;
      const headers: Record<string, string> = { 'X-API-Key': r.apiKey };
      if (this.etag && this.confirmedAt) headers['If-None-Match'] = this.etag;
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 304 && this.confirmedAt) {
        this.confirmedAt = Date.now();
        this.remoteError = null;
        return;
      }
      if (res.status !== 200) throw new Error(`policy bundle fetch answered ${res.status}`);
      const raw = await res.text();
      if (r.requireSigned || res.headers.get(SIGNATURE_HEADER)) {
        const key = loadPublicKey(process.env.ARMORD_BUNDLE_PUBKEY ?? '');
        const trusted = [...(key ? [key] : []), ...(this.options.trustedKeys ?? [])];
        if (!verifyDetached(raw, res.headers.get(SIGNATURE_HEADER) ?? undefined, trusted)) {
          throw new Error(res.headers.get(SIGNATURE_HEADER) ? 'bundle signature does not verify; bundle refused' : `bundle has no ${SIGNATURE_HEADER} header and signed bundles are required; bundle refused`);
        }
      }
      const body = JSON.parse(raw) as unknown;
      if (!this.accept(body, r)) throw new Error(this.remoteError ?? 'unreadable bundle');
      this.etag = res.headers.get('etag') ?? '';
      this.confirmedAt = Date.now();
      this.remoteFetchedAt = new Date().toISOString();
      this.remoteError = null;
      this.remoteFromCache = false;
      mkdirSync(r.cacheDir, { recursive: true });
      writeFileSync(cacheFile(r), JSON.stringify({ fetchedAt: this.remoteFetchedAt, etag: this.etag, body }), { mode: 0o600 });
    } catch (err) {
      this.remoteError = (err as Error).message;
    }
  }

  /** Pick this agent out of the bundle (by agentId or name, as the SDK does) and check its document. */
  private accept(body: unknown, r: RemoteOptions): boolean {
    const agents = (body as { agents?: unknown })?.agents;
    if (!Array.isArray(agents) || !agents.every((a) => a && typeof a === 'object')) {
      this.remoteError = 'bundle body has no agents list';
      return false;
    }
    const agent = (agents as BundleAgent[]).find((a) => a.agentId === r.agentId || a.name === r.agentId) ?? null;
    const problems: PolicyProblem[] = [];
    let doc: PolicyDocument | null = null;
    const candidate = agent?.policy?.document;
    if (candidate) {
      if (candidate.schemaVersion !== 'armor.policy.v2') problems.push({ file: 'remote', severity: 'error', code: 'not_v2', message: `${agent?.policy?.policyId ?? 'policy'} is not an armor.policy.v2 document; ignored` });
      else if (candidate.policyHash && !verifyPolicyHash(candidate)) problems.push({ file: 'remote', severity: 'error', code: 'policy_hash_mismatch', message: `${candidate.policyId}: policyHash does not match the document; ignored` });
      else doc = candidate;
    }
    this.agent = agent;
    this.remoteDoc = doc;
    this.problems = [...this.problems.filter((p) => p.file !== 'remote'), ...problems];
    // A document that failed its hash check must not degrade into "no active policy" (allow).
    if (candidate && !doc) this.agent = { ...(agent as BundleAgent), inactive: true };
    return true;
  }
}

function cacheFile(r: RemoteOptions): string {
  const key = createHash('sha256').update(`${r.endpoint}|${r.agentId}`).digest('hex').slice(0, 16);
  return join(r.cacheDir, `bundle-${key}.json`);
}

function parseCompiled(src: LocalSource, problems: PolicyProblem[]): PolicyDocument | null {
  try {
    const doc = JSON.parse(src.text) as PolicyDocument;
    if (doc.schemaVersion !== 'armor.policy.v2') {
      problems.push({ file: src.file, severity: 'error', code: 'not_v2', message: 'expected a compiled armor.policy.v2 document' });
      return null;
    }
    if (doc.policyHash && !verifyPolicyHash(doc)) {
      problems.push({ file: src.file, severity: 'error', code: 'policy_hash_mismatch', message: 'policyHash does not match the document; refusing to load it' });
      return null;
    }
    return doc;
  } catch (err) {
    problems.push({ file: src.file, severity: 'error', code: 'bad_json', message: (err as Error).message });
    return null;
  }
}
