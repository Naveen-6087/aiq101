// Install armord into agent hosts: merge hook entries into each host's own config file, and wrap
// MCP client configs so every stdio server runs behind `armord mcp-proxy`. Merges are idempotent,
// keep everything the user already has, and are reversible. A file that exists is copied once to
// <file>.armord-bak before the first change.

import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InstallHost = 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'openhands' | 'mcp';
export const INSTALL_HOSTS: InstallHost[] = ['claude-code', 'cursor', 'codex', 'gemini', 'openhands', 'mcp'];

export interface InstallOptions {
  scope: 'user' | 'project';
  cwd: string;
  home: string;
  dryRun?: boolean;
  /** Command that starts armord; defaults to `armord` (must be on PATH for the host process). */
  command?: string;
}

export interface Change {
  file: string;
  action: 'create' | 'merge' | 'unchanged' | 'remove';
  summary: string;
}
export interface InstallResult {
  changes: Change[];
}
export interface HostStatus {
  host: InstallHost;
  installed: boolean;
  files: { file: string; installed: boolean; exists: boolean }[];
}

type Json = Record<string, any>;
const BACKUP_SUFFIX = '.armord-bak';
export const ORIGINAL_KEY = 'armord-original';

function readJson(file: string): Json | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
  } catch {
    /* fall through */
  }
  throw new Error(`${file} is not a JSON object; fix it by hand first (armord never overwrites a file it cannot parse)`);
}

function writeJson(file: string, value: Json, existed: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existed && !existsSync(file + BACKUP_SUFFIX)) copyFileSync(file, file + BACKUP_SUFFIX);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------
// Hook hosts

interface HookSpec {
  file: (o: InstallOptions) => string;
  /** Event name -> entries to hold. `flat` entries carry `command` directly (Cursor). */
  events: (cmd: string) => Record<string, Json[]>;
  flat?: boolean;
  top?: Json;
}

const userOrProject = (dir: string, name: string) => (o: InstallOptions) => join(o.scope === 'user' ? o.home : o.cwd, dir, name);

function nested(matcher: string, hook: Json): Json {
  return { matcher, hooks: [hook] };
}

const HOOK_SPECS: Record<string, HookSpec> = {
  'claude-code': {
    file: userOrProject('.claude', 'settings.json'),
    events: (c) => ({ PreToolUse: [nested('*', { type: 'command', command: `${c} hook claude-code`, timeout: 120 })] }),
  },
  cursor: {
    file: userOrProject('.cursor', 'hooks.json'),
    flat: true,
    top: { version: 1 },
    events: (c) => {
      const command = `${c} hook cursor`;
      return {
        beforeShellExecution: [{ command, failClosed: true }],
        beforeMCPExecution: [{ command, failClosed: true }],
        beforeReadFile: [{ command, failClosed: true }],
        preToolUse: [{ command, failClosed: true, matcher: '^(Write|Delete|Grep|Task)$' }],
      };
    },
  },
  codex: {
    file: userOrProject('.codex', 'hooks.json'),
    events: (c) => ({ PreToolUse: [nested('*', { type: 'command', command: `${c} hook codex`, timeout: 120 })] }),
  },
  gemini: {
    file: userOrProject('.gemini', 'settings.json'),
    events: (c) => ({ BeforeTool: [nested('*', { name: 'armord', type: 'command', command: `${c} hook gemini`, timeout: 10000 })] }),
  },
};

function isOurs(entry: Json, host: string, flat: boolean): boolean {
  const test = (cmd: unknown) => typeof cmd === 'string' && new RegExp(`armord\\S*\\s+hook\\s+${host}\\s*$`).test(cmd.trim());
  if (flat) return test(entry?.command);
  return Array.isArray(entry?.hooks) && entry.hooks.some((h: Json) => test(h?.command));
}

function hookInstall(host: string, spec: HookSpec, o: InstallOptions): Change {
  const file = spec.file(o);
  const existing = readJson(file);
  const doc: Json = existing ? structuredClone(existing) : {};
  for (const [k, v] of Object.entries(spec.top ?? {})) if (!(k in doc)) doc[k] = v;
  const hooks: Json = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : (doc.hooks = {})) as Json;
  const events = spec.events(o.command ?? 'armord');
  for (const [event, entries] of Object.entries(events)) {
    const list: Json[] = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
    for (const entry of entries) {
      const at = list.findIndex((e) => isOurs(e, host, !!spec.flat));
      if (at < 0) list.push(entry);
      else list[at] = entry;
    }
  }
  if (existing && same(existing, doc)) return { file, action: 'unchanged', summary: 'armord hooks already installed' };
  if (!o.dryRun) writeJson(file, doc, !!existing);
  return { file, action: existing ? 'merge' : 'create', summary: `${Object.keys(events).join(', ')} -> armord hook ${host}` };
}

function hookUninstall(host: string, spec: HookSpec, o: InstallOptions): Change {
  const file = spec.file(o);
  const existing = readJson(file);
  if (!existing) return { file, action: 'unchanged', summary: 'no file' };
  const doc: Json = structuredClone(existing);
  let removed = 0;
  if (doc.hooks && typeof doc.hooks === 'object') {
    for (const event of Object.keys(doc.hooks)) {
      if (!Array.isArray(doc.hooks[event])) continue;
      const before = doc.hooks[event].length;
      doc.hooks[event] = doc.hooks[event].filter((e: Json) => !isOurs(e, host, !!spec.flat));
      removed += before - doc.hooks[event].length;
      if (doc.hooks[event].length === 0) delete doc.hooks[event];
    }
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
  }
  if (removed === 0) return { file, action: 'unchanged', summary: 'armord hooks not present' };
  // A file armord created (nothing left but its own defaults, no backup) goes away entirely.
  const onlyDefaults = Object.keys(doc).every((k) => same(doc[k], (spec.top ?? {})[k]));
  if (!o.dryRun) {
    if (onlyDefaults && !existsSync(file + BACKUP_SUFFIX)) rmSync(file);
    else writeJson(file, doc, true);
  }
  return { file, action: 'remove', summary: `removed ${removed} armord hook entr${removed === 1 ? 'y' : 'ies'}` };
}

function hookStatus(host: string, spec: HookSpec, o: InstallOptions): HostStatus['files'][number] {
  const file = spec.file(o);
  const doc = existsSync(file) ? readJson(file) : undefined;
  const installed = !!doc?.hooks && Object.values(doc.hooks as Json).some((l) => Array.isArray(l) && l.some((e: Json) => isOurs(e, host, !!spec.flat)));
  return { file, installed, exists: !!doc };
}

// ---------------------------------------------------------------------------------------------
// MCP client configs

function claudeDesktopConfig(home: string): string {
  // APPDATA only applies to the real home; a test or custom home stays inside that directory.
  if (process.platform === 'win32') return join(home === homedir() ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming')) : join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export function mcpConfigFiles(o: InstallOptions): string[] {
  return o.scope === 'project'
    ? [join(o.cwd, '.mcp.json'), join(o.cwd, '.cursor', 'mcp.json')]
    : [join(o.home, '.cursor', 'mcp.json'), join(o.home, '.claude.json'), claudeDesktopConfig(o.home), join(o.home, '.gemini', 'settings.json')];
}

function mcpInstall(file: string, o: InstallOptions): Change {
  const existing = readJson(file);
  if (!existing) return { file, action: 'unchanged', summary: 'no file' };
  const doc: Json = structuredClone(existing);
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object') return { file, action: 'unchanged', summary: 'no mcpServers' };
  const armord = o.command ?? 'armord';
  const wrapped: string[] = [];
  for (const [name, s] of Object.entries<Json>(servers)) {
    if (!s || typeof s.command !== 'string' || ORIGINAL_KEY in s) continue; // http servers and already-wrapped ones
    const original = s.command;
    const args: string[] = Array.isArray(s.args) ? s.args.map(String) : [];
    s[ORIGINAL_KEY] = { command: original, ...(Array.isArray(s.args) ? { args: s.args } : {}) };
    s.command = armord;
    s.args = ['mcp-proxy', '--name', name, '--', original, ...args];
    wrapped.push(name);
  }
  if (wrapped.length === 0) return { file, action: 'unchanged', summary: 'no unwrapped stdio servers' };
  if (!o.dryRun) writeJson(file, doc, true);
  return { file, action: 'merge', summary: `wrapped ${wrapped.join(', ')} with armord mcp-proxy` };
}

function mcpUninstall(file: string, o: InstallOptions): Change {
  const existing = readJson(file);
  const servers = existing?.mcpServers;
  if (!existing || !servers || typeof servers !== 'object') return { file, action: 'unchanged', summary: 'no file' };
  const doc: Json = structuredClone(existing);
  const restored: string[] = [];
  for (const [name, s] of Object.entries<Json>(doc.mcpServers)) {
    const orig = s?.[ORIGINAL_KEY];
    if (!orig) continue;
    s.command = orig.command;
    if (orig.args) s.args = orig.args;
    else delete s.args;
    delete s[ORIGINAL_KEY];
    restored.push(name);
  }
  if (restored.length === 0) return { file, action: 'unchanged', summary: 'nothing wrapped' };
  if (!o.dryRun) writeJson(file, doc, true);
  return { file, action: 'remove', summary: `unwrapped ${restored.join(', ')}` };
}

function mcpStatus(file: string): HostStatus['files'][number] {
  const doc = existsSync(file) ? readJson(file) : undefined;
  const servers = Object.values<Json>(doc?.mcpServers ?? {});
  return { file, installed: servers.some((s) => s && ORIGINAL_KEY in s), exists: !!doc };
}

// ---------------------------------------------------------------------------------------------
// OpenHands: a Python snippet (the analyzer is a library, not a config file)

const OPENHANDS_SNIPPET = `# Generated by "armord install openhands". Needs the daemon: armord start
#   pip install ./adapters/openhands openhands-sdk
from armord_openhands import ArmordSecurityAnalyzer, confirm_risky_policy, pending_actions, reject_blocked


def govern(conversation, cwd="."):
    """Gate an OpenHands SDK conversation with armord. Call before conversation.run()."""
    analyzer = ArmordSecurityAnalyzer(cwd=cwd)
    conversation.set_security_analyzer(analyzer)
    conversation.set_confirmation_policy(confirm_risky_policy())  # without this armord's verdict is not enforced
    return analyzer
`;

function openhandsFile(o: InstallOptions): string {
  return o.scope === 'user' ? join(o.home, '.armoriq', 'armord', 'openhands_armord.py') : join(o.cwd, 'openhands_armord.py');
}

function openhandsInstall(o: InstallOptions): Change {
  const file = openhandsFile(o);
  if (existsSync(file) && readFileSync(file, 'utf8') === OPENHANDS_SNIPPET) return { file, action: 'unchanged', summary: 'snippet already written' };
  const existed = existsSync(file);
  if (!o.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    if (existed && !existsSync(file + BACKUP_SUFFIX)) copyFileSync(file, file + BACKUP_SUFFIX);
    writeFileSync(file, OPENHANDS_SNIPPET);
  }
  return { file, action: existed ? 'merge' : 'create', summary: 'wrote govern(conversation) helper; pip install ./adapters/openhands openhands-sdk' };
}

// ---------------------------------------------------------------------------------------------

function isHookHost(h: string): boolean {
  return h in HOOK_SPECS;
}
const unknown = (h: unknown): never => {
  throw new Error(`unknown host "${String(h)}"; one of ${INSTALL_HOSTS.join(', ')}`);
};

export function installHost(host: InstallHost, o: InstallOptions): InstallResult {
  if (isHookHost(host)) return { changes: [hookInstall(host, HOOK_SPECS[host] as HookSpec, o)] };
  if (host === 'openhands') return { changes: [openhandsInstall(o)] };
  if (host === 'mcp') return { changes: mcpConfigFiles(o).map((f) => mcpInstall(f, o)) };
  return unknown(host);
}

export function uninstallHost(host: InstallHost, o: InstallOptions): InstallResult {
  if (isHookHost(host)) return { changes: [hookUninstall(host, HOOK_SPECS[host] as HookSpec, o)] };
  if (host === 'openhands') {
    const file = openhandsFile(o);
    if (!existsSync(file)) return { changes: [{ file, action: 'unchanged', summary: 'no file' }] };
    if (!o.dryRun) rmSync(file);
    return { changes: [{ file, action: 'remove', summary: 'removed snippet' }] };
  }
  if (host === 'mcp') return { changes: mcpConfigFiles(o).map((f) => mcpUninstall(f, o)) };
  return unknown(host);
}

export function hostStatus(host: InstallHost, o: InstallOptions): HostStatus {
  let files: HostStatus['files'];
  if (isHookHost(host)) files = [hookStatus(host, HOOK_SPECS[host] as HookSpec, o)];
  else if (host === 'openhands') {
    const file = openhandsFile(o);
    files = [{ file, installed: existsSync(file), exists: existsSync(file) }];
  } else if (host === 'mcp') files = mcpConfigFiles(o).map(mcpStatus);
  else return unknown(host);
  return { host, installed: files.some((f) => f.installed), files };
}
