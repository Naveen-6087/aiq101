// Small shared building blocks. Everything is plain text and borders: no icons, one accent colour.

import React from 'react';
import { Box, Text } from 'ink';
import { cell } from './data.js';

export const ACCENT = 'cyan';
export const VERDICT_COLOR = { allow: 'green', hold: 'yellow', block: 'red', other: 'gray' } as const;
export const EFFECT_COLOR: Record<string, string> = { allow: 'green', hold: 'yellow', block: 'red' };
export const STATUS_COLOR: Record<string, string> = { ok: 'green', warn: 'yellow', fail: 'red' };

export interface Size {
  columns: number;
  rows: number;
}

export function Panel({ title, right, width, height, children }: { title: string; right?: string; width: number; height?: number; children?: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} width={width} height={height}>
      <Box justifyContent="space-between">
        <Text bold color={ACCENT} wrap="truncate-end">
          {title}
        </Text>
        {right ? (
          <Text dimColor wrap="truncate-end">
            {right}
          </Text>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

/** Label and value on one line; the value is cut, never wrapped, so rows keep their height. */
export function Kv({ label, children, lw = 14 }: { label: string; children: React.ReactNode; lw?: number }) {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{cell(label, lw)}</Text>
      {children}
    </Text>
  );
}

export function Hint({ keys, text }: { keys: string; text: string }) {
  return (
    <Text>
      <Text color={ACCENT}>{keys}</Text> <Text dimColor>{text}</Text>
    </Text>
  );
}
