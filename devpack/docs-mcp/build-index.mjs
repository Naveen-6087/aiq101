// Build docs-mcp/data/docs-index.json from the local ArmorIQ docs corpus and the cookbook recipes.
// No network. Usage: node docs-mcp/build-index.mjs [--docs <dir>] [--cookbook <dir>] [--out <file>]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DOCS = resolve(opt('--docs', join(here, '..', '..', 'docs')));
const COOKBOOK = resolve(opt('--cookbook', join(here, '..', '..', 'cookbook')));
const OUT = resolve(opt('--out', join(here, 'data', 'docs-index.json')));
const SITE = 'https://docs.armoriq.ai';

const slug = (url) => url.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'index';

/** Split a corpus into pages: a level-1 heading (outside code fences) equal to the next expected title starts a page. */
export function splitPages(text, titles) {
  const lines = text.split('\n');
  const body = lines.findIndex((l) => /^# Documentation Body\s*$/.test(l));
  let i = body >= 0 ? body + 1 : 0;
  const starts = [];
  let fence = false;
  let next = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence || next >= titles.length) continue;
    const m = /^# (.+?)\s*$/.exec(l);
    if (m && m[1] === titles[next]) {
      starts.push(i);
      next++;
    }
  }
  return { lines, starts, matched: next };
}

/** Split one page body into heading-delimited sections. */
export function sections(bodyLines, pageTitle) {
  const out = [];
  let cur = { heading: pageTitle, level: 1, text: [] };
  let fence = false;
  for (const l of bodyLines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{2,4}) (.+?)\s*(\[#[^\]]*\])?\s*$/.exec(l);
    if (m) {
      out.push(cur);
      cur = { heading: m[2], level: m[1].length, text: [] };
    } else cur.text.push(l);
  }
  out.push(cur);
  return out
    .map((s) => ({ heading: s.heading, level: s.level, text: s.text.join('\n').trim() }))
    .filter((s) => s.text.length > 0 || s.level === 1);
}

const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-./:{}]+)/g;

function build() {
  const manifest = JSON.parse(readFileSync(join(DOCS, 'index.json'), 'utf8'));
  const corpusFile = ['llms-full.txt', 'ARMORIQ_DOCS.md', 'docs.md'].map((f) => join(DOCS, f)).find((f) => existsSync(f));
  if (!corpusFile) throw new Error(`no corpus (llms-full.txt / ARMORIQ_DOCS.md) in ${DOCS}`);
  const titles = manifest.pages.map((p) => p.title);
  const { lines, starts, matched } = splitPages(readFileSync(corpusFile, 'utf8'), titles);

  const pages = [];
  const chunks = [];
  const routes = {};
  for (let n = 0; n < starts.length; n++) {
    const meta = manifest.pages[n];
    const body = lines.slice(starts[n] + 1, n + 1 < starts.length ? starts[n + 1] : lines.length);
    // The next page's body starts after a "---" rule in the aggregate; drop a trailing rule.
    while (body.length && /^(---|\s*)$/.test(body.at(-1))) body.pop();
    const id = slug(meta.url);
    const secs = sections(body, meta.title);
    const url = SITE + meta.url;
    pages.push({ id, url, path: meta.url, mdx: SITE + meta.mdxUrl, title: meta.title, description: meta.description, product: meta.product, sections: secs.map((s) => s.heading) });
    secs.forEach((s, k) => {
      chunks.push({ page: id, k, heading: s.heading, text: s.text });
      for (const m of s.text.matchAll(ROUTE)) (routes[`${m[1]} ${m[2]}`] ||= new Set()).add(id);
    });
  }
  const endpoints = Object.entries(routes)
    .map(([r, ids]) => {
      const [method, path] = r.split(' ');
      return { method, path, pages: [...ids] };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  // Recipes
  const recipes = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '__pycache__' || e === '.venv') continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e === 'recipe.yaml') {
        const r = parseYaml(readFileSync(p, 'utf8'));
        recipes.push({
          path: relative(join(COOKBOOK, 'recipes'), dirname(p)).split(sep).join('/'),
          title: r.title, summary: r.summary, framework: r.framework, language: r.language, tier: r.tier,
          products: r.products ?? [], use_case: r.use_case ?? null, tags: r.tags ?? [], demonstrates: r.demonstrates ?? [],
          requires: r.requires?.services ?? [],
        });
      }
    }
  };
  if (existsSync(join(COOKBOOK, 'recipes'))) walk(join(COOKBOOK, 'recipes'));
  recipes.sort((a, b) => a.path.localeCompare(b.path));

  return {
    schema: 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: { corpus: corpusFile.split(sep).pop(), pages: pages.length, titlesMatched: matched, manifestPages: titles.length },
    pages, chunks, endpoints, recipes,
  };
}

const index = build();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(index));
console.log(`wrote ${OUT}: ${index.pages.length}/${index.source.manifestPages} pages, ${index.chunks.length} chunks, ${index.endpoints.length} routes, ${index.recipes.length} recipes`);
