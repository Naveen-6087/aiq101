#!/usr/bin/env node
// Checks every recipe against the layout rule (spec 0001) and the manifest rules (spec 0002).
//
//   npm run validate
//
// Prints one line per problem (file, field, what to do) and exits 1 if there are any.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifest } from '../schema/manifest.mjs';
import { ALLOWLIST, loadTaxonomy, readAllowlistLines, recipeDir, recipeIds, repoFiles, root } from './recipes.mjs';

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const PATH_SEGMENTS = ['framework', 'language', 'slug'];

const problems = [];
const report = (file, field, message) => problems.push({ file, field, message });

const taxonomy = loadTaxonomy();
const files = repoFiles();
const ids = recipeIds(files);
const idSet = new Set(ids);

const languageAlias = new Map();
for (const [lang, entry] of Object.entries(taxonomy.languages)) {
  for (const alias of entry.aliases ?? []) languageAlias.set(String(alias).toLowerCase(), lang);
}

// Layout: nothing but generated READMEs above the recipe level, and no symlinks anywhere.
for (const file of files) {
  const parts = file.split('/').slice(1);
  if (parts.length <= 3 && parts.at(-1) !== 'README.md') {
    report(file, '(layout)', 'only recipe folders may live here; move it into recipes/<framework>/<language>/<slug>/');
  }
  const full = join(root, file);
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
    report(file, '(layout)', 'symlinks are not allowed in recipes; copy the file in instead');
  }
}

// Value must be a key of one taxonomy list. Adds an alias hint for languages.
function inTaxonomy(file, field, list, value) {
  if (Object.hasOwn(taxonomy[list] ?? {}, value)) return true;
  const hint = list === 'languages' && languageAlias.get(String(value).toLowerCase());
  const fix = hint
    ? `use "${hint}"`
    : `use one of: ${Object.keys(taxonomy[list]).join(', ')} (or add it to schema/taxonomy.yaml in this PR)`;
  report(file, field, `"${value}" is not an allowed ${list.replace(/_/g, ' ').replace(/s$/, '')}; ${fix}`);
  return false;
}

// Exact version a lockfile resolves for a package, or null if the lockfile does not name it.
function lockedVersion(dir, name, ecosystem) {
  if (ecosystem === 'npm') {
    const lock = join(dir, 'package-lock.json');
    if (!existsSync(lock)) return { error: 'no package-lock.json in the recipe; run npm install and commit it' };
    const version = JSON.parse(readFileSync(lock, 'utf8')).packages?.[`node_modules/${name}`]?.version;
    return version ? { version } : { error: `package-lock.json does not resolve ${name}` };
  }
  if (ecosystem === 'pypi') {
    const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
    for (const lockName of ['uv.lock', 'poetry.lock']) {
      const lock = join(dir, lockName);
      if (!existsSync(lock)) continue;
      for (const block of readFileSync(lock, 'utf8').split('[[package]]')) {
        const n = block.match(/^name = "([^"]+)"/m)?.[1];
        if (n && norm(n) === norm(name)) return { version: block.match(/^version = "([^"]+)"/m)?.[1] };
      }
      return { error: `${lockName} does not resolve ${name}` };
    }
    const req = join(dir, 'requirements.txt');
    if (existsSync(req)) {
      for (const line of readFileSync(req, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/);
        if (m && norm(m[1]) === norm(name)) return { version: m[2] };
      }
      return { error: `requirements.txt does not pin ${name} with ==` };
    }
    return { error: 'no uv.lock, poetry.lock, or requirements.txt in the recipe' };
  }
  return { error: `unknown package ecosystem "${ecosystem}" in schema/taxonomy.yaml` };
}

const allowlistText = existsSync(join(root, ALLOWLIST)) ? readFileSync(join(root, ALLOWLIST), 'utf8') : null;
const allowlist = allowlistText === null ? [] : readAllowlistLines(allowlistText);
const official = new Set(allowlist.map((l) => l.id));

for (const id of ids) {
  const segments = id.split('/');
  const dir = recipeDir(id);
  const manifestFile = `recipes/${id}/recipe.yaml`;

  segments.forEach((seg, i) => {
    const field = `(path ${PATH_SEGMENTS[i]})`;
    if (!SEGMENT.test(seg) || seg.length > 40) {
      report(`recipes/${id}`, field, `"${seg}" must be lowercase kebab case, at most 40 characters`);
    }
    if (RESERVED.test(seg)) report(`recipes/${id}`, field, `"${seg}" is a name Windows reserves; pick another`);
  });
  const frameworkOk = inTaxonomy(`recipes/${id}`, '(path framework)', 'frameworks', segments[0]);
  const languageOk = inTaxonomy(`recipes/${id}`, '(path language)', 'languages', segments[1]);

  if (!files.includes(manifestFile)) {
    report(manifestFile, '(file)', 'every recipe needs a recipe.yaml; copy one from schema/fixtures/valid/');
    continue;
  }

  const { data: m, errors } = checkManifest(join(root, manifestFile));
  for (const e of errors) report(manifestFile, e.field, e.message);
  if (!m) continue;

  // Path agreement.
  if (frameworkOk && m.framework !== segments[0]) {
    report(manifestFile, 'framework', `is "${m.framework}" but the folder says "${segments[0]}"; they must match`);
  }
  if (languageOk && m.language !== segments[1]) {
    report(manifestFile, 'language', `is "${m.language}" but the folder says "${segments[1]}"; they must match`);
  }

  // Taxonomy membership.
  if (typeof m.framework === 'string') inTaxonomy(manifestFile, 'framework', 'frameworks', m.framework);
  if (typeof m.language === 'string') inTaxonomy(manifestFile, 'language', 'languages', m.language);
  if (typeof m.use_case === 'string') inTaxonomy(manifestFile, 'use_case', 'use_cases', m.use_case);
  for (const p of m.products ?? []) inTaxonomy(manifestFile, 'products', 'products', p);
  for (const o of m.demonstrates ?? []) inTaxonomy(manifestFile, 'demonstrates', 'outcomes', o);
  for (const s of m.requires?.services ?? []) inTaxonomy(manifestFile, 'requires.services', 'services', s);
  for (const f of m.secondary?.frameworks ?? []) {
    inTaxonomy(manifestFile, 'secondary.frameworks', 'frameworks', f);
    if (f === m.framework) report(manifestFile, 'secondary.frameworks', `repeats the primary framework "${f}"; remove it`);
  }
  for (const l of m.secondary?.languages ?? []) {
    inTaxonomy(manifestFile, 'secondary.languages', 'languages', l);
    if (l === m.language) report(manifestFile, 'secondary.languages', `repeats the primary language "${l}"; remove it`);
  }

  // Authors unique ignoring case.
  const seen = new Set();
  for (const a of m.authors ?? []) {
    if (seen.has(a.toLowerCase())) report(manifestFile, 'authors', `lists "${a}" twice (handles ignore case)`);
    seen.add(a.toLowerCase());
  }

  // Links to other recipes.
  for (const s of m.siblings ?? []) {
    if (s === id) report(manifestFile, 'siblings', 'lists this recipe itself; remove it');
    else if (!idSet.has(s)) report(manifestFile, 'siblings', `"${s}" is not a recipe in this repo`);
  }
  for (const old of m.moved_from ?? []) {
    if (idSet.has(old)) report(manifestFile, 'moved_from', `"${old}" is still a recipe; moved_from lists old locations only`);
  }

  // Tier and the official allowlist must agree.
  if (m.tier === 'official' && !official.has(id)) {
    report(manifestFile, 'tier', `is official but ${id} is not in ${ALLOWLIST}; a maintainer adds it, or use community`);
  }
  if (m.tier === 'community' && official.has(id)) {
    report(manifestFile, 'tier', `is community but ${id} is in ${ALLOWLIST}; set tier: official or remove it there`);
  }

  // tested_with: ArmorIQ packages only, the right SDK for the language, and equal to the lockfile.
  const tested = m.tested_with ?? {};
  for (const [pkg, version] of Object.entries(tested)) {
    if (!inTaxonomy(manifestFile, 'tested_with', 'packages', pkg)) continue;
    const locked = lockedVersion(dir, pkg, taxonomy.packages[pkg].ecosystem);
    if (locked.error) report(manifestFile, `tested_with.${pkg}`, locked.error);
    else if (locked.version !== version) {
      report(manifestFile, `tested_with.${pkg}`, `says ${version} but the lockfile resolves ${locked.version}; set it to "${locked.version}"`);
    }
  }
  const lane = taxonomy.languages[m.language]?.lane;
  if ((m.products ?? []).includes('sdk') && (lane === 'python' || lane === 'typescript')) {
    const sdkPackages = Object.entries(taxonomy.packages).filter(([, p]) => p.language === m.language).map(([name]) => name);
    if (sdkPackages.length === 0) {
      report(manifestFile, 'tested_with', `no ArmorIQ SDK package for ${m.language} is in schema/taxonomy.yaml yet; add it there`);
    } else if (!sdkPackages.some((p) => Object.hasOwn(tested, p))) {
      report(manifestFile, 'tested_with', `must include the ArmorIQ SDK for ${m.language}: ${sdkPackages.join(' or ')}`);
    }
  }

  // Title equals the README's first heading.
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) {
    report(`recipes/${id}/README.md`, '(file)', 'every recipe needs a README.md');
  } else {
    const h1 = readFileSync(readme, 'utf8').match(/^# (.+?)\s*$/m)?.[1];
    if (!h1) report(`recipes/${id}/README.md`, '(heading)', 'needs a first "# " heading that matches title');
    else if (typeof m.title === 'string' && h1 !== m.title) {
      report(manifestFile, 'title', `must equal the README heading "${h1}"`);
    }
  }
}

// The allowlist itself.
if (allowlistText === null) {
  report(ALLOWLIST, '(file)', 'the official allowlist is missing');
} else {
  const seenIds = new Set();
  let previous = '';
  for (const { line, id } of allowlist) {
    const where = `${ALLOWLIST}:${line}`;
    if (!idSet.has(id)) report(where, '(id)', `"${id}" is not a recipe in this repo`);
    if (seenIds.has(id)) report(where, '(id)', `"${id}" is listed twice`);
    if (id < previous) report(where, '(order)', `"${id}" is out of order; keep the IDs sorted`);
    seenIds.add(id);
    previous = id;
  }
}

if (problems.length === 0) {
  console.log(`ok  ${ids.length} recipe${ids.length === 1 ? '' : 's'} valid`);
  for (const id of ids) console.log(`    ${id}${official.has(id) ? '  (official)' : ''}`);
} else {
  for (const p of problems) console.log(`${p.file}: ${p.field}: ${p.message}`);
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${ids.length} recipe${ids.length === 1 ? '' : 's'}`);
  process.exit(1);
}
