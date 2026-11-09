import React, { useEffect, useRef, useState } from 'react';
import { Text, useInput } from 'ink';
import { cell, clampIndex, flattenPolicies, truncate, windowRows, type PolicyDoc } from './data.js';
import { ACCENT, EFFECT_COLOR, Panel, type Size } from './ui.js';

interface Props {
  docs: PolicyDoc[];
  problems: Array<{ severity: string; file: string; message: string }>;
  size: Size;
  body: number;
  onCapture: (on: boolean) => void;
  onReload: () => void;
}

export function Policies({ docs, problems, size, body, onCapture, onReload }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [cur, setCur] = useState(0);

  const lines = flattenPolicies(docs, problems, collapsed, query);
  const idx = clampIndex(cur, lines.length);
  const visible = Math.max(1, body - 3 - (draft !== null ? 1 : 0));
  const count = useRef(lines.length);
  count.current = lines.length;
  useEffect(() => onCapture(draft !== null), [draft, onCapture]);

  useInput((input, key) => {
    if (draft !== null) {
      if (key.return) (setQuery(draft.trim()), setDraft(null), setCur(0));
      else if (key.escape) setDraft(null);
      else if (key.backspace || key.delete) setDraft((d) => (d ?? '').slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft((d) => (d ?? '') + input);
      return;
    }
    if (key.upArrow || input === 'k') setCur((i) => clampIndex(i - 1, count.current));
    else if (key.downArrow || input === 'j') setCur((i) => clampIndex(i + 1, count.current));
    else if (key.pageUp) setCur((i) => clampIndex(i - visible, count.current));
    else if (key.pageDown) setCur((i) => clampIndex(i + visible, count.current));
    else if (input === '/') setDraft(query);
    else if (key.escape && query) setQuery('');
    else if (input === 'r') onReload();
    else if (key.return || input === ' ') {
      const l = lines[idx];
      if (l && l.docId && !query) {
        setCollapsed((c) => {
          const n = new Set(c);
          if (n.has(l.docId)) n.delete(l.docId);
          else n.add(l.docId);
          return n;
        });
        if (l.kind === 'stmt') setCur(lines.findIndex((x) => x.kind === 'doc' && x.docId === l.docId));
      }
    }
  });

  const { start, end } = windowRows(lines.length, idx, visible);
  const inner = size.columns - 4;
  const stmts = docs.reduce((n, d) => n + d.statements.length, 0);
  const right = [query ? `search "${query}"` : '', `${docs.length} document${docs.length === 1 ? '' : 's'}, ${stmts} statements`].filter(Boolean).join('  ');

  return (
    <Panel title="Policies" right={right} width={size.columns} height={body}>
      {docs.length === 0 ? <Text dimColor>No local policies. Add one with: armord init --template armordev</Text> : null}
      {lines.length === 0 && docs.length > 0 ? <Text dimColor>Nothing matches the search.</Text> : null}
      {lines.slice(start, end).map((l, i) => {
        const on = start + i === idx;
        return (
          <Text key={l.key} wrap="truncate-end" bold={on || l.kind === 'doc'}>
            <Text color={ACCENT}>{on ? '> ' : '  '}</Text>
            {l.kind === 'doc' ? (
              <>
                <Text dimColor>{l.collapsed ? '+ ' : '- '}</Text>
                <Text color={ACCENT}>{l.text}</Text>
              </>
            ) : l.kind === 'stmt' ? (
              <>
                {'    '}
                <Text color={EFFECT_COLOR[l.effect ?? ''] ?? 'gray'}>{cell(l.effect ?? '', 5)}</Text> <Text bold={false}>{truncate(l.text, Math.max(10, inner - 12))}</Text>
              </>
            ) : (
              <Text color={l.severity === 'error' ? 'red' : 'yellow'}>{truncate(l.text, Math.max(10, inner - 4))}</Text>
            )}
          </Text>
        );
      })}
      {draft !== null ? (
        <Text color={ACCENT} wrap="truncate-end">
          search: {draft}_  <Text dimColor>enter apply  esc cancel</Text>
        </Text>
      ) : null}
    </Panel>
  );
}
