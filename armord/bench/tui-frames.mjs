// Prints each TUI screen in demo mode as plain text, for eyeballing layout.
// usage: node bench/tui-frames.mjs [columns] [rows]
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../dist/tui/App.js';
import { demoSource } from '../dist/tui/demo.js';

const columns = Number(process.argv[2] ?? 100);
const rows = Number(process.argv[3] ?? 30);
const NOW = Date.parse('2026-11-10T14:30:00Z');
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const app = render(React.createElement(App, { source: demoSource({ now: () => NOW }), size: { columns, rows }, now: () => NOW, pollMs: 50 }));
await settle();
for (const [key, label] of [['1', 'Overview'], ['2', 'Holds'], ['3', 'Decisions'], ['4', 'Policies'], ['5', 'Doctor']]) {
  app.stdin.write(key);
  await settle();
  console.log(`\n===== ${label} (${columns}x${rows}) =====`);
  console.log(app.lastFrame());
}
app.unmount();
process.exit(0);
