// Dev helper: print a docs page from the local index. node scripts/read-doc.mjs <id> [section] [maxChars]
import { readFileSync } from 'node:fs';
import { createTools } from '../docs-mcp/tools.mjs';
const t = createTools(JSON.parse(readFileSync(new URL('../docs-mcp/data/docs-index.json', import.meta.url), 'utf8')));
const [id, section, max] = process.argv.slice(2);
console.log(t.read_doc({ id, section: section || undefined, max_chars: Number(max || 6000) }).content);
