// Offline stand-in for src/mcpClient.js: canned rows for the notes and employees tables, read from
// the INSERT statements in db/init.sql, instead of a spawned postgres MCP server and Docker.
// Like the real server, anything that is not a SELECT fails (it runs every statement read only).

import { readFileSync } from 'node:fs';

const seed = readFileSync(new URL('../db/init.sql', import.meta.url), 'utf8');

function literal(raw) {
  const value = raw.trim();
  if (value.startsWith("'")) return value.slice(1, -1);
  return Number(value);
}

function rowsFor(table, columns) {
  const match = seed.match(new RegExp(`INSERT INTO ${table} \\(([^)]*)\\) VALUES([\\s\\S]*?)(?:ON CONFLICT|;)`));
  const names = match[1].split(',').map((c) => c.trim());
  const tuples = [...match[2].matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(literal));
  return tuples.map((values, i) => Object.fromEntries([['id', i + 1], ...names.map((n, j) => [n, values[j]])]));
}

const tables = { notes: rowsFor('notes'), employees: rowsFor('employees') };

export async function connectPostgresServer() {
  return { close: async () => {} };
}

export async function callTool(client, name, args = {}) {
  if (name !== 'query') throw new Error(`Offline postgres stand-in does not implement ${name}`);
  const sql = String(args.sql ?? '');
  const select = sql.match(/^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
  if (!select) throw new Error('cannot execute in a read-only transaction');
  const rows = tables[select[2].toLowerCase()];
  if (!rows) throw new Error(`relation "${select[2]}" does not exist`);
  const cols = select[1] === '*' ? null : select[1].split(',').map((c) => c.trim());
  const result = rows.map((row) => (cols ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row));
  if (/ORDER BY salary DESC/i.test(sql)) result.sort((a, b) => b.salary - a.salary);
  return result;
}
