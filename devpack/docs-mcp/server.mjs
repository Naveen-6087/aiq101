#!/usr/bin/env node
// ArmorIQ docs MCP server: JSON-RPC 2.0 over stdin/stdout, newline-delimited (MCP stdio transport).
// Offline: reads data/docs-index.json (build with `npm run index`). Override with ARMORIQ_DOCS_INDEX.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, createTools } from './tools.mjs';

const PROTOCOL = '2024-11-05';
const here = dirname(fileURLToPath(import.meta.url));

export function handle(tools, msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (id === undefined) return null; // notification: never answered
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'armoriq-docs', version: '0.1.0' }, instructions: 'Search and read the ArmorIQ docs and cookbook recipes offline. Start with search_docs, then read_doc.' });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOL_DEFS });
    case 'tools/call': {
      const fn = tools[params?.name];
      if (!fn) return fail(-32602, `unknown tool "${params?.name}"`);
      try {
        const out = fn(params.arguments ?? {});
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function loadIndex(file = process.env.ARMORIQ_DOCS_INDEX ?? join(here, 'data', 'docs-index.json')) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read docs index ${file}: ${e.message}. Run "npm run index" first.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tools = createTools(loadIndex());
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const out = handle(tools, msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
