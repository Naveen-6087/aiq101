#!/usr/bin/env node
// 1-Click Installer for ArmorIQ DevPack: Skills & Docs MCP Server.
// Automatically adds skills and registers the Docs MCP server across Claude, Cursor, and Codex.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install as installSkills } from '../skills/install.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, 'docs-mcp', 'server.mjs');

console.log('=== Installing ArmorIQ DevPack Skills ===');
for (const host of ['claude', 'cursor', 'codex']) {
  try {
    const res = installSkills(host, { scope: 'user' });
    console.log(`[skills] ${host}: ${res.changes.length} item(s) configured`);
  } catch (err) {
    console.log(`[skills] ${host}: ${(err).message}`);
  }
}

console.log('\n=== Registering ArmorIQ Docs MCP Server ===');

// 1. Claude (~/.claude.json)
const claudePath = join(homedir(), '.claude.json');
try {
  let doc = { mcpServers: {} };
  if (existsSync(claudePath)) {
    try { doc = JSON.parse(readFileSync(claudePath, 'utf8')); } catch { doc = { mcpServers: {} }; }
  }
  doc.mcpServers = doc.mcpServers || {};
  doc.mcpServers['armoriq-docs'] = {
    command: 'node',
    args: [serverPath],
  };
  writeFileSync(claudePath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[mcp] Claude (~/.claude.json): registered armoriq-docs`);
} catch (err) {
  console.log(`[mcp] Claude: ${(err).message}`);
}

// 2. Cursor (~/.cursor/mcp.json)
const cursorPath = join(homedir(), '.cursor', 'mcp.json');
try {
  let doc = { mcpServers: {} };
  if (existsSync(cursorPath)) {
    try { doc = JSON.parse(readFileSync(cursorPath, 'utf8')); } catch { doc = { mcpServers: {} }; }
  }
  doc.mcpServers = doc.mcpServers || {};
  doc.mcpServers['armoriq-docs'] = {
    command: 'node',
    args: [serverPath],
  };
  writeFileSync(cursorPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[mcp] Cursor (~/.cursor/mcp.json): registered armoriq-docs`);
} catch (err) {
  console.log(`[mcp] Cursor: ${(err).message}`);
}

// 3. Codex (~/.codex/config.toml)
const codexPath = join(homedir(), '.codex', 'config.toml');
try {
  let toml = existsSync(codexPath) ? readFileSync(codexPath, 'utf8') : '';
  if (!toml.includes('[mcp_servers.armoriq-docs]')) {
    const escaped = serverPath.replace(/\\/g, '/');
    const block = `\n[mcp_servers.armoriq-docs]\ncommand = "node"\nargs = ["${escaped}"]\n`;
    writeFileSync(codexPath, toml + block);
    console.log(`[mcp] Codex (~/.codex/config.toml): registered armoriq-docs`);
  } else {
    console.log(`[mcp] Codex (~/.codex/config.toml): armoriq-docs already registered`);
  }
} catch (err) {
  console.log(`[mcp] Codex: ${(err).message}`);
}

console.log('\nAll skills and Docs MCP server successfully installed!');
