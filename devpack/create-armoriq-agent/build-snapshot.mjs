// Snapshot the cookbook recipes and the armord policy templates into this package, so the scaffolder
// works offline. Usage: node create-armoriq-agent/build-snapshot.mjs [--cookbook <dir>] [--armord <dir>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const COOKBOOK = resolve(opt('--cookbook', join(here, '..', '..', 'cookbook')));
const ARMORD = resolve(opt('--armord', join(here, '..', '..', 'armord')));
const SKIP = new Set(['node_modules', '__pycache__', '.venv', '.pytest_cache', '.git']);
const SKIP_FILES = /^(\.env|\.DS_Store)$|\.pyc$/;

// Which bundled recipe a `--framework X [--language Y]` request uses. Offline-capable recipes only.
export const DEFAULTS = {
  langchain: { python: 'langchain/python/sql-analyst', typescript: 'langchain/typescript/weather-agent' },
  crewai: { python: 'crewai/python/delegated-crew' },
  'openai-agents': { python: 'openai-agents/python/gateway-monitor-to-enforce' },
  'vercel-ai-sdk': { typescript: 'vercel-ai-sdk/typescript/gateway-support-bot' },
  langgraph: { python: 'langgraph/python/approval-interrupt' },
  'claude-agent-sdk': { typescript: 'claude-agent-sdk/typescript/governed-tools' },
  mcp: { python: 'sdk/python/handle-a-block', typescript: 'sdk/typescript/filesystem-notes' },
};

const out = join(here, 'templates');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    if (SKIP.has(e) || SKIP_FILES.test(e)) continue;
    const s = join(src, e);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, join(dst, e));
    else cpSync(s, join(dst, e));
  }
};

const recipes = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'recipe.yaml'))) {
      const r = parse(readFileSync(join(p, 'recipe.yaml'), 'utf8'));
      const rel = relative(join(COOKBOOK, 'recipes'), p).split(sep).join('/');
      if (r.language === 'config') continue; // policy packs are not runnable agents
      copyTree(p, join(out, 'recipes', rel));
      recipes.push({ path: rel, title: r.title, summary: r.summary, framework: r.framework, language: r.language, services: r.requires?.services ?? [] });
    } else walk(p);
  }
};
walk(join(COOKBOOK, 'recipes'));

const policies = [];
mkdirSync(join(here, 'policies'), { recursive: true });
for (const f of readdirSync(join(ARMORD, 'templates'))) {
  if (!f.endsWith('.yaml')) continue;
  cpSync(join(ARMORD, 'templates', f), join(here, 'policies', f));
  if (!f.endsWith('.cases.yaml')) policies.push(f.replace(/\.yaml$/, ''));
}

recipes.sort((a, b) => a.path.localeCompare(b.path));
policies.sort();
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ schema: 1, defaults: DEFAULTS, recipes, policies }, null, 2));
console.log(`snapshot: ${recipes.length} recipes, ${policies.length} policy templates`);
