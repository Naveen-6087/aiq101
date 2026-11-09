// One interface for "ask armord": through the running daemon when there is one, otherwise an
// in-process engine over the same policy files. Never fails open: if neither can be built, the
// caller gets a block.

import type { InventoryTool } from '@armoriq/policy-ir';
import { Armord, defaultConfig, type DecideOptions, type DecisionResult } from './daemon.js';
import type { DecideRequest } from './engine.js';
import { ArmordClient } from './ipc.js';

export interface Decider {
  readonly mode: 'daemon' | 'in-process';
  decide(req: DecideRequest, opts?: DecideOptions): Promise<DecisionResult>;
  setInventory(tools: InventoryTool[]): Promise<void>;
  close(): void;
}

class DaemonDecider implements Decider {
  readonly mode = 'daemon' as const;
  constructor(private readonly client: ArmordClient) {}
  decide(req: DecideRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    return this.client.call<DecisionResult>('decide', { ...req, ...opts } as Record<string, unknown>);
  }
  async setInventory(tools: InventoryTool[]): Promise<void> {
    await this.client.call('inventory.set', { tools });
  }
  close(): void {
    this.client.close();
  }
}

class LocalDecider implements Decider {
  readonly mode = 'in-process' as const;
  constructor(private readonly armord: Armord) {}
  decide(req: DecideRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    return this.armord.decide(req, opts);
  }
  async setInventory(tools: InventoryTool[]): Promise<void> {
    this.armord.setInventory(tools);
  }
  close(): void {
    this.armord.stop();
  }
}

export async function connectDecider(opts: { preferDaemon?: boolean; socket?: string } = {}): Promise<Decider> {
  if (opts.preferDaemon !== false) {
    const client = new ArmordClient(opts.socket);
    try {
      await client.connect(300);
      return new DaemonDecider(client);
    } catch {
      // fall through to in-process
    }
  }
  const config = defaultConfig();
  // In-process: no background refresh; use the cached remote bundle so a hook never waits on the network.
  const armord = new Armord({ ...config, refreshMs: 0 });
  armord.store.loadLocal();
  armord.store.loadRemoteCache();
  // No daemon and no fresh cache: one short refresh, so a first hook call is not blocked "no bundle yet".
  if (config.remote && armord.store.remoteStatus() !== 'current' && process.env.ARMORD_OFFLINE !== '1') {
    await Promise.race([armord.store.refreshRemote(), new Promise((r) => setTimeout(r, 2500))]).catch(() => undefined);
  }
  return new LocalDecider(armord);
}
