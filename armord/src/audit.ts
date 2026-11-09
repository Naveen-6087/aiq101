// Append-only, hash-chained decision log. Each line carries the hash of the line before it, so
// editing or deleting any record breaks every hash after it (`armord audit verify`).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditRecord {
  seq: number;
  ts: string;
  prev: string;
  hash: string;
  event: string;
  [key: string]: unknown;
}

const GENESIS = 'sha256:' + '0'.repeat(64);

function digest(body: Omit<AuditRecord, 'hash'>): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export class AuditLog {
  private seq = 0;
  private prev = GENESIS;

  constructor(private readonly file: string | null) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const rec = JSON.parse(last) as AuditRecord;
        this.seq = rec.seq;
        this.prev = rec.hash;
      }
    }
  }

  append(event: string, data: Record<string, unknown>): AuditRecord {
    const body = { seq: this.seq + 1, ts: new Date().toISOString(), prev: this.prev, event, ...data };
    const record = { ...body, hash: digest(body) } as AuditRecord;
    this.seq = record.seq;
    this.prev = record.hash;
    if (this.file) appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
    return record;
  }
}

/** Recompute the chain. Returns the first broken line, or null when the log is intact. */
export function verifyAuditLog(file: string): { ok: boolean; records: number; brokenAt?: number; problem?: string } {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i] as string) as AuditRecord;
    const { hash, ...body } = rec;
    if (rec.prev !== prev) return { ok: false, records: lines.length, brokenAt: i + 1, problem: 'prev hash does not match the line before' };
    if (digest(body) !== hash) return { ok: false, records: lines.length, brokenAt: i + 1, problem: 'record content does not match its hash' };
    prev = hash;
  }
  return { ok: true, records: lines.length };
}
