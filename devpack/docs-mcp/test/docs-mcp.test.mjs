import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

function start() {
  const p = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = createInterface({ input: p.stdout });
  const waiters = new Map();
  rl.on('line', (l) => {
    const m = JSON.parse(l);
    waiters.get(m.id)?.(m);
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiters.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text;
    return { r, text, json: r.result?.isError ? null : JSON.parse(text) };
  };
  return { p, call, tool, notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close: () => p.kill() };
}

test('initialize, tools/list and ping over stdio', async () => {
  const s = start();
  const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.ok(init.result.capabilities.tools);
  s.notify('notifications/initialized'); // must not get a reply
  const list = await s.call('tools/list');
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['find_recipe', 'get_endpoint', 'list_docs', 'read_doc', 'search_docs']);
  assert.deepEqual((await s.call('ping')).result, {});
  assert.equal((await s.call('nope')).error.code, -32601);
  s.close();
});

test('search_docs finds the Intent Gateway page', async () => {
  const s = start();
  const { json } = await s.tool('search_docs', { query: 'intent gateway base url', limit: 5 });
  assert.ok(json.length > 0 && json.length <= 5);
  assert.ok(json.some((h) => /gateway/i.test(h.title)), JSON.stringify(json.map((h) => h.title)));
  assert.ok(json[0].url.startsWith('https://docs.armoriq.ai/'));
  s.close();
});

test('read_doc by id, by URL and by section; unknown page is a tool error', async () => {
  const s = start();
  const a = await s.tool('read_doc', { id: 'products' });
  assert.match(a.json.content, /Intent Gateway/);
  const b = await s.tool('read_doc', { url: 'https://docs.armoriq.ai/products' });
  assert.equal(b.json.id, 'products');
  const c = await s.tool('read_doc', { id: '/products', section: 'one line' });
  assert.match(c.json.content, /OPENAI_BASE_URL/);
  const bad = await s.tool('read_doc', { id: 'does-not-exist' });
  assert.equal(bad.r.result.isError, true);
  assert.match(bad.text, /no page matches/);
  s.close();
});

test('list_docs lists all pages and filters by product', async () => {
  const s = start();
  const all = (await s.tool('list_docs', {})).json;
  assert.equal(all.count, 255);
  const sdk = (await s.tool('list_docs', { product: 'sdk' })).json;
  assert.ok(sdk.count > 0 && sdk.count < all.count);
  s.close();
});

test('get_endpoint resolves routes with and without a method, and param names', async () => {
  const s = start();
  const a = (await s.tool('get_endpoint', { path_or_name: 'POST /agent/register' })).json;
  assert.equal(a.routes[0].path, '/agent/register');
  assert.ok(a.context.length > 0);
  const b = (await s.tool('get_endpoint', { path_or_name: '/agent/agents/{id}/status' })).json;
  assert.equal(b.routes[0].path, '/agent/agents/:agentId/status');
  const c = (await s.tool('get_endpoint', { path_or_name: 'Intent Gateway' })).json;
  assert.ok(c.pages.length > 0);
  s.close();
});

test('find_recipe filters by framework, language and outcome', async () => {
  const s = start();
  const a = (await s.tool('find_recipe', { framework: 'langchain', language: 'python' })).json;
  assert.ok(a.recipes.some((r) => r.path === 'langchain/python/sql-analyst'));
  const b = (await s.tool('find_recipe', { outcome: 'prompt-injection' })).json;
  assert.ok(b.count >= 1);
  const none = (await s.tool('find_recipe', { framework: 'cobol' })).json;
  assert.equal(none.count, 0);
  s.close();
});
