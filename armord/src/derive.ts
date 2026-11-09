// Host derivation: turn a raw tool call from any agent host into the CallInput fields the
// armor.io/v2 evaluator reads. The evaluator only applies `files`, `network`, `skills` and
// `secrets` rules when the caller supplies capability tags and derived fields (`path`, `host`,
// `program`, ...). Every ArmorIQ plugin does this on its own today; armord does it once.

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { analyzeShell, quoteArg } from './shell.js';

export type Host = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'openhands' | 'mcp' | 'generic';

export interface RawCall {
  /** Tool name exactly as the host reports it. */
  tool: string;
  arguments?: Record<string, unknown>;
  /** MCP server the tool belongs to, when the host knows it. */
  mcpServer?: string;
  /** Working directory of the agent; relative paths resolve against it. */
  cwd?: string;
  /** Workspace root for `withinWorkspace`; defaults to cwd. */
  workspace?: string;
}

export interface DerivedCall {
  tool: string;
  qualifiedName?: string;
  arguments: Record<string, unknown>;
  derived: Record<string, unknown>;
  capabilities: string[];
  /** Environment variable names a shell command reads; the engine checks each against `secrets`. */
  envVars: string[];
}

const SHELL = new Set(['bash', 'shell', 'run_shell_command', 'exec_command', 'run_terminal_cmd', 'local_shell', 'execute_bash', 'cmdrunaction', 'terminal']);
const READ = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'read_file', 'view', 'list_dir', 'list_directory', 'search_files', 'read_many_files', 'codebase_search', 'file_search', 'view_image']);
const WRITE = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'write_file', 'edit_file', 'replace', 'create_file', 'str_replace_editor', 'fileeditaction', 'search_replace']);
const DELETE = new Set(['delete_file', 'remove_file', 'rm']);
const FETCH = new Set(['webfetch', 'web_fetch', 'fetch', 'fetch_url', 'http_get', 'http_post', 'browse', 'browser']);
const SEARCH = new Set(['websearch', 'web_search', 'google_web_search']);
const SKILL = new Set(['skill']);
const SUBAGENT = new Set(['agent', 'task']);

const PATH_KEYS = ['file_path', 'path', 'filePath', 'filename', 'file', 'notebook_path', 'target_file', 'absolute_path', 'dir_path', 'directory', 'target_directory'];
const URL_KEYS = ['url', 'uri', 'href', 'endpoint'];

/** Lower-case bare name: `mcp__github__create_pr` → `create_pr`. */
function bareName(tool: string): string {
  const parts = tool.split('__');
  return (parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : tool).toLowerCase();
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Path the evaluator compares globs against: absolute, forward slashes, `~/` when under home. */
export function normalizePath(p: string, cwd: string): string {
  let expanded = p.startsWith('~') ? homedir() + p.slice(1) : p;
  if (!isAbsolute(expanded)) expanded = resolve(cwd, expanded);
  else expanded = resolve(expanded);
  const home = homedir();
  const rel = relative(home, expanded);
  const underHome = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  const out = underHome ? (rel === '' ? '~' : `~/${rel}`) : expanded;
  return out.split(sep).join('/');
}

function within(p: string, root: string): boolean {
  const rel = relative(resolve(root), p.startsWith('~') ? homedir() + p.slice(1) : p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = /^([a-z0-9.-]+\.[a-z]{2,})(:\d+)?(\/|$)/i.exec(url.trim());
    return m?.[1]?.toLowerCase();
  }
}

/** First real program in a shell command, skipping env assignments, sudo and common wrappers. */
export function programOf(command: string): string | undefined {
  return analyzeShell(command).program;
}

/** Rank shell-touched paths so the most sensitive one becomes `derived.path`: outside the workspace, then dotfiles and keys. */
function sensitivity(p: string, workspace: string): number {
  return (within(p, workspace) ? 0 : 2) + (/(^|\/)\.[^./]|\.(pem|key|p12|pfx)$|id_[a-z0-9]+$/i.test(p) ? 1 : 0);
}

/**
 * Shell commands go through the tokenizer in shell.ts: programs, hosts, destructive commands,
 * obfuscation, pipe-to-shell, redirections and the files a command writes or deletes. A command
 * that writes or deletes files also gets the `files` capability and `derived.path` (its most
 * sensitive path), so `files.deny` globs apply to `echo x > ~/.ssh/authorized_keys` too.
 */
function shellCall(args: Record<string, unknown>, out: DerivedCall, cwd: string, workspace: string): void {
  const raw = args.command ?? args.cmd ?? args.script;
  const command = Array.isArray(raw) ? raw.map(String).join(' ') : typeof raw === 'string' ? raw : '';
  // An argv array is quoted per element so `["bash", "-lc", "rm -rf x"]` keeps its script intact.
  const a = analyzeShell(Array.isArray(raw) ? raw.map((x) => quoteArg(String(x))).join(' ') : command);
  out.capabilities.push('shell');
  const d = out.derived;
  d.command = command;
  if (a.program) d.program = a.program;
  d.programs = a.programs;
  d.programList = a.programs.join(' ');
  d.writeRedirection = a.writeRedirection;
  d.obfuscated = a.obfuscated;
  d.pipeToShell = a.pipeToShell;
  d.envDump = a.envDump;
  d.dynamicProgram = a.dynamicProgram;
  if (a.heredoc) d.heredoc = true;
  if (a.parseError) d.parseError = a.parseError;
  if (a.reasons.length) d.shellReasons = a.reasons;
  if (a.network) {
    out.capabilities.push('network');
    if (a.hosts[0]) d.host = a.hosts[0];
    if (a.hosts.length) d.hosts = a.hosts;
    if (a.urls[0]) d.url = a.urls[0];
    if (a.urls.length) d.urls = a.urls;
  }
  if (a.destructive) out.capabilities.push('destructive');
  out.envVars = a.envVars;

  const norm = (ps: string[]): string[] => [...new Set(ps.map((p) => normalizePath(p, cwd)))];
  const writes = norm(a.writes);
  const deletes = norm(a.deletes);
  d.writes = writes;
  if (deletes.length) d.deletes = deletes;
  if (a.reads.length) d.reads = norm(a.reads);
  const touched = [...new Set([...writes, ...deletes])];
  if (touched.length) {
    const ranked = touched.map((p, i) => ({ p, i, s: sensitivity(p, workspace) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.p);
    d.path = ranked[0];
    if (ranked.length > 1) d.paths = ranked;
    d.withinWorkspace = touched.every((p) => within(p, workspace));
    out.capabilities.push('files');
    if (writes.length) out.capabilities.push('file.write');
    if (deletes.length) out.capabilities.push('file.delete');
  }
}

/** `*** Update File: path` / `*** Add File:` / `*** Delete File:` headers in an apply_patch body. */
function patchPaths(args: Record<string, unknown>): { paths: string[]; deletes: boolean } {
  const body = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
  const paths = [...body.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)].map((m) => (m[2] as string).trim());
  return { paths, deletes: /^\*\*\* Delete File:/m.test(body) };
}

export function deriveCall(raw: RawCall): DerivedCall {
  const args = raw.arguments ?? {};
  const cwd = raw.cwd ?? process.cwd();
  const workspace = raw.workspace ?? cwd;
  const qualifiedName = raw.mcpServer && !raw.tool.startsWith('mcp__') ? `mcp__${raw.mcpServer}__${raw.tool}` : raw.tool.startsWith('mcp__') ? raw.tool : undefined;
  const out: DerivedCall = { tool: raw.tool, arguments: args, derived: {}, capabilities: [], envVars: [] };
  if (qualifiedName) out.qualifiedName = qualifiedName;
  const name = bareName(raw.tool);

  if (SHELL.has(name)) shellCall(args, out, cwd, workspace);
  if (SKILL.has(name)) {
    out.capabilities.push('skill', 'skills');
    const skill = firstString(args, ['skill', 'name', 'command']);
    if (skill) out.derived.skill = skill;
  }
  if (SUBAGENT.has(name)) out.capabilities.push('subagent');
  if (SEARCH.has(name)) out.capabilities.push('web.search');

  // Files: a named file tool, or any call (MCP included) whose arguments carry a path.
  let path = firstString(args, PATH_KEYS);
  let deletes = DELETE.has(name);
  if (name === 'apply_patch') {
    const patch = patchPaths(args);
    path = path ?? patch.paths[0];
    deletes = deletes || patch.deletes;
    if (patch.paths.length > 1) out.derived.paths = patch.paths.map((p) => normalizePath(p, cwd));
  }
  if (path && !SHELL.has(name)) {
    const norm = normalizePath(path, cwd);
    out.derived.path = norm;
    out.derived.withinWorkspace = within(norm, workspace);
    out.capabilities.push('files');
    if (deletes) out.capabilities.push('file.delete');
    if (WRITE.has(name)) out.capabilities.push('file.write');
    else if (READ.has(name)) out.capabilities.push('file.read');
  }

  // Network: a fetch tool, or any call whose arguments carry a URL.
  const url = firstString(args, URL_KEYS);
  if (url && !SHELL.has(name)) {
    const host = hostOf(url);
    out.derived.url = url;
    if (host) out.derived.host = host;
    out.capabilities.push('network');
    if (FETCH.has(name)) out.capabilities.push('web.fetch');
  } else if (FETCH.has(name)) {
    out.capabilities.push('network', 'web.fetch');
  }

  out.capabilities = [...new Set(out.capabilities)];
  return out;
}
