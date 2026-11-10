#!/usr/bin/env node
// Install the ArmorIQ agent skills into a coding agent.
//   node skills/install.mjs claude [--project] [--dry-run] [--uninstall] [--home <dir>] [--cwd <dir>]
//   node skills/install.mjs codex  ...   (managed block in AGENTS.md)
//   node skills/install.mjs cursor ...   (.cursor/rules/<skill>.mdc in the project)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BEGIN = '<!-- armoriq-devpack:begin -->';
const END = '<!-- armoriq-devpack:end -->';

export function skillNames(dir = here) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

/** Split `---` frontmatter from a SKILL.md. */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('SKILL.md has no frontmatter');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

export function install(target, { scope = 'user', home = homedir(), cwd = process.cwd(), dryRun = false, uninstall = false, source = here } = {}) {
  const names = skillNames(source);
  const changes = [];
  const note = (file, action, summary) => changes.push({ file, action, summary });

  if (target === 'claude') {
    const root = scope === 'project' ? join(cwd, '.claude', 'skills') : join(home, '.claude', 'skills');
    for (const n of names) {
      const dest = join(root, n);
      if (uninstall) {
        if (existsSync(dest)) {
          note(dest, 'remove', 'skill folder');
          if (!dryRun) rmSync(dest, { recursive: true, force: true });
        }
        continue;
      }
      note(dest, existsSync(dest) ? 'replace' : 'create', 'skill folder');
      if (!dryRun) {
        mkdirSync(root, { recursive: true });
        cpSync(join(source, n), dest, { recursive: true });
      }
    }
    return { changes };
  }

  if (target === 'cursor') {
    const root = join(cwd, '.cursor', 'rules');
    for (const n of names) {
      const dest = join(root, `${n}.mdc`);
      if (uninstall) {
        if (existsSync(dest)) {
          note(dest, 'remove', 'rule');
          if (!dryRun) rmSync(dest, { force: true });
        }
        continue;
      }
      const { meta, body } = parseSkill(readFileSync(join(source, n, 'SKILL.md'), 'utf8'));
      const mdc = `---\ndescription: ${meta.description}\nalwaysApply: false\n---\n\n${body}\n`;
      note(dest, existsSync(dest) ? 'replace' : 'create', 'Cursor rule (agent-requested)');
      if (!dryRun) {
        mkdirSync(root, { recursive: true });
        writeFileSync(dest, mdc);
      }
    }
    return { changes };
  }

  if (target === 'codex') {
    const file = scope === 'project' ? join(cwd, 'AGENTS.md') : join(home, '.codex', 'AGENTS.md');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`);
    const stripped = existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    if (uninstall) {
      if (re.test(existing)) {
        note(file, 'merge', 'removed the armoriq-devpack block');
        if (!dryRun) writeFileSync(file, stripped ? stripped + '\n' : '');
      }
      return { changes };
    }
    const blocks = names.map((n) => {
      const { meta, body } = parseSkill(readFileSync(join(source, n, 'SKILL.md'), 'utf8'));
      return `## Skill: ${meta.name}\n\nWhen to use: ${meta.description}\n\n${body.replace(/^# /m, '### ')}`;
    });
    const out = `${stripped ? stripped + '\n\n' : ''}${BEGIN}\n# ArmorIQ skills\n\n${blocks.join('\n\n')}\n${END}\n`;
    note(file, existing ? 'merge' : 'create', `managed block with ${names.length} skills`);
    if (!dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, out);
    }
    return { changes };
  }
  throw new Error('target must be claude, codex or cursor');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const target = a.find((x) => !x.startsWith('-'));
  const flag = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  try {
    if (!target) throw new Error('usage: node skills/install.mjs <claude|codex|cursor> [--project] [--dry-run] [--uninstall]');
    const r = install(target, { scope: a.includes('--project') ? 'project' : 'user', dryRun: a.includes('--dry-run'), uninstall: a.includes('--uninstall'), home: flag('--home') ?? homedir(), cwd: flag('--cwd') ?? process.cwd() });
    for (const c of r.changes) console.log(`${c.action.padEnd(8)} ${c.file}  ${c.summary}`);
    if (!r.changes.length) console.log('nothing to do');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
