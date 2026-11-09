// Policy template library: armor.io/v2 starting points shipped with armord.
// Each templates/<name>.yaml has a templates/<name>.cases.yaml for `armord policy test`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export interface TemplateInfo {
  name: string;
  description: string;
  file: string;
  casesFile?: string;
}

export function templatesDir(): string {
  return DIR;
}

function describe(text: string): string {
  const m = /^\s*description:\s*(.+)$/m.exec(text);
  return (m?.[1] ?? '').trim();
}

export function listTemplates(): TemplateInfo[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.yaml') && !f.endsWith('.cases.yaml'))
    .sort()
    .map((f) => {
      const name = f.slice(0, -'.yaml'.length);
      const cases = join(DIR, `${name}.cases.yaml`);
      const info: TemplateInfo = { name, description: describe(readFileSync(join(DIR, f), 'utf8')), file: join(DIR, f) };
      if (existsSync(cases)) info.casesFile = cases;
      return info;
    });
}

export function readTemplate(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid template name "${name}"`);
  const file = join(DIR, `${name}.yaml`);
  if (!existsSync(file)) throw new Error(`unknown template "${name}"; available: ${listTemplates().map((t) => t.name).join(', ')}`);
  return readFileSync(file, 'utf8');
}

/**
 * Substitute {{var}} placeholders. Array values render as a YAML flow list, so
 * `allow: {{allowedHosts}}` works. An unknown placeholder is an error, not a silent blank.
 */
export function renderTemplate(name: string, vars: Record<string, string | string[]> = {}): string {
  return readTemplate(name).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`template ${name} needs variable "${k}"`);
    return Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : v;
  });
}
