#!/usr/bin/env node
// create-armoriq-agent <dir> --framework <name> [--language python|typescript] [--policy <template>] [--recipe <path>] [--yes]
import { createInterface } from 'node:readline/promises';
import { DEFAULT_POLICY, listFrameworks, listPolicies, loadManifest, scaffold } from '../lib/scaffold.mjs';

const HELP = `create-armoriq-agent <dir> --framework <name> [options]

  --framework <name>   langchain | crewai | openai-agents | vercel-ai-sdk | langgraph | claude-agent-sdk | mcp
  --language <lang>    python | typescript (default: the framework's first language)
  --policy <template>  armord policy template (default ${DEFAULT_POLICY}); see --list
  --recipe <path>      pick a specific bundled cookbook recipe instead
  --yes                no prompts; take defaults for anything not given
  --force              scaffold into a non-empty directory
  --dry-run            print what would be created
  --list               list frameworks, recipes and policy templates

Run with no framework in a terminal to choose interactively.`;

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const valueFlags = new Set(['--framework', '--language', '--policy', '--recipe']);
const positional = args.filter((a, i) => !a.startsWith('-') && !valueFlags.has(args[i - 1]));

async function main() {
  if (args.includes('--help') || args.includes('-h')) return console.log(HELP);
  const manifest = loadManifest();
  if (args.includes('--list')) {
    for (const f of listFrameworks(manifest)) console.log(`${f.framework.padEnd(18)} ${f.languages.join(', ').padEnd(22)} ${f.recipes.join(', ')}`);
    console.log(`\nrecipes: ${manifest.recipes.map((r) => r.path).join(', ')}`);
    console.log(`\npolicies: ${listPolicies().join(', ')}`);
    return;
  }

  let dir = positional[0];
  let framework = flag('--framework');
  let language = flag('--language');
  let policy = flag('--policy');
  const recipe = flag('--recipe');
  const yes = args.includes('--yes');
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !yes && !recipe;

  if (!framework && !recipe) {
    const fws = listFrameworks(manifest);
    if (!interactive) {
      console.error('missing --framework. Choose one of:\n' + fws.map((f) => `  ${f.framework} (${f.languages.join(', ')})`).join('\n') + '\n\nOr run in a terminal without arguments to choose interactively.');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('Frameworks:');
      fws.forEach((f, i) => console.log(`  ${i + 1}. ${f.framework}  (${f.languages.join(', ')})`));
      const pick = Number((await rl.question('Framework number: ')).trim());
      const chosen = fws[pick - 1];
      if (!chosen) throw new Error('not a valid choice');
      framework = chosen.framework;
      if (chosen.languages.length > 1 && !language) {
        language = (await rl.question(`Language (${chosen.languages.join('/')}) [${chosen.languages[0]}]: `)).trim() || chosen.languages[0];
      }
      if (!policy) {
        console.log(`Policies: ${listPolicies().join(', ')}`);
        policy = (await rl.question(`Policy template [${DEFAULT_POLICY}]: `)).trim() || undefined;
      }
      if (!dir) dir = (await rl.question('Directory: ')).trim();
    } finally {
      rl.close();
    }
  }
  if (!dir) {
    console.error('missing <dir>.\n\n' + HELP);
    process.exitCode = 1;
    return;
  }

  const r = scaffold({ dir, framework, language, recipe, policy, force: args.includes('--force'), dryRun: args.includes('--dry-run') });
  if (r.dryRun) return console.log(`would scaffold ${r.recipe} with policy ${r.policy} into ${r.dest}`);
  console.log(`created ${r.dest}\n  recipe: ${r.recipe}\n  policy: ${r.policy}\n\nnext: cd ${dir} && see README.md (offline run needs no keys)`);
}

main().catch((e) => {
  console.error(`create-armoriq-agent: ${e.message}`);
  process.exit(1);
});
