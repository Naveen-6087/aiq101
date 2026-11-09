// `armord policy test`: run a policy against a table of tool calls and their expected verdicts,
// with the same engine the daemon uses. Policy as code: check it into the repo, run it in CI.
//
// cases.yaml:
//   cases:
//     - name: rm -rf is blocked
//       tool: Bash
//       args: {command: "rm -rf /"}
//       expect: block
//     - tool: Read
//       args: {file_path: "~/.ssh/id_rsa"}
//       expect: block

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Engine } from './engine.js';
import { PolicyStore } from './store.js';

export interface PolicyCase {
  name?: string;
  tool: string;
  args?: Record<string, unknown>;
  mcpServer?: string;
  cwd?: string;
  expect: 'allow' | 'hold' | 'block';
}

export interface CaseResult {
  name: string;
  expect: string;
  got: string;
  ok: boolean;
  reason: string;
}

export function runPolicyTests(policyFiles: string[], casesFile: string): { results: CaseResult[]; problems: PolicyStore['problems'] } {
  const store = new PolicyStore();
  for (const f of policyFiles) store.addSource(f, readFileSync(f, 'utf8'));
  const engine = new Engine(store);
  const doc = parse(readFileSync(casesFile, 'utf8')) as { cases?: PolicyCase[]; cwd?: string };
  const results: CaseResult[] = [];
  for (const [i, c] of (doc.cases ?? []).entries()) {
    const req: Parameters<Engine['decide']>[0] = { tool: c.tool, arguments: c.args ?? {}, host: 'test' };
    const cwd = c.cwd ?? doc.cwd;
    if (cwd) req.cwd = cwd;
    if (c.mcpServer) req.mcpServer = c.mcpServer;
    const d = engine.decide(req);
    results.push({ name: c.name ?? `#${i + 1} ${c.tool}`, expect: c.expect, got: d.verdict, ok: d.verdict === c.expect, reason: d.reason });
  }
  return { results, problems: store.problems };
}
