// armor-tui: Interactive terminal dashboard for armord.
// Displays live MCP servers, real-time audit stream, and 1-key interactive hold resolution ([y]/[n]).

import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { ArmordClient, socketPath } from './ipc.js';
import type { AuditRecord } from './audit.js';

interface HoldItem {
  id: string;
  tool: string;
  reason: string;
  summary?: string;
  args?: Record<string, unknown>;
  ts: string;
}

interface McpServerSummary {
  name: string;
  host: string;
  status: 'active' | 'pinned' | 'configured';
  toolCount?: number;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  bgBlue: '\x1b[44m',
  bgDark: '\x1b[40m',
  clearScreen: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

type FilterMode = 'ALL' | 'BLOCK' | 'HOLD';

export async function runTui(): Promise<void> {
  const home = process.env.ARMORD_HOME ?? join(homedir(), '.armoriq', 'armord');
  const auditFile = join(home, 'audit.jsonl');
  const pinsDir = join(home, 'pins');

  const client = new ArmordClient(socketPath());
  let daemonOnline = false;
  let daemonInfo: Record<string, unknown> = {};

  try {
    daemonInfo = (await client.call('status')) as Record<string, unknown>;
    daemonOnline = true;
  } catch {
    daemonOnline = false;
  }

  const rawRecords: AuditRecord[] = [];
  let pendingHolds: HoldItem[] = [];
  let selectedHoldIdx = 0;
  let statusMessage = 'Connected to armord daemon';
  let filterMode: FilterMode = 'ALL';

  // Stats counters
  let totalEvaluations = 0;
  let allowedCount = 0;
  let blockedCount = 0;
  let heldCount = 0;

  function processRecord(rec: AuditRecord) {
    rawRecords.push(rec);
    totalEvaluations++;
    const v = String(rec.final ?? rec.verdict ?? '').toUpperCase();
    if (v === 'ALLOW') allowedCount++;
    else if (v === 'BLOCK') blockedCount++;
    else if (v === 'HOLD') heldCount++;
    if (rawRecords.length > 200) rawRecords.shift();
  }

  // Read initial audit events
  if (existsSync(auditFile)) {
    try {
      const lines = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as AuditRecord;
          processRecord(rec);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* busy */
    }
  }

  // Discover configured MCP servers
  const mcpServers = discoverMcpServers(home, pinsDir);

  // Watch audit log live
  let logSize = existsSync(auditFile) ? statSync(auditFile).size : 0;
  watchFile(auditFile, { interval: 250 }, (cur) => {
    if (cur.size <= logSize) return;
    try {
      const chunk = readFileSync(auditFile, 'utf8').slice(logSize);
      logSize = cur.size;
      for (const line of chunk.split('\n').filter(Boolean)) {
        try {
          const rec = JSON.parse(line) as AuditRecord;
          processRecord(rec);
          render();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* busy */
    }
  });

  // Poll holds if daemon online
  const holdInterval = setInterval(async () => {
    if (!daemonOnline) {
      try {
        daemonInfo = (await client.call('status')) as Record<string, unknown>;
        daemonOnline = true;
      } catch {
        daemonOnline = false;
      }
    }
    if (daemonOnline) {
      try {
        const rawHolds = (await client.call('holds.list')) as HoldItem[];
        pendingHolds = rawHolds ?? [];
        if (selectedHoldIdx >= pendingHolds.length) selectedHoldIdx = Math.max(0, pendingHolds.length - 1);
        render();
      } catch {
        daemonOnline = false;
      }
    }
  }, 1000);

  function formatEvent(r: AuditRecord): string {
    const verdict = String(r.final ?? r.verdict ?? 'INFO').toUpperCase();
    let badge = `${C.green} ALLOW ${C.reset}`;
    if (verdict === 'BLOCK') badge = `${C.red} BLOCK ${C.reset}`;
    else if (verdict === 'HOLD') badge = `${C.yellow} HOLD  ${C.reset}`;

    const time = r.ts ? r.ts.slice(11, 19) : '--:--:--';
    const d = (r.derived ?? {}) as Record<string, unknown>;
    const target = d.command ?? d.path ?? d.url ?? d.host ?? '';
    const desc = r.tool ? `${r.tool} ${String(target).slice(0, 32)}` : r.event;
    const reason = r.reason ? ` ${C.dim}(${String(r.reason).slice(0, 30)})${C.reset}` : '';
    return `${C.dim}${time}${C.reset} [${badge}] ${C.bold}${desc}${C.reset}${reason}`;
  }

  function render(): void {
    const width = process.stdout.columns || 110;

    let buf = C.clearScreen + C.hideCursor;

    // Header Banner
    const daemonTag = daemonOnline ? `${C.green}● ONLINE${C.reset}` : `${C.red}● OFFLINE${C.reset}`;
    buf += ` ${C.bgBlue}${C.bold} ARMORIQ AGENT GUARDIAN (armord TUI) ${C.reset}  Daemon: ${daemonTag}  ${C.dim}Pipe: ${socketPath()}${C.reset}\n`;
    buf += ` ${C.dim}Evaluations:${C.reset} ${C.bold}${totalEvaluations}${C.reset}  │  ${C.green}Allowed: ${allowedCount}${C.reset}  │  ${C.red}Blocked: ${blockedCount}${C.reset}  │  ${C.yellow}Held: ${heldCount}${C.reset}  │  ${C.cyan}Filter: ${filterMode}${C.reset}\n`;
    buf += '─'.repeat(Math.min(width, 115)) + '\n\n';

    // Left Column: Servers & Approvals
    const leftWidth = 44;
    const leftLines: string[] = [];

    // 1. MCP Servers Box
    leftLines.push(`${C.bold}${C.cyan}╭── Governed MCP Servers [${mcpServers.length}] ───────────╮${C.reset}`);
    if (mcpServers.length === 0) {
      leftLines.push(`│ ${C.dim}No servers pinned or detected yet       │${C.reset}`);
    } else {
      for (const s of mcpServers.slice(0, 6)) {
        const dot = s.status === 'pinned' ? `${C.green}●${C.reset}` : `${C.yellow}○${C.reset}`;
        const nameStr = s.name.slice(0, 18).padEnd(18);
        const hostStr = `[${s.host}]`.slice(0, 12).padEnd(12);
        leftLines.push(`│ ${dot} ${C.bold}${nameStr}${C.reset} ${C.dim}${hostStr}${C.reset}    │`);
      }
    }
    leftLines.push(`${C.bold}${C.cyan}╰──────────────────────────────────────────╯${C.reset}`);
    leftLines.push('');

    // 2. Holds Box
    const holdCount = pendingHolds.length;
    const holdTitle = holdCount > 0 ? `${C.yellow}▲ Pending Approvals [${holdCount}]${C.reset}` : `${C.green}✓ Approvals Queue Clean${C.reset}`;
    leftLines.push(`${C.bold}${C.yellow}╭── ${holdTitle} ` + '─'.repeat(Math.max(0, leftWidth - 27)) + `╮${C.reset}`);

    if (holdCount === 0) {
      leftLines.push(`│ ${C.dim}Autonomous actions requiring human sign-off│${C.reset}`);
      leftLines.push(`│ ${C.dim}will appear here with 1-key [y]/[n].       │${C.reset}`);
    } else {
      for (let i = 0; i < Math.min(holdCount, 3); i++) {
        const h = pendingHolds[i]!;
        const prefix = i === selectedHoldIdx ? `${C.yellow}►${C.reset}` : ' ';
        leftLines.push(`│ ${prefix} ${C.bold}${h.tool}${C.reset} ${C.dim}#${h.id.slice(0, 8)}${C.reset}`);
        leftLines.push(`│   ${C.yellow}${h.reason.slice(0, 36)}${C.reset}`);
        if (h.summary) leftLines.push(`│   ${C.dim}${h.summary.slice(0, 36)}${C.reset}`);
      }
    }
    leftLines.push(`${C.bold}${C.yellow}╰──────────────────────────────────────────╯${C.reset}`);

    // Right Column: Filtered Event Stream
    let filtered = rawRecords;
    if (filterMode === 'BLOCK') filtered = rawRecords.filter((r) => String(r.final ?? r.verdict).toUpperCase() === 'BLOCK');
    else if (filterMode === 'HOLD') filtered = rawRecords.filter((r) => String(r.final ?? r.verdict).toUpperCase() === 'HOLD');

    const maxStreamLines = 14;
    const streamSlice = filtered.slice(-maxStreamLines).map(formatEvent);

    const outLines: string[] = [];
    const maxRows = Math.max(leftLines.length, streamSlice.length + 1);

    outLines.push(`${' '.repeat(leftWidth + 2)} ${C.bold}${C.cyan}╭── Live Policy Decisions ─────────────────────────────╮${C.reset}`);

    for (let r = 0; r < maxRows; r++) {
      const leftPart = leftLines[r] ?? ' '.repeat(leftWidth + 2);
      const rightPart = streamSlice[r] ?? '';
      outLines.push(`${leftPart.padEnd(leftWidth + 4)} ${rightPart}`);
    }

    buf += outLines.join('\n') + '\n\n';

    // Footer Hotkeys & Status
    buf += '─'.repeat(Math.min(width, 115)) + '\n';
    buf += ` ${C.bold}[y]${C.reset} Approve Hold    ${C.bold}[n]${C.reset} Reject Hold    ${C.bold}[f]${C.reset} Toggle Filter    ${C.bold}[c]${C.reset} Clear Log    ${C.bold}[q]${C.reset} Quit\n`;
    if (statusMessage) {
      buf += ` ${C.cyan}Status:${C.reset} ${statusMessage}\n`;
    }

    process.stdout.write(buf);
  }

  // Setup Keypress listener
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  const cleanup = () => {
    unwatchFile(auditFile);
    clearInterval(holdInterval);
    client.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(C.showCursor + '\n');
  };

  process.stdin.on('keypress', async (_str, key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.exit(0);
    }
    if (key.name === 'q') {
      cleanup();
      process.exit(0);
    }
    if (key.name === 'f') {
      if (filterMode === 'ALL') filterMode = 'BLOCK';
      else if (filterMode === 'BLOCK') filterMode = 'HOLD';
      else filterMode = 'ALL';
      statusMessage = `Filter set to ${filterMode}`;
      render();
    }
    if (key.name === 'c') {
      rawRecords.length = 0;
      totalEvaluations = 0;
      allowedCount = 0;
      blockedCount = 0;
      heldCount = 0;
      statusMessage = 'Event stream and counters reset';
      render();
    }
    if (key.name === 'r') {
      statusMessage = 'Refreshed';
      render();
    }
    if (key.name === 'y') {
      if (pendingHolds.length > 0) {
        const hold = pendingHolds[selectedHoldIdx] || pendingHolds[0];
        if (hold && daemonOnline) {
          try {
            await client.call('holds.resolve', { id: hold.id, outcome: 'approved' });
            statusMessage = `Approved hold #${hold.id.slice(0, 8)} (${hold.tool})`;
            pendingHolds.splice(selectedHoldIdx, 1);
          } catch (err) {
            statusMessage = `Approve failed: ${(err as Error).message}`;
          }
        }
      } else {
        statusMessage = 'No pending holds to approve';
      }
      render();
    }
    if (key.name === 'n') {
      if (pendingHolds.length > 0) {
        const hold = pendingHolds[selectedHoldIdx] || pendingHolds[0];
        if (hold && daemonOnline) {
          try {
            await client.call('holds.resolve', { id: hold.id, outcome: 'rejected' });
            statusMessage = `Rejected hold #${hold.id.slice(0, 8)} (${hold.tool})`;
            pendingHolds.splice(selectedHoldIdx, 1);
          } catch (err) {
            statusMessage = `Reject failed: ${(err as Error).message}`;
          }
        }
      } else {
        statusMessage = 'No pending holds to reject';
      }
      render();
    }
  });

  render();
}

function discoverMcpServers(home: string, _pinsDir: string): McpServerSummary[] {
  const list: McpServerSummary[] = [];

  // 1. Claude settings
  const claudeJson = join(homedir(), '.claude.json');
  if (existsSync(claudeJson)) {
    try {
      const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
      if (doc.mcpServers) {
        for (const k of Object.keys(doc.mcpServers)) {
          list.push({ name: k, host: 'claude', status: 'configured' });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Codex config
  const codexToml = join(homedir(), '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const text = readFileSync(codexToml, 'utf8');
      const matches = text.matchAll(/\[mcp_servers\.([^\]]+)\]/g);
      for (const m of matches) {
        if (m[1]) list.push({ name: m[1], host: 'codex', status: 'configured' });
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Cursor mcp
  const cursorMcp = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorMcp)) {
    try {
      const doc = JSON.parse(readFileSync(cursorMcp, 'utf8'));
      if (doc.mcpServers) {
        for (const k of Object.keys(doc.mcpServers)) {
          list.push({ name: k, host: 'cursor', status: 'configured' });
        }
      }
    } catch {
      /* ignore */
    }
  }

  return list;
}
