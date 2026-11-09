import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { cell, clampIndex, fmtDuration, holdAge, holdFacts, holdRemaining, holdTarget, windowRows, type HoldRow } from './data.js';
import { wrapLines } from './wrap.js';
import { ACCENT, Kv, Panel, type Size } from './ui.js';

interface Props {
  holds: HoldRow[];
  mode: string;
  size: Size;
  body: number;
  now: number;
  timeoutMs: number;
  resolve: (id: string, outcome: 'approved' | 'rejected') => Promise<void>;
  onNote: (s: string) => void;
  refresh: () => Promise<void>;
}

export function Holds({ holds, mode, size, body, now, timeoutMs, resolve, onNote, refresh }: Props) {
  const [idx, setIdx] = useState(0);
  const [confirm, setConfirm] = useState<'approved' | 'rejected' | null>(null);
  const enabled = mode !== 'direct';
  const sel = holds[clampIndex(idx, holds.length)];

  useInput((input, key) => {
    if (confirm) {
      if (input === 'y' || input === 'Y') {
        const h = sel;
        setConfirm(null);
        if (h) void resolve(h.id, confirm).then(() => (onNote(`${confirm} ${h.tool}`), refresh())).catch((e: Error) => onNote(`failed: ${e.message}`));
      } else if (input === 'n' || input === 'N' || key.escape) setConfirm(null);
      return;
    }
    if (key.upArrow || input === 'k') setIdx((i) => clampIndex(i - 1, holds.length));
    else if (key.downArrow || input === 'j') setIdx((i) => clampIndex(i + 1, holds.length));
    else if (holds.length && enabled && input === 'a') setConfirm('approved');
    else if (holds.length && enabled && input === 'r') setConfirm('rejected');
  });

  if (!enabled) {
    return (
      <Panel title="Held calls" width={size.columns}>
        <Text color="yellow">The daemon is not running, so there is nothing to approve.</Text>
        <Text dimColor>Start it with: armord start</Text>
      </Panel>
    );
  }
  if (holds.length === 0) {
    return (
      <Panel title="Held calls" right="0 waiting" width={size.columns}>
        <Text dimColor>Nothing is waiting for you. Held calls appear here the moment they happen.</Text>
      </Panel>
    );
  }

  const wide = size.columns >= 80;
  const listW = wide ? Math.floor(size.columns * 0.42) : size.columns;
  const detailW = wide ? size.columns - listW : size.columns;
  const fit = Math.min(body, Math.max(11, holds.length + 3));
  const listH = wide ? fit : Math.min(holds.length + 3, Math.max(5, Math.floor(body / 2)));
  const detailH = wide ? fit : Math.min(Math.max(8, body - listH), 12);
  const visible = Math.max(1, listH - 3);
  const { start, end } = windowRows(holds.length, clampIndex(idx, holds.length), visible);
  const inner = listW - 4;
  const remaining = sel ? holdRemaining(sel.createdAt, timeoutMs, now) : 0;
  const facts = sel ? holdFacts(sel) : [];
  const dw = detailW - 4 - 14;

  return (
    <Box flexDirection={wide ? 'row' : 'column'}>
      <Panel title="Held calls" right={`${holds.length} waiting`} width={listW} height={listH}>
        {holds.slice(start, end).map((h) => {
          const on = h.id === sel?.id;
          const age = fmtDuration(holdAge(h.createdAt, now));
          return (
            <Text key={h.id} wrap="truncate-end" bold={on}>
              <Text color={ACCENT}>{on ? '> ' : '  '}</Text>
              {cell(h.tool, 9)} <Text dimColor>{cell(holdTarget(h), Math.max(6, inner - 2 - 9 - 1 - 6))}</Text> <Text dimColor>{age.padStart(5)}</Text>
            </Text>
          );
        })}
      </Panel>
      <Panel title="Selected call" width={detailW} height={detailH}>
        {facts.map(([k, v]) => {
          const lines = wrapLines(v, dw, k === 'command' ? 3 : 1);
          return (
            <Box key={k}>
              <Box width={14}>
                <Text dimColor>{k}</Text>
              </Box>
              <Box flexDirection="column">
                {lines.map((l, i) => (
                  <Text key={i} color={k === 'rule' ? 'yellow' : undefined}>
                    {l}
                  </Text>
                ))}
              </Box>
            </Box>
          );
        })}
        {sel ? (
          <>
            <Kv label="waiting" lw={14}>
              {fmtDuration(holdAge(sel.createdAt, now))}
            </Kv>
            <Kv label="auto-reject" lw={14}>
              <Text color={remaining < 30 ? 'red' : 'yellow'}>in {fmtDuration(remaining)}</Text>
            </Kv>
          </>
        ) : null}
        <Box marginTop={1}>
          {confirm ? (
            <Text color={confirm === 'approved' ? 'green' : 'red'} bold wrap="truncate-end">
              {confirm === 'approved' ? 'Approve' : 'Reject'} this call? y confirm  n cancel
            </Text>
          ) : (
            <Text dimColor wrap="truncate-end">
              a approve  r reject
            </Text>
          )}
        </Box>
      </Panel>
    </Box>
  );
}
