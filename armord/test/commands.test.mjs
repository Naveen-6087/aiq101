import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterAudit, formatRecord, parseSince, completionScript, installedHosts, runDoctor, fetchBundle, registerAgent } from '../dist/commands.js';

const rec = (o) => ({ seq: 1, ts: '2026-01-01T10:11:12.000Z', prev: 'x', hash: 'y', event: 'decision', ...o });

test('filters by verdict, tool and limit', () => {
  const rs = [rec({ tool: 'Bash', final: 'block' }), rec({ tool: 'Read', final: 'allow' }), rec({ tool: 'Bash', final: 'allow' })];
  assert.equal(filterAudit(rs, { verdict: 'block' }).length, 1);
  assert.equal(filterAudit(rs, { tool: 'bash' }).length, 2);
  assert.equal(filterAudit(rs, { limit: 1 }).length, 1);
});

test('formats a record with its command', () => {
  assert.match(formatRecord(rec({ tool: 'Bash', final: 'block', reason: 'nope', derived: { command: 'rm -rf /' } })), /BLOCK Bash rm -rf \/  \(nope\)/);
});

test('parseSince handles durations and dates', () => {
  assert.equal(parseSince('10m', 1_000_000).getTime(), 1_000_000 - 600_000);
  assert.throws(() => parseSince('soon'));
});

test('completions for each shell', () => {
  for (const s of ['bash', 'zsh', 'fish', 'powershell']) assert.match(completionScript(s), /doctor/);
  assert.throws(() => completionScript('tcsh'));
});

test('detects hosts that run armord hook', () => {
  const d = mkdtempSync(join(tmpdir(), 'armord-h-'));
  mkdirSync(join(d, '.cursor'));
  writeFileSync(join(d, '.cursor', 'hooks.json'), '{"hooks":{"preToolUse":[{"command":"armord hook cursor"}]}}');
  const empty = mkdtempSync(join(tmpdir(), 'armord-e-'));
  assert.deepEqual(installedHosts(d, empty).map((h) => h.host), ['cursor']);
});

test('fetchBundle and registerAgent use the right headers', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify({ orgId: 'o', agents: [], agent: { agentId: 'a', name: 'n' } }), { status: 200 }); };
  await fetchBundle('https://x.test/', 'k', f);
  assert.equal(calls[0][0], 'https://x.test/policy/bundles/current');
  assert.equal(calls[0][1].headers['X-API-Key'], 'k');
  assert.equal((await registerAgent('https://x.test', 'k', 'n', f)).agentId, 'a');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer k');
  await assert.rejects(fetchBundle('https://x.test', 'k', async () => new Response('', { status: 401 })), /401/);
});

test('doctor flags an agent without a policy', async () => {
  const d = mkdtempSync(join(tmpdir(), 'armord-d-'));
  process.env.ARMORIQ_API_KEY = 'k';
  const f = async () => new Response(JSON.stringify({ orgId: 'o', agents: [{ name: 'bare', policy: null }] }), { status: 200 });
  const checks = await runDoctor({ home: d, policyDir: join(d, 'p'), auditFile: null, endpoint: 'https://x.test', holdTimeoutMs: 1, refreshMs: 1, requireSigned: false, trustedKeysDir: d, keysDir: d }, d, f);
  delete process.env.ARMORIQ_API_KEY;
  assert.equal(checks.find((c) => c.name === 'bundle').status, 'warn');
  assert.equal(checks.find((c) => c.name === 'policies').status, 'warn');
});
