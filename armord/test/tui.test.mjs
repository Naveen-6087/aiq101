import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../dist/tui/App.js';
import { demoSource, demoAudit } from '../dist/tui/demo.js';
import {
  TABS, nextFilter, visibleDecisions, verdictOf, fmtLatency, shortHash, clampIndex, describeStatement, describeCall, counts,
  truncate, cell, bar, pct, windowRows, segments, filterDecisions, decisionColumns, flattenPolicies, fmtDuration, holdRemaining, holdAge, shortTool, clampSize, layoutFor,
} from '../dist/tui/data.js';
import { wrapLines } from '../dist/tui/wrap.js';

const NOW = Date.parse('2026-11-10T14:30:00Z');
const rec = (seq, o) => ({ seq, ts: `2026-01-01T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, prev: 'p', hash: 'h', event: 'decision', ...o });
const AUDIT = [
  rec(1, { tool: 'Bash', final: 'allow', verdict: 'allow', derived: { command: 'ls' }, reason: 'read-only' }),
  rec(2, { tool: 'Bash', final: 'block', verdict: 'block', derived: { command: 'rm -rf /' }, reason: 'destructive', statementId: 'st-destructive-0' }),
  rec(3, { tool: 'Write', final: 'allow', verdict: 'hold', holdOutcome: 'approved', derived: { path: '~/a.txt' }, reason: 'asks' }),
];
const WIDE = { columns: 100, rows: 30 };

function fakeSource(over = {}) {
  const resolved = [];
  let reloads = 0;
  return {
    mode: 'daemon',
    resolved,
    get reloads() { return reloads; },
    status: async () => ({ policySetHash: 'sha256:abcdef0123456789', decisions: { allow: 5, hold: 2, block: 1 }, latencyUs: { p50: 33, p99: 226, samples: 8 }, remote: { agentId: 'agent-1', status: 'current', policyId: 'pol-1', agentFound: true }, pendingHolds: 1 }),
    holds: async () => [{ id: 'h1', tool: 'Bash', host: 'cursor', reason: 'package publish', arguments: { command: 'npm publish' }, createdAt: new Date(NOW - 20_000).toISOString() }],
    resolve: async (id, outcome) => void resolved.push([id, outcome]),
    audit: () => AUDIT,
    policies: async () => ({ docs: [{ id: 'local:starter', layer: 'local', defaults: 'tools allow', statements: [{ id: 's1', effect: 'block', label: '[destructive]' }, { id: 's2', effect: 'allow', label: 'Read' }] }], problems: [{ severity: 'warning', file: 'f.yaml', message: 'something odd' }] }),
    reload: async () => void reloads++,
    doctor: async () => [{ name: 'policies', status: 'ok', detail: '1 document compiles' }, { name: 'hooks', status: 'warn', detail: 'none', fix: 'armord install claude-code' }],
    hosts: () => [{ host: 'cursor', scope: 'user' }],
    close() {},
    ...over,
  };
}

const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const settle = (ms = 70) => new Promise((r) => setTimeout(r, ms));
async function mount(src, size = WIDE) {
  const app = render(React.createElement(App, { source: src, pollMs: 20, size, now: () => NOW }));
  mounted.push(app);
  await settle();
  return app;
}
const press = async (app, k) => (app.stdin.write(k), settle());
const type = async (app, text) => { for (const ch of text) await press(app, ch); };

test('data helpers', () => {
  assert.equal(TABS.length, 5);
  assert.equal(nextFilter('all'), 'block');
  assert.equal(nextFilter('hold'), 'all');
  assert.equal(visibleDecisions(AUDIT, 'block', 10).length, 1);
  assert.equal(visibleDecisions(AUDIT, 'hold', 10).length, 1);
  assert.equal(visibleDecisions(AUDIT, 'all', 2).length, 2);
  assert.equal(verdictOf(AUDIT[1]), 'block');
  assert.equal(fmtLatency(33), '33 us');
  assert.equal(fmtLatency(1500), '1.50 ms');
  assert.equal(shortHash('sha256:abcdef0123456789'), 'abcdef012345');
  assert.equal(clampIndex(9, 3), 2);
  assert.equal(describeCall(AUDIT[1]), 'Bash rm -rf /');
  assert.equal(describeStatement({ id: 'x', effect: 'hold', match: { tool: 'Bash' }, conditions: [{ field: 'args.command', op: 'matches', value: 'x' }] }).label, 'Bash when args.command matches "x"');
  assert.deepEqual(counts({ decisions: { allow: 1 } }), { allow: 1, hold: 0, block: 0 });
});

test('layout helpers', () => {
  assert.equal(truncate('abcdefghij', 6), 'abc...');
  assert.equal(cell('ab', 5), 'ab   ');
  assert.equal(cell('abcdefghij', 6).length, 6);
  assert.equal(bar(1, 4, 8), '██░░░░░░');
  assert.equal(pct(1, 4), '25%');
  assert.deepEqual(windowRows(100, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(windowRows(100, 99, 10), { start: 90, end: 100 });
  assert.deepEqual(windowRows(5, 3, 10), { start: 0, end: 5 });
  const w = windowRows(100, 50, 10);
  assert.ok(w.start <= 50 && 50 < w.end);
  for (const [vals, width] of [[[18, 9, 9], 66], [[1, 1, 1], 10], [[5, 0, 0], 7]]) assert.equal(segments(vals, width).reduce((a, b) => a + b, 0), width);
  assert.deepEqual(segments([0, 0, 0], 10), [0, 0, 0]);
  assert.equal(fmtDuration(42), '42s');
  assert.equal(fmtDuration(105), '1m 45s');
  assert.equal(holdAge(new Date(NOW - 20_000).toISOString(), NOW), 20);
  assert.equal(holdRemaining(new Date(NOW - 20_000).toISOString(), 120_000, NOW), 100);
  assert.equal(holdRemaining(new Date(NOW - 500_000).toISOString(), 120_000, NOW), 0);
  assert.equal(shortTool('mcp__github__create_pr'), 'github.create_pr');
  assert.equal(shortTool('Bash'), 'Bash');
  assert.deepEqual(clampSize(10, 5), { columns: 40, rows: 12 });
  assert.deepEqual(clampSize(300, 50), { columns: 120, rows: 50 });
  assert.equal(layoutFor(79), 'narrow');
  assert.equal(layoutFor(80), 'wide');
  assert.deepEqual(wrapLines('abcdefghij', 4, 2), ['abcd', 'e...']);
  assert.deepEqual(wrapLines('abc', 10, 3), ['abc']);
});

test('decision columns drop the rule column when narrow', () => {
  assert.ok(decisionColumns(96).rule > 0);
  assert.equal(decisionColumns(60).rule, 0);
  for (const n of [40, 60, 80, 96, 116]) {
    const c = decisionColumns(n);
    assert.ok(2 + c.time + 1 + c.verdict + 1 + c.tool + 1 + (c.rule ? c.rule + 1 : 0) + c.target <= Math.max(n, 2 + 8 + 1 + 7 + 1 + 10 + 1 + 8), `fits at ${n}`);
  }
});

test('filterDecisions applies filter and search', () => {
  assert.equal(filterDecisions(AUDIT, 'all', 'rm').length, 1);
  assert.equal(filterDecisions(AUDIT, 'all', 'BASH').length, 2);
  assert.equal(filterDecisions(AUDIT, 'block', 'ls').length, 0);
  assert.equal(filterDecisions(AUDIT, 'hold', '').length, 1);
  assert.equal(filterDecisions(AUDIT, 'all', 'st-destructive').length, 1);
});

test('flattenPolicies folds and searches', () => {
  const docs = [{ id: 'a', layer: 'local', defaults: 'd', statements: [{ id: '1', effect: 'block', label: 'Bash rm' }, { id: '2', effect: 'allow', label: 'Read' }] }, { id: 'b', layer: 'agent', defaults: 'd', statements: [{ id: '3', effect: 'hold', label: 'Write' }] }];
  const problems = [{ severity: 'warning', file: 'f', message: 'm' }];
  assert.equal(flattenPolicies(docs, problems, new Set()).length, 2 + 2 + 1 + 1);
  assert.equal(flattenPolicies(docs, problems, new Set(['a'])).length, 1 + 2 + 1);
  const found = flattenPolicies(docs, problems, new Set(), 'write');
  assert.deepEqual(found.map((l) => l.kind), ['doc', 'stmt']);
});

test('overview shows daemon, counters, remote and hooks', async () => {
  const app = await mount(fakeSource());
  const f = app.lastFrame();
  for (const t of ['running', 'abcdef012345', 'Allow', 'Hold', 'Block', '63%', 'p50 33 us', 'agent-1', 'current', 'cursor', 'Recent decisions', 'rm -rf /']) assert.ok(f.includes(t), `missing ${t}\n${f}`);
  app.unmount();
});

test('number keys and arrows switch tabs', async () => {
  const app = await mount(fakeSource());
  await press(app, '3');
  assert.ok(app.lastFrame().includes('rm -rf /'));
  await press(app, '\u001B[D'); // left -> Holds
  assert.ok(app.lastFrame().includes('Held calls'));
  await press(app, '4');
  assert.ok(app.lastFrame().includes('local:starter'));
  assert.ok(app.lastFrame().includes('something odd'));
  await press(app, '5');
  assert.ok(app.lastFrame().includes('armord install claude-code'));
  app.unmount();
});

test('decisions: filter cycles and detail pane shows the record', async () => {
  const app = await mount(fakeSource());
  await press(app, '3');
  assert.ok(app.lastFrame().includes('filter all'));
  await press(app, 'f');
  let f = app.lastFrame();
  assert.ok(f.includes('filter block') && f.includes('rm -rf /') && !f.includes('~/a.txt'), f);
  await press(app, 'f');
  f = app.lastFrame();
  assert.ok(f.includes('filter hold') && f.includes('~/a.txt') && !f.includes('rm -rf /'), f);
  await press(app, 'f'); // back to all
  await press(app, 'k'); // select the previous row
  await press(app, '\r');
  f = app.lastFrame();
  assert.ok(f.includes('Record') && f.includes('st-destructive-0') && f.includes('destructive'), f);
  await press(app, '\r');
  assert.ok(!app.lastFrame().includes('Record'));
  app.unmount();
});

test('decisions: scrolls through a long log with j/k, paging and g/G', async () => {
  const many = Array.from({ length: 80 }, (_, i) => rec(i + 1, { tool: 'Bash', final: 'allow', verdict: 'allow', derived: { command: `cmd-${String(i + 1).padStart(3, '0')}` }, reason: 'r' }));
  const app = await mount(fakeSource({ audit: () => many }), { columns: 100, rows: 16 });
  await press(app, '3');
  let f = app.lastFrame();
  assert.ok(f.includes('cmd-080') && !f.includes('cmd-001') && f.includes('live'), f);
  await press(app, 'g');
  f = app.lastFrame();
  assert.ok(f.includes('cmd-001') && !f.includes('cmd-080') && !f.includes('live') && f.includes('1/80'), f);
  await press(app, 'j');
  assert.ok(app.lastFrame().includes('2/80'));
  await press(app, 'k');
  assert.ok(app.lastFrame().includes('1/80'));
  await press(app, '\u001B[6~'); // page down
  f = app.lastFrame();
  assert.ok(!f.includes('1/80'), f);
  const n = Number(/(\d+)\/80/.exec(f)[1]);
  assert.ok(n > 5, `page moved ${n}`);
  await press(app, '\u001B[5~'); // page up
  assert.ok(Number(/(\d+)\/80/.exec(app.lastFrame())[1]) < n);
  await press(app, 'G');
  f = app.lastFrame();
  assert.ok(f.includes('cmd-080') && f.includes('live') && f.includes('80/80'), f);
  app.unmount();
});

test('decisions: search with / narrows rows, typing digits does not switch tabs, esc clears', async () => {
  const app = await mount(fakeSource());
  await press(app, '3');
  await press(app, '/');
  assert.ok(app.lastFrame().includes('search:'));
  await type(app, 'rm');
  assert.ok(app.lastFrame().includes('search: rm'));
  await press(app, '\r');
  let f = app.lastFrame();
  assert.ok(f.includes('search "rm"') && f.includes('rm -rf /') && !f.includes('~/a.txt'), f);
  await press(app, '/');
  await press(app, '\u007F'); // backspace
  await press(app, '\u007F');
  await type(app, '3');
  assert.ok(app.lastFrame().includes('search: 3'), 'digit typed into the box, tab unchanged');
  await press(app, '\u001B'); // esc cancels typing
  await press(app, '\u001B'); // esc clears the applied search
  await settle(120);
  f = app.lastFrame();
  assert.ok(!f.includes('search "') && f.includes('~/a.txt'), f);
  await press(app, '/');
  await type(app, 'zzz');
  await press(app, '\r');
  assert.ok(app.lastFrame().includes('Nothing matches'));
  app.unmount();
});

test('decisions: space pauses the view while new records arrive', async () => {
  const log = [...AUDIT];
  const app = await mount(fakeSource({ audit: () => log }));
  await press(app, '3');
  await press(app, ' ');
  assert.ok(app.lastFrame().includes('paused'));
  log.push(rec(4, { tool: 'Bash', final: 'allow', verdict: 'allow', derived: { command: 'late-arrival' }, reason: 'r' }));
  await settle(120);
  assert.ok(!app.lastFrame().includes('late-arrival'));
  await press(app, ' ');
  await settle(120);
  assert.ok(app.lastFrame().includes('late-arrival'));
  app.unmount();
});

test('holds: detail pane shows command, rule and a countdown; approve asks to confirm then resolves', async () => {
  const src = fakeSource();
  const app = await mount(src);
  await press(app, '2');
  const f = app.lastFrame();
  for (const t of ['npm publish', 'package publish', 'cursor', 'waiting', '20s', 'auto-reject', '1m 40s']) assert.ok(f.includes(t), `missing ${t}\n${f}`);
  await press(app, 'a');
  assert.ok(app.lastFrame().includes('Approve this call?'));
  await press(app, 'y');
  assert.deepEqual(src.resolved, [['h1', 'approved']]);
  app.unmount();
});

test('holds: reject can be cancelled', async () => {
  const src = fakeSource();
  const app = await mount(src);
  await press(app, '2');
  await press(app, 'r');
  assert.ok(app.lastFrame().includes('Reject this call?'));
  await press(app, 'n');
  assert.deepEqual(src.resolved, []);
  assert.ok(!app.lastFrame().includes('Reject this call?'));
  app.unmount();
});

test('daemon down: says so and disables holds', async () => {
  const src = fakeSource({ mode: 'direct', status: async () => null, holds: async () => [] });
  const app = await mount(src);
  assert.ok(app.lastFrame().includes('offline') && app.lastFrame().includes('not running'));
  await press(app, '2');
  assert.ok(app.lastFrame().includes('armord start'));
  await press(app, 'a');
  assert.deepEqual(src.resolved, []);
  app.unmount();
});

test('policies: fold, search and reload; help toggles', async () => {
  const src = fakeSource();
  const app = await mount(src);
  await press(app, '4');
  assert.ok(app.lastFrame().includes('[destructive]') && app.lastFrame().includes('Read'));
  await press(app, '\r'); // fold the document under the cursor
  assert.ok(!app.lastFrame().includes('[destructive]'));
  await press(app, '\r');
  assert.ok(app.lastFrame().includes('[destructive]'));
  await press(app, '/');
  await type(app, 'destr');
  await press(app, '\r');
  const f = app.lastFrame();
  assert.ok(f.includes('[destructive]') && !f.includes('allow Read') && f.includes('search "destr"'), f);
  await press(app, '\u001B');
  await press(app, 'r');
  assert.equal(src.reloads, 1);
  await press(app, '?');
  assert.ok(app.lastFrame().includes('switch screen'));
  await press(app, '?');
  assert.ok(!app.lastFrame().includes('switch screen'));
  app.unmount();
});

test('narrow terminals: compact tab bar, no rule column, nothing wider than the screen', async () => {
  const size = { columns: 60, rows: 24 };
  const app = await mount(fakeSource(), size);
  let f = app.lastFrame();
  const head = f.split(String.fromCharCode(10))[0];
  assert.ok(head.includes('1 Overview') && !head.includes('Decisions'), f);
  for (const k of ['1', '2', '3', '4', '5']) {
    await press(app, k);
    for (const line of app.lastFrame().split('\n')) assert.ok(line.length <= size.columns, `line too wide on tab ${k}: ${line.length}\n${line}`);
  }
  await press(app, '3');
  f = app.lastFrame();
  assert.ok(f.includes('target') && !f.includes(' rule '), f);
  app.unmount();
});

test('short terminals: overview collapses to plain lines', async () => {
  const app = await mount(fakeSource(), { columns: 100, rows: 14 });
  const f = app.lastFrame();
  assert.ok(f.includes('allow 5') && f.includes('pending holds') && !f.includes('╭'.repeat(2)), f);
  assert.ok(f.split('\n').length <= 14);
  app.unmount();
});

test('wide screens never overflow the width, on any tab', async () => {
  const app = await mount(fakeSource());
  for (const k of ['1', '2', '3', '4', '5']) {
    await press(app, k);
    for (const line of app.lastFrame().split('\n')) assert.ok(line.length <= WIDE.columns, `tab ${k}: ${line.length}`);
  }
  app.unmount();
});

test('demo mode fills every screen without a daemon', async () => {
  const src = demoSource({ now: () => NOW });
  const app = await mount(src);
  let f = app.lastFrame();
  assert.ok(f.includes('demo') && f.includes('Allow') && f.includes('Recent decisions') && f.includes('claude-code (user)'), f);
  await press(app, '2');
  f = app.lastFrame();
  assert.ok(f.includes('npm publish --access public') && f.includes('2 waiting'), f);
  await press(app, '3');
  f = app.lastFrame();
  assert.ok(f.includes('ALLOW') && f.includes('BLOCK') && f.includes('filter all'), f);
  await press(app, '4');
  f = app.lastFrame();
  assert.ok(f.includes('local:armordev') && f.includes('local:starter') && f.includes('2 documents'), f);
  await press(app, '5');
  f = app.lastFrame();
  assert.ok(f.includes('autostart') && f.includes('fix: armord service install'), f);
  app.unmount();
  src.close();
});

test('demo mode: approving a hold removes it and logs the decision', async () => {
  const src = demoSource({ now: () => NOW });
  const before = src.audit().length;
  const app = await mount(src);
  await press(app, '2');
  await press(app, 'a');
  await press(app, 'y');
  await settle(120);
  assert.equal((await src.holds()).length, 1);
  assert.equal(src.audit().length, before + 1);
  assert.ok(app.lastFrame().includes('1 waiting'));
  app.unmount();
  src.close();
});

test('demo data covers every verdict and many tools', () => {
  const rows = demoAudit(NOW);
  assert.equal(rows.length, 36);
  assert.deepEqual([...new Set(rows.map((r) => r.verdict))].sort(), ['allow', 'block', 'hold']);
  assert.ok(new Set(rows.map((r) => r.tool)).size >= 6);
});
