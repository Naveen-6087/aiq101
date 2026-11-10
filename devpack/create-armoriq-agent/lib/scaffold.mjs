// Scaffold a governed agent from a bundled cookbook recipe plus an armord policy template.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = join(root, 'templates');
export const POLICIES = join(root, 'policies');
export const DEFAULT_POLICY = 'armor-balanced';

export function loadManifest() {
  const file = join(TEMPLATES, 'manifest.json');
  if (!existsSync(file)) throw new Error('templates are not built; run "npm run snapshot" in the devpack');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listFrameworks(manifest = loadManifest()) {
  return Object.entries(manifest.defaults).map(([framework, byLang]) => ({
    framework,
    languages: Object.keys(byLang),
    recipes: Object.values(byLang),
  }));
}

/** Resolve the CLI choices to one bundled recipe. */
export function pickRecipe({ framework, language, recipe }, manifest = loadManifest()) {
  if (recipe) {
    const r = manifest.recipes.find((x) => x.path === recipe);
    if (!r) throw new Error(`unknown recipe "${recipe}". Bundled: ${manifest.recipes.map((x) => x.path).join(', ')}`);
    return r;
  }
  const byLang = manifest.defaults[framework];
  if (!byLang) throw new Error(`unknown framework "${framework}". Choose one of: ${Object.keys(manifest.defaults).join(', ')}`);
  const lang = language ?? Object.keys(byLang)[0];
  const path = byLang[lang];
  if (!path) throw new Error(`framework "${framework}" has no ${lang} recipe; available: ${Object.keys(byLang).join(', ')}`);
  return manifest.recipes.find((x) => x.path === path);
}

const ENV_FOR = {
  armoriq: ['ARMORIQ_API_KEY=ak_your_key_here'],
  gemini: ['GEMINI_API_KEY=your_gemini_key_here'],
  openai: ['OPENAI_API_KEY=sk-your-key-here'],
  anthropic: ['ANTHROPIC_API_KEY=sk-ant-your-key-here'],
  github: ['GITHUB_TOKEN=your_github_token_here'],
  coingecko: ['COINGECKO_API_KEY=your_coingecko_key_here'],
};

export function envExample(services) {
  const lines = ['# Placeholders only. Copy to .env and fill in; never commit .env.'];
  for (const s of services) lines.push(...(ENV_FOR[s] ?? [`# ${s}: see the recipe README`]));
  lines.push('', '# Offline mode (no keys, no network): hold decisions are approved unless this is "reject"', '# OFFLINE_APPROVAL=approve');
  return lines.join('\n') + '\n';
}

export function armordConfig(policy) {
  return [
    '# armord settings for this project. Load them, then start the daemon:',
    '#   set -a; . ./armord.config; set +a; armord start',
    '# (PowerShell: Get-Content armord.config | % { if ($_ -match "^([A-Z_]+)=(.*)$") { Set-Item "env:$($Matches[1])" $Matches[2] } })',
    `# Policy in ./armord/${policy}.yaml; test it with: armord policy test armord/${policy}.cases.yaml armord/${policy}.yaml`,
    'ARMORD_POLICY_DIR=./armord',
    'ARMORD_AUDIT=./armord/audit.jsonl',
    'ARMORD_HOLD_TIMEOUT_MS=120000',
    '# Mirror this agent\'s policy from ArmorIQ as well (strictest verdict wins). The key comes from',
    '# the environment or `armoriq login`, never from this file:',
    '# ARMORD_AGENT_ID=your-agent-id',
    '',
  ].join('\n');
}

function runSteps(dest, recipe) {
  const has = (f) => existsSync(join(dest, f));
  if (recipe.language === 'python') {
    const steps = ['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt'];
    if (has('offline/demo.py')) steps.push('.venv/bin/python offline/demo.py     # scripted run: allow, hold, block');
    if (has('offline/test.py')) steps.push('.venv/bin/python offline/test.py     # the same run as a pass/fail check');
    return { steps, windows: 'On Windows use `.venv\\Scripts\\python.exe` and `.venv\\Scripts\\pip.exe` instead of `.venv/bin/...`.' };
  }
  const pkg = has('package.json') ? JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) : { scripts: {} };
  const steps = ['npm ci'];
  if (pkg.scripts?.['demo:offline']) steps.push('npm run demo:offline    # scripted run: allow, hold, block');
  if (pkg.scripts?.['test:offline']) steps.push('npm run test:offline    # the same run as a pass/fail check');
  return { steps, windows: null };
}

export function readme({ name, recipe, policy, dest }) {
  const { steps, windows } = runSteps(dest, recipe);
  const live = recipe.language === 'python' ? '.venv/bin/python agent.py' : 'npm start';
  return `# ${name}

Scaffolded by \`create-armoriq-agent\` from the ArmorIQ cookbook recipe **${recipe.title}** (\`${recipe.path}\`).

${recipe.summary}

## Run it offline

No accounts, keys or network. The real agent code runs against an offline stand-in for ArmorIQ (in \`offline/\`) that decides from this project's \`policy.yaml\` and prints one line per decision:

\`\`\`
[armoriq] check <tool>: ALLOWED | HELD | BLOCKED (<rule>)
[armoriq] hold <tool>: APPROVED | REJECTED
\`\`\`

\`\`\`bash
${steps.join('\n')}
\`\`\`
${windows ? `\n${windows}\n` : ''}
Held calls are approved by default. \`OFFLINE_APPROVAL=reject\` rejects them, so you can watch the agent handle a human saying no. Edit a rule in \`policy.yaml\` and the offline result changes with it.

## Run it live

1. Create an ArmorIQ account and API key (or a gateway key, for gateway recipes) and register the agent with an active policy. See \`RECIPE.md\` for this recipe's exact steps.
2. \`cp .env.example .env\` and fill in the placeholders. \`.env\` is git-ignored.
3. \`${live}\`

## Policies

- \`policy.yaml\` is the recipe's own policy; the offline stand-in and the walkthrough in \`RECIPE.md\` use it.
- \`armord/${policy}.yaml\` is the **${policy}** template for the local \`armord\` daemon (guarding the coding agent or MCP clients you use while building this), with expected-verdict cases next to it:

\`\`\`bash
armord policy test armord/${policy}.cases.yaml armord/${policy}.yaml
set -a; . ./armord.config; set +a
armord start        # then: armord install claude-code | cursor | codex | gemini
\`\`\`

Other templates: \`armord templates\`.

## Layout

| Path | What |
|---|---|
| \`RECIPE.md\` | the full cookbook walkthrough for this recipe |
| \`policy.yaml\` | the recipe's policy |
| \`armord/\` | armord policy template, cases, and (once running) the audit log |
| \`armord.config\` | armord environment settings for this project |
| \`.env.example\` | placeholders for the keys you need |
| \`offline/\` | the offline stand-ins |
`;
}

function appendIgnore(dest, lines) {
  const f = join(dest, '.gitignore');
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const missing = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (missing.length) appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

export function listPolicies() {
  return readdirSync(POLICIES).filter((f) => f.endsWith('.yaml') && !f.endsWith('.cases.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
}

/**
 * @param {{dir: string, framework?: string, language?: string, recipe?: string, policy?: string, force?: boolean, dryRun?: boolean}} o
 */
export function scaffold(o) {
  const manifest = loadManifest();
  const recipe = pickRecipe(o, manifest);
  const policy = o.policy ?? DEFAULT_POLICY;
  if (!listPolicies().includes(policy)) throw new Error(`unknown policy "${policy}". Choose one of: ${listPolicies().join(', ')}`);
  const dest = resolve(o.dir);
  if (existsSync(dest) && readdirSync(dest).length && !o.force) throw new Error(`${dest} is not empty (use --force to scaffold into it anyway)`);
  const plan = { dest, recipe: recipe.path, policy, language: recipe.language };
  if (o.dryRun) return { ...plan, dryRun: true };

  mkdirSync(dest, { recursive: true });
  cpSync(join(TEMPLATES, 'recipes', recipe.path), dest, { recursive: true });
  if (existsSync(join(dest, 'README.md'))) renameSync(join(dest, 'README.md'), join(dest, 'RECIPE.md'));
  mkdirSync(join(dest, 'armord'), { recursive: true });
  cpSync(join(POLICIES, `${policy}.yaml`), join(dest, 'armord', `${policy}.yaml`));
  if (existsSync(join(POLICIES, `${policy}.cases.yaml`))) cpSync(join(POLICIES, `${policy}.cases.yaml`), join(dest, 'armord', `${policy}.cases.yaml`));
  writeFileSync(join(dest, 'armord.config'), armordConfig(policy));
  if (!existsSync(join(dest, '.env.example'))) writeFileSync(join(dest, '.env.example'), envExample(recipe.services));
  appendIgnore(dest, ['.env', '.venv/', 'node_modules/', '__pycache__/', 'armord/audit.jsonl']);
  writeFileSync(join(dest, 'README.md'), readme({ name: basename(dest), recipe, policy, dest }));
  writeFileSync(join(dest, '.armoriq-scaffold.json'), JSON.stringify({ tool: 'create-armoriq-agent', recipe: recipe.path, policy, framework: recipe.framework, language: recipe.language }, null, 2) + '\n');
  return plan;
}
