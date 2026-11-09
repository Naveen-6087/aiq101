import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { AuditRecord } from '../audit.js';
import type { Check } from '../commands.js';
import type { TuiSource } from './source.js';
import { TABS, clampSize, type HoldRow, type PolicyDoc, type StatusInfo, type Tab } from './data.js';
import { Decisions } from './Decisions.js';
import { Doctor } from './Doctor.js';
import { Holds } from './Holds.js';
import { Overview } from './Overview.js';
import { Policies } from './Policies.js';
import { ACCENT, Panel, type Size } from './ui.js';

export interface Snapshot {
  status: StatusInfo | null;
  holds: HoldRow[];
  audit: AuditRecord[];
  policies: { docs: PolicyDoc[]; problems: Array<{ severity: string; file: string; message: string }> };
  hosts: Array<{ host: string; scope: string }>;
}

const EMPTY: Snapshot = { status: null, holds: [], audit: [], policies: { docs: [], problems: [] }, hosts: [] };

const HINTS: Record<Tab, string> = {
  Overview: 'refreshes every second',
  Holds: 'j/k select  a approve  r reject',
  Decisions: 'j/k PgUp/PgDn scroll  f filter  / search  space pause  enter detail',
  Policies: 'j/k move  enter fold  / search  r reload',
  Doctor: 'j/k scroll  r re-run',
};

const HELP: Array<[string, string]> = [
  ['1-5, left/right', 'switch screen'],
  ['j / k, up / down', 'move in a list'],
  ['PgUp / PgDn, g / G', 'page, jump to top / newest'],
  ['Holds', 'a approve, r reject, then y to confirm or n to cancel'],
  ['Decisions', 'f filter (all, block, hold), / search, space pause, enter detail, esc clear search'],
  ['Policies', 'enter fold a document, / search, r reload from disk'],
  ['Doctor', 'r run the checks again'],
  ['?  q', 'toggle this help, quit'],
];

function useSize(override?: Size): Size {
  const { stdout } = useStdout();
  const read = () => clampSize(stdout?.columns, stdout?.rows);
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (override || !stdout) return;
    const on = () => setSize(read());
    stdout.on('resize', on);
    return () => void stdout.off('resize', on);
  }, [stdout, override]);
  return override ?? size;
}

export function App({ source, pollMs = 1000, size: sizeProp, now: nowFn = Date.now }: { source: TuiSource; pollMs?: number; size?: Size; now?: () => number }) {
  const { exit } = useApp();
  const size = useSize(sizeProp ? clampSize(sizeProp.columns, sizeProp.rows) : undefined);
  const [tab, setTab] = useState(0);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [help, setHelp] = useState(false);
  const [capture, setCapture] = useState(false);
  const [note, setNote] = useState('');
  const [now, setNow] = useState(nowFn());
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((s: string) => {
    setNote(s);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 4000);
  }, []);

  const refresh = useCallback(async () => {
    const [status, holds, policies] = await Promise.all([source.status(), source.holds(), source.policies()]);
    setSnap({ status, holds, audit: source.audit(), policies, hosts: source.hosts() });
  }, [source]);
  const runChecks = useCallback(() => {
    setChecks(null);
    void source.doctor().then(setChecks).catch(() => setChecks([{ name: 'doctor', status: 'fail', detail: 'checks failed to run' }]));
  }, [source]);
  const reload = useCallback(() => void source.reload().then(refresh).then(() => say('reloaded from disk')), [source, refresh, say]);

  useEffect(() => {
    void refresh();
    runChecks();
    const t = setInterval(() => void refresh(), pollMs);
    const c = setInterval(() => setNow(nowFn()), 1000);
    return () => (clearInterval(t), clearInterval(c));
  }, [refresh, runChecks, pollMs, nowFn]);
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);

  useInput(
    (input, key) => {
      if (input === 'q') return exit();
      if (input === '?') return setHelp((h) => !h);
      if (key.escape && help) return setHelp(false);
      if (/^[1-5]$/.test(input)) return (setHelp(false), setTab(Number(input) - 1));
      if (key.rightArrow) return (setHelp(false), setTab((t) => (t + 1) % TABS.length));
      if (key.leftArrow) return (setHelp(false), setTab((t) => (t + TABS.length - 1) % TABS.length));
    },
    { isActive: !capture },
  );

  const current = TABS[tab] as Tab;
  const body = Math.max(6, size.rows - 3);
  const narrow = size.columns < 80;
  const mode = source.mode;
  const pending = snap.holds.length;
  const stateWord = mode === 'daemon' ? { t: 'running', c: 'green' } : mode === 'demo' ? { t: 'demo', c: ACCENT } : { t: 'offline', c: 'yellow' };

  return (
    <Box flexDirection="column" width={size.columns}>
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color={ACCENT}>
            armord
          </Text>
          {'  '}
          <Text color={stateWord.c}>{stateWord.t}</Text>
          {'   '}
          {TABS.map((t, i) => {
            const label = t === 'Holds' && pending > 0 ? `Holds ${pending}` : t;
            const on = i === tab;
            if (narrow && !on) return <Text key={t} dimColor>{`${i + 1}  `}</Text>;
            return (
              <Text key={t}>
                <Text dimColor={!on}>{i + 1} </Text>
                <Text bold={on} underline={on} color={on ? ACCENT : t === 'Holds' && pending > 0 ? 'yellow' : undefined} dimColor={!on && !(t === 'Holds' && pending > 0)}>
                  {label}
                </Text>
                {'   '}
              </Text>
            );
          })}
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(size.columns)}</Text>

      <Box flexDirection="column" height={body}>
        {help ? (
          <Panel title="Keys" width={size.columns}>
            {HELP.map(([k, v]) => (
              <Text key={k} wrap="truncate-end">
                <Text color={ACCENT}>{k.padEnd(22)}</Text>
                <Text dimColor>{v}</Text>
              </Text>
            ))}
          </Panel>
        ) : current === 'Overview' ? (
          <Overview snap={snap} mode={mode} size={size} body={body} />
        ) : current === 'Holds' ? (
          <Holds holds={snap.holds} mode={mode} size={size} body={body} now={now} timeoutMs={snap.status?.holdTimeoutMs ?? 120_000} resolve={(id, o) => source.resolve(id, o)} onNote={say} refresh={refresh} />
        ) : current === 'Decisions' ? (
          <Decisions audit={snap.audit} size={size} body={body} onCapture={setCapture} />
        ) : current === 'Policies' ? (
          <Policies docs={snap.policies.docs} problems={snap.policies.problems} size={size} body={body} onCapture={setCapture} onReload={reload} />
        ) : (
          <Doctor checks={checks} size={size} body={body} onRerun={runChecks} />
        )}
      </Box>

      <Box paddingX={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {help ? 'esc close help' : HINTS[current]}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text>
            {note ? <Text color={ACCENT}>{note}  </Text> : null}
            <Text dimColor>{narrow ? '1-5  ?  q' : '1-5 tabs  ? help  q quit'}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
