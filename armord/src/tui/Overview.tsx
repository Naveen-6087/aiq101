import React from 'react';
import { Box, Text } from 'ink';
import { bar, cell, counts, decisionTarget, fmtLatency, pct, segments, shortHash, shortTool, verdictOf, visibleDecisions } from './data.js';
import type { Snapshot } from './App.js';
import { ACCENT, Kv, Panel, VERDICT_COLOR, type Size } from './ui.js';

function Stat({ label, n, total, color, width }: { label: string; n: number; total: number; color: string; width: number }) {
  return (
    <Panel title={label} right={pct(n, total)} width={width}>
      <Text bold color={color}>
        {n}
      </Text>
      <Text color={color} wrap="truncate-end">
        {bar(n, total, width - 4)}
      </Text>
    </Panel>
  );
}

export function Overview({ snap, mode, size, body }: { snap: Snapshot; mode: string; size: Size; body: number }) {
  const s = snap.status;
  const c = counts(s);
  const total = c.allow + c.hold + c.block;
  const w = size.columns;
  const wide = w >= 80;
  const pending = s?.pendingHolds ?? snap.holds.length;
  const state = mode === 'demo' ? 'demo data, no daemon' : mode === 'daemon' ? 'running' : 'not running (reading files)';
  const stateColor = mode === 'daemon' ? 'green' : mode === 'demo' ? ACCENT : 'yellow';
  const hooks = snap.hosts.length ? snap.hosts.map((h) => `${h.host} (${h.scope})`).join(', ') : 'none yet: armord install claude-code';
  const remote = s?.remote;

  // Short terminals: one plain block of facts instead of bordered cards.
  if (body < 17) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color="green">allow {c.allow}</Text>  <Text color="yellow">hold {c.hold}</Text>  <Text color="red">block {c.block}</Text>
        </Text>
        <Kv label="daemon">{state}</Kv>
        <Kv label="policy set">{shortHash(s?.policySetHash)}</Kv>
        <Kv label="pending holds">{String(pending)}</Kv>
        <Kv label="latency">
          p50 {fmtLatency(s?.latencyUs?.p50)}  p99 {fmtLatency(s?.latencyUs?.p99)}
        </Kv>
        <Kv label="bundle">{remote ? `${remote.status}, agent ${remote.agentId}` : 'not configured'}</Kv>
        <Kv label="hooks">{hooks}</Kv>
      </Box>
    );
  }

  const half = Math.floor(w / 2);
  const status = (
    <Panel title="Status" width={w}>
      <Kv label="state">
        <Text color={stateColor}>{state}</Text>
      </Kv>
      <Kv label="policy set">{shortHash(s?.policySetHash)}</Kv>
      <Kv label="pending holds">
        <Text color={pending > 0 ? 'yellow' : undefined}>{String(pending)}</Text>
      </Kv>
      <Kv label="latency">
        p50 {fmtLatency(s?.latencyUs?.p50)}  p99 {fmtLatency(s?.latencyUs?.p99)}
      </Kv>
      <Kv label="bundle">{remote ? `${remote.status}, ${remote.agentId.slice(0, 8)}` : 'not configured'}</Kv>
      <Kv label="hooks">{hooks}</Kv>
    </Panel>
  );
  const panels = (
    <Box>
      <Panel title="Daemon" width={half}>
        <Kv label="state">
          <Text color={stateColor}>{state}</Text>
        </Kv>
        <Kv label="policy set">{shortHash(s?.policySetHash)}</Kv>
        <Kv label="pending holds">
          <Text color={pending > 0 ? 'yellow' : undefined}>{String(pending)}</Text>
        </Kv>
        <Kv label="latency">
          p50 {fmtLatency(s?.latencyUs?.p50)}  p99 {fmtLatency(s?.latencyUs?.p99)}
        </Kv>
      </Panel>
      <Panel title="Remote policy" width={w - half}>
        {remote ? (
          <>
            <Kv label="agent">{remote.agentId}</Kv>
            <Kv label="bundle">
              <Text color={remote.status === 'current' ? 'green' : 'yellow'}>{remote.status}</Text>
            </Kv>
            <Kv label="policy">{remote.policyId ?? 'none (calls are allowed)'}</Kv>
          </>
        ) : (
          <Text dimColor wrap="truncate-end">
            not configured: set ARMORD_AGENT_ID and ARMORIQ_API_KEY
          </Text>
        )}
      </Panel>
    </Box>
  );

  // Stacked bar on narrow screens, three cards on wide ones.
  const top = wide ? (
    <Box>
      <Stat label="Allow" n={c.allow} total={total} color="green" width={Math.floor(w / 3)} />
      <Stat label="Hold" n={c.hold} total={total} color="yellow" width={Math.floor(w / 3)} />
      <Stat label="Block" n={c.block} total={total} color="red" width={w - 2 * Math.floor(w / 3)} />
    </Box>
  ) : (
    <Panel title="Decisions" right={`${total} this run`} width={w}>
      <Text wrap="truncate-end">
        <Text color="green">allow {c.allow}</Text>  <Text color="yellow">hold {c.hold}</Text>  <Text color="red">block {c.block}</Text>
      </Text>
      <Text wrap="truncate-end">
        {total === 0 ? (
          <Text dimColor>{bar(0, 1, w - 4)}</Text>
        ) : (
          (() => {
            const [a = 0, h = 0, bl = 0] = segments([c.allow, c.hold, c.block], w - 4);
            return (
              <>
                <Text color="green">{'█'.repeat(a)}</Text>
                <Text color="yellow">{'█'.repeat(h)}</Text>
                <Text color="red">{'█'.repeat(bl)}</Text>
              </>
            );
          })()
        )}
      </Text>
    </Panel>
  );

  // Whatever height is left over shows the newest decisions.
  const used = 5 + 6 + 3;
  const recentRows = Math.min(8, body - used - 3);
  const recent = recentRows >= 2 ? visibleDecisions(snap.audit, 'all', recentRows) : [];
  const inner = w - 4;

  if (!wide) {
    return (
      <Box flexDirection="column">
        {top}
        {status}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {top}
      {panels}
      <Panel title="Hooks" width={w}>
        <Text wrap="truncate-end">{hooks}</Text>
      </Panel>
      {recentRows >= 2 ? (
        <Panel title="Recent decisions" right="press 3 for all" width={w}>
          {recent.length === 0 ? <Text dimColor>none yet</Text> : null}
          {recent.map((r) => {
            const v = verdictOf(r);
            return (
              <Text key={r.seq} wrap="truncate-end">
                <Text dimColor>{r.ts.slice(11, 19)}</Text>{' '}
                <Text color={VERDICT_COLOR[v]} bold>
                  {cell(v.toUpperCase(), 5)}
                </Text>{' '}
                {cell(shortTool(String(r.tool ?? '')), 14)} {cell(decisionTarget(r), Math.max(8, inner - 8 - 1 - 5 - 1 - 14 - 1))}
              </Text>
            );
          })}
        </Panel>
      ) : null}
    </Box>
  );
}
