#!/usr/bin/env node
// armord command line. Run `armord help`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { Armord, defaultConfig } from './daemon.js';
import { connectDecider } from './decider.js';
import { runHook, type HookHost } from './hooks.js';
import { ArmordClient, serve, socketPath } from './ipc.js';
import { pinFile, runProxy } from './mcp-proxy.js';
import { runPolicyTests } from './policy-test.js';
import { PolicyStore } from './store.js';
import { verifyAuditLog } from './audit.js';
import { STARTER_POLICY } from './starter.js';
import { generateSigningKey, signFile } from './keys.js';
import { runPlanServer } from './mcp-plan.js';
import { installService, servicePlan, uninstallService } from './service.js';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { readdirSync } from 'node:fs';
import { completionScript, fetchBundle, filterAudit, followAudit, formatChecks, formatRecord, installedHosts, parseSince, readAudit, registerAgent, resolveApiKey, runDoctor, watchHolds, type LogFilter } from './commands.js';
import { runTui } from './tui.js';
import { INSTALL_HOSTS, hostStatus, installHost, uninstallHost, type InstallHost } from './install.js';
import { homedir } from 'node:os';
import { applyMigration, planMigration, scanSources, type SourceId } from './migrate.js';
import { listTemplates, readTemplate, renderTemplate } from './templates.js';

const HELP = `armord - local ArmorIQ decision daemon

  armord init                         write a starter armor.io/v2 policy to the policy dir
  armord start                        run the daemon in the foreground
  armord status                       show the running daemon's policy, counts and latency
  armord decide <tool> [json-args]    ask for one verdict (daemon, or in-process if none)
  armord hook <host>                  answer a pre-tool-use hook from stdin
                                      host: claude-code | cursor | codex | gemini | generic (docs/adapters.md)
  armord mcp-proxy --name <server> -- <command> [args...]
                                      govern a stdio MCP server for any MCP client
  armord holds                        list held calls waiting for a human
  armord approve <id> | reject <id>   resolve a held call
  armord policy check <file>          compile a policy and print its statements and problems
  armord policy test <cases.yaml> <policy-file>...
                                      run expected-verdict cases against policies (CI friendly)
  armord pins list <server> | accept <server>
                                      show or reset pinned MCP tool fingerprints
  armord audit verify [file]          check the decision log's hash chain
  armord keygen [name]                create an Ed25519 signing key (private key owner-only, public key trusted)
  armord policy sign <file> [name]    write <file>.sig; with ARMORD_REQUIRE_SIGNED=1 only signed files load
  armord plan register <plan.json> [--session id] [--host h]
                                      hold a session to a plan (steps, optional intent token)
  armord plan list | clear <session>  show or drop registered plans
  armord mcp-plan [--host h]          stdio MCP server giving agents a register_intent_plan tool
  armord install <host> [--project] [--dry-run]   claude-code | cursor | codex | gemini | openhands | mcp
  armord uninstall <host> [--project]             remove only armord's entries, restore wrapped MCP servers
  armord setup <host> [--template name] [--npx]   one command: policy + hooks + doctor
  armord hosts                        which hosts run armord
  armord templates [show <name>]      policy templates; armord init --template <name>
  armord migrate [--from a,b] [--apply] [--show]   import rules, hooks and MCP servers from Claude Code, Codex, Cursor, Gemini, ArmorClaw...
  armord doctor                       check policies, daemon, hooks, credentials, bundle, audit chain
  armord logs [-n 30] [-f] [--verdict block] [--tool Bash] [--since 2h] [--json]
  armord watch                        approve or reject held calls from this terminal
  armord tui [--demo] [--plain]       terminal UI: overview, holds, decisions, policies, doctor (--demo uses sample data)
  armord remote agents|bundle|register <name>     inspect your ArmorIQ workspace, create an agent
  armord export-policy <file>         print the compiled armor.policy.v2 document (paste into the dashboard)
  armord completions bash|zsh|fish|powershell
  armord service print|install|uninstall
                                      start armord at login (Task Scheduler / LaunchAgent / systemd --user)

Environment: ARMORD_HOME (~/.armoriq/armord), ARMORD_POLICY_DIR, ARMORD_SOCKET, ARMORD_AUDIT
(path or "off"), ARMORD_NO_POLICY (block|hold|allow), ARMORD_HOLD_TIMEOUT_MS. Remote policy:
ARMORD_AGENT_ID + ARMORIQ_API_KEY (or the \`armoriq login\` profile). More: README.md.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function withClient<T>(fn: (c: ArmordClient) => Promise<T>): Promise<T> {
  const c = new ArmordClient();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

const print = (v: unknown) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const config = defaultConfig();
  switch (cmd) {
    case 'init': {
      mkdirSync(config.policyDir, { recursive: true });
      const ti = rest.indexOf('--template');
      const tname = ti >= 0 ? rest[ti + 1] : undefined;
      const file = join(config.policyDir, `${tname ?? 'starter'}.yaml`);
      if (existsSync(file)) return print(`${file} already exists`), 0;
      writeFileSync(file, tname ? renderTemplate(tname) : STARTER_POLICY);
      print(`wrote ${file}`);
      return 0;
    }
    case 'start': {
      const armord = new Armord(config);
      await armord.start();
      const path = socketPath();
      await serve(armord, path);
      const s = armord.status();
      process.stderr.write(`armord listening on ${path}\n  policy set ${String(s.policySetHash)}\n  ${armord.store.localDocuments().length} local document(s) from ${config.policyDir}${config.remote ? `, remote agent ${config.remote.agentId}` : ''}\n`);
      for (const p of armord.store.problems) process.stderr.write(`  ${p.severity}: ${p.file}: ${p.code} ${p.message}\n`);
      armord.holds.on('created', (h: { id: string; tool: string; reason: string }) => process.stderr.write(`HOLD ${h.id} ${h.tool}: ${h.reason}\n  approve: armord approve ${h.id}   reject: armord reject ${h.id}\n`));
      return await new Promise<number>(() => {});
    }
    case 'status':
      print(await withClient((c) => c.call('status')));
      return 0;
    case 'decide': {
      const [tool, json] = rest;
      if (!tool) throw new Error('usage: armord decide <tool> [json-args]');
      const decider = await connectDecider();
      const d = await decider.decide({ tool, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {}, host: 'cli', cwd: process.cwd() });
      decider.close();
      print({ via: decider.mode, ...d });
      return d.verdict === 'allow' ? 0 : 2;
    }
    case 'hook': {
      const host = (rest[0] ?? 'generic') as HookHost;
      const decider = await connectDecider();
      const answer = await runHook(host, await readStdin(), decider);
      decider.close();
      if (answer.stdout) process.stdout.write(answer.stdout + '\n');
      return answer.exitCode;
    }
    case 'mcp-proxy': {
      const dash = rest.indexOf('--');
      const flags = dash >= 0 ? rest.slice(0, dash) : rest;
      const command = dash >= 0 ? rest.slice(dash + 1) : [];
      const nameIdx = flags.indexOf('--name');
      const name = nameIdx >= 0 ? flags[nameIdx + 1] : undefined;
      if (!name || command.length === 0) throw new Error('usage: armord mcp-proxy --name <server> -- <command> [args...]');
      const decider = await connectDecider();
      process.stderr.write(`[armord:${name}] governing "${command.join(' ')}" (${decider.mode})\n`);
      const code = await runProxy({ name, command: command[0] as string, args: command.slice(1), decider, pinDir: join(config.home, 'pins') });
      decider.close();
      return code;
    }
    case 'holds':
      print(await withClient((c) => c.call('holds.list', { all: rest.includes('--all') })));
      return 0;
    case 'approve':
    case 'reject': {
      if (!rest[0]) throw new Error(`usage: armord ${cmd} <hold-id>`);
      print(await withClient((c) => c.call('holds.resolve', { id: rest[0], outcome: cmd === 'approve' ? 'approved' : 'rejected' })));
      return 0;
    }
    case 'policy': {
      const [sub, ...files] = rest;
      if (sub === 'check') {
        const store = new PolicyStore();
        for (const f of files) store.addSource(f, readFileSync(f, 'utf8'));
        for (const doc of store.localDocuments()) {
          print(`${doc.policyId}  layer=${doc.layer}  defaults=${JSON.stringify({ tools: doc.defaults.tools, network: doc.defaults.network, files: doc.defaults.files })}`);
          for (const s of doc.statements) print(`  ${s.effect.padEnd(5)} ${'tool' in s.match ? s.match.tool : `[${s.match.capability}]`}${s.conditions.length ? ' when ' + s.conditions.map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' and ') : ''}  (${s.id})`);
        }
        for (const p of store.problems) print(`${p.severity}: ${p.file}: ${p.code} ${p.message}`);
        return store.problems.some((p) => p.severity === 'error') ? 1 : 0;
      }
      if (sub === 'test') {
        const [cases, ...policies] = files;
        if (!cases || policies.length === 0) throw new Error('usage: armord policy test <cases.yaml> <policy-file>...');
        const { results, problems } = runPolicyTests(policies, cases);
        for (const p of problems.filter((x) => x.severity === 'error')) print(`error: ${p.file}: ${p.code} ${p.message}`);
        for (const r of results) print(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: expected ${r.expect}, got ${r.got}${r.ok ? '' : `  (${r.reason})`}`);
        const failed = results.filter((r) => !r.ok).length;
        print(`\n${results.length - failed}/${results.length} cases passed`);
        return failed > 0 || problems.some((p) => p.severity === 'error') ? 1 : 0;
      }
      if (sub === 'sign') {
        const [file, name] = files;
        if (!file) throw new Error('usage: armord policy sign <file> [key-name]');
        const key = join(config.keysDir, `${name ?? 'local'}.private.pem`);
        if (!existsSync(key)) throw new Error(`no signing key at ${key}; run armord keygen ${name ?? ''}`.trim());
        print(`wrote ${signFile(file, readFileSync(key, 'utf8'))}`);
        return 0;
      }
      throw new Error('usage: armord policy check <file> | test <cases.yaml> <policy-file>... | sign <file> [key-name]');
    }
    case 'pins': {
      const [sub, server] = rest;
      if (!server) throw new Error('usage: armord pins list|accept <server>');
      const file = pinFile(join(config.home, 'pins'), server);
      if (sub === 'accept') {
        if (existsSync(file)) rmSync(file);
        print(`cleared pins for ${server}; the next tools/list pins the current definitions`);
        return 0;
      }
      print(existsSync(file) ? readFileSync(file, 'utf8') : `no pins for ${server}`);
      return 0;
    }
    case 'audit': {
      const file = rest[1] ?? config.auditFile;
      if (rest[0] !== 'verify' || !file) throw new Error('usage: armord audit verify [file]');
      const r = verifyAuditLog(file);
      print(r);
      return r.ok ? 0 : 1;
    }
    case 'keygen': {
      const r = generateSigningKey(config.keysDir, config.trustedKeysDir, rest[0] ?? 'local');
      print(`private key: ${r.privateFile} (owner-only; never give an agent access to it)
trusted public key: ${r.publicFile}`);
      return 0;
    }
    case 'plan': {
      const [sub, ...args] = rest;
      if (sub === 'register') {
        const file = args[0];
        if (!file) throw new Error('usage: armord plan register <plan.json> [--session id] [--host h]');
        const plan = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        const flag = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
        const params: Record<string, unknown> = { ...plan };
        if (flag('--session')) params.sessionId = flag('--session');
        if (flag('--host')) params.host = flag('--host');
        print(await withClient((c) => c.call('plan.register', params)));
        return 0;
      }
      if (sub === 'list') return print(await withClient((c) => c.call('plan.list'))), 0;
      if (sub === 'clear' && args[0]) return print(await withClient((c) => c.call('plan.clear', { sessionId: args[0] }))), 0;
      throw new Error('usage: armord plan register <plan.json> | list | clear <session>');
    }
    case 'mcp-plan': {
      const hostIdx = rest.indexOf('--host');
      const host = hostIdx >= 0 ? (rest[hostIdx + 1] ?? 'generic') : 'generic';
      const client = new ArmordClient();
      await client.connect();
      await runPlanServer(client, host);
      client.close();
      return 0;
    }
    case 'service': {
      const plan = servicePlan(fileURLToPath(import.meta.url));
      if (rest[0] === 'install') return installService(plan), print('armord will start at login'), 0;
      if (rest[0] === 'uninstall') return uninstallService(plan), print('removed'), 0;
      print({ file: plan.file, content: plan.content, enable: plan.enable.map((c) => c.join(' ')), disable: plan.disable.map((c) => c.join(' ')) });
      return 0;
    }
    case 'install':
    case 'uninstall': {
      const host = rest.find((a) => !a.startsWith('-'));
      if (!host || !(INSTALL_HOSTS as readonly string[]).includes(host)) throw new Error(`usage: armord ${cmd} <${INSTALL_HOSTS.join('|')}> [--project] [--dry-run]`);
      const opts = { scope: (rest.includes('--project') ? 'project' : 'user') as 'user' | 'project', cwd: process.cwd(), home: homedir(), dryRun: rest.includes('--dry-run') };
      const r = cmd === 'install' ? installHost(host as InstallHost, opts) : uninstallHost(host as InstallHost, opts);
      for (const c of r.changes) print(`${c.action.padEnd(9)} ${c.file}  ${c.summary}`);
      if (cmd === 'install' && !opts.dryRun) print(`
next: armord init && armord start   (then armord doctor)`);
      return 0;
    }
    case 'setup': {
      // One command: starter policy (if none) + hook install + health check.
      const host = rest.find((a) => !a.startsWith('-'));
      if (!host || !(INSTALL_HOSTS as readonly string[]).includes(host)) throw new Error(`usage: armord setup <${INSTALL_HOSTS.join('|')}> [--project] [--template name] [--npx]`);
      mkdirSync(config.policyDir, { recursive: true });
      const ti = rest.indexOf('--template');
      const tname = ti >= 0 ? rest[ti + 1] : undefined;
      const pf = join(config.policyDir, `${tname ?? 'starter'}.yaml`);
      if (!existsSync(pf) && readdirSync(config.policyDir).length === 0) {
        writeFileSync(pf, tname ? renderTemplate(tname) : STARTER_POLICY);
        print(`wrote ${pf}`);
      }
      const r = installHost(host as InstallHost, { scope: rest.includes('--project') ? 'project' : 'user', cwd: process.cwd(), home: homedir(), command: rest.includes('--npx') ? 'npx -y @armoriq-labs/armord' : undefined });
      for (const c of r.changes) print(`${c.action.padEnd(9)} ${c.file}  ${c.summary}`);
      print('');
      print(formatChecks(await runDoctor(config, process.cwd())));
      return 0;
    }
    case 'hosts': {
      const opts = { scope: (rest.includes('--project') ? 'project' : 'user') as 'user' | 'project', cwd: process.cwd(), home: homedir() };
      for (const h of INSTALL_HOSTS) print(`${h.padEnd(12)} ${hostStatus(h, opts).installed ? 'installed' : '-'}`);
      return 0;
    }
    case 'templates': {
      const [sub, name] = rest;
      if (sub === 'show' && name) return process.stdout.write(readTemplate(name)), 0;
      for (const t of listTemplates()) print(`${t.name.padEnd(24)} ${t.description}${t.casesFile ? '' : ''}`);
      print('');
      print('armord init --template <name>   |   armord templates show <name>');
      return 0;
    }
    case 'migrate': {
      const only = rest.includes('--from') ? (rest[rest.indexOf('--from') + 1] ?? '').split(',').filter(Boolean) as SourceId[] : undefined;
      const scan = scanSources({ home: homedir(), cwd: process.cwd() });
      const plan = planMigration(scan, { policyDir: config.policyDir, only });
      if (plan.sources.length === 0) return print('no existing agent setups found (looked for Claude Code, Codex, Cursor, Gemini, ArmorIQ plugins, MCP configs)'), 0;
      print(`found: ${plan.sources.join(', ')}  (${plan.stats.rules} rules, ${plan.stats.filesDeny} file denies, ${plan.stats.mcpServers} MCP servers)`);
      for (const a of plan.actions) print(`  ${a.kind.padEnd(20)} ${a.file}  ${a.summary}`);
      for (const w of plan.warnings) print(`  warning: ${w}`);
      for (const pr of plan.problems) print(`  problem: ${pr}`);
      if (rest.includes('--show')) print(plan.policyYaml);
      if (!rest.includes('--apply')) return print('dry run. Re-run with --apply to write the policy and wire hooks (sources are backed up as *.armord-bak); --show prints the policy; --replace-plugin-hooks removes ArmorIQ plugin hook entries'), 0;
      const r = applyMigration(plan, { home: homedir(), cwd: process.cwd(), replacePluginHooks: rest.includes('--replace-plugin-hooks') });
      for (const c of r.changes) print(`${c.action.padEnd(9)} ${c.file}  ${c.summary}`);
      return plan.problems.length ? 1 : 0;
    }
    case 'doctor': {
      const checks = await runDoctor(config, process.cwd());
      print(formatChecks(checks));
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }
    case 'logs': {
      const flag = (n: string) => (rest.indexOf(n) >= 0 ? rest[rest.indexOf(n) + 1] : undefined);
      const filter: LogFilter = { verdict: flag('--verdict'), tool: flag('--tool'), host: flag('--host'), limit: Number(flag('-n') ?? 30) };
      if (flag('--since')) filter.since = parseSince(flag('--since') as string);
      if (!config.auditFile) throw new Error('audit log is off (ARMORD_AUDIT=off)');
      const rows = filterAudit(readAudit(config.auditFile).filter((r) => r.event === 'decision'), filter);
      if (rest.includes('--json')) return print(rows), 0;
      for (const r of rows) print(formatRecord(r));
      if (rest.includes('-f') || rest.includes('--follow')) {
        followAudit(config.auditFile, filter, (l) => print(l));
        return await new Promise<number>(() => {});
      }
      return 0;
    }
    case 'tui': {
      // Ink UI by default; --plain keeps the dependency-light readline dashboard in tui.ts.
      if (rest.includes('--plain')) return await runTui(), 0;
      return await (await import('./tui/index.js')).runTui({ demo: rest.includes('--demo') });
    }
    case 'watch': {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const stop = { done: false };
      rl.on('close', () => (stop.done = true));
      await withClient((c) => watchHolds(c, (q) => new Promise((r) => rl.question(q, r)), (l) => print(l), stop));
      rl.close();
      return 0;
    }
    case 'remote': {
      const [sub, name] = rest;
      const key = resolveApiKey();
      if (sub === 'agents' || sub === 'bundle') {
        const b = await fetchBundle(config.endpoint, key);
        if (sub === 'bundle') return print(b), 0;
        print(`org ${b.orgId}`);
        for (const a of b.agents as Array<{ agentId: string; name: string; inactive: boolean; policy: { name?: string } | null; tools: unknown[] }>) print(`  ${a.name.padEnd(28)} ${a.agentId}  ${a.inactive ? 'inactive' : 'active  '}  policy: ${a.policy ? (a.policy.name ?? 'yes') : 'none'}  tools: ${a.tools.length}`);
        return 0;
      }
      if (sub === 'register') {
        if (!name) throw new Error('usage: armord remote register <agent-name>   (creates the agent in your ArmorIQ workspace)');
        const a = await registerAgent(config.endpoint, key, name);
        print(`registered ${a.name} (${a.agentId}); attach a policy in the dashboard, then: ARMORD_AGENT_ID=${a.agentId} armord start`);
        return 0;
      }
      throw new Error('usage: armord remote agents | bundle | register <agent-name>');
    }
    case 'export-policy': {
      const [file] = rest;
      if (!file) throw new Error('usage: armord export-policy <policy.yaml>   (prints the compiled armor.policy.v2 document to paste into the dashboard)');
      const store = new PolicyStore();
      store.addSource(file, readFileSync(file, 'utf8'));
      const errs = store.problems.filter((x) => x.severity === 'error');
      if (errs.length) throw new Error(errs.map((x) => `${x.code} ${x.message}`).join('; '));
      print(store.localDocuments()[0] ?? {});
      return 0;
    }
    case 'completions':
      process.stdout.write(completionScript(rest[0] ?? 'bash'));
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(HELP);
      return 0;
    default:
      throw new Error(`unknown command "${cmd}"; run armord help`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`armord: ${err.message}\n`);
    process.exit(1);
  },
);
