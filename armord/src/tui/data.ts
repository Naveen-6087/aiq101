// Pure data helpers for the TUI: no Ink, no I/O. Everything here is unit-tested.

import type { AuditRecord } from '../audit.js';

export const TABS = ['Overview', 'Holds', 'Decisions', 'Policies', 'Doctor'] as const;
export type Tab = (typeof TABS)[number];

export type Filter = 'all' | 'block' | 'hold';
const FILTERS: Filter[] = ['all', 'block', 'hold'];

export function nextFilter(f: Filter): Filter {
  return FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length] as Filter;
}

export interface StatusInfo {
  policySetHash?: string;
  decisions?: Record<string, number>;
  latencyUs?: { p50: number | null; p99: number | null; samples: number };
  remote?: { agentId: string; status: string; policyId: string | null; agentFound: boolean; error?: string | null } | null;
  pendingHolds?: number;
  holdTimeoutMs?: number;
  problems?: Array<{ severity: string; file: string; message: string }>;
}

export interface HoldRow {
  id: string;
  tool: string;
  host: string;
  reason: string;
  arguments: Record<string, unknown>;
  createdAt: string;
}

export interface StatementRow {
  id: string;
  effect: string;
  label: string;
}

export interface PolicyDoc {
  id: string;
  layer: string;
  defaults: string;
  statements: StatementRow[];
}

export const shortHash = (h?: string, n = 12): string => (h ? h.replace(/^sha256:/, '').slice(0, n) : '-');

export function fmtLatency(us: number | null | undefined): string {
  if (us == null) return '-';
  return us < 1000 ? `${Math.round(us)} us` : `${(us / 1000).toFixed(2)} ms`;
}

export function verdictOf(r: AuditRecord): 'allow' | 'hold' | 'block' | 'other' {
  const v = String(r.final ?? r.verdict ?? '');
  return v === 'allow' || v === 'hold' || v === 'block' ? v : 'other';
}

/** Decisions only, filtered, newest last, capped to what fits on screen. */
export function visibleDecisions(records: AuditRecord[], filter: Filter, max: number): AuditRecord[] {
  const rows = records.filter((r) => r.event === 'decision' && (filter === 'all' || verdictOf(r) === filter || (filter === 'hold' && r.holdOutcome != null)));
  return rows.slice(-max);
}

export function describeCall(r: object): string {
  const rec = r as { tool?: unknown; derived?: unknown };
  const d = (rec.derived ?? {}) as Record<string, unknown>;
  const target = d.command ?? d.path ?? d.url ?? d.host;
  return `${String(rec.tool ?? '?')}${target ? ' ' + String(target) : ''}`;
}

export function holdTarget(h: HoldRow): string {
  const a = h.arguments ?? {};
  const t = a.command ?? a.file_path ?? a.path ?? a.url;
  return t ? String(t) : JSON.stringify(a).slice(0, 80);
}

export function clampIndex(i: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(length - 1, i));
}

/** Compile-time shape of a policy statement from policy-ir, reduced to a one-line label. */
export function describeStatement(s: { id: string; effect: string; match: Record<string, unknown>; conditions?: Array<{ field: string; op: string; value: unknown }> }): StatementRow {
  const m = s.match;
  const what = typeof m.tool === 'string' ? m.tool : typeof m.capability === 'string' ? `[${m.capability}]` : JSON.stringify(m);
  const when = s.conditions?.length ? ' when ' + s.conditions.map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' and ') : '';
  return { id: s.id, effect: s.effect, label: `${what}${when}` };
}

export function counts(status: StatusInfo | null): { allow: number; hold: number; block: number } {
  const d = status?.decisions ?? {};
  return { allow: Number(d.allow ?? 0), hold: Number(d.hold ?? 0), block: Number(d.block ?? 0) };
}

// ---- text and layout helpers ----

/** Cut to n characters, ending in "..." when something was dropped. */
export function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : n <= 3 ? flat.slice(0, n) : `${flat.slice(0, n - 3)}...`;
}

/** Fixed-width cell: truncated, then padded, so columns never move. */
/** `mcp__github__create_pr` reads better as `github.create_pr`. */
export function shortTool(name: string): string {
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? `${parts[1]}.${parts.slice(2).join('__')}` : name;
}

export function cell(s: string, n: number): string {
  return truncate(s, n).padEnd(n);
}

/** Proportional bar made of fill and rest characters. */
export function bar(n: number, total: number, width: number): string {
  if (width <= 0) return '';
  const filled = total <= 0 ? 0 : Math.min(width, Math.round((n / total) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function pct(n: number, total: number): string {
  return total <= 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

/** The slice of a list of `total` rows that keeps `selected` visible in a window of `height`. */
export function windowRows(total: number, selected: number, height: number): { start: number; end: number } {
  const h = Math.max(1, height);
  if (total <= h) return { start: 0, end: total };
  const start = Math.max(0, Math.min(total - h, selected - Math.floor(h / 2)));
  return { start, end: start + h };
}

export type Layout = 'wide' | 'narrow';
export const layoutFor = (columns: number): Layout => (columns < 80 ? 'narrow' : 'wide');

/** Terminal size clamped to something the screens can lay out in. */
export function clampSize(columns?: number, rows?: number): { columns: number; rows: number } {
  return { columns: Math.max(40, Math.min(columns ?? 80, 120)), rows: Math.max(12, rows ?? 24) };
}

export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export const holdAge = (createdAt: string, now: number): number => Math.max(0, (now - new Date(createdAt).getTime()) / 1000);
export const holdRemaining = (createdAt: string, timeoutMs: number, now: number): number => Math.max(0, timeoutMs / 1000 - holdAge(createdAt, now));

// ---- decisions ----

const targetOf = (r: AuditRecord): string => {
  const d = (r.derived ?? {}) as Record<string, unknown>;
  const t = d.command ?? d.path ?? d.url ?? d.host;
  return t ? String(t) : '';
};
export const decisionTarget = targetOf;

export function matchesQuery(r: AuditRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [r.tool, targetOf(r), r.reason, r.statementId, r.host].some((v) => String(v ?? '').toLowerCase().includes(q));
}

/** Every decision that passes the verdict filter and the text search, oldest first. */
export function filterDecisions(records: AuditRecord[], filter: Filter, query = ''): AuditRecord[] {
  return records.filter((r) => r.event === 'decision' && (filter === 'all' || verdictOf(r) === filter || (filter === 'hold' && r.holdOutcome != null)) && matchesQuery(r, query));
}

export interface DecisionColumns {
  time: number;
  verdict: number;
  tool: number;
  rule: number;
  target: number;
}

/** Column widths for a table `inner` characters wide. The rule column is dropped on narrow screens. */
export function decisionColumns(inner: number): DecisionColumns {
  const time = 8;
  const verdict = 7;
  const tool = inner >= 76 ? 14 : 10;
  const rule = inner >= 76 ? 16 : 0;
  const fixed = 2 + time + 1 + verdict + 1 + tool + 1 + (rule ? rule + 1 : 0);
  return { time, verdict, tool, rule, target: Math.max(8, inner - fixed) };
}

export function decisionFacts(r: AuditRecord): Array<[string, string]> {
  const d = (r.derived ?? {}) as Record<string, unknown>;
  const facts: Array<[string, string | undefined]> = [
    ['time', r.ts],
    ['verdict', `${verdictOf(r)}${r.holdOutcome ? ` (hold ${String(r.holdOutcome)})` : ''}`],
    ['tool', String(r.tool ?? '')],
    ['target', targetOf(r)],
    ['host', r.host ? String(r.host) : undefined],
    ['reason', r.reason ? String(r.reason) : undefined],
    ['rule', r.statementId ? String(r.statementId) : undefined],
    ['capabilities', Array.isArray(r.capabilities) ? (r.capabilities as string[]).join(', ') : undefined],
    ['path', d.path ? String(d.path) : undefined],
    ['latency', typeof r.latencyUs === 'number' ? fmtLatency(r.latencyUs) : undefined],
  ];
  return facts.filter((f): f is [string, string] => !!f[1]);
}

// ---- holds ----

export function holdFacts(h: HoldRow): Array<[string, string]> {
  const a = h.arguments ?? {};
  const out: Array<[string, string | undefined]> = [
    ['tool', h.tool],
    ['command', a.command ? String(a.command) : undefined],
    ['path', a.file_path ?? a.path ? String(a.file_path ?? a.path) : undefined],
    ['url', a.url ? String(a.url) : undefined],
    ['host', h.host],
    ['rule', h.reason],
  ];
  return out.filter((f): f is [string, string] => !!f[1]);
}

// ---- policies ----

export interface PolicyLine {
  key: string;
  kind: 'doc' | 'stmt' | 'problem';
  docId: string;
  text: string;
  effect?: string;
  collapsed?: boolean;
  severity?: string;
}

/** The policy tree as flat lines: document, then its statements (unless folded), then problems. */
export function flattenPolicies(docs: PolicyDoc[], problems: Array<{ severity: string; file: string; message: string }>, collapsed: ReadonlySet<string>, query = ''): PolicyLine[] {
  const q = query.trim().toLowerCase();
  const lines: PolicyLine[] = [];
  for (const d of docs) {
    const stmts = d.statements.filter((s) => !q || `${s.label} ${s.effect} ${s.id}`.toLowerCase().includes(q));
    const docMatch = !q || d.id.toLowerCase().includes(q);
    if (q && !docMatch && stmts.length === 0) continue;
    const fold = !q && collapsed.has(d.id);
    lines.push({ key: `d:${d.id}`, kind: 'doc', docId: d.id, text: `${d.id}  layer ${d.layer}  ${d.defaults}`, collapsed: fold });
    if (!fold) for (const s of q ? stmts : d.statements) lines.push({ key: `s:${d.id}:${s.id}`, kind: 'stmt', docId: d.id, effect: s.effect, text: s.label });
  }
  if (!q) problems.forEach((p, i) => lines.push({ key: `p:${i}`, kind: 'problem', docId: '', severity: p.severity, text: `${p.severity}: ${p.message}` }));
  return lines;
}

/** Split `width` cells between values in proportion, using every cell (largest remainder). */
export function segments(values: number[], width: number): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || width <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * width);
  const out = raw.map(Math.floor);
  let left = width - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}
