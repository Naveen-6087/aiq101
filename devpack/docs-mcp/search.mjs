// Small BM25 over the heading-split chunks. Pure functions; the index is plain JSON.

const STOP = new Set('a an and are as at be by for from has have in is it of on or that the this to was were will with you your'.split(' '));

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? [])
    .flatMap((t) => (/[_.-]/.test(t) ? [t, ...t.split(/[_.-]+/)] : [t]))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class Bm25 {
  constructor(docs, { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs; // [{id, text, boost?: string}]
    this.tf = [];
    this.len = [];
    this.df = new Map();
    for (const d of docs) {
      // The heading counts three times so a section named after the query outranks a passing mention.
      const toks = tokenize(`${d.boost ?? ''} ${d.boost ?? ''} ${d.boost ?? ''} ${d.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tf.push(tf);
      this.len.push(toks.length);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = this.len.reduce((a, b2) => a + b2, 0) / Math.max(1, docs.length);
  }

  search(query, limit = 5) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const scored = [];
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const t of q) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avg));
      }
      if (s > 0) scored.push([i, s]);
    }
    scored.sort((a, b2) => b2[1] - a[1]);
    return scored.slice(0, limit).map(([i, s]) => ({ doc: this.docs[i], score: s }));
  }
}

/** A short excerpt around the first query-term hit. */
export function snippet(text, query, width = 280) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of tokenize(query)) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  const out = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + out + (start + width < text.length ? '…' : '');
}
