import React from 'react';
import { render } from 'ink';
import { defaultConfig } from '../daemon.js';
import { App } from './App.js';
import { demoSource } from './demo.js';
import { connectSource } from './source.js';

export async function runTui(opts: { demo?: boolean } = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('armord tui needs an interactive terminal. For scripts use: armord status | armord logs | armord doctor\n');
    return 1;
  }
  const source = opts.demo ? demoSource({ live: true }) : await connectSource(defaultConfig());
  const app = render(React.createElement(App, { source }));
  await app.waitUntilExit();
  source.close();
  return 0;
}
