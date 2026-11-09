// Local IPC: newline-delimited JSON over a Unix socket (or a named pipe on Windows).
// Request  {"id": 1, "method": "decide", "params": {...}}
// Response {"id": 1, "result": {...}}  or  {"id": 1, "error": "message"}
// The socket is created with owner-only permissions; only the user running armord can ask it.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Armord } from './daemon.js';

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARMORD_SOCKET) return env.ARMORD_SOCKET;
  if (process.platform === 'win32') return `\\\\.\\pipe\\armord-${userInfo().username}`;
  return join(homedir(), '.armoriq', 'armord.sock');
}

type Handler = (params: Record<string, unknown>) => unknown;

export function serve(armord: Armord, path = socketPath()): Promise<Server> {
  const methods: Record<string, Handler> = {
    decide: (p) => armord.decide(p as never, { waitOnHold: p.waitOnHold === true, ...(typeof p.holdTimeoutMs === 'number' ? { holdTimeoutMs: p.holdTimeoutMs } : {}) }),
    status: () => armord.status(),
    reload: () => (armord.reload(), armord.status()),
    'holds.list': (p) => armord.holds.list(p.all === true),
    'holds.resolve': (p) => {
      const hold = armord.holds.resolve(String(p.id), p.outcome === 'approved' ? 'approved' : 'rejected', typeof p.by === 'string' ? p.by : 'local-user');
      if (!hold) throw new Error(`no pending hold ${String(p.id)}`);
      armord.audit.append('hold.resolved', { holdId: hold.id, outcome: hold.status, by: hold.resolvedBy });
      return hold;
    },
    'inventory.set': (p) => (armord.setInventory((p.tools ?? []) as never), { tools: armord.store.getInventory().length, problems: armord.store.problems }),
    'plan.register': (p) => {
      const plan = armord.plans.register(p as never);
      armord.audit.append('plan', { planId: plan.id, sessionId: plan.sessionId, host: plan.host, goal: plan.goal, steps: plan.steps, tokenVerified: plan.token?.verified ?? false });
      return plan;
    },
    'plan.list': () => armord.plans.list(),
    'plan.clear': (p) => ({ cleared: armord.plans.clear(String(p.sessionId)) }),
    ping: () => 'pong',
  };

  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) unlinkSync(path);
  }

  const server = createServer((socket: Socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        void handle(line);
      }
    });
    socket.on('error', () => {});
    async function handle(line: string): Promise<void> {
      let id: unknown = null;
      try {
        const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
        id = msg.id ?? null;
        const fn = methods[msg.method ?? ''];
        if (!fn) throw new Error(`unknown method ${String(msg.method)}`);
        const result = await fn(msg.params ?? {});
        if (!socket.destroyed) socket.write(JSON.stringify({ id, result }) + '\n');
      } catch (err) {
        if (!socket.destroyed) socket.write(JSON.stringify({ id, error: (err as Error).message }) + '\n');
      }
    }
  });

  return new Promise((resolveServe, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      resolveServe(server);
    });
  });
}

/** Minimal client: one connection, many requests. */
export class ArmordClient {
  private socket: Socket | null = null;
  private buf = '';
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly path = socketPath()) {}

  connect(timeoutMs = 1000): Promise<void> {
    return new Promise((resolveConnect, reject) => {
      const socket = createConnection(this.path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`armord not reachable at ${this.path}`));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolveConnect();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`armord not reachable at ${this.path}: ${err.message}`));
      });
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('armord connection closed'));
        this.pending.clear();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('not connected'));
    const id = this.next++;
    return new Promise<T>((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall as (v: unknown) => void, reject });
      this.socket?.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}
