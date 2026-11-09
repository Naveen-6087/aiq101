import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Check } from '../commands.js';
import { cell, clampIndex, truncate } from './data.js';
import { Panel, STATUS_COLOR, type Size } from './ui.js';

export function Doctor({ checks, size, body, onRerun }: { checks: Check[] | null; size: Size; body: number; onRerun: () => void }) {
  const [top, setTop] = useState(0);
  const lines = (checks ?? []).flatMap((c) => [{ c, fix: false }, ...(c.fix ? [{ c, fix: true }] : [])]);
  const visible = Math.max(1, body - 3);
  const start = clampIndex(top, Math.max(1, lines.length - visible + 1));
  const end = Math.min(lines.length, start + visible);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow || input === 'j') setTop((t) => Math.min(Math.max(0, lines.length - visible), t + 1));
    else if (input === 'r') onRerun();
  });

  const bad = (checks ?? []).filter((c) => c.status !== 'ok').length;
  const right = checks ? (bad ? `${bad} to look at` : 'all good') : 'running';
  const inner = size.columns - 4;
  return (
    <Panel title="Doctor" right={right} width={size.columns} height={body}>
      {!checks ? <Text dimColor>Running checks...</Text> : null}
      {lines.slice(start, end).map(({ c, fix }, i) =>
        fix ? (
          <Text key={`${c.name}-fix-${i}`} dimColor wrap="truncate-end">
            {'                   '}fix: {c.fix}
          </Text>
        ) : (
          <Text key={c.name} wrap="truncate-end">
            <Text color={STATUS_COLOR[c.status]} bold>
              {cell(c.status, 5)}
            </Text>{' '}
            {cell(c.name, 12)} {truncate(c.detail, Math.max(10, inner - 19))}
          </Text>
        ),
      )}
    </Panel>
  );
}
