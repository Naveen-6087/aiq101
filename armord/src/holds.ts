// Local hold queue. A held call waits here until someone approves or rejects it
// (`armord approve <id>`, the TUI, or a future approvals router), or until it times out.
// Timeout is a rejection: a hold never turns into an allow by waiting.

import { EventEmitter } from 'node:events';
import type { Decision } from './engine.js';

export type HoldOutcome = 'approved' | 'rejected' | 'timeout';

export interface Hold {
  id: string;
  createdAt: string;
  tool: string;
  host: string;
  reason: string;
  arguments: Record<string, unknown>;
  status: 'pending' | HoldOutcome;
  resolvedBy?: string;
}

export class HoldQueue extends EventEmitter {
  private holds = new Map<string, Hold>();

  create(decision: Decision, host: string, args: Record<string, unknown>): Hold {
    const hold: Hold = { id: decision.id.slice(0, 8), createdAt: new Date().toISOString(), tool: decision.tool, host, reason: decision.reason, arguments: args, status: 'pending' };
    this.holds.set(hold.id, hold);
    this.emit('created', hold);
    return hold;
  }

  list(all = false): Hold[] {
    return [...this.holds.values()].filter((h) => all || h.status === 'pending');
  }

  resolve(id: string, outcome: 'approved' | 'rejected', by = 'local-user'): Hold | null {
    const hold = this.holds.get(id);
    if (!hold || hold.status !== 'pending') return null;
    hold.status = outcome;
    hold.resolvedBy = by;
    this.emit(`resolved:${id}`, outcome);
    this.emit('resolved', hold);
    return hold;
  }

  wait(id: string, timeoutMs: number): Promise<HoldOutcome> {
    const hold = this.holds.get(id);
    if (!hold) return Promise.resolve('rejected');
    if (hold.status !== 'pending') return Promise.resolve(hold.status);
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        this.removeAllListeners(`resolved:${id}`);
        hold.status = 'timeout';
        this.emit('resolved', hold);
        resolveWait('timeout');
      }, timeoutMs);
      this.once(`resolved:${id}`, (outcome: HoldOutcome) => {
        clearTimeout(timer);
        resolveWait(outcome);
      });
    });
  }
}
