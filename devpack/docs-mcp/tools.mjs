// The five tools of the ArmorIQ docs MCP server, as plain functions over the loaded index.
import { Bm25, snippet } from './search.mjs';

export function createTools(index) {
  const pageById = new Map(index.pages.map((p) => [p.id, p]));
  const chunksByPage = new Map();
  for (const c of index.chunks) {
    if (!chunksByPage.has(c.page)) chunksByPage.set(c.page, []);
    chunksByPage.get(c.page).push(c);
  }
  const bm = new Bm25(index.chunks.map((c) => ({ id: c, text: c.text, boost: `${c.heading} ${pageById.get(c.page)?.title ?? ''}` })));

  const findPage = (ref) => {
    const r = String(ref).trim();
    const stripped = r.replace(/^https?:\/\/docs\.armoriq\.ai/, '').replace(/^\/llms\.mdx/, '');
    const lc = stripped.toLowerCase();
    return (
      pageById.get(lc) ??
      index.pages.find((p) => p.path === stripped || p.path === `/${stripped.replace(/^\/+/, '')}`) ??
      index.pages.find((p) => p.title.toLowerCase() === lc) ??
      pageById.get(lc.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/g, '-'))
    );
  };

  const normRoute = (p) => p.replace(/\{[^}]+\}|:[A-Za-z_]+/g, ':x').replace(/\/+$/, '');

  return {
    search_docs({ query, limit = 5, product }) {
      if (!query || typeof query !== 'string') throw new Error('query is required');
      const n = Math.min(20, Math.max(1, Number(limit) || 5));
      const hits = bm
        .search(query, 200)
        .map((h) => ({ c: h.doc.id, score: h.score }))
        .filter((h) => !product || pageById.get(h.c.page)?.product === product)
        .slice(0, n);
      return hits.map(({ c, score }) => {
        const p = pageById.get(c.page);
        return { id: p.id, title: p.title, section: c.heading, url: p.url, product: p.product, score: Math.round(score * 100) / 100, snippet: snippet(c.text, query) };
      });
    },

    read_doc({ id, url, section, max_chars = 20000 }) {
      const ref = id ?? url;
      if (!ref) throw new Error('id or url is required');
      const p = findPage(ref);
      if (!p) throw new Error(`no page matches "${ref}"; use list_docs or search_docs to find an id`);
      let cs = chunksByPage.get(p.id) ?? [];
      if (section) {
        const s = String(section).toLowerCase();
        cs = cs.filter((c) => c.heading.toLowerCase().includes(s));
        if (!cs.length) throw new Error(`page ${p.id} has no section matching "${section}"; sections: ${p.sections.join(' | ')}`);
      }
      let text = cs.map((c) => (c.k === 0 ? c.text : `## ${c.heading}\n\n${c.text}`)).join('\n\n');
      const limit = Math.max(500, Number(max_chars) || 20000);
      const truncated = text.length > limit;
      if (truncated) text = text.slice(0, limit);
      return { id: p.id, title: p.title, url: p.url, description: p.description, sections: p.sections, truncated, content: `# ${p.title}\n\n${text}` };
    },

    list_docs({ product } = {}) {
      const ps = index.pages.filter((p) => !product || p.product === product);
      return { products: [...new Set(index.pages.map((p) => p.product))], count: ps.length, pages: ps.map((p) => ({ id: p.id, title: p.title, product: p.product, description: p.description })) };
    },

    get_endpoint({ path_or_name }) {
      if (!path_or_name) throw new Error('path_or_name is required');
      const q = String(path_or_name).trim();
      const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i.exec(q);
      const method = m?.[1]?.toUpperCase();
      const want = normRoute((m ? m[2] : q).toLowerCase());
      const routes = index.endpoints.filter((e) => (!method || e.method === method) && (normRoute(e.path.toLowerCase()) === want || (want.startsWith('/') && normRoute(e.path.toLowerCase()).startsWith(want))));
      const byName = q.startsWith('/') || m ? [] : index.pages.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()) || p.id.includes(q.toLowerCase().replace(/\s+/g, '-'))).slice(0, 8);
      const context = [];
      for (const r of routes.slice(0, 5)) {
        for (const pid of r.pages.slice(0, 3)) {
          for (const c of chunksByPage.get(pid) ?? []) {
            for (const line of c.text.split('\n')) {
              if (line.includes(r.path) && line.includes(r.method) && context.length < 12) context.push({ route: `${r.method} ${r.path}`, page: pid, line: line.trim().slice(0, 600) });
            }
          }
        }
      }
      return { routes, context, pages: byName.map((p) => ({ id: p.id, title: p.title, url: p.url })), note: routes.length || byName.length ? undefined : 'no route or page matched; try search_docs' };
    },

    find_recipe({ framework, language, outcome, query } = {}) {
      const lc = (v) => String(v).toLowerCase();
      let rs = index.recipes.filter((r) => (!framework || lc(r.framework) === lc(framework)) && (!language || lc(r.language) === lc(language)));
      if (outcome) {
        const o = lc(outcome);
        rs = rs.filter((r) => [...r.demonstrates, ...r.tags, ...r.products, r.use_case ?? ''].some((x) => lc(x) === o || lc(x).includes(o)));
      }
      if (query) {
        const qs = lc(query).split(/\s+/).filter(Boolean);
        rs = rs.filter((r) => qs.every((t) => lc(`${r.title} ${r.summary} ${r.tags.join(' ')}`).includes(t)));
      }
      return { count: rs.length, recipes: rs.map((r) => ({ ...r, repo_path: `cookbook/recipes/${r.path}`, scaffold: `create-armoriq-agent <dir> --framework ${r.framework} --language ${r.language}` })) };
    },
  };
}

export const TOOL_DEFS = [
  { name: 'search_docs', description: 'Search the ArmorIQ documentation (BM25 over every section). Returns ranked sections with a snippet; follow up with read_doc.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 }, product: { type: 'string', description: 'Restrict to one product, e.g. sdk, platform, armorclaude (see list_docs).' } }, required: ['query'] } },
  { name: 'read_doc', description: 'Read a documentation page (or one section of it) by id, path or URL, as markdown.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Page id from search_docs/list_docs, a docs.armoriq.ai URL, or a path like /products' }, url: { type: 'string' }, section: { type: 'string', description: 'Only sections whose heading contains this text' }, max_chars: { type: 'integer', default: 20000 } } } },
  { name: 'list_docs', description: 'List every documentation page (id, title, product, description), optionally for one product.', inputSchema: { type: 'object', properties: { product: { type: 'string' } } } },
  { name: 'get_endpoint', description: 'Look up an ArmorIQ API route (for example "POST /policies" or "/agent/register") or a page by name, with the doc lines that mention it.', inputSchema: { type: 'object', properties: { path_or_name: { type: 'string' } }, required: ['path_or_name'] } },
  { name: 'find_recipe', description: 'Find cookbook recipes by framework, language and outcome (allow, hold, block, prompt-injection, ...). Each result says how to scaffold it.', inputSchema: { type: 'object', properties: { framework: { type: 'string' }, language: { type: 'string', enum: ['python', 'typescript', 'config'] }, outcome: { type: 'string' }, query: { type: 'string' } } } },
];
