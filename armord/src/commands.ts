// Everyday commands built on the core: doctor, logs, watch, remote, completions.
// Kept apart from cli.ts so each is small and testable.

import { existsSync, readFileSync, readdirSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ArmordConfig } from './daemon.js';
import { ArmordClient } from './ipc.js';
import { PolicyStore } from './store.js';
import { verifyAuditLog, type AuditRecord } from './audit.js';
import { credentialsApiKey, servicePlan } from './service.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

const HOOK_FILES: Array<[string, string]> = [
  ['claude-code', '.claude/settings.json'],
  ['claude-code', '.claude/settings.local.json'],
  ['cursor', '.cursor/hooks.json'],
  ['codex', '.codex/hooks.json'],
  ['codex', '.codex/config.toml'],
  ['gemini', '.gemini/settings.json'],
];

/** Which hosts have an `armord hook` entry, in the user (home) or project (cwd) config. */
export function installedHosts(cwd: string, home = homedir()): Array<{ host: string; file: string; scope: 'user' | 'project' }> {
  const out: Array<{ host: string; file: string; scope: 'user' | 'project' }> = [];
  for (const [scope, root] of [['project', cwd], ['user', home]] as const) {
    for (const [host, rel] of HOOK_FILES) {
      const file = join(root, rel);
      if (!existsSync(file)) continue;
      try {
        if (/armord\s+hook/.test(readFileSync(file, 'utf8'))) out.push({ host, file, scope });
      } catch {
        /* unreadable */
      }
    }
  }
  return out;
}

export async function runDoctor(config: ArmordConfig, cwd: string, fetchImpl: typeof fetch = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? { name: 'node', status: 'ok', detail: process.version } : { name: 'node', status: 'fail', detail: process.version, fix: 'install Node 20 or newer' });

  const store = new PolicyStore();
  const files = existsSync(config.policyDir) ? readdirSync(config.policyDir).filter((f) => /\.(ya?ml|json)$/.test(f)) : [];
  for (const f of files) store.addSource(join(config.policyDir, f), readFileSync(join(config.policyDir, f), 'utf8'));
  const errors = store.problems.filter((p) => p.severity === 'error');
  if (files.length === 0) add({ name: 'policies', status: 'warn', detail: `none in ${config.policyDir}`, fix: 'armord init --template armordev' });
  else if (errors.length) add({ name: 'policies', status: 'fail', detail: `${errors.length} error(s): ${errors[0]?.file}: ${errors[0]?.message}`, fix: 'armord policy check <file>' });
  else add({ name: 'policies', status: 'ok', detail: `${store.localDocuments().length} document(s) compile` });

  const client = new ArmordClient();
  try {
    await client.connect(500);
    const s = (await client.call('status')) as { latencyUs?: { p50?: number } };
    add({ name: 'daemon', status: 'ok', detail: `running, p50 ${s.latencyUs?.p50 ?? '?'} us` });
    client.close();
  } catch {
    add({ name: 'daemon', status: 'warn', detail: 'not running (hooks fall back to in-process decisions)', fix: 'armord start, or armord service install' });
  }

  const hosts = installedHosts(cwd);
  add(hosts.length ? { name: 'hooks', status: 'ok', detail: hosts.map((h) => `${h.host} (${h.scope})`).join(', ') } : { name: 'hooks', status: 'warn', detail: 'no host runs armord hook yet', fix: 'armord install claude-code | cursor | codex | gemini' });

  const creds = process.env.ARMORIQ_API_KEY ? { apiKey: process.env.ARMORIQ_API_KEY } : credentialsApiKey();
  if (!creds) add({ name: 'credentials', status: 'warn', detail: 'no ARMORIQ_API_KEY or armoriq login profile (remote policy off)', fix: 'armoriq login' });
  else {
    add({ name: 'credentials', status: 'ok', detail: process.env.ARMORIQ_API_KEY ? 'ARMORIQ_API_KEY' : 'armoriq login profile' });
    try {
      const b = await fetchBundle(config.endpoint, creds.apiKey, fetchImpl);
      const bare = b.agents.filter((a) => !a.policy).map((a) => String(a.name));
      add({ name: 'bundle', status: bare.length ? 'warn' : 'ok', detail: `${b.agents.length} agent(s)${bare.length ? `; no active policy on: ${bare.join(', ')} (calls are allowed)` : ''}`, fix: bare.length ? 'attach a policy in the dashboard; armord export-policy <file> prints one' : undefined });
    } catch (e) {
      add({ name: 'bundle', status: 'warn', detail: (e as Error).message });
    }
  }

  const auditFile = config.auditFile;
  if (auditFile && existsSync(auditFile)) {
    const v = verifyAuditLog(auditFile);
    add(v.ok ? { name: 'audit', status: 'ok', detail: `${v.records} records, chain intact` } : { name: 'audit', status: 'fail', detail: `broken at line ${v.brokenAt}: ${v.problem}` });
  } else add({ name: 'audit', status: 'ok', detail: 'no decisions logged yet' });

  try {
    const file = servicePlan(process.argv[1] ?? 'armord').file;
    const there = !!file && existsSync(file);
    add({ name: 'autostart', status: there ? 'ok' : 'warn', detail: there ? String(file) : 'not installed', fix: there ? undefined : 'armord service install' });
  } catch {
    /* unsupported platform */
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  return checks.map((c) => `${mark[c.status]} ${c.name.padEnd(11)} ${c.detail}${c.fix ? `\n       fix: ${c.fix}` : ''}`).join('\n');
}

// ---- logs ----
export interface LogFilter {
  verdict?: string;
  tool?: string;
  host?: string;
  since?: Date;
  limit?: number;
}

export function readAudit(file: string): AuditRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
}

export function filterAudit(records: AuditRecord[], f: LogFilter): AuditRecord[] {
  const out = records.filter((r) => {
    if (f.verdict && String(r.final ?? r.verdict) !== f.verdict) return false;
    if (f.tool && !String(r.tool ?? '').toLowerCase().includes(f.tool.toLowerCase())) return false;
    if (f.host && r.host !== f.host) return false;
    if (f.since && new Date(r.ts) < f.since) return false;
    return true;
  });
  return f.limit ? out.slice(-f.limit) : out;
}

export function formatRecord(r: AuditRecord): string {
  const v = String(r.final ?? r.verdict ?? r.event).toUpperCase().padEnd(5);
  const d = (r.derived ?? {}) as Record<string, unknown>;
  const target = d.command ?? d.path ?? d.url ?? d.host;
  const what = r.tool ? `${String(r.tool)}${target ? ' ' + String(target) : ''}` : r.event;
  return `${r.ts.slice(11, 19)} ${v} ${String(what).slice(0, 80)}${r.reason ? `  (${String(r.reason)})` : ''}`;
}

/** `10m`, `2h`, `3d`, or an ISO date. */
export function parseSince(s: string, now = Date.now()): Date {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`cannot parse --since "${s}" (use 10m, 2h, 3d or an ISO date)`);
    return d;
  }
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(now - Number(m[1]) * mult);
}

export function followAudit(file: string, filter: LogFilter, write: (s: string) => void): () => void {
  let size = existsSync(file) ? statSync(file).size : 0;
  watchFile(file, { interval: 300 }, (cur) => {
    if (cur.size <= size) return;
    const chunk = readFileSync(file, 'utf8').slice(size);
    size = cur.size;
    for (const line of chunk.split('\n').filter(Boolean)) for (const r of filterAudit([JSON.parse(line) as AuditRecord], { ...filter, limit: undefined })) write(formatRecord(r));
  });
  return () => unwatchFile(file);
}

// ---- watch: approve holds from a terminal ----
export async function watchHolds(client: ArmordClient, ask: (q: string) => Promise<string>, write: (s: string) => void, stop: { done: boolean }): Promise<void> {
  const seen = new Set<string>();
  write('watching for held calls (a = approve, r = reject, s = skip). Ctrl-C to stop.');
  while (!stop.done) {
    const holds = (await client.call('holds.list')) as Array<{ id: string; tool: string; reason: string; summary?: string }>;
    for (const h of holds) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      write(`\nHOLD ${h.id}\n  ${h.tool}${h.summary ? ': ' + h.summary : ''}\n  why: ${h.reason}`);
      const a = (await ask('  [a]pprove / [r]eject / [s]kip > ')).trim().toLowerCase();
      if (a.startsWith('a')) await client.call('holds.resolve', { id: h.id, outcome: 'approved' });
      else if (a.startsWith('r')) await client.call('holds.resolve', { id: h.id, outcome: 'rejected' });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---- remote ----
export async function fetchBundle(endpoint: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ orgId: string; agents: Array<Record<string, unknown>> }> {
  const r = await fetchImpl(`${endpoint.replace(/\/$/, '')}/policy/bundles/current`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 401) throw new Error('API key rejected (401)');
  if (!r.ok) throw new Error(`bundle fetch failed: HTTP ${r.status}`);
  return (await r.json()) as { orgId: string; agents: Array<Record<string, unknown>> };
}

export function resolveApiKey(): string {
  if (process.env.ARMORIQ_API_KEY) return process.env.ARMORIQ_API_KEY;
  const c = credentialsApiKey();
  if (!c) throw new Error('no API key: set ARMORIQ_API_KEY or run `armoriq login`');
  return c.apiKey;
}

// ---- completions ----
export const COMMANDS = ['init', 'start', 'status', 'doctor', 'tui', 'install', 'uninstall', 'migrate', 'templates', 'decide', 'hook', 'mcp-proxy', 'holds', 'watch', 'approve', 'reject', 'logs', 'policy', 'pins', 'audit', 'keygen', 'plan', 'mcp-plan', 'service', 'remote', 'completions', 'help'];

export function completionScript(shell: string): string {
  const words = COMMANDS.join(' ');
  if (shell === 'bash') return '_armord(){ COMPREPLY=( $(compgen -W "' + words + '" -- "${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _armord armord\n';
  if (shell === 'zsh') return '#compdef armord\n_arguments "1: :(' + words + ')"\n';
  if (shell === 'fish') return COMMANDS.map((c) => 'complete -c armord -n __fish_use_subcommand -a ' + c).join('\n') + '\n';
  if (shell === 'powershell') return "Register-ArgumentCompleter -Native -CommandName armord -ScriptBlock { param($w) '" + COMMANDS.join("','") + "' | Where-Object { $_ -like \"$w*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) } }\n";
  throw new Error('shell must be bash, zsh, fish or powershell');
}

/** Register (or re-register) an agent with the control plane; the same call `armoriq register` makes. */
export async function registerAgent(endpoint: string, apiKey: string, name: string, fetchImpl: typeof fetch = fetch): Promise<{ agentId: string; name: string }> {
  const body = {
    version: '1',
    identity: { api_key: 'redacted', user_id: 'armord', agent_id: name },
    environment: 'sandbox',
    proxy: { url: 'https://customer-proxy.armoriq.ai', timeout: 30, max_retries: 3 },
    mcp_servers: [],
    policy: { allow: [], deny: [] },
    intent: { ttl_seconds: 3600, require_csrg: true },
  };
  const r = await fetchImpl(`${endpoint.replace(/\/$/, '')}/iap/sdk/register`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`register failed: HTTP ${r.status}`);
  const j = (await r.json()) as { agent?: { agentId: string; name: string } };
  if (!j.agent) throw new Error('register returned no agent');
  return j.agent;
}
