// Shared pieces for host hook adapters: the answer shape, a strictest-of helper for hosts that
// pack several targets into one call, and a few small readers for untrusted hook JSON.

import type { DecisionResult } from '../daemon.js';
import type { Decider } from '../decider.js';
import type { DecideRequest } from '../engine.js';

export interface HookAnswer {
  stdout: string;
  exitCode: number;
}

export type Json = Record<string, unknown>;

export const PASS: HookAnswer = { stdout: '', exitCode: 0 };

const RANK = { allow: 0, hold: 1, block: 2 } as const;

/**
 * Decide several requests that stand for one host call (e.g. one web_fetch naming two URLs) and
 * return the strictest result. An empty list is a block: nothing was understood, so nothing runs.
 */
export async function decideStrictest(decider: Decider, reqs: DecideRequest[]): Promise<DecisionResult | null> {
  let worst: DecisionResult | null = null;
  for (const req of reqs) {
    const d = await decider.decide(req, { waitOnHold: false });
    if (!worst || RANK[d.verdict] > RANK[worst.verdict]) worst = d;
    if (d.verdict === 'block') break;
  }
  return worst;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

export function isObject(v: unknown): v is Json {
  return obj(v) !== undefined;
}

export function firstWorkspaceRoot(input: Json): string | undefined {
  const roots = input.workspace_roots;
  return Array.isArray(roots) ? str(roots[0]) : undefined;
}

export function reasonText(d: DecisionResult): string {
  return `ArmorIQ: ${d.reason}`;
}

/** http(s) URLs in free text, in order, de-duplicated. */
export function urlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bhttps?:\/\/[^\s"'<>`)\]]+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, '')))];
}
