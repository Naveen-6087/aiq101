// Start armord at login, per user, with no API key in the service definition (armord reads the
// `armoriq login` profile from ~/.armoriq/credentials.json at start).
//
//   Windows  a Task Scheduler task that runs at logon (schtasks)
//   macOS    a LaunchAgent plist in ~/Library/LaunchAgents
//   Linux    a systemd --user unit

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ServicePlan {
  platform: NodeJS.Platform;
  file: string | null;
  content: string | null;
  enable: string[][];
  disable: string[][];
}

const LABEL = 'ai.armoriq.armord';

export function credentialsApiKey(env: NodeJS.ProcessEnv = process.env): { apiKey: string; backend: string } | null {
  const file = join(homedir(), '.armoriq', 'credentials.json');
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; active?: string; profiles?: Record<string, { apiKey?: string; backend?: string }> };
    if (doc.version !== 2 || !doc.profiles) return null;
    const name = env.ARMORIQ_PROFILE ?? doc.active;
    const p = name ? doc.profiles[name] : undefined;
    return p?.apiKey && p.backend ? { apiKey: p.apiKey, backend: p.backend } : null;
  } catch {
    return null;
  }
}

export function servicePlan(cliPath: string, platform: NodeJS.Platform = process.platform): ServicePlan {
  const node = process.execPath;
  const log = join(homedir(), '.armoriq', 'armord', 'armord.log');
  if (platform === 'win32') {
    const tr = `"${node}" "${cliPath}" start`;
    return {
      platform,
      file: null,
      content: null,
      enable: [['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'armord', '/TR', tr], ['schtasks', '/Run', '/TN', 'armord']],
      disable: [['schtasks', '/End', '/TN', 'armord'], ['schtasks', '/Delete', '/F', '/TN', 'armord']],
    };
  }
  if (platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${cliPath}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
    return { platform, file, content, enable: [['launchctl', 'load', '-w', file]], disable: [['launchctl', 'unload', '-w', file]] };
  }
  const file = join(homedir(), '.config', 'systemd', 'user', 'armord.service');
  const content = `[Unit]
Description=armord - local ArmorIQ decision daemon

[Service]
ExecStart=${node} ${cliPath} start
Restart=on-failure

[Install]
WantedBy=default.target
`;
  return {
    platform,
    file,
    content,
    enable: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'armord.service']],
    disable: [['systemctl', '--user', 'disable', '--now', 'armord.service']],
  };
}

export function installService(plan: ServicePlan): void {
  if (plan.file && plan.content) {
    mkdirSync(dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, plan.content);
  }
  for (const [cmd, ...args] of plan.enable) execFileSync(cmd as string, args, { stdio: 'inherit' });
}

export function uninstallService(plan: ServicePlan): void {
  for (const [cmd, ...args] of plan.disable) {
    try {
      execFileSync(cmd as string, args, { stdio: 'inherit' });
    } catch {
      // already gone
    }
  }
  if (plan.file && existsSync(plan.file)) rmSync(plan.file);
}
