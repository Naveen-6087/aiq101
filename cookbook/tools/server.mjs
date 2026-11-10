#!/usr/bin/env node
// Localhost recipe browser: static UI in tools/browser/ plus a small JSON/SSE API.
// Run with: npm run serve   (PORT env var supported)
// Recipes are run by convention (spec 0003/0004); no recipe ids live in this file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { root, recipeIds, recipeDir, loadTaxonomy, ALLOWLIST, readAllowlistLines } from './recipes.mjs';
import { loadYaml } from '../schema/manifest.mjs';

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser');
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const isWin = process.platform === 'win32';

// True when `target` is inside (or equal to) `base`, using path.relative.
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readManifest(dir) {
  const p = path.join(dir, 'recipe.yaml');
  if (!fs.existsSync(p)) return null;
  try {
    return loadYaml(p);
  } catch {
    return null;
  }
}

function getRecipes() {
  const allowlistContent = fs.existsSync(path.join(root, ALLOWLIST))
    ? fs.readFileSync(path.join(root, ALLOWLIST), 'utf8')
    : '';
  const allowedSet = new Set(readAllowlistLines(allowlistContent).map((l) => l.id));
  return recipeIds().map((id) => {
    const dir = recipeDir(id);
    return {
      id,
      dir: path.relative(root, dir),
      isOfficial: allowedSet.has(id),
      manifest: readManifest(dir),
      hasReadme: fs.existsSync(path.join(dir, 'README.md')),
    };
  });
}

function getRecipeFiles(id) {
  const dir = recipeDir(id);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  (function scan(current, rel) {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const subRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) scan(path.join(current, ent.name), subRel);
      else results.push(subRel);
    }
  })(dir, '');
  return results.sort();
}

function getPolicies(id) {
  return getRecipeFiles(id)
    .filter((f) => /(^|\/)policy[^/]*\.ya?ml$/.test(f))
    .map((file) => {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(recipeDir(id), file), 'utf8')) || {};
        const rules = (Array.isArray(doc.rules) ? doc.rules : []).map((r) => {
          const { tool, action, ...rest } = r || {};
          return { tool: tool ?? '', action: action ?? '', extra: Object.keys(rest).length ? rest : null };
        });
        return {
          file,
          name: doc.name ?? null,
          version: doc.version ?? null,
          scope: doc.scope ?? null,
          default_action: doc.default_action ?? null,
          rules,
        };
      } catch (err) {
        return { file, error: String(err.message || err), rules: [] };
      }
    });
}

// Figure out which lane a recipe runs in: taxonomy language lane first, then files.
function laneFor(id, taxonomy) {
  const lang = readManifest(recipeDir(id))?.language;
  const lane = lang && taxonomy.languages?.[lang]?.lane;
  if (lane) return lane;
  const dir = recipeDir(id);
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'typescript';
  if (fs.existsSync(path.join(dir, 'offline', 'demo.py'))) return 'python';
  return 'other';
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(STATIC_DIR, rel);
  if (!isInside(STATIC_DIR, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

function handleRun(recipeId, url, req, res) {
  const dir = recipeDir(recipeId);
  if (!fs.existsSync(dir)) return json(res, 404, { error: 'Recipe not found' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const approval = url.searchParams.get('approval') === 'reject' ? 'reject' : 'approve';
  const env = { ...process.env, OFFLINE_APPROVAL: approval };
  const lane = laneFor(recipeId, loadTaxonomy());

  send('start', { recipeId, lane, approval });

  let cmd, args, shell = false;
  if (lane === 'typescript') {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    } catch {}
    const script = scripts['demo:browser'] ? 'demo:browser' : scripts['demo:offline'] ? 'demo:offline' : null;
    if (!script) {
      send('problem', { tone: 'bad', text: 'This recipe has no demo:browser or demo:offline script.' });
      send('done', { code: null });
      return res.end();
    }
    cmd = 'npm';
    args = ['run', '-s', script];
    shell = isWin;
    send('log', { text: `$ npm run -s ${script}   (OFFLINE_APPROVAL=${approval})\n` });
  } else if (lane === 'python') {
    const py = path.join(dir, isWin ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    if (!fs.existsSync(py)) {
      send('problem', {
        tone: 'warn',
        text: `No .venv found. Run \`npm run check:recipes ${recipeId}\` once to set it up.`,
      });
      send('done', { code: null });
      return res.end();
    }
    if (!fs.existsSync(path.join(dir, 'offline', 'demo.py'))) {
      send('problem', { tone: 'bad', text: 'This recipe has no offline/demo.py.' });
      send('done', { code: null });
      return res.end();
    }
    cmd = py;
    args = ['offline/demo.py'];
    send('log', { text: `$ .venv python offline/demo.py   (OFFLINE_APPROVAL=${approval})\n` });
  } else {
    send('problem', { tone: 'info', text: 'This recipe is config only and has nothing to run.' });
    send('done', { code: null });
    return res.end();
  }

  const child = spawn(cmd, args, { cwd: dir, env, shell });
  child.stdout.on('data', (d) => send('log', { text: d.toString() }));
  child.stderr.on('data', (d) => send('log', { text: d.toString() }));
  child.on('error', (err) => {
    send('problem', { tone: 'bad', text: `Could not start the process: ${err.message}` });
    send('done', { code: null });
    res.end();
  });
  child.on('close', (code) => {
    send('done', { code });
    res.end();
  });
  res.on('close', () => {
    if (child.exitCode === null) child.kill();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/recipes') return json(res, 200, { recipes: getRecipes(), taxonomy: loadTaxonomy() });
  if (pathname === '/api/taxonomy') return json(res, 200, loadTaxonomy());

  if (pathname.startsWith('/api/recipe/')) {
    const id = decodeURIComponent(pathname.slice('/api/recipe/'.length));
    const dir = recipeDir(id);
    if (!isInside(path.join(root, 'recipes'), dir) || !fs.existsSync(dir)) {
      return json(res, 404, { error: 'Recipe not found' });
    }
    const readmePath = path.join(dir, 'README.md');
    return json(res, 200, {
      id,
      manifest: readManifest(dir),
      readme: fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '',
      files: getRecipeFiles(id),
    });
  }

  if (pathname.startsWith('/api/policy/')) {
    const id = decodeURIComponent(pathname.slice('/api/policy/'.length));
    const dir = recipeDir(id);
    if (!isInside(path.join(root, 'recipes'), dir) || !fs.existsSync(dir)) {
      return json(res, 404, { error: 'Recipe not found' });
    }
    return json(res, 200, { id, policies: getPolicies(id) });
  }

  if (pathname.startsWith('/api/file/')) {
    const id = decodeURIComponent(pathname.slice('/api/file/'.length));
    const queryPath = url.searchParams.get('file');
    const dir = recipeDir(id);
    if (!queryPath || !isInside(path.join(root, 'recipes'), dir) || !fs.existsSync(dir)) {
      return json(res, 400, { error: 'Invalid file or recipe' });
    }
    const fullPath = path.resolve(dir, queryPath);
    if (!isInside(dir, fullPath) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return json(res, 404, { error: 'File not found' });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(fullPath, 'utf8'));
  }

  if (pathname === '/api/check') {
    const cp = spawn('npm', ['run', 'check'], { cwd: root, shell: isWin });
    let output = '';
    cp.stdout.on('data', (d) => (output += d));
    cp.stderr.on('data', (d) => (output += d));
    cp.on('close', (code) => json(res, 200, { code, output }));
    return;
  }

  if (pathname.startsWith('/api/run/')) {
    return handleRun(decodeURIComponent(pathname.slice('/api/run/'.length)), url, req, res);
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  serveStatic(pathname, res);
});

server.listen(PORT, () => {
  console.log(`ArmorIQ Cookbook browser running on http://localhost:${PORT}`);
});
