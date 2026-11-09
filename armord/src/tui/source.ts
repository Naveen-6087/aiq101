// Where the TUI gets its data: the running daemon over IPC when there is one, files otherwise.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type ArmordConfig } from '../daemon.js';
import { ArmordClient } from '../ipc.js';
import { PolicyStore } from '../store.js';
import { readAudit, runDoctor, installedHosts, type Check } from '../commands.js';
import type { AuditRecord } from '../audit.js';
import { describeStatement, type HoldRow, type PolicyDoc, type StatusInfo } from './data.js';

export interface TuiSource {
  mode: 'daemon' | 'direct' | 'demo';
  status(): Promise<StatusInfo | null>;
  holds(): Promise<HoldRow[]>;
  resolve(id: string, outcome: 'approved' | 'rejected'): Promise<void>;
  audit(): AuditRecord[];
  policies(): Promise<{ docs: PolicyDoc[]; problems: Array<{ severity: string; file: string; message: string }> }>;
  reload(): Promise<void>;
  doctor(): Promise<Check[]>;
  hosts(): Array<{ host: string; scope: string }>;
  close(): void;
}

export async function connectSource(config: ArmordConfig, cwd = process.cwd()): Promise<TuiSource> {
  let client: ArmordClient | null = new ArmordClient();
  try {
    await client.connect(500);
  } catch {
    client = null;
  }
  const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T | null> => {
    if (!client) return null;
    try {
      return (await client.call(method, params)) as T;
    } catch {
      return null;
    }
  };
  const readPolicies = () => {
    const store = new PolicyStore();
    const files = existsSync(config.policyDir) ? readdirSync(config.policyDir).filter((f) => /\.(ya?ml|json)$/.test(f)) : [];
    for (const f of files) store.addSource(join(config.policyDir, f), readFileSync(join(config.policyDir, f), 'utf8'));
    const docs: PolicyDoc[] = store.localDocuments().map((d) => ({
      id: d.policyId,
      layer: String(d.layer),
      defaults: `tools ${String(d.defaults.tools)} / network ${String(d.defaults.network)} / files ${String(d.defaults.files)}`,
      statements: d.statements.map((s) => describeStatement(s as never)),
    }));
    return { docs, problems: store.problems.map((p) => ({ severity: p.severity, file: p.file, message: `${p.code} ${p.message}` })) };
  };
  return {
    mode: client ? 'daemon' : 'direct',
    status: () => call<StatusInfo>('status'),
    holds: async () => (await call<HoldRow[]>('holds.list')) ?? [],
    resolve: async (id, outcome) => {
      if (!client) throw new Error('daemon not running');
      await client.call('holds.resolve', { id, outcome, by: 'tui' });
    },
    audit: () => (config.auditFile ? readAudit(config.auditFile) : []),
    policies: async () => readPolicies(),
    reload: async () => void (await call('reload')),
    doctor: () => runDoctor(config, cwd),
    hosts: () => installedHosts(cwd, homedir()),
    close: () => client?.close(),
  };
}
