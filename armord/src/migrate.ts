// Migration: read what other agent setups already enforce (Claude Code permissions, Codex approval
// and sandbox modes, Gemini/Cursor config, ArmorIQ plugin policies and MCP servers), turn it into
// one armor.io/v2 policy, and optionally point those hosts at armord. Reading never changes a
// source. Applying backs up every file it touches (<file>.armord-bak, once) and is idempotent.
//
// Verified against the host docs/SDK source: Claude Code permission rule syntax, Codex config keys,
// ArmorCodex's {rules:[{id,action,tool}]} policy store, ArmorClaw's file locations. Everything
// marked "unverified" in a warning is inferred from docs and not run against a real install.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { installHost, type InstallHost } from './install.js';
import { PolicyStore } from './store.js';

export type SourceId = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'claude-desktop' | 'armorclaude' | 'armorcodex' | 'armorgemini' | 'armorclaw' | 'armorcopilot' | 'armoriq-sdk' | 'armor-mcp-proxy';
export type Effect = 'allow' | 'hold' | 'block';

export interface NativeRule {
  effect: Effect;
  /** Tool name as the source host names it (Bash, mcp__x__y, run_shell_command, ...). */
  tool: string;
  /** Specifier inside Tool(...), when the source has one. */
  spec?: string;
  /** Where it came from, for reasons and warnings. */
  origin: string;
  /** A matcher armord cannot express (ArmorCodex dataClass/anyParam). */
  unconvertible?: string;
}

export interface McpServerRef {
  name: string;
  file: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export interface HookRef {
  file: string;
  event: string;
  command: string;
  /** Looks like an ArmorIQ plugin hook (armorclaude, armorcodex, armorgemini, armorclaw, armorcopilot). */
  armoriq: boolean;
}

export interface SourceFinding {
  source: SourceId;
  label: string;
  files: string[];
  rules: NativeRule[];
  mcpServers: McpServerRef[];
  hooks: HookRef[];
  /** Mode settings (approval_policy, sandbox_mode, defaultMode). */
  settings: Record<string, string>;
  notes: string[];
}

export interface Scan {
  home: string;
  cwd: string;
  findings: SourceFinding[];
}

export interface MigrationAction {
  kind: 'write-policy' | 'install-hooks' | 'wrap-mcp' | 'replace-plugin-hook' | 'manual';
  source?: SourceId;
  host?: InstallHost;
  scope?: 'user' | 'project';
  file: string;
  summary: string;
}

export interface MigrationPlan {
  actions: MigrationAction[];
  policyYaml: string;
  policyName: string;
  /** Absolute path the policy will be written to by applyMigration. */
  policyFile: string;
  warnings: string[];
  /** Compile problems found in policyYaml (empty when it is valid). */
  problems: string[];
  sources: SourceId[];
  /** Counts so a caller can print "12 rules, 3 servers". */
  stats: { rules: number; filesDeny: number; mcpServers: number };
}

export interface PlanOptions {
  /** Restrict to these sources; default: everything found. */
  only?: SourceId[];
  policyDir: string;
  /** Add armord's baseline (destructive: block, pipe-to-shell block, secret paths denied). Default true. */
  baseline?: boolean;
}

export interface ApplyOptions {
  dryRun?: boolean;
  home: string;
  cwd: string;
  /** Command that starts armord in hook and proxy entries; default "armord". */
  command?: string;
  /** Remove ArmorIQ plugin hook entries found in settings files. Default false: they keep running alongside. */
  replacePluginHooks?: boolean;
}

export interface ApplyResult {
  changes: { file: string; action: string; summary: string }[];
  dryRun: boolean;
}

type Json = Record<string, any>;
const BACKUP = '.armord-bak';
const ARMORIQ_HOOK = /armor(iq|claude|codex|gemini|claw|copilot)|hook-router\.mjs|armoriq/i;

// ---------------------------------------------------------------------------------------------
// readers

function readJson(file: string): Json | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Just enough TOML for Codex's config: [tables], key = string|number|bool|[string array]. */
export function parseToml(text: string): Json {
  const root: Json = {};
  let cur: Json = root;
  const lines = text.split(/\r?\n/);
  const value = (raw: string): unknown => {
    const s = raw.trim();
    if (s.startsWith('"') || s.startsWith("'")) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('[')) return [...s.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    return s;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] as string).replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      cur = root;
      for (const part of (table[1] as string).split('.').map((p) => p.trim().replace(/^["']|["']$/g, ''))) cur = (cur[part] ??= {}) as Json;
      continue;
    }
    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let rhs = kv[2] as string;
    while (rhs.trim().startsWith('[') && !rhs.includes(']') && i + 1 < lines.length) rhs += ' ' + (lines[++i] as string).replace(/#.*$/, '');
    cur[(kv[1] as string).replace(/^["']|["']$/g, '')] = value(rhs);
  }
  return root;
}

function finding(source: SourceId, label: string): SourceFinding {
  return { source, label, files: [], rules: [], mcpServers: [], hooks: [], settings: {}, notes: [] };
}

function addMcp(f: SourceFinding, file: string, servers: unknown): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, s] of Object.entries<Json>(servers as Json)) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.command === 'string') f.mcpServers.push({ name, file, transport: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [] });
    else if (typeof s.url === 'string' || typeof s.httpUrl === 'string') f.mcpServers.push({ name, file, transport: 'http', url: String(s.url ?? s.httpUrl) });
  }
}

function addHooks(f: SourceFinding, file: string, hooks: unknown): void {
  if (!hooks || typeof hooks !== 'object') return;
  for (const [event, list] of Object.entries<unknown>(hooks as Json)) {
    if (!Array.isArray(list)) continue;
    for (const e of list as Json[]) {
      const cmds: string[] = [];
      if (typeof e?.command === 'string') cmds.push(e.command);
      if (Array.isArray(e?.hooks)) for (const h of e.hooks) if (typeof h?.command === 'string') cmds.push(h.command);
      for (const command of cmds) f.hooks.push({ file, event, command, armoriq: ARMORIQ_HOOK.test(command) && !/\barmord\b/.test(command) });
    }
  }
}

const EFFECT: Record<string, Effect> = { allow: 'allow', ask: 'hold', hold: 'hold', deny: 'block', block: 'block' };

/** `Bash(npm test:*)` -> {tool:'Bash', spec:'npm test:*'}; `mcp__x__y` -> {tool}. */
export function parseClaudeRule(raw: string): { tool: string; spec?: string } | undefined {
  const m = /^([A-Za-z_][\w.*-]*)(?:\(([\s\S]*)\))?$/.exec(raw.trim());
  if (!m) return undefined;
  return m[2] === undefined || m[2] === '' ? { tool: m[1] as string } : { tool: m[1] as string, spec: m[2] };
}

function claudeFindings(home: string, cwd: string): SourceFinding[] {
  const f = finding('claude-code', 'Claude Code');
  const files = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  for (const file of files) {
    const doc = readJson(file);
    if (!doc) continue;
    f.files.push(file);
    for (const [key, effect] of [['allow', 'allow'], ['ask', 'hold'], ['deny', 'block']] as const) {
      const list = doc.permissions?.[key];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const r = typeof raw === 'string' ? parseClaudeRule(raw) : undefined;
        if (!r) {
          f.notes.push(`${file}: could not parse permission rule ${JSON.stringify(raw)}`);
          continue;
        }
        f.rules.push({ effect, tool: r.tool, ...(r.spec !== undefined ? { spec: r.spec } : {}), origin: `${basename(file)} permissions.${key}` });
      }
    }
    if (typeof doc.permissions?.defaultMode === 'string') f.settings.defaultMode = doc.permissions.defaultMode;
    if (Array.isArray(doc.permissions?.additionalDirectories) && doc.permissions.additionalDirectories.length) f.notes.push(`${file}: additionalDirectories (${doc.permissions.additionalDirectories.length}) are not carried over; set the workspace per call instead`);
    addHooks(f, file, doc.hooks);
    addMcp(f, file, doc.mcpServers);
  }
  const mcpJson = join(cwd, '.mcp.json');
  const mj = readJson(mcpJson);
  if (mj) {
    f.files.push(mcpJson);
    addMcp(f, mcpJson, mj.mcpServers);
  }
  const claudeJson = join(home, '.claude.json');
  const cj = readJson(claudeJson);
  if (cj) {
    addMcp(f, claudeJson, cj.mcpServers);
    const proj = cj.projects?.[cwd] ?? cj.projects?.[cwd.replace(/\\/g, '/')];
    if (proj) addMcp(f, claudeJson, proj.mcpServers);
    if (f.mcpServers.some((s) => s.file === claudeJson)) f.files.push(claudeJson);
  }
  return f.files.length ? [f] : [];
}

function codexFindings(home: string): SourceFinding[] {
  const f = finding('codex', 'Codex CLI');
  const cfg = join(home, '.codex', 'config.toml');
  if (existsSync(cfg)) {
    f.files.push(cfg);
    const t = parseToml(readFileSync(cfg, 'utf8'));
    for (const k of ['approval_policy', 'sandbox_mode', 'model']) if (typeof t[k] === 'string') f.settings[k] = t[k];
    for (const [name, s] of Object.entries<Json>((t.mcp_servers as Json) ?? {})) {
      if (typeof s.command === 'string') f.mcpServers.push({ name, file: cfg, transport: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [] });
      else if (typeof s.url === 'string') f.mcpServers.push({ name, file: cfg, transport: 'http', url: s.url });
    }
  }
  const hooks = join(home, '.codex', 'hooks.json');
  const hj = readJson(hooks);
  if (hj) {
    f.files.push(hooks);
    addHooks(f, hooks, hj.hooks ?? hj);
  }
  return f.files.length ? [f] : [];
}

function cursorFindings(home: string, cwd: string): SourceFinding[] {
  const f = finding('cursor', 'Cursor');
  for (const base of [home, cwd]) {
    const mcp = join(base, '.cursor', 'mcp.json');
    const m = readJson(mcp);
    if (m) {
      f.files.push(mcp);
      addMcp(f, mcp, m.mcpServers);
    }
    const hooks = join(base, '.cursor', 'hooks.json');
    const h = readJson(hooks);
    if (h) {
      f.files.push(hooks);
      addHooks(f, hooks, h.hooks);
    }
    const rulesDir = join(base, '.cursor', 'rules');
    if (existsSync(rulesDir)) {
      const n = readdirSync(rulesDir).filter((x) => /\.mdc?$/.test(x)).length;
      if (n) f.notes.push(`${rulesDir}: ${n} Cursor rule file(s) are natural-language instructions to the model and cannot be converted to enforceable policy`);
    }
  }
  if (existsSync(join(cwd, '.cursorrules'))) f.notes.push('.cursorrules is natural-language guidance, not enforceable policy; not converted');
  if (f.files.length) f.notes.push('Cursor\'s in-app command allowlist/denylist lives in app state, not a readable file (unverified); re-create it in the policy by hand');
  return f.files.length ? [f] : [];
}

function geminiFindings(home: string, cwd: string): SourceFinding[] {
  const f = finding('gemini', 'Gemini CLI');
  for (const file of [join(home, '.gemini', 'settings.json'), join(cwd, '.gemini', 'settings.json')]) {
    const doc = readJson(file);
    if (!doc) continue;
    f.files.push(file);
    const allowed = [...(doc.tools?.allowed ?? []), ...(doc.coreTools ?? [])];
    const excluded = [...(doc.tools?.exclude ?? []), ...(doc.excludeTools ?? [])];
    for (const [list, effect] of [[allowed, 'allow'], [excluded, 'block']] as const) {
      for (const raw of list as unknown[]) {
        const r = typeof raw === 'string' ? parseClaudeRule(raw) : undefined;
        if (r) f.rules.push({ effect, tool: r.tool, ...(r.spec !== undefined ? { spec: r.spec } : {}), origin: `${basename(file)} ${effect === 'allow' ? 'tools.allowed' : 'tools.exclude'}` });
      }
    }
    addHooks(f, file, doc.hooks);
    addMcp(f, file, doc.mcpServers);
  }
  return f.files.length ? [f] : [];
}

function desktopFindings(home: string): SourceFinding[] {
  const dir = process.platform === 'win32' ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude');
  const file = join(dir, 'claude_desktop_config.json');
  const doc = readJson(file);
  if (!doc) return [];
  const f = finding('claude-desktop', 'Claude Desktop');
  f.files.push(file);
  addMcp(f, file, doc.mcpServers);
  return f.mcpServers.length ? [f] : [];
}

/** ArmorIQ plugin policy stores: {rules:[{id,action,tool,...}]}, {policy:{rules}} or {statements}. */
function pluginRules(doc: Json, origin: string, f: SourceFinding): void {
  const list: Json[] = doc.rules ?? doc.policy?.rules ?? doc.statements ?? doc.policy?.statements ?? [];
  if (!Array.isArray(list)) return;
  for (const r of list) {
    const effect = EFFECT[String(r?.action ?? r?.effect ?? '')];
    const tool = r?.tool ?? r?.match?.tool;
    if (!effect || typeof tool !== 'string') {
      f.notes.push(`${origin}: skipped a rule with no recognisable action/tool (${JSON.stringify(r).slice(0, 80)})`);
      continue;
    }
    const extra = ['dataClass', 'anyParam', 'conditions', 'when'].filter((k) => r[k] !== undefined);
    f.rules.push({ effect, tool, origin: `${origin} ${r.id ?? ''}`.trim(), ...(extra.length ? { unconvertible: extra.join('+') } : {}) });
  }
  if (doc.default && EFFECT[String(doc.default)]) f.settings.default = EFFECT[String(doc.default)] as string;
}

function pluginFindings(home: string, cwd: string): SourceFinding[] {
  const out: SourceFinding[] = [];

  // ArmorClaude: policy store under the Claude plugin data dir (documented path). Shape unverified.
  const claudeData = join(home, '.claude', 'plugins', 'data', 'armorclaude-armoriq', 'policy.json');
  const installed = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const hasPlugin = existsSync(installed) && /armorclaude/i.test(readFileSync(installed, 'utf8'));
  if (existsSync(claudeData) || hasPlugin) {
    const f = finding('armorclaude', 'ArmorClaude');
    if (hasPlugin) f.files.push(installed);
    const doc = readJson(claudeData);
    if (doc) {
      f.files.push(claudeData);
      pluginRules(doc, 'armorclaude policy.json', f);
    }
    f.notes.push('ArmorClaude is a Claude Code plugin; its PreToolUse hook lives in the plugin, not settings.json. Disable it with /plugin after armord hooks are installed. Policy store shape is read leniently (unverified)');
    out.push(f);
  }

  // ArmorClaw (OpenClaw): ~/.openclaw/openclaw.json + armoriq.policy.json.
  const claw = join(home, '.openclaw', 'openclaw.json');
  const clawPolicy = join(home, '.openclaw', 'armoriq.policy.json');
  const clawCfg = readJson(claw);
  const clawEntry = clawCfg?.plugins?.entries?.armoriq;
  if (clawEntry || existsSync(clawPolicy)) {
    const f = finding('armorclaw', 'ArmorClaw (OpenClaw)');
    if (clawEntry) f.files.push(claw);
    const doc = readJson(clawPolicy);
    if (doc) {
      f.files.push(clawPolicy);
      pluginRules(doc, 'armoriq.policy.json', f);
    }
    f.notes.push('ArmorClaw runs inside the OpenClaw gateway; armord has no OpenClaw hook yet, so only its policy rules are migrated and the plugin stays installed. Policy store shape is read leniently (unverified)');
    out.push(f);
  }

  // ArmorCodex: [mcp_servers.armorcodex-policy] in config.toml + hooks.json entries.
  const codexCfg = join(home, '.codex', 'config.toml');
  if (existsSync(codexCfg) && /armorcodex/i.test(readFileSync(codexCfg, 'utf8'))) {
    const f = finding('armorcodex', 'ArmorCodex');
    f.files.push(codexCfg);
    f.notes.push('ArmorCodex keeps rules in its policy MCP server (rule list {id,action,tool}); its storage path is not documented, so rules are only migrated from a policy.json you point at in ~/.armoriq/armorcodex-policy.json (unverified location)');
    const doc = readJson(join(home, '.armoriq', 'armorcodex-policy.json'));
    if (doc) pluginRules(doc, 'armorcodex-policy.json', f);
    out.push(f);
  }

  // ArmorGemini: hook-router.mjs hooks in ~/.gemini/settings.json.
  const gs = readJson(join(home, '.gemini', 'settings.json'));
  if (gs && JSON.stringify(gs).includes('hook-router.mjs')) {
    const f = finding('armorgemini', 'ArmorGemini');
    f.files.push(join(home, '.gemini', 'settings.json'));
    f.notes.push('ArmorGemini hooks run scripts/hook-router.mjs; rules live in its policy MCP server (armorgemini-policy), not in a file armord can read (unverified)');
    out.push(f);
  }

  // ArmorCopilot: no documented file layout we could verify.
  for (const dir of [join(cwd, '.github', 'hooks'), join(home, '.copilot')]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).filter((x) => x.endsWith('.json')).find((x) => /armorcopilot|armoriq/i.test(readFileSync(join(dir, x), 'utf8')));
    if (hit) {
      const f = finding('armorcopilot', 'ArmorCopilot');
      f.files.push(join(dir, hit));
      f.notes.push('ArmorCopilot detected by a hook file mentioning ArmorIQ (unverified layout); nothing is converted. armord has no Copilot adapter yet');
      out.push(f);
    }
  }

  // SDK config: armoriq.yaml policy.allow/deny as <mcp_id>.<tool>.
  const yamlFile = existsSync(join(cwd, 'armoriq.yaml')) ? join(cwd, 'armoriq.yaml') : undefined;
  if (yamlFile) {
    const f = finding('armoriq-sdk', 'ArmorIQ SDK (armoriq.yaml)');
    f.files.push(yamlFile);
    const text = readFileSync(yamlFile, 'utf8');
    let section: 'allow' | 'deny' | undefined;
    let inPolicy = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\S/.test(line)) inPolicy = /^policy:/.test(line);
      if (!inPolicy) continue;
      const s = /^\s{2}(allow|deny):/.exec(line);
      if (s) section = s[1] as 'allow' | 'deny';
      const item = /^\s+-\s+([A-Za-z0-9_.*-]+)\s*(#.*)?$/.exec(line);
      if (item && section) {
        const [id, ...rest] = (item[1] as string).split('.');
        f.rules.push({ effect: section === 'allow' ? 'allow' : 'block', tool: rest.length ? `mcp__${id}__${rest.join('.')}` : `mcp__${id}__*`, origin: `armoriq.yaml policy.${section}` });
      }
    }
    out.push(f);
  }

  // The user's own armor-mcp-proxy: any MCP entry launched through it.
  const proxied = new SourceFindingCollector();
  for (const [file, key] of [[join(cwd, '.mcp.json'), 'mcpServers'], [join(home, '.cursor', 'mcp.json'), 'mcpServers'], [join(home, '.claude.json'), 'mcpServers']] as const) {
    const doc = readJson(file);
    for (const [name, s] of Object.entries<Json>(doc?.[key] ?? {})) {
      if (typeof s?.command === 'string' && /armor-mcp-proxy/.test([s.command, ...(s.args ?? [])].join(' '))) proxied.add(file, name, s);
    }
  }
  if (proxied.items.length) {
    const f = finding('armor-mcp-proxy', 'armor-mcp-proxy');
    for (const p of proxied.items) {
      f.files.push(p.file);
      f.notes.push(`${p.file}: MCP server "${p.name}" runs through armor-mcp-proxy; re-wrap it with "armord install mcp" after restoring its original command (the proxy's config format is unverified, so armord does not unwrap it automatically)`);
    }
    f.files = [...new Set(f.files)];
    out.push(f);
  }
  return out;
}

class SourceFindingCollector {
  items: { file: string; name: string }[] = [];
  add(file: string, name: string, _s: Json): void {
    this.items.push({ file, name });
  }
}

export function scanSources(opts: { home: string; cwd: string }): Scan {
  const { home, cwd } = opts;
  const findings = [...claudeFindings(home, cwd), ...codexFindings(home), ...cursorFindings(home, cwd), ...geminiFindings(home, cwd), ...desktopFindings(home), ...pluginFindings(home, cwd)];
  return { home, cwd, findings };
}

// ---------------------------------------------------------------------------------------------
// conversion

const SAFE = '[^;&|$<>`]*';
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** A Bash(...) specifier as a regex over args.command. Allow rules refuse chaining; deny/ask match anywhere. */
export function bashRegex(spec: string, effect: Effect): string {
  let prefix = false;
  let body = spec.trim();
  if (body.endsWith(':*')) {
    prefix = true;
    body = body.slice(0, -2);
  } else if (/\s\*$/.test(body)) {
    prefix = true;
    body = body.replace(/\s\*$/, '');
  }
  const words = body.split(/\s+/).filter(Boolean).map((w) => esc(w).replace(/\\\*/g, '.*'));
  const core = words.join('\\s+');
  if (effect === 'allow') return `^\\s*${core}${prefix ? `\\b${SAFE}` : '\\s*'}$`;
  return `(^|[\\s;&|(])${core}${prefix ? '\\b' : '(\\s|$)'}`;
}

/** Claude path specifiers -> armord globs (./x and bare x mean "anywhere under the project"). */
export function pathGlob(spec: string): string {
  let p = spec.trim();
  if (p.startsWith('//')) return p.slice(1);
  if (p.startsWith('~/') || p.startsWith('**/')) return p;
  if (p.startsWith('./')) p = p.slice(2);
  else if (p.startsWith('/')) p = p.slice(1);
  return `**/${p}`;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SEVERITY: Record<Effect, number> = { block: 0, hold: 1, allow: 2 };
const LOWER: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', glob: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch' };

interface Stmt {
  when?: Record<string, unknown>;
  action: Effect;
  reason: string;
  /** bare = no specifier, applies to every call of the tool */
  bare: boolean;
}

interface Build {
  rules: Map<string, Stmt[]>;
  capability: Map<string, Effect>;
  filesDeny: Set<string>;
  netAllow: Set<string>;
  netDeny: Set<string>;
  defaultVerdict: Effect;
  warnings: string[];
}

function pushStmt(b: Build, tool: string, s: Stmt): void {
  const list = b.rules.get(tool) ?? [];
  if (!list.some((x) => x.action === s.action && JSON.stringify(x.when) === JSON.stringify(s.when))) list.push(s);
  b.rules.set(tool, list);
}

function convertRule(b: Build, r: NativeRule, settings: Record<string, string>): void {
  const reason = `migrated from ${r.origin}: ${r.effect}${r.spec !== undefined ? ` ${r.tool}(${r.spec})` : ` ${r.tool}`}`;
  const tool = LOWER[r.tool] ?? r.tool;
  const isShell = tool === 'Bash' || tool === 'run_shell_command' || tool === 'ShellTool';
  const key = tool === 'ShellTool' ? 'run_shell_command' : tool;

  if (r.unconvertible) {
    if (r.effect === 'allow') {
      b.warnings.push(`${r.origin}: skipped allow ${r.tool} with ${r.unconvertible} matcher (armord cannot express it; leaving it out is the safe direction)`);
      return;
    }
    b.warnings.push(`${r.origin}: ${r.effect} ${r.tool} had a ${r.unconvertible} matcher armord cannot express; applied to every ${r.tool} call as hold (review it)`);
    pushStmt(b, key, { action: 'hold', reason: `${reason} (matcher ${r.unconvertible} dropped, needs review)`, bare: true });
    return;
  }

  if (key === '*') {
    b.defaultVerdict = r.effect;
    return;
  }

  if (isShell) {
    if (r.spec === undefined) return void pushStmt(b, key, { action: r.effect, reason, bare: true });
    return void pushStmt(b, key, { when: { 'args.command': { matches: bashRegex(r.spec, r.effect) } }, action: r.effect, reason, bare: false });
  }

  const readish = READ_TOOLS.includes(tool);
  const editish = EDIT_TOOLS.includes(tool);
  if ((readish || editish) && r.spec !== undefined) {
    const glob = pathGlob(r.spec);
    if (r.effect === 'block') {
      b.filesDeny.add(glob);
      return;
    }
    for (const t of readish ? READ_TOOLS : EDIT_TOOLS) pushStmt(b, t, { when: { path: { glob } }, action: r.effect, reason, bare: false });
    return;
  }
  if ((readish || editish) && r.spec === undefined) {
    for (const t of readish ? READ_TOOLS : EDIT_TOOLS) pushStmt(b, t, { action: r.effect, reason, bare: true });
    return;
  }

  if (tool === 'WebFetch' && r.spec !== undefined) {
    const m = /^domain:(.+)$/.exec(r.spec);
    if (m) {
      (r.effect === 'allow' ? b.netAllow : r.effect === 'block' ? b.netDeny : new Set<string>()).add(m[1] as string);
      if (r.effect === 'hold') b.warnings.push(`${r.origin}: ask WebFetch(domain:${m[1]}) is covered by network.default: hold`);
      return;
    }
  }
  if (tool === 'WebSearch' || tool === 'WebFetch') return void pushStmt(b, tool, { action: r.effect, reason, bare: true });

  // MCP tools, Gemini tools and anything else: keyed by name; a specifier we do not understand is
  // handled as the whole tool only when that is stricter or equal, otherwise skipped.
  if (r.spec !== undefined) {
    if (r.effect === 'allow') {
      b.warnings.push(`${r.origin}: skipped allow ${r.tool}(${r.spec}); armord has no equivalent matcher for that specifier`);
      return;
    }
    b.warnings.push(`${r.origin}: ${r.effect} ${r.tool}(${r.spec}) widened to every ${r.tool} call (stricter than the original)`);
  }
  pushStmt(b, key, { action: r.effect, reason, bare: true });
  void settings;
}

function applyModes(b: Build, f: SourceFinding): void {
  const s = f.settings;
  if (f.source === 'claude-code') {
    const mode = s.defaultMode;
    if (mode === 'acceptEdits') for (const t of EDIT_TOOLS) pushStmt(b, t, { when: { withinWorkspace: { eq: true } }, action: 'allow', reason: 'migrated from Claude defaultMode acceptEdits', bare: false });
    else if (mode === 'plan') b.warnings.push('Claude defaultMode "plan" is a session mode, not a policy; use armord intent plans (armord plan register) instead');
    else if (mode === 'bypassPermissions') b.warnings.push('Claude defaultMode "bypassPermissions" auto-approves everything. The migrated policy is stricter on purpose (unlisted tools hold); loosen tools.default if that is what you want');
  }
  if (f.source === 'codex') {
    if (s.sandbox_mode === 'read-only') {
      b.capability.set('file.write', 'block');
      b.capability.set('file.delete', 'block');
    } else if (s.sandbox_mode === 'danger-full-access') b.warnings.push('Codex sandbox_mode "danger-full-access" has no sandbox; armord adds only its own baseline. Tighten tools.default if you want approvals');
    if (s.approval_policy === 'never') b.warnings.push('Codex approval_policy "never" never asks; armord holds still ask. Set tools.default to allow if you really want that');
    if (s.approval_policy === 'untrusted' || s.approval_policy === undefined) b.defaultVerdict = 'hold';
    else b.defaultVerdict = b.defaultVerdict === 'block' ? 'block' : 'allow';
  }
  if (f.source === 'gemini' || f.source === 'cursor') b.defaultVerdict = b.defaultVerdict === 'block' ? 'block' : 'hold';
  if (s.default && f.rules.length === 0) b.defaultVerdict = s.default as Effect;
}

function buildPolicy(findings: SourceFinding[], baseline: boolean, name: string): { yaml: string; warnings: string[]; stats: MigrationPlan['stats'] } {
  const b: Build = { rules: new Map(), capability: new Map(), filesDeny: new Set(), netAllow: new Set(), netDeny: new Set(), defaultVerdict: 'hold', warnings: [] };
  if (baseline) {
    b.capability.set('destructive', 'block');
    for (const p of ['~/.ssh/**', '~/.aws/**', '~/.armoriq/**', '**/id_rsa*']) b.filesDeny.add(p);
    pushStmt(b, 'Bash', { when: { pipeToShell: { eq: true } }, action: 'block', reason: 'armord baseline: downloaded code piped into a shell', bare: false });
  }
  for (const f of findings) {
    for (const n of f.notes) b.warnings.push(`${f.label}: ${n}`);
    applyModes(b, f);
    for (const r of f.rules) convertRule(b, r, f.settings);
  }

  const rules: Record<string, unknown> = {};
  for (const [cap, v] of b.capability) rules[cap] = v;
  for (const [tool, stmts] of [...b.rules].sort(([a], [c]) => a.localeCompare(c))) {
    // The baseline's non-bare block stays first; the rest orders strictest first, which is also
    // Claude's own precedence (deny, ask, allow).
    const ordered = stmts.filter((s) => !s.bare).concat(stmts.filter((s) => s.bare));
    ordered.sort((x, y) => SEVERITY[x.action] - SEVERITY[y.action] || Number(x.bare) - Number(y.bare));
    // Anything after a whole-tool statement can never match (and the compiler rejects it): strictest wins.
    const firstBare = ordered.findIndex((s) => s.bare);
    if (firstBare >= 0 && firstBare < ordered.length - 1) {
      b.warnings.push(`${tool}: ${ordered.length - 1 - firstBare} conflicting rule(s) after the whole-tool ${ordered[firstBare]?.action} dropped (strictest wins)`);
      ordered.length = firstBare + 1;
    }
    const hasBare = firstBare >= 0;
    const readDefault: Effect = READ_TOOLS.includes(tool) ? 'allow' : b.defaultVerdict;
    const entries: Record<string, unknown>[] = ordered.map((s) => ({ ...(s.when ? { when: s.when } : {}), action: s.action, reason: s.reason }));
    if (!hasBare) entries.push({ action: readDefault, reason: 'migrated default for tool without a matching rule' });
    rules[tool] = entries.length === 1 && !('when' in (entries[0] as object)) ? (entries[0] as { action: string }).action : entries;
  }
  // Reads run by default in Claude Code; keep that unless a rule for them exists.
  if (findings.some((f) => f.source === 'claude-code')) for (const t of READ_TOOLS) if (!(t in rules)) rules[t] = 'allow';

  const spec: Record<string, unknown> = { expiresAt: 'never', approvalDefaults: { approvers: 1, anyMember: true }, tools: { default: b.defaultVerdict, rules } };
  if (b.filesDeny.size) spec.files = { deny: [...b.filesDeny].sort() };
  if (b.netAllow.size || b.netDeny.size) spec.network = { default: 'hold', ...(b.netAllow.size ? { allow: [...b.netAllow].sort() } : {}), ...(b.netDeny.size ? { deny: [...b.netDeny].sort() } : {}) };
  const doc = { apiVersion: 'armor.io/v2', kind: 'Policy', metadata: { name, description: `Migrated by armord from ${findings.map((f) => f.label).join(', ')}. Review before enforcing.` }, target: { device: 'local' }, spec };
  const header = `# Generated by "armord migrate". Sources: ${findings.map((f) => f.label).join(', ')}.\n# Test it: armord policy test <cases.yaml> <this file>. Original files are untouched until you apply.\n`;
  const stmtCount = [...b.rules.values()].reduce((n, l) => n + l.length, 0) + b.capability.size;
  return { yaml: header + stringify(doc, { lineWidth: 0 }), warnings: b.warnings, stats: { rules: stmtCount, filesDeny: b.filesDeny.size, mcpServers: 0 } };
}

// ---------------------------------------------------------------------------------------------
// plan + apply

const HOST_OF: Partial<Record<SourceId, InstallHost>> = { 'claude-code': 'claude-code', codex: 'codex', cursor: 'cursor', gemini: 'gemini' };

export function planMigration(scan: Scan, opts: PlanOptions): MigrationPlan {
  const chosen = scan.findings.filter((f) => !opts.only || opts.only.includes(f.source));
  const sources = [...new Set(chosen.map((f) => f.source))];
  const label = sources.length === 1 ? (sources[0] as string) : 'combined';
  const policyName = `migrated-${label}`;
  const policyFile = join(opts.policyDir, `${policyName}.yaml`);
  const built = buildPolicy(chosen, opts.baseline !== false, policyName);
  const warnings = [...built.warnings];
  const actions: MigrationAction[] = [];

  const store = new PolicyStore();
  store.addSource(policyFile, built.yaml);
  const problems = store.problems.filter((p) => p.severity === 'error').map((p) => `${p.code}: ${p.message}`);

  if (chosen.length === 0) warnings.push('nothing to migrate: no agent setups found');
  else actions.push({ kind: 'write-policy', file: policyFile, summary: `write ${built.stats.rules} statement(s) and ${built.stats.filesDeny} denied path(s) as armor.io/v2` });

  const servers = new Map<string, McpServerRef>();
  for (const f of chosen) for (const s of f.mcpServers) servers.set(`${s.file}\0${s.name}`, s);
  const stdio = [...servers.values()].filter((s) => s.transport === 'stdio' && !/armord/.test([s.command, ...(s.args ?? [])].join(' ')));
  const http = [...servers.values()].filter((s) => s.transport === 'http');
  built.stats.mcpServers = servers.size;
  const claimedFiles = new Set<string>();
  for (const s of stdio) {
    if (claimedFiles.has(s.file)) continue;
    claimedFiles.add(s.file);
    const names = stdio.filter((x) => x.file === s.file).map((x) => x.name);
    actions.push({ kind: 'wrap-mcp', file: s.file, summary: `run ${names.join(', ')} behind "armord mcp-proxy" (policy, tool pinning, redaction); originals kept under armord-original` });
  }
  if (http.length) warnings.push(`${http.length} remote (http) MCP server(s) (${http.map((s) => s.name).join(', ')}) cannot be wrapped by a stdio proxy; their tool calls are still governed by the host hook`);

  for (const f of chosen) {
    const host = HOST_OF[f.source];
    if (!host) continue;
    const scopes = new Set<'user' | 'project'>(f.files.map((file) => (file.startsWith(scan.home) && !file.startsWith(scan.cwd) ? 'user' : file.startsWith(scan.cwd) ? 'project' : 'user')));
    if (scopes.size === 0) scopes.add('user');
    for (const scope of scopes) actions.push({ kind: 'install-hooks', source: f.source, host, scope, file: f.files[0] ?? '', summary: `add armord ${host} hook (${scope})` });
    for (const h of f.hooks.filter((x) => x.armoriq)) {
      actions.push({ kind: 'replace-plugin-hook', source: f.source, file: h.file, summary: `ArmorIQ hook on ${h.event} (${h.command.slice(0, 60)}) -> armord hook ${host}; the plugin's intent-plan token checks have no armord equivalent unless you use armord plans` });
    }
  }
  for (const f of chosen.filter((x) => ['armorclaude', 'armorclaw', 'armorcodex', 'armorgemini', 'armorcopilot', 'armor-mcp-proxy'].includes(x.source))) {
    actions.push({ kind: 'manual', source: f.source, file: f.files[0] ?? '', summary: f.notes[0] ?? `${f.label}: review by hand` });
  }
  if (problems.length) warnings.push(`generated policy has ${problems.length} compile problem(s): ${problems.join('; ')}`);
  return { actions, policyYaml: built.yaml, policyName, policyFile, warnings, problems, sources, stats: built.stats };
}

function backup(file: string): void {
  if (existsSync(file) && !existsSync(file + BACKUP)) copyFileSync(file, file + BACKUP);
}

function stripPluginHooks(file: string, dryRun: boolean): { removed: number } {
  const doc = readJson(file);
  if (!doc) return { removed: 0 };
  const container: Json | undefined = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : undefined;
  if (!container) return { removed: 0 };
  let removed = 0;
  const isPlugin = (c: unknown) => typeof c === 'string' && ARMORIQ_HOOK.test(c) && !/\barmord\b/.test(c);
  for (const event of Object.keys(container)) {
    if (!Array.isArray(container[event])) continue;
    const kept = (container[event] as Json[]).filter((e) => !(isPlugin(e?.command) || (Array.isArray(e?.hooks) && e.hooks.some((h: Json) => isPlugin(h?.command)))));
    removed += container[event].length - kept.length;
    if (kept.length) container[event] = kept;
    else delete container[event];
  }
  if (removed && !dryRun) {
    backup(file);
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  }
  return { removed };
}

export function applyMigration(plan: MigrationPlan, opts: ApplyOptions): ApplyResult {
  const dryRun = !!opts.dryRun;
  const changes: ApplyResult['changes'] = [];
  const install = { home: opts.home, cwd: opts.cwd, dryRun, ...(opts.command ? { command: opts.command } : {}) };
  const done = new Set<string>();
  for (const a of plan.actions) {
    if (a.kind === 'write-policy') {
      if (plan.problems.length) {
        changes.push({ file: a.file, action: 'skipped', summary: `not written: policy has compile problems (${plan.problems.join('; ')})` });
        continue;
      }
      if (!dryRun) {
        mkdirSync(dirname(a.file), { recursive: true });
        backup(a.file);
        writeFileSync(a.file, plan.policyYaml);
      }
      changes.push({ file: a.file, action: 'write', summary: a.summary });
    } else if (a.kind === 'install-hooks' && a.host && a.scope) {
      const k = `${a.host}:${a.scope}`;
      if (done.has(k)) continue;
      done.add(k);
      for (const c of installHost(a.host, { ...install, scope: a.scope }).changes) changes.push({ file: c.file, action: c.action, summary: c.summary });
    } else if (a.kind === 'wrap-mcp') {
      if (done.has('mcp')) continue;
      done.add('mcp');
      for (const scope of ['user', 'project'] as const) for (const c of installHost('mcp', { ...install, scope }).changes) if (c.action !== 'unchanged') changes.push({ file: c.file, action: c.action, summary: c.summary });
    } else if (a.kind === 'replace-plugin-hook') {
      if (!opts.replacePluginHooks) {
        changes.push({ file: a.file, action: 'kept', summary: 'ArmorIQ plugin hook left in place (pass replacePluginHooks to remove it)' });
        continue;
      }
      if (done.has(`strip:${a.file}`)) continue;
      done.add(`strip:${a.file}`);
      const { removed } = stripPluginHooks(a.file, dryRun);
      changes.push({ file: a.file, action: removed ? 'remove' : 'unchanged', summary: removed ? `removed ${removed} ArmorIQ plugin hook entr${removed === 1 ? 'y' : 'ies'}` : 'no plugin hooks' });
    }
  }
  return { changes, dryRun };
}
