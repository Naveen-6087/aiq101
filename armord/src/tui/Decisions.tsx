import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AuditRecord } from '../audit.js';
import { cell, clampIndex, decisionColumns, decisionFacts, decisionTarget, filterDecisions, nextFilter, shortTool, verdictOf, windowRows, type Filter } from './data.js';
import { ACCENT, Kv, Panel, VERDICT_COLOR, type Size } from './ui.js';

interface Props {
  audit: AuditRecord[];
  size: Size;
  body: number;
  onCapture: (on: boolean) => void;
}

export function Decisions({ audit, size, body, onCapture }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string | null>(null); // non-null while typing a search
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState(0);
  const [frozen, setFrozen] = useState<AuditRecord[] | null>(null);
  const [detail, setDetail] = useState(false);

  const rows = filterDecisions(frozen ?? audit, filter, query);
  const idx = follow ? Math.max(0, rows.length - 1) : clampIndex(sel, rows.length);
  const detailH = detail ? Math.min(13, Math.max(6, Math.floor(body / 2))) : 0;
  const visible = Math.max(1, body - 4 - detailH);
  const count = useRef(rows.length);
  count.current = rows.length;
  useEffect(() => onCapture(draft !== null), [draft, onCapture]);

  const moveTo = (i: number) => {
    const n = count.current;
    const next = clampIndex(i, n);
    if (next >= n - 1) setFollow(true);
    else (setFollow(false), setSel(next));
  };

  useInput((input, key) => {
    if (draft !== null) {
      if (key.return) (setQuery(draft.trim()), setDraft(null), setFollow(true));
      else if (key.escape) setDraft(null);
      else if (key.backspace || key.delete) setDraft((d) => (d ?? '').slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft((d) => (d ?? '') + input);
      return;
    }
    if (key.upArrow || input === 'k') moveTo(idx - 1);
    else if (key.downArrow || input === 'j') moveTo(idx + 1);
    else if (key.pageUp) moveTo(idx - visible);
    else if (key.pageDown) moveTo(idx + visible);
    else if (input === 'g') moveTo(0);
    else if (input === 'G') setFollow(true);
    else if (input === 'f') (setFilter((f) => nextFilter(f)), setFollow(true));
    else if (input === '/') setDraft(query);
    else if (input === ' ') setFrozen((f) => (f ? null : [...audit]));
    else if (key.escape && query) (setQuery(''), setFollow(true));
    else if (key.return) setDetail((d) => !d);
  });

  const inner = size.columns - 4;
  const col = decisionColumns(inner);
  const { start, end } = windowRows(rows.length, idx, visible);
  const cur = rows[idx];
  const status = [`filter ${filter}`, query ? `search "${query}"` : '', frozen ? 'paused' : follow ? 'live' : '', `${rows.length ? idx + 1 : 0}/${rows.length}`].filter(Boolean).join('  ');

  return (
    <Box flexDirection="column">
      <Panel title="Decisions" right={status} width={size.columns} height={body - detailH}>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {cell('time', col.time)} {cell('verdict', col.verdict)} {cell('tool', col.tool)} {col.rule ? cell('rule', col.rule) + ' ' : ''}
          target
        </Text>
        {rows.length === 0 ? <Text dimColor>{audit.length === 0 ? 'No decisions logged yet.' : 'Nothing matches the current filter or search.'}</Text> : null}
        {rows.slice(start, end).map((r, i) => {
          const on = start + i === idx;
          const v = verdictOf(r);
          return (
            <Text key={r.seq} wrap="truncate-end" bold={on}>
              <Text color={ACCENT}>{on ? '> ' : '  '}</Text>
              <Text dimColor={!on}>{cell(r.ts.slice(11, 19), col.time)}</Text>{' '}
              <Text color={VERDICT_COLOR[v]} bold>
                {cell(v.toUpperCase(), col.verdict)}
              </Text>{' '}
              {cell(shortTool(String(r.tool ?? '')), col.tool)}{' '}
              {col.rule ? <Text dimColor>{cell(String(r.statementId ?? ''), col.rule)} </Text> : null}
              {cell(decisionTarget(r) || String(r.reason ?? ''), col.target)}
            </Text>
          );
        })}
        {draft !== null ? (
          <Text color={ACCENT} wrap="truncate-end">
            search: {draft}_  <Text dimColor>enter apply  esc cancel</Text>
          </Text>
        ) : null}
      </Panel>
      {detail ? (
        <Panel title="Record" width={size.columns} height={detailH}>
          {cur ? (
            decisionFacts(cur)
              .slice(0, detailH - 3)
              .map(([k, v]) => (
                <Kv key={k} label={k} lw={13}>
                  {v}
                </Kv>
              ))
          ) : (
            <Text dimColor>Select a decision.</Text>
          )}
        </Panel>
      ) : null}
    </Box>
  );
}
