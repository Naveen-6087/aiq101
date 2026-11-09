// MCP proxy: armord's front door for any stdio MCP server, under any MCP client.
//
//   client  <-- stdio JSON-RPC -->  armord mcp-proxy  <-- stdio JSON-RPC -->  real MCP server
//
// - tools/call is decided before the server sees it; a block or a rejected hold is answered
//   with an MCP tool error the model can read, and the server never runs it.
// - tools/list results feed the policy inventory (so exact rule keys bind to real schemas) and
//   are pinned: a tool whose description or schema changes after first sight is held until a
//   human accepts the change (`armord pins accept <server>`). That catches a server that
//   rewrites a tool after you trusted it.
// - tools/call results are scanned for secrets and redacted before they reach the model.
// - the server's stderr and exit code are surfaced, instead of the client showing "0 tools".

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaHash } from '@armoriq/policy-ir';
import type { InventoryTool } from '@armoriq/policy-ir';
import type { Decider } from './decider.js';
import { redact } from './redact.js';

export interface ProxyOptions {
  name: string;
  command: string;
  args: string[];
  decider: Decider;
  pinDir: string;
  /** Where to log; defaults to process.stderr. */
  log?: (line: string) => void;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

interface Pin {
  description: string;
  schema: string | null;
}

type Json = Record<string, unknown>;

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export function pinFile(pinDir: string, server: string): string {
  return join(pinDir, `${server.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

export function runProxy(opts: ProxyOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const upIn = opts.stdin ?? process.stdin;
  const upOut = opts.stdout ?? process.stdout;
  const child = spawn(opts.command, opts.args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, shell: process.platform === 'win32' });

  const pendingMethods = new Map<string, string>();
  const drifted = new Set<string>();
  const liveSchemaHash = new Map<string, string | null>();
  const pinPath = pinFile(opts.pinDir, opts.name);
  const pins: Record<string, Pin> = existsSync(pinPath) ? (JSON.parse(readFileSync(pinPath, 'utf8')) as Record<string, Pin>) : {};

  const send = (stream: NodeJS.WritableStream, msg: unknown) => stream.write(JSON.stringify(msg) + '\n');
  const toServer = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');

  child.stderr.setEncoding('utf8');
  lines(child.stderr, (l) => log(`[armord:${opts.name}] ${l}`));
  child.on('error', (err) => log(`[armord:${opts.name}] could not start "${opts.command}": ${err.message}`));

  lines(upIn, (line) => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      log(`[armord:${opts.name}] dropped a non-JSON line from the client`);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === 'string') pendingMethods.set(String(msg.id), msg.method);
    if (msg.method !== 'tools/call') return void toServer(msg);
    void gate(msg);
  });

  async function gate(msg: Json): Promise<void> {
    const params = (msg.params ?? {}) as Json;
    const tool = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const d = await opts.decider.decide(
        { host: 'mcp', tool, arguments: args, mcpServer: opts.name, schemaHash: liveSchemaHash.get(tool) ?? null },
        { waitOnHold: true },
      );
      let final = d.final;
      let reason = d.reason;
      if (final === 'allow' && drifted.has(tool)) {
        final = 'block';
        reason = `tool "${tool}" changed its description or schema since it was first seen; run \`armord pins accept ${opts.name}\` after reviewing it`;
      }
      log(`[armord:${opts.name}] ${final.toUpperCase().padEnd(5)} ${tool} (${reason}${d.holdOutcome ? `; hold ${d.holdOutcome}` : ''}) ${d.latencyUs}us`);
      if (final === 'allow') return void toServer(msg);
      pendingMethods.delete(String(msg.id));
      send(upOut, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: `ArmorIQ did not run "${tool}": ${reason}${d.holdOutcome ? ` (approval ${d.holdOutcome})` : ''}` }] },
      });
    } catch (err) {
      pendingMethods.delete(String(msg.id));
      log(`[armord:${opts.name}] BLOCK ${tool} (decision failed: ${(err as Error).message})`);
      send(upOut, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `ArmorIQ could not decide "${tool}", so it did not run.` }] } });
    }
  }

  lines(child.stdout, (line) => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      log(`[armord:${opts.name}] server wrote a non-JSON line to stdout: ${line.slice(0, 200)}`);
      return;
    }
    const method = msg.id !== undefined ? pendingMethods.get(String(msg.id)) : undefined;
    if (method) pendingMethods.delete(String(msg.id));
    if (method === 'tools/list' && msg.result) void onToolsList(msg.result as Json);
    if (method === 'tools/call' && msg.result) {
      const { value, count } = redact(msg.result);
      if (count > 0) {
        log(`[armord:${opts.name}] redacted ${count} secret${count === 1 ? '' : 's'} from a tool result`);
        msg.result = value;
      }
    }
    send(upOut, msg);
  });

  async function onToolsList(result: Json): Promise<void> {
    const tools = (Array.isArray(result.tools) ? result.tools : []) as Json[];
    const inventory: InventoryTool[] = [];
    let changed = false;
    for (const t of tools) {
      const name = String(t.name);
      const hash = schemaHash(t.inputSchema);
      liveSchemaHash.set(name, hash);
      const fingerprint: Pin = { description: sha(String(t.description ?? '')), schema: hash };
      const pinned = pins[name];
      if (!pinned) {
        pins[name] = fingerprint;
        changed = true;
      } else if (pinned.description !== fingerprint.description || pinned.schema !== fingerprint.schema) {
        if (!drifted.has(name)) log(`[armord:${opts.name}] PIN   ${name} changed since it was first seen; its calls are blocked until you accept it`);
        drifted.add(name);
      }
      inventory.push({ name, qualifiedName: `mcp__${opts.name}__${name}`, owner: { type: 'mcp_server', id: opts.name, name: opts.name }, schemaHash: hash, inputSchema: t.inputSchema, declared: true });
    }
    if (changed) {
      mkdirSync(opts.pinDir, { recursive: true });
      writeFileSync(pinPath, JSON.stringify(pins, null, 2));
    }
    log(`[armord:${opts.name}] ${tools.length} tools listed (${drifted.size} changed since pinned)`);
    try {
      await opts.decider.setInventory(inventory);
    } catch (err) {
      log(`[armord:${opts.name}] could not update the policy inventory: ${(err as Error).message}`);
    }
  }

  return new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      if (code !== 0) log(`[armord:${opts.name}] server exited ${signal ? `on ${signal}` : `with code ${code}`}`);
      resolveExit(code ?? 1);
    });
    upIn.on('end', () => child.stdin.end());
  });
}

function sha(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}
