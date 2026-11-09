// Shell command analysis: a small, dependency-free tokenizer and analyzer for POSIX shells, with
// enough PowerShell and cmd.exe awareness for Windows agents. It turns one command line into the
// facts a policy needs: every program that runs (through pipes, `&&`, subshells, `$( )`,
// backticks, `bash -c`, `eval`, `xargs`, `find -exec`, `sudo`/`env`/`timeout` wrappers…), whether
// anything is destructive or talks to the network, which files it writes or deletes, which
// environment variables it reads, and signals of deliberate obfuscation.
//
// It never throws: input it can't parse (unbalanced quotes, absurd nesting, oversized input) is
// reported as `obfuscated` with a `parseError`, and the old regex heuristics still run on it.

export type Dialect = 'posix' | 'powershell' | 'cmd';

export interface ShellAnalysis {
  /** First real program (wrappers such as sudo/env/timeout skipped), lower-case basename. */
  program?: string;
  /** Every program found anywhere in the command, lower-case basename, no .exe. */
  programs: string[];
  destructive: boolean;
  network: boolean;
  hosts: string[];
  urls: string[];
  obfuscated: boolean;
  pipeToShell: boolean;
  writeRedirection: boolean;
  /** Raw (un-normalized) paths written, created or modified. */
  writes: string[];
  /** Raw paths deleted. */
  deletes: string[];
  /** Raw paths read by well-known readers (cat, cp sources, curl -d @file, `< file`…). */
  reads: string[];
  envVars: string[];
  /** The command dumps the whole environment (env, printenv, set, gci env:, /proc/self/environ). */
  envDump: boolean;
  heredoc: boolean;
  /** The program name is a variable or substitution and can't be known statically. */
  dynamicProgram: boolean;
  /** Why destructive / network / obfuscated / pipeToShell were set (for audit and debugging). */
  reasons: string[];
  parseError?: string;
}

const MAX_INPUT = 64 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 5000;
const MAX_ANALYZE = 300;

class ParseError extends Error {}

// ---------------------------------------------------------------------------------------------
// AST

type Part = { t: 'u' | 'q'; v: string } | { t: 'v'; v: string } | { t: 's' };

interface Word {
  parts: Part[];
  raw: string;
  /** Command / process substitutions inside the word (walked separately). */
  subs: Script[];
  quoted: boolean;
  /** Number of quoted/unquoted segments: `r''m` has 3. */
  segs: number;
  /** `$'\x72\x6d'`-style escapes were decoded. */
  hex: boolean;
  glob: boolean;
  /** A backslash (or PowerShell backtick / cmd caret) escape inside the word, not at its start. */
  escMid: boolean;
  ifs: boolean;
  indirect: boolean;
  procsub: boolean;
  text: string;
  subNet: boolean;
  subDec: boolean;
}
interface Redirect {
  op: string;
  target: Word;
  body?: string;
  bodySubs?: Script[];
}
interface Cmd {
  k: 'cmd';
  dialect: Dialect;
  words: Word[];
  assigns: Word[];
  redirs: Redirect[];
  /** Not a command invocation (for/select/case heads, PowerShell expressions): only substitutions run. */
  control: boolean;
  psAssign?: { name: string; value: Word };
}
interface Group {
  k: 'group';
  scripts: Script[];
  redirs: Redirect[];
}
type Stage = Cmd | Group;
type Pipeline = Stage[];
type Script = Pipeline[];
interface Shared {
  nodes: number;
}

const NO_VARS = new Map<string, string>();
const HOME_VARS = new Set(['HOME', 'USERPROFILE']);

class WordBuilder {
  parts: Part[] = [];
  subs: Script[] = [];
  quoted = false;
  segs = 0;
  private last: boolean | null = null;
  hex = false;
  glob = false;
  escMid = false;
  ifs = false;
  indirect = false;
  procsub = false;
  stop = false;

  private seg(q: boolean): void {
    if (this.last !== q) {
      this.segs++;
      this.last = q;
    }
    if (q) this.quoted = true;
  }
  lit(v: string, q: boolean): void {
    this.seg(q);
    const p = this.parts[this.parts.length - 1];
    if (p && (p.t === 'u' || p.t === 'q') && p.t === (q ? 'q' : 'u')) p.v += v;
    else this.parts.push({ t: q ? 'q' : 'u', v });
  }
  variable(name: string, q: boolean): void {
    this.seg(q);
    this.parts.push({ t: 'v', v: name });
  }
  sub(sc: Script, q: boolean): void {
    this.seg(q);
    this.parts.push({ t: 's' });
    this.subs.push(sc);
  }
  empty(): boolean {
    return this.parts.length === 0;
  }
  build(raw: string): Word {
    const w: Word = {
      parts: this.parts, raw, subs: this.subs, quoted: this.quoted, segs: this.segs, hex: this.hex, glob: this.glob,
      escMid: this.escMid, ifs: this.ifs, indirect: this.indirect, procsub: this.procsub, text: '', subNet: false, subDec: false,
    };
    w.text = render(w, NO_VARS);
    return w;
  }
}

function render(w: Word, vars: Map<string, string>): string {
  let out = '';
  for (const p of w.parts) {
    if (p.t === 'u' || p.t === 'q') out += p.v;
    else if (p.t === 'v') {
      const v = vars.get(p.v);
      if (v !== undefined) out += v;
      else if (out === '' && HOME_VARS.has(p.v.toUpperCase())) out += '~';
      else out += '${' + p.v + '}';
    } else out += '${__cmd}';
  }
  return out;
}
const isDynamic = (w: Word): boolean => w.parts.some((p) => p.t === 'v' || p.t === 's');
const isStatic = (w: Word, vars: Map<string, string>): boolean => w.parts.every((p) => p.t === 'u' || p.t === 'q' || (p.t === 'v' && vars.has(p.v)));
const onlySubs = (w: Word): boolean => w.parts.length > 0 && w.parts.every((p) => p.t === 's' || ((p.t === 'u' || p.t === 'q') && p.v.trim() === ''));
function plain(w: Word): string | undefined {
  const p = w.parts[0];
  return !w.quoted && w.parts.length === 1 && p?.t === 'u' ? p.v : undefined;
}

// ---------------------------------------------------------------------------------------------
// POSIX parser

const POSIX_META = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>']);
const SKIP_WORDS = new Set(['{', '}', '!', 'then', 'else', 'elif', 'fi', 'do', 'done', 'if', 'while', 'until', 'esac']);
const REDIR_OPS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>|', '>&', '>'];
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const ARRAY_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
const WORD_RUN = /[^ \t\n\r;&|()<>\\'"$`*?[]+/y;

class PosixParser {
  i = 0;
  private pending: Redirect[] = [];
  constructor(
    private readonly s: string,
    private depth: number,
    private readonly shared: Shared,
  ) {
    if (depth > MAX_DEPTH) throw new ParseError('nesting too deep');
  }

  parse(): Script {
    return this.list(false, false, false);
  }

  /** `$`, backtick and `${…}` expansions inside text that has no quoting of its own (heredoc bodies, arithmetic). */
  scan(): Script[] {
    const b = new WordBuilder();
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') this.i += 2;
      else if (c === '$') this.dollar(b, true);
      else if (c === '`') this.backtick(b, true);
      else this.i++;
    }
    return b.subs;
  }

  private list(paren: boolean, inCase: boolean, brace: boolean): Script {
    const s = this.s;
    const out: Script = [];
    for (;;) {
      this.gap(true);
      const c = s[this.i];
      if (c === undefined) {
        if (paren) throw new ParseError('unbalanced (');
        if (brace) throw new ParseError('unbalanced {');
        return out;
      }
      if (c === ')') {
        if (paren) {
          this.i++;
          return out;
        }
        throw new ParseError('unbalanced )');
      }
      if (inCase && (s.startsWith(';;', this.i) || s.startsWith(';&', this.i))) return out;
      if (c === ';' || c === '&' || c === '|') {
        this.i++;
        continue;
      }
      if (brace && c === '}' && this.peekWord() === '}') {
        this.i++;
        return out;
      }
      if (inCase && this.peekWord() === 'esac') return out;
      const at = this.i;
      out.push(this.pipeline());
      if (this.i === at) throw new ParseError(`unexpected ${c}`);
      this.gap(false);
      if (s.startsWith('&&', this.i) || s.startsWith('||', this.i)) this.i += 2;
      else if (s[this.i] === ';' && !(inCase && (s[this.i + 1] === ';' || s[this.i + 1] === '&'))) this.i++;
      else if (s[this.i] === '&' && s[this.i + 1] !== '>') this.i++;
    }
  }

  private pipeline(): Pipeline {
    const s = this.s;
    const stages: Pipeline = [this.stage()];
    for (;;) {
      this.gap(false);
      if (s[this.i] === '|' && s[this.i + 1] !== '|') {
        this.i += s[this.i + 1] === '&' ? 2 : 1;
        this.gap(true);
        stages.push(this.stage());
      } else return stages;
    }
  }

  private stage(): Stage {
    const s = this.s;
    if (++this.shared.nodes > MAX_NODES) throw new ParseError('too many commands');
    this.gap(false);
    if (s[this.i] === '!' && /[\s(]/.test(s[this.i + 1] ?? '')) {
      this.i++;
      this.gap(false);
    }
    if (s[this.i] === '(') {
      if (s[this.i + 1] === '(') {
        const e = this.matchArith(this.i + 2);
        const inner = s.slice(this.i + 2, e);
        this.i = e + 2;
        const scripts = scanSubs(inner, this.depth + 1, this.shared);
        return { k: 'group', scripts, redirs: this.trailing() };
      }
      this.i++;
      this.enter();
      const sc = this.list(true, false, false);
      this.depth--;
      return { k: 'group', scripts: [sc], redirs: this.trailing() };
    }
    if (s[this.i] === '{' && /[\s]/.test(s[this.i + 1] ?? '')) {
      this.i++;
      this.enter();
      const sc = this.list(false, false, true);
      this.depth--;
      return { k: 'group', scripts: [sc], redirs: this.trailing() };
    }
    return this.simple();
  }

  private trailing(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      this.gap(false);
      const r = this.redirect();
      if (!r) return out;
      out.push(r);
    }
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ParseError('nesting too deep');
  }

  private simple(): Stage {
    const s = this.s;
    const cmd: Cmd = { k: 'cmd', dialect: 'posix', words: [], assigns: [], redirs: [], control: false };
    let test = false;
    for (;;) {
      this.gap(false);
      const c = s[this.i];
      if (c === undefined) break;
      if (test) {
        if (s.startsWith('&&', this.i) || s.startsWith('||', this.i)) {
          this.i += 2;
          continue;
        }
        if (c === '<' || c === '>' || c === '(' || c === ')') {
          this.i++;
          continue;
        }
      }
      const procsub = (c === '<' || c === '>') && s[this.i + 1] === '(';
      if (!procsub) {
        const r = this.redirect();
        if (r) {
          cmd.redirs.push(r);
          continue;
        }
      }
      if (c === '(') {
        if (cmd.words.length <= 1 && /^\(\s*\)/.test(s.slice(this.i, this.i + 16))) {
          // function definition `name ()` - its body is parsed as ordinary commands
          this.i = s.indexOf(')', this.i) + 1;
          cmd.words = [];
          cmd.control = true;
          return cmd;
        }
        throw new ParseError('unexpected (');
      }
      if (POSIX_META.has(c) && !procsub) break;
      const w = this.word();
      if (!w) break;
      if (cmd.words.length === 0) {
        if (w.raw.includes('=') && ASSIGN.test(w.raw)) {
          cmd.assigns.push(w);
          continue;
        }
        const lit = plain(w);
        if (lit !== undefined) {
          if (SKIP_WORDS.has(lit)) continue;
          if (lit === 'case') return this.caseStmt();
          if (lit === 'function') {
            this.gap(false);
            this.word();
            cmd.control = true;
            continue;
          }
          if (lit === 'for' || lit === 'select') cmd.control = true;
          if (lit === '[[') test = true;
        }
      } else if (test && plain(w) === ']]') test = false;
      cmd.words.push(w);
    }
    return cmd;
  }

  private caseStmt(): Stage {
    const s = this.s;
    this.gap(false);
    const subject = this.word();
    const head: Cmd = { k: 'cmd', dialect: 'posix', words: subject ? [subject] : [], assigns: [], redirs: [], control: true };
    const scripts: Script[] = [[[head]]];
    this.gap(true);
    if (!this.word()) throw new ParseError('bad case');
    for (;;) {
      this.gap(true);
      if (this.i >= s.length) throw new ParseError('unterminated case');
      if (this.peekWord() === 'esac') {
        this.word();
        break;
      }
      if (s[this.i] === '(') this.i++;
      for (;;) {
        this.gap(false);
        if (s[this.i] !== ')' && s[this.i] !== '|' && !this.word()) throw new ParseError('bad case pattern');
        this.gap(false);
        if (s[this.i] === '|') {
          this.i++;
          continue;
        }
        if (s[this.i] === ')') {
          this.i++;
          break;
        }
        throw new ParseError('bad case pattern');
      }
      scripts.push(this.list(false, true, false));
      if (s.startsWith(';;&', this.i)) this.i += 3;
      else if (s.startsWith(';;', this.i) || s.startsWith(';&', this.i)) this.i += 2;
    }
    return { k: 'group', scripts, redirs: this.trailing() };
  }

  private peekWord(): string | undefined {
    const save = this.i;
    const pend = this.pending.length;
    let out: string | undefined;
    try {
      const c = this.s[this.i];
      if (c !== undefined && !POSIX_META.has(c)) {
        const w = this.word();
        out = w ? plain(w) : undefined;
      }
    } catch {
      out = undefined;
    }
    this.i = save;
    this.pending.length = pend;
    return out;
  }

  private redirect(): Redirect | null {
    const s = this.s;
    let j = this.i;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    let op: string | undefined;
    if (j === this.i && s.startsWith('&>>', j)) op = '&>>';
    else if (j === this.i && s.startsWith('&>', j)) op = '&>';
    else if (s[j] === '<' || s[j] === '>') {
      if (s[j + 1] === '(') return null;
      for (const o of REDIR_OPS) {
        if (s.startsWith(o, j)) {
          op = o;
          break;
        }
      }
    }
    if (!op) return null;
    this.i = j + op.length;
    this.gap(false);
    const target = this.word();
    if (!target) throw new ParseError('missing redirection target');
    const r: Redirect = { op, target };
    if (op === '<<' || op === '<<-') this.pending.push(r);
    return r;
  }

  private newline(): void {
    this.i++;
    if (!this.pending.length) return;
    const s = this.s;
    for (const r of this.pending) {
      const delim = r.target.parts.map((p) => (p.t === 'u' || p.t === 'q' ? p.v : p.t === 'v' ? '$' + p.v : '')).join('');
      let body = '';
      while (this.i < s.length) {
        let e = s.indexOf('\n', this.i);
        if (e < 0) e = s.length;
        const line = s.slice(this.i, e);
        this.i = Math.min(e + 1, s.length);
        const cmp = (r.op === '<<-' ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
        if (cmp === delim) break;
        body += line + '\n';
      }
      r.body = body;
      if (!r.target.quoted) r.bodySubs = scanSubs(body, this.depth + 1, this.shared);
    }
    this.pending = [];
  }

  private gap(nl: boolean): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2;
      else if (c === '\\' && s[this.i + 1] === '\r' && s[this.i + 2] === '\n') this.i += 3;
      else if (c === '#') {
        const e = s.indexOf('\n', this.i);
        this.i = e < 0 ? s.length : e;
      } else if (c === '\n' && nl) this.newline();
      else return;
    }
  }

  private word(): Word | null {
    const s = this.s;
    const start = this.i;
    const b = new WordBuilder();
    if ((s[start] === '<' || s[start] === '>') && s[start + 1] === '(') {
      this.i += 2;
      b.procsub = true;
      b.sub(this.subList(), false);
      return b.build(s.slice(start, this.i));
    }
    for (;;) {
      WORD_RUN.lastIndex = this.i;
      if (WORD_RUN.test(s)) {
        b.lit(s.slice(this.i, WORD_RUN.lastIndex), false);
        this.i = WORD_RUN.lastIndex;
      }
      const c = s[this.i];
      if (c === undefined) break;
      if (POSIX_META.has(c)) {
        if (c === '(' && ARRAY_ASSIGN.test(s.slice(start, this.i))) {
          const e = this.matchParen(this.i);
          b.lit(s.slice(this.i, e + 1), false);
          this.i = e + 1;
          continue;
        }
        break;
      }
      if (c === '\\') {
        const d = s[this.i + 1];
        if (d === '\n') {
          this.i += 2;
          continue;
        }
        if (d === undefined) {
          b.lit('\\', false);
          this.i++;
          continue;
        }
        if (this.i > start) b.escMid = true;
        b.lit(d, false);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", this.i + 1);
        if (e < 0) throw new ParseError('unbalanced single quote');
        b.lit(s.slice(this.i + 1, e), true);
        this.i = e + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        this.dq(b);
        continue;
      }
      if (c === '$') {
        this.dollar(b, false);
        if (b.stop) {
          b.stop = false;
          if (!b.empty()) break;
        }
        continue;
      }
      if (c === '`') {
        this.backtick(b, false);
        continue;
      }
      // * ? [
      b.glob = true;
      b.lit(c, false);
      this.i++;
    }
    if (this.i === start) return null;
    return b.build(s.slice(start, this.i));
  }

  private dq(b: WordBuilder): void {
    const s = this.s;
    b.lit('', true);
    for (;;) {
      const c = s[this.i];
      if (c === undefined) throw new ParseError('unbalanced double quote');
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === '\\') {
        const d = s[this.i + 1];
        if (d === '\n') {
          this.i += 2;
          continue;
        }
        if (d === '$' || d === '`' || d === '"' || d === '\\') {
          b.lit(d, true);
          this.i += 2;
          continue;
        }
        b.lit('\\', true);
        this.i++;
        continue;
      }
      if (c === '$') {
        this.dollar(b, true);
        continue;
      }
      if (c === '`') {
        this.backtick(b, true);
        continue;
      }
      let j = this.i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\\' && s[j] !== '$' && s[j] !== '`') j++;
      b.lit(s.slice(this.i, j), true);
      this.i = j;
    }
  }

  private dollar(b: WordBuilder, inDq: boolean): void {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === "'" && !inDq) {
      this.ansi(b);
      return;
    }
    if (n === '"' && !inDq) {
      this.i += 2;
      this.dq(b);
      return;
    }
    if (n === '(') {
      if (s[this.i + 2] === '(') {
        const e = this.matchArith(this.i + 3);
        const inner = s.slice(this.i + 3, e);
        this.i = e + 2;
        b.subs.push(...scanSubs(inner, this.depth + 1, this.shared));
        b.variable('__arith', inDq);
        return;
      }
      this.i += 2;
      b.sub(this.subList(), inDq);
      return;
    }
    if (n === '{') {
      const e = this.matchBrace(this.i + 1);
      const inner = s.slice(this.i + 2, e);
      this.i = e + 1;
      const m = /^([!#]?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(inner);
      if (!m) {
        b.variable('__expr', inDq);
        return;
      }
      if (m[1] === '!') b.indirect = true;
      const name = m[2] as string;
      const rest = inner.slice(m[0].length);
      if (/[$`]/.test(rest)) b.subs.push(...scanSubs(rest, this.depth + 1, this.shared));
      if (name === 'IFS' && !inDq) {
        b.ifs = true;
        b.stop = true;
        return;
      }
      b.variable(name, inDq);
      return;
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = this.i + 2;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j] as string)) j++;
      const name = s.slice(this.i + 1, j);
      this.i = j;
      if (name === 'IFS' && !inDq) {
        b.ifs = true;
        b.stop = true;
        return;
      }
      b.variable(name, inDq);
      return;
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
      this.i += 2;
      b.variable(n, inDq);
      return;
    }
    b.lit('$', inDq);
    this.i++;
  }

  private ansi(b: WordBuilder): void {
    const s = this.s;
    let j = this.i + 2;
    let out = '';
    let enc = false;
    for (;;) {
      const c = s[j];
      if (c === undefined) throw new ParseError("unbalanced $'");
      if (c === "'") break;
      if (c !== '\\') {
        out += c;
        j++;
        continue;
      }
      const d = s[j + 1];
      j += 2;
      switch (d) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'e': case 'E': out += '\x1b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\\': case "'": case '"': case '?': out += d; break;
        case 'x': case 'u': case 'U': {
          const max = d === 'x' ? 2 : d === 'u' ? 4 : 8;
          let k = 0;
          while (k < max && /[0-9a-fA-F]/.test(s[j + k] ?? '')) k++;
          if (k) {
            const cp = parseInt(s.slice(j, j + k), 16);
            out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
            j += k;
            enc = true;
          } else out += '\\' + d;
          break;
        }
        case 'c':
          out += String.fromCharCode((s.charCodeAt(j) || 64) & 31);
          j++;
          break;
        default:
          if (d !== undefined && /[0-7]/.test(d)) {
            j--;
            let k = 0;
            while (k < 3 && /[0-7]/.test(s[j + k] ?? '')) k++;
            out += String.fromCharCode(parseInt(s.slice(j, j + k), 8));
            j += k;
            enc = true;
          } else out += '\\' + (d ?? '');
      }
    }
    this.i = j + 1;
    if (enc) b.hex = true;
    b.lit(out, true);
  }

  private backtick(b: WordBuilder, inDq: boolean): void {
    const s = this.s;
    let j = this.i + 1;
    let inner = '';
    for (;;) {
      const c = s[j];
      if (c === undefined) throw new ParseError('unbalanced backtick');
      if (c === '`') break;
      if (c === '\\' && (s[j + 1] === '`' || s[j + 1] === '\\' || s[j + 1] === '$')) {
        inner += s[j + 1];
        j += 2;
        continue;
      }
      inner += c;
      j++;
    }
    this.i = j + 1;
    b.sub(new PosixParser(inner, this.depth + 1, this.shared).parse(), inDq);
  }

  private subList(): Script {
    this.enter();
    const sc = this.list(true, false, false);
    this.depth--;
    return sc;
  }

  private matchBrace(open: number): number {
    const s = this.s;
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
    }
    throw new ParseError('unbalanced ${');
  }

  /** Index of the first `)` of the closing `))`. */
  private matchArith(from: number): number {
    const s = this.s;
    let depth = 0;
    for (let j = from; j < s.length; j++) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0 && s[j + 1] === ')') return j;
        depth--;
      }
    }
    throw new ParseError('unbalanced $((');
  }

  private matchParen(open: number): number {
    const s = this.s;
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === "'" || c === '"') {
        const e = s.indexOf(c, j + 1);
        if (e < 0) break;
        j = e;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    throw new ParseError('unbalanced (');
  }
}

function scanSubs(text: string, depth: number, shared: Shared): Script[] {
  if (!/[$`]/.test(text)) return [];
  return new PosixParser(text, depth, shared).scan();
}

// ---------------------------------------------------------------------------------------------
// PowerShell parser (statements, pipelines, quoting, $( ) / ( ) / { } nesting, here-strings)

const PS_ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };
const isSq = (c: string | undefined): boolean => c === "'" || c === '\u2018' || c === '\u2019';
const isDq = (c: string | undefined): boolean => c === '"' || c === '\u201C' || c === '\u201D';

class PsParser {
  i = 0;
  constructor(
    private readonly s: string,
    private depth: number,
    private readonly shared: Shared,
  ) {
    if (depth > MAX_DEPTH) throw new ParseError('nesting too deep');
  }

  parse(): Script {
    return this.list(undefined);
  }

  private list(stop: string | undefined): Script {
    const s = this.s;
    const out: Script = [];
    for (;;) {
      this.gap(true);
      const c = s[this.i];
      if (c === undefined) {
        if (stop) throw new ParseError(`unbalanced ${stop === ')' ? '(' : '{'}`);
        return out;
      }
      if (stop && c === stop) {
        this.i++;
        return out;
      }
      if (c === ')' || c === '}') throw new ParseError(`unbalanced ${c}`);
      if (s.startsWith('&&', this.i) || s.startsWith('||', this.i)) {
        this.i += 2;
        continue;
      }
      if (c === ';' || c === '|') {
        this.i++;
        continue;
      }
      const at = this.i;
      out.push(this.pipeline());
      if (this.i === at) throw new ParseError(`unexpected ${c}`);
      this.gap(false);
      if (s.startsWith('&&', this.i) || s.startsWith('||', this.i)) this.i += 2;
      else if (s[this.i] === ';') this.i++;
    }
  }

  private pipeline(): Pipeline {
    const stages: Pipeline = [this.command()];
    for (;;) {
      this.gap(false);
      if (this.s[this.i] === '|' && this.s[this.i + 1] !== '|') {
        this.i++;
        this.gap(true);
        stages.push(this.command());
      } else return stages;
    }
  }

  private command(): Cmd {
    const s = this.s;
    if (++this.shared.nodes > MAX_NODES) throw new ParseError('too many commands');
    const cmd: Cmd = { k: 'cmd', dialect: 'powershell', words: [], assigns: [], redirs: [], control: false };
    this.gap(false);
    let callOp = false;
    if ((s[this.i] === '&' && s[this.i + 1] !== '&') || (s[this.i] === '.' && /[\s'"$(]/.test(s[this.i + 1] ?? ''))) {
      callOp = true;
      this.i++;
    }
    for (;;) {
      this.gap(false);
      const c = s[this.i];
      if (c === undefined || c === '\n' || c === ';' || c === '|' || c === ')' || c === '}') break;
      if (c === '&') {
        if (s[this.i + 1] === '&') break;
        this.i++;
        continue;
      }
      const r = /^[1-6*]?>>?(&[12])?/.exec(s.slice(this.i, this.i + 5));
      if (r && r[0].includes('>')) {
        this.i += r[0].length;
        if (r[1]) continue;
        this.gap(false);
        const t = this.word();
        if (!t) throw new ParseError('missing redirection target');
        cmd.redirs.push({ op: r[0].includes('>>') ? '>>' : '>', target: t });
        continue;
      }
      const w = this.word();
      if (!w) throw new ParseError(`unexpected ${c}`);
      cmd.words.push(w);
    }
    // `$x = <statement>`: the right-hand side is a command in its own right.
    while (!callOp && cmd.words.length >= 2 && cmd.words[0]!.raw.startsWith('$') && /^[-+*/%]?=$/.test(cmd.words[1]!.raw)) {
      const name = cmd.words[0]!.raw.slice(1).replace(/^\{|\}$/g, '').replace(/^\w+:/, '');
      if (cmd.words.length === 3) cmd.psAssign = { name, value: cmd.words[2]! };
      cmd.words = cmd.words.slice(2);
    }
    const first = cmd.words[0];
    if (first && !callOp && /^[$'"(@[0-9\u2018\u2019\u201C\u201D]/.test(first.raw)) cmd.control = true;
    return cmd;
  }

  private gap(nl: boolean): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\u00a0') this.i++;
      else if (c === '`' && (s[this.i + 1] === '\n' || s[this.i + 1] === '\r')) this.i += 2;
      else if (c === '<' && s[this.i + 1] === '#') {
        const e = s.indexOf('#>', this.i + 2);
        this.i = e < 0 ? s.length : e + 2;
      } else if (c === '#') {
        const e = s.indexOf('\n', this.i);
        this.i = e < 0 ? s.length : e;
      } else if (c === '\n' && nl) this.i++;
      else return;
    }
  }

  private word(): Word | null {
    const s = this.s;
    const start = this.i;
    const b = new WordBuilder();
    for (;;) {
      const c = s[this.i];
      if (c === undefined || c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ';' || c === '|' || c === '&' || c === ')' || c === '}' || c === '>') break;
      if (c === '`') {
        const d = s[this.i + 1];
        if (d === undefined || d === '\n' || d === '\r') break;
        if (this.i > start) b.escMid = true;
        b.lit(PS_ESC[d] ?? d, false);
        this.i += 2;
        continue;
      }
      if (c === '@' && (isSq(s[this.i + 1]) || isDq(s[this.i + 1])) && /^\r?\n/.test(s.slice(this.i + 2, this.i + 4))) {
        const close = '\n' + s[this.i + 1] + '@';
        const e = s.indexOf(close, this.i + 2);
        if (e < 0) throw new ParseError('unbalanced here-string');
        b.lit(s.slice(this.i + 2, e).replace(/^\r?\n/, ''), true);
        this.i = e + close.length;
        continue;
      }
      if (isSq(c)) {
        this.sq(b);
        continue;
      }
      if (isDq(c)) {
        this.dq(b);
        continue;
      }
      if (c === '$') {
        this.dollar(b, false);
        continue;
      }
      if (c === '@' && (s[this.i + 1] === '(' || s[this.i + 1] === '{')) {
        this.i++;
        continue;
      }
      if (c === '(') {
        this.i++;
        b.sub(this.subList(')'), false);
        continue;
      }
      if (c === '{') {
        this.i++;
        b.sub(this.subList('}'), false);
        continue;
      }
      if (c === '[') {
        let depth = 0;
        let j = this.i;
        for (; j < s.length; j++) {
          if (s[j] === '[') depth++;
          else if (s[j] === ']' && --depth === 0) break;
        }
        if (j >= s.length) throw new ParseError('unbalanced [');
        b.lit(s.slice(this.i, j + 1), false);
        this.i = j + 1;
        continue;
      }
      b.lit(c, false);
      this.i++;
    }
    if (this.i === start) return null;
    return b.build(s.slice(start, this.i));
  }

  private sq(b: WordBuilder): void {
    const s = this.s;
    let j = this.i + 1;
    let out = '';
    for (;;) {
      const c = s[j];
      if (c === undefined) throw new ParseError('unbalanced single quote');
      if (isSq(c)) {
        if (isSq(s[j + 1])) {
          out += "'";
          j += 2;
          continue;
        }
        break;
      }
      out += c;
      j++;
    }
    this.i = j + 1;
    b.lit(out, true);
  }

  private dq(b: WordBuilder): void {
    const s = this.s;
    this.i++;
    b.lit('', true);
    for (;;) {
      const c = s[this.i];
      if (c === undefined) throw new ParseError('unbalanced double quote');
      if (isDq(c)) {
        if (isDq(s[this.i + 1])) {
          b.lit('"', true);
          this.i += 2;
          continue;
        }
        this.i++;
        return;
      }
      if (c === '`') {
        const d = s[this.i + 1] ?? '';
        b.lit(PS_ESC[d] ?? d, true);
        this.i += 2;
        continue;
      }
      if (c === '$') {
        this.dollar(b, true);
        continue;
      }
      b.lit(c, true);
      this.i++;
    }
  }

  private dollar(b: WordBuilder, q: boolean): void {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      this.i += 2;
      b.sub(this.subList(')'), q);
      return;
    }
    if (n === '{') {
      const e = s.indexOf('}', this.i);
      if (e < 0) throw new ParseError('unbalanced ${');
      this.variable(b, s.slice(this.i + 2, e), q);
      this.i = e + 1;
      return;
    }
    const m = /^[A-Za-z_?^$][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?/.exec(s.slice(this.i + 1, this.i + 200));
    if (m) {
      this.i += 1 + m[0].length;
      this.variable(b, m[0], q);
      return;
    }
    b.lit('$', q);
    this.i++;
  }

  private variable(b: WordBuilder, name: string, q: boolean): void {
    const low = name.toLowerCase();
    if (low === 'null' || low === 'true' || low === 'false') {
      b.lit('$' + name, q);
      return;
    }
    const k = name.indexOf(':');
    b.variable(k >= 0 ? name.slice(k + 1) : name, q);
  }

  private subList(stop: string): Script {
    if (++this.depth > MAX_DEPTH) throw new ParseError('nesting too deep');
    const sc = this.list(stop);
    this.depth--;
    return sc;
  }
}

// ---------------------------------------------------------------------------------------------
// cmd.exe parser (& && || |, ^ escapes, "quotes", %VAR% / !VAR!, ( ) blocks, redirections)

class CmdParser {
  i = 0;
  private paren = 0;
  constructor(
    private readonly s: string,
    depth: number,
    private readonly shared: Shared,
  ) {
    if (depth > MAX_DEPTH) throw new ParseError('nesting too deep');
  }

  parse(): Script {
    return this.list();
  }

  private list(): Script {
    const s = this.s;
    const out: Script = [];
    for (;;) {
      this.gap();
      const c = s[this.i];
      if (c === undefined) {
        if (this.paren) throw new ParseError('unbalanced (');
        return out;
      }
      if (c === ')' && this.paren) {
        this.i++;
        return out;
      }
      if (c === '\n' || c === '&' || c === '|' || c === ')') {
        this.i++;
        continue;
      }
      const at = this.i;
      out.push(this.pipeline());
      if (this.i === at) this.i++;
    }
  }

  private pipeline(): Pipeline {
    const st: Pipeline = [this.stage()];
    for (;;) {
      this.gap();
      if (this.s[this.i] === '|' && this.s[this.i + 1] !== '|') {
        this.i++;
        st.push(this.stage());
      } else return st;
    }
  }

  private stage(): Stage {
    const s = this.s;
    if (++this.shared.nodes > MAX_NODES) throw new ParseError('too many commands');
    this.gap();
    while (s[this.i] === '@') {
      this.i++;
      this.gap();
    }
    if (s[this.i] === '(') {
      this.i++;
      if (++this.paren > MAX_DEPTH) throw new ParseError('nesting too deep');
      const sc = this.list();
      this.paren--;
      return { k: 'group', scripts: [sc], redirs: [] };
    }
    const cmd: Cmd = { k: 'cmd', dialect: 'cmd', words: [], assigns: [], redirs: [], control: false };
    for (;;) {
      this.gap();
      const c = s[this.i];
      if (c === undefined || c === '\n' || c === '&' || c === '|' || (c === ')' && this.paren)) break;
      const r = /^(\d?)(>>|>|<)(&\d)?/.exec(s.slice(this.i, this.i + 5));
      if (r) {
        this.i += r[0].length;
        if (r[3]) continue;
        this.gap();
        const t = this.word();
        if (!t) throw new ParseError('missing redirection target');
        cmd.redirs.push({ op: r[2] as string, target: t });
        continue;
      }
      const w = this.word();
      if (!w) {
        this.i++;
        continue;
      }
      cmd.words.push(w);
    }
    return cmd;
  }

  private gap(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '^' && s[this.i + 1] === '\n') this.i += 2;
      else return;
    }
  }

  private word(): Word | null {
    const s = this.s;
    const start = this.i;
    const b = new WordBuilder();
    for (;;) {
      const c = s[this.i];
      if (c === undefined || c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '&' || c === '|' || c === '<' || c === '>' || (c === ')' && this.paren)) break;
      if (c === '^') {
        const d = s[this.i + 1];
        if (d === undefined) {
          this.i++;
          break;
        }
        if (this.i > start) b.escMid = true;
        b.lit(d, false);
        this.i += 2;
        continue;
      }
      if (c === '"') {
        const e = s.indexOf('"', this.i + 1);
        const end = e < 0 ? s.length : e;
        b.lit(s.slice(this.i + 1, end), true);
        this.i = e < 0 ? s.length : e + 1;
        continue;
      }
      if (c === '%' || c === '!') {
        const m = (c === '%' ? /^%([A-Za-z_][A-Za-z0-9_]*)(:[^%]*)?%/ : /^!([A-Za-z_][A-Za-z0-9_]*)!/).exec(s.slice(this.i, this.i + 300));
        if (m) {
          b.variable(m[1] as string, false);
          this.i += m[0].length;
          continue;
        }
      }
      b.lit(c, false);
      this.i++;
    }
    if (this.i === start) return null;
    return b.build(s.slice(start, this.i));
  }
}

// ---------------------------------------------------------------------------------------------
// Option parsing helpers

interface Opts {
  pos: Word[];
  short: string;
  long: Set<string>;
  vals: Map<string, string[]>;
  /** With stopAtFirst: index of the first positional (the wrapped command). */
  rest: number;
}

/** getopt-style parsing. `shortVals`: short letters that take a value; `longVals`: long names (no --) that take one. */
function getopt(args: Word[], shortVals: string, longVals: readonly string[], stopAtFirst = false): Opts {
  const o: Opts = { pos: [], short: '', long: new Set(), vals: new Map(), rest: args.length };
  const put = (k: string, v: string): void => {
    const a = o.vals.get(k);
    if (a) a.push(v);
    else o.vals.set(k, [v]);
  };
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as Word).text;
    if (t === '--') {
      if (stopAtFirst) {
        o.rest = k + 1;
        return o;
      }
      o.pos.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      o.long.add(name);
      if (eq >= 0) put(name, t.slice(eq + 1));
      else if (longVals.includes(name) && k + 1 < args.length) put(name, (args[++k] as Word).text);
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c] as string;
        o.short += ch;
        if (shortVals.includes(ch)) {
          const v = c + 1 < t.length ? t.slice(c + 1) : args[++k]?.text;
          if (v !== undefined) put(ch, v);
          break;
        }
      }
      continue;
    }
    if (stopAtFirst) {
      o.rest = k;
      return o;
    }
    o.pos.push(args[k] as Word);
  }
  return o;
}

/** PowerShell parameters: `-Name value`, `-Name:value`, unique prefixes, switches. */
function psArgs(args: Word[], vals: readonly string[], sws: readonly string[]): { named: Map<string, string[]>; sw: Set<string>; pos: string[] } {
  const named = new Map<string, string[]>();
  const sw = new Set<string>();
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k] as Word;
    const m = /^-([A-Za-z][\w-]*)(?::(.*))?$/.exec(w.text);
    if (!m || (w.quoted && w.segs === 1)) {
      pos.push(w.text);
      continue;
    }
    const nm = (m[1] as string).toLowerCase();
    const full = vals.find((v) => v.startsWith(nm));
    if (full) {
      const v = m[2] ?? args[++k]?.text;
      if (v !== undefined) named.set(full, [...(named.get(full) ?? []), v]);
      continue;
    }
    if (m[2] !== undefined && /^\$false$/i.test(m[2])) continue;
    sw.add(sws.find((s) => s.startsWith(nm)) ?? nm);
  }
  return { named, sw, pos };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)\]}]+/gi;

export function urlHost(t: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined;
  try {
    const h = new URL(t).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h || undefined;
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(t)?.[1]?.toLowerCase();
  }
}

/** A bare `host[:port][/path]` as curl and friends accept it. */
function bareHost(t: string): string | undefined {
  const m = /^(?:[^@/\s]+@)?(\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::\d*)?(?:[/?#].*)?$/i.exec(t);
  if (!m) return undefined;
  const h = (m[1] as string).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}$/.test(h) || h.includes(':')) return h;
  return undefined;
}

/** `[user@]host[:port]` or `scheme://…` as ssh, nc and telnet take it. */
function anyHost(t: string): string | undefined {
  const u = urlHost(t);
  if (u) return u;
  if (!t || t.startsWith('-')) return undefined;
  const h = t.replace(/^[^@]*@/, '').replace(/^\[([^\]]+)\].*$/, '$1').replace(/:.*$/, '').toLowerCase();
  return h || undefined;
}

/** Remote side of scp / rsync / git: `user@host:path`, `host::module`, or a URL. */
function remoteHost(t: string): string | undefined {
  if (/^[A-Za-z]:[\\/]/.test(t)) return undefined;
  const u = urlHost(t);
  if (u) return /^file:/i.test(t) ? undefined : u;
  const m = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^:\s/\\]+)::?(?!\/\/)/.exec(t);
  if (m && (m[1] as string).length > 1) return (m[1] as string).replace(/^\[|\]$/g, '').toLowerCase();
  return undefined;
}

const SINK = /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|nul|con|\$null)$/i;
const isSink = (t: string): boolean => SINK.test(t);
const ROOTISH = /^(\/|\/\*|~\/?\*?|\*|\.\/?\*?|\.\.\/?|\/(bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|usr|var|Users|System|Library|Applications)\/?\*?|[A-Za-z]:[\\/]?\*?|[A-Za-z]:\\(Windows|Users|Program Files)\\?)$/i;
const fileKey = (t: string): string => t.replace(/^\.[\\/]/, '');

function progName(w: Word): string | undefined {
  let t = w.text;
  if (/^[A-Za-z]:[^\\/]/.test(t) && w.raw.includes('\\')) t = w.raw.replace(/["']/g, '');
  const base = t.split(/[\\/]/).pop() ?? t;
  const n = base.replace(/\.(exe|com|bat|cmd)$/i, '').toLowerCase();
  return n || undefined;
}

function decodeB64(t: string): string | undefined {
  const clean = t.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean) || clean.length > 16384) return undefined;
  const out = Buffer.from(clean, 'base64').toString('utf8');
  return /[\x00-\x08\x0e-\x1f]/.test(out) ? undefined : out;
}

// ---------------------------------------------------------------------------------------------
// Program tables

export const NETWORK_PROGRAMS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'lftp', 'telnet', 'http', 'https', 'xh', 'xhs',
  'aria2c', 'axel', 'lynx', 'links', 'w3m', 'elinks', 'socat', 'mosh', 'ssh-copy-id', 'autossh', 'ping', 'ping6', 'traceroute', 'tracert',
  'mtr', 'whois', 'dig', 'nslookup', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'bitsadmin',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'yash', 'tcsh', 'csh', 'rbash']);
const WRAPPERS = new Set(['sudo', 'doas', 'pkexec', 'env', 'nohup', 'builtin', 'setsid', 'unbuffer', 'noglob', 'nocorrect', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'command', 'exec', 'chroot', 'busybox', 'xargs', 'watch', 'flock', 'strace', 'ltrace', 'call', 'start']);
const SCRIPT_INTERP = /^(python[\d.]*|py|pypy[\d.]*|perl|ruby|node|nodejs|php|lua|rscript)$/;
const PKG = new Set(['pip', 'pip3', 'pipx', 'uv', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'gem', 'cargo', 'go', 'composer', 'poetry', 'conda', 'npx', 'pnpx', 'bunx', 'brew']);
/** First-positional-is-the-host programs and their value-taking short options. */
const NET_HOST_FIRST: Record<string, string> = {
  nc: 'pswiqxXecIOTVMm', ncat: 'pswiqxXecIOTVMm', netcat: 'pswiqxXecIOTVMm', telnet: 'lnebX', ssh: 'bcDEeFIiJLlmOopQRSWwB',
  autossh: 'MbcDEeFIiJLlmOopQRSWwB', mosh: '', 'ssh-copy-id': 'ipoF', sftp: 'BbcDFiJlNoPRSs', ftp: 'P', tftp: 'm', lftp: 'pueEf',
  ping: 'cisWwtIl', ping6: 'cisWwtIl', traceroute: 'fmpqswNtz', tracert: 'hjw', mtr: 'cisa', whois: 'hp',
};
const URL_PROGRAMS = new Set(['http', 'https', 'xh', 'xhs', 'aria2c', 'axel', 'lynx', 'links', 'w3m', 'elinks']);
/** PowerShell aliases (only inside PowerShell) → cmdlet. */
const PS_ALIASES: Record<string, string> = {
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', ri: 'remove-item',
  iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest', irm: 'invoke-restmethod', iex: 'invoke-expression',
  saps: 'start-process', start: 'start-process', icm: 'invoke-command', sc: 'set-content', ac: 'add-content', ni: 'new-item',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', mv: 'move-item', move: 'move-item', mi: 'move-item', ren: 'rename-item',
  rni: 'rename-item', gc: 'get-content', cat: 'get-content', type: 'get-content', gci: 'get-childitem', ls: 'get-childitem',
  dir: 'get-childitem', gi: 'get-item', tee: 'tee-object',
};
/** Aliases that don't collide with POSIX programs, recognized in every dialect. */
const PS_ANYWHERE: Record<string, string> = { iwr: 'invoke-webrequest', irm: 'invoke-restmethod', iex: 'invoke-expression', ri: 'remove-item', icm: 'invoke-command', saps: 'start-process' };

const EXTRA_ENV: RegExp[] = [
  /\bprintenv\s+([A-Za-z_]\w*)/g,
  /os\.environ\s*\[\s*['"](\w+)/g,
  /os\.(?:environ\.get|getenv)\s*\(\s*['"](\w+)/g,
  /process\.env\.([A-Za-z_]\w*)/g,
  /process\.env\[\s*['"](\w+)/g,
  /\$ENV\{\s*['"]?(\w+)/g,
  /ENVIRON\[\s*"(\w+)/g,
  /GetEnvironmentVariable\(\s*['"](\w+)/gi,
  /\bgetenv\(\s*['"](\w+)/g,
];
const ENV_DUMP = /\/proc\/(self|\d+|\$\$)\/environ|GetEnvironmentVariables\(|os\.environ(?!\s*[[.])|\bprocess\.env(?!\s*[[.])/;

// ---------------------------------------------------------------------------------------------
// Legacy regex heuristics: the fail-safe when a command can't be parsed.

const LEGACY_DESTRUCTIVE = /(^|[\s;&|(`])(rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|mkfs(\.\w+)?|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\b[^;&|]*\s(--force\b|-f\b)|shred\s|format\s+[a-z]:)/i;

export function regexProgramOf(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (const raw of tokens) {
    const t = raw.replace(/^["'(\\]+|["')]+$/g, '');
    if (t === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'xargs', 'doas'].includes(t)) continue;
    const base = t.split(/[\\/]/).pop() ?? t;
    return base.replace(/\.exe$/i, '').toLowerCase();
  }
  return undefined;
}

function regexPrograms(command: string): string[] {
  return command
    .split(/\|\||&&|[|;&\n]|\$\(|`/)
    .map((seg) => regexProgramOf(seg))
    .filter((p): p is string => !!p);
}

// ---------------------------------------------------------------------------------------------
// Analyzer

interface StageInfo {
  name: string;
  /** Reads a program from stdin (sh, python, iex with no argument…). */
  stdin: boolean;
  /** A POSIX shell reading stdin (decoded base64 fed to it is analyzed). */
  shell: boolean;
  net: boolean;
  dec: boolean;
  b64: boolean;
  literal?: string;
  decoded?: string;
  outFiles: string[];
}
const freshInfo = (): StageInfo => ({ name: '', stdin: false, shell: false, net: false, dec: false, b64: false, outFiles: [] });

class Analyzer {
  program?: string;
  programs: string[] = [];
  private progSet = new Set<string>();
  destructive = false;
  network = false;
  obfuscated = false;
  pipeToShell = false;
  writeRedirection = false;
  heredoc = false;
  envDump = false;
  dynamicProgram = false;
  hosts: string[] = [];
  urls: string[] = [];
  writes: string[] = [];
  deletes: string[] = [];
  reads: string[] = [];
  reasons: string[] = [];
  parseError?: string;
  texts: string[] = [];
  cmdTexts: string[] = [];
  private netCount = 0;
  private decCount = 0;
  private subDepth = 0;
  private calls = 0;
  private vars = new Map<string, string>();
  private aliases = new Map<string, string>();
  private produced = new Map<string, { net: boolean; dec: boolean }>();
  private shared: Shared = { nodes: 0 };

  private why(r: string): void {
    if (this.reasons.length < 32 && !this.reasons.includes(r)) this.reasons.push(r);
  }
  destr(r: string): void {
    this.destructive = true;
    this.why(`destructive: ${r}`);
  }
  obf(r: string): void {
    this.obfuscated = true;
    this.why(`obfuscated: ${r}`);
  }
  pipe(r: string): void {
    this.pipeToShell = true;
    this.why(`pipeToShell: ${r}`);
  }
  net(host?: string, url?: string): void {
    this.network = true;
    this.netCount++;
    if (host && !this.hosts.includes(host)) this.hosts.push(host);
    if (url && !this.urls.includes(url)) this.urls.push(url);
  }
  private dec(): void {
    this.decCount++;
  }
  addProgram(name: string): void {
    if (!this.progSet.has(name)) {
      this.progSet.add(name);
      this.programs.push(name);
    }
    if (this.program === undefined && this.subDepth === 0 && !WRAPPERS.has(name)) this.program = name;
  }

  analyze(text: string, dialect: Dialect, d: number, ev: boolean): void {
    if (dialect === 'cmd') this.cmdTexts.push(text);
    else this.texts.push(text);
    if (++this.calls > MAX_ANALYZE) return this.fail('too many nested commands', text);
    if (d > MAX_DEPTH) return this.fail('nesting too deep', text);
    if (text.length > MAX_INPUT) return this.fail('command over size limit', text);
    let script: Script;
    try {
      script =
        dialect === 'posix' ? new PosixParser(text, d, this.shared).parse() : dialect === 'powershell' ? new PsParser(text, d, this.shared).parse() : new CmdParser(text, d, this.shared).parse();
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e), text);
    }
    this.walkScript(script, d, ev);
    if (dialect === 'powershell') this.psText(text);
  }

  fail(msg: string, text: string): void {
    this.parseError ??= msg;
    this.obf(`unparseable (${msg})`);
    for (const p of regexPrograms(text)) this.addProgram(p);
    if (this.program === undefined) {
      const p = regexProgramOf(text);
      if (p) this.program = p;
    }
    if (LEGACY_DESTRUCTIVE.test(text)) this.destr('pattern match');
    if (regexPrograms(text).some((p) => NETWORK_PROGRAMS.has(p))) {
      const url = /\bhttps?:\/\/[^\s"'<>]+/i.exec(text)?.[0];
      const host = url ? urlHost(url) : /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(text)?.[1]?.toLowerCase();
      this.net(host, url);
    }
    if (/(^|[^0-9&>])>{1,2}\s*[^&\s]/.test(text)) this.writeRedirection = true;
    if (/\b(curl|wget|iwr|irm)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\biex\b/i.test(text)) this.pipe('pattern match');
  }

  private psText(text: string): void {
    if (/frombase64string|\[char\]\s*0x|-bxor|gzipstream|deflatestream|\[text\.encoding\]::\w+\.getstring/i.test(text)) this.obf('PowerShell decoding');
    if (/\.(downloadstring|downloadfile|downloaddata|openread|uploadstring|uploadfile|uploaddata)\s*\(|net\.webclient|net\.http\.httpclient|net\.sockets\.tcpclient|system\.net\.webrequest/i.test(text)) {
      this.net();
      for (const m of text.matchAll(URL_RE)) this.net(urlHost(m[0]), m[0]);
    }
    if (/\b(iex|invoke-expression)\b/i.test(text) && /\.download(string|data)\s*\(|\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(text)) this.pipe('downloaded PowerShell executed');
  }

  private walkScript(sc: Script, d: number, ev: boolean): void {
    for (const p of sc) this.walkPipeline(p, d, ev);
  }

  private walkPipeline(p: Pipeline, d: number, ev: boolean): void {
    const prev: StageInfo[] = [];
    for (const st of p) {
      const n0 = this.netCount;
      const d0 = this.decCount;
      const info = freshInfo();
      if (st.k === 'group') {
        for (const sc of st.scripts) this.walkScript(sc, d, ev);
        for (const r of st.redirs) this.redirect(r, info);
      } else this.walkCmd(st, d, ev, info);
      info.net = this.netCount > n0;
      info.dec = this.decCount > d0;
      const last = prev[prev.length - 1];
      if (info.b64 && last?.literal !== undefined) info.decoded = decodeB64(last.literal);
      if (info.stdin && prev.length) {
        if (prev.some((x) => x.net)) this.pipe(`network output piped into ${info.name}`);
        if (prev.some((x) => x.dec)) this.obf(`decoded data piped into ${info.name}`);
        if (info.shell && last?.decoded) this.analyze(last.decoded, 'posix', d + 1, true);
      }
      const upNet = info.net || prev.some((x) => x.net);
      const upDec = info.dec || prev.some((x) => x.dec);
      if (upNet || upDec) for (const f of info.outFiles) this.produced.set(fileKey(f), { net: upNet, dec: upDec });
      prev.push(info);
    }
  }

  private walkWordSubs(w: Word, d: number): void {
    if (!w.subs.length) return;
    const n0 = this.netCount;
    const d0 = this.decCount;
    this.subDepth++;
    for (const sc of w.subs) this.walkScript(sc, d + 1, false);
    this.subDepth--;
    w.subNet = this.netCount > n0;
    w.subDec = this.decCount > d0;
    if (w.subDec) this.obf('decoding inside a command substitution');
  }

  private walkCmd(cmd: Cmd, d: number, ev: boolean, info: StageInfo): void {
    for (const w of cmd.assigns) this.walkWordSubs(w, d);
    for (const w of cmd.words) this.walkWordSubs(w, d);
    for (const r of cmd.redirs) {
      this.walkWordSubs(r.target, d);
      if (r.bodySubs?.length) {
        this.subDepth++;
        for (const sc of r.bodySubs) this.walkScript(sc, d + 1, false);
        this.subDepth--;
      }
    }
    if (cmd.psAssign) {
      this.walkWordSubs(cmd.psAssign.value, d);
      const v = cmd.psAssign.value;
      if (isStatic(v, this.vars)) this.vars.set(cmd.psAssign.name, render(v, this.vars));
      else this.vars.delete(cmd.psAssign.name);
    }
    for (const a of cmd.assigns) {
      a.text = render(a, this.vars);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/.exec(a.text);
      if (!m) continue;
      const name = m[1] as string;
      if (name === 'IFS') {
        const p = cmd.words[0] && progName(cmd.words[0]);
        if (p !== 'read' && p !== 'mapfile' && p !== 'readarray') this.obf('IFS reassigned');
      }
      if (isStatic(a, this.vars) && !m[2]) this.vars.set(name, a.text.slice(m[0].length));
      else this.vars.delete(name);
    }
    for (const w of cmd.words) {
      if (isDynamic(w)) w.text = render(w, this.vars);
      if (w.ifs) this.obf('IFS used as a word separator');
      if (w.indirect) this.obf('indirect variable expansion');
    }
    for (const r of cmd.redirs) {
      if (isDynamic(r.target)) r.target.text = render(r.target, this.vars);
      this.redirect(r, info);
    }
    if (cmd.control || !cmd.words.length) return;
    this.argv(cmd.words, cmd.dialect, d, ev, info, cmd.redirs);
  }

  private redirect(r: Redirect, info: StageInfo): void {
    const t = r.target.text;
    const op = r.op;
    if (op === '<<' || op === '<<-') {
      this.heredoc = true;
      return;
    }
    if (op === '<<<') return;
    const dev = /^\/dev\/(tcp|udp)\/([^/]+)\/(\d+)/.exec(t);
    if (dev) {
      this.net((dev[2] as string).toLowerCase());
      this.why(`network: /dev/${dev[1]} redirection`);
      return;
    }
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(t)) return;
    if (op === '<' || op === '<&') {
      if (!isSink(t) && op === '<') this.reads.push(t);
      return;
    }
    if (isSink(t)) return;
    this.writeRedirection = true;
    this.writes.push(t);
    info.outFiles.push(t);
    if (/^\/dev\/(sd|hd|nvme|xvd|vd|mmcblk|disk|rdisk|dm-|md)/.test(t)) this.destr('write to a block device');
  }

  private runFile(w: Word): void {
    if (w.procsub) {
      if (w.subNet) this.pipe('shell reads a process substitution from the network');
      if (w.subDec) this.obf('shell reads decoded data');
      return;
    }
    const p = this.produced.get(fileKey(w.text));
    if (p?.net) this.pipe(`runs ${w.text}, which it just downloaded`);
    if (p?.dec) this.obf(`runs ${w.text}, which it just decoded`);
  }

  /** Script text handed to an interpreter (`bash -c`, `eval`, `iex`, `cmd /c`…). */
  private inline(w: Word, dialect: Dialect, d: number): void {
    if (w.subNet) this.pipe('downloaded text executed as a script');
    if (w.subDec) this.obf('decoded text executed as a script');
    if (onlySubs(w)) return;
    this.analyze(w.text, dialect, d + 1, true);
  }

  private evalWords(args: Word[], dialect: Dialect, d: number): void {
    if (!args.length) return;
    if (args.some((w) => w.subNet)) this.pipe('eval of downloaded text');
    if (args.some((w) => w.subDec)) this.obf('eval of decoded text');
    if (args.every(onlySubs)) return;
    this.analyze(args.map((w) => w.text).join(' '), dialect, d + 1, true);
  }

  private feedBodies(redirs: Redirect[], d: number): void {
    for (const r of redirs) {
      if (r.body !== undefined) this.analyze(r.body, 'posix', d + 1, true);
      else if (r.op === '<<<') this.inline(r.target, 'posix', d);
      else if (r.op === '<') this.runFile(r.target);
    }
  }

  private argv(ws: Word[], dia: Dialect, d: number, ev: boolean, info: StageInfo, redirs: Redirect[]): void {
    for (let hop = 0; ws.length > 0 && hop < 24; hop++) {
      const w0 = ws[0] as Word;
      if (!w0.parts.length && !w0.quoted) {
        ws = ws.slice(1);
        continue;
      }
      if (isDynamic(w0)) {
        const lone = w0.parts.length === 1 && w0.parts[0]?.t === 'v';
        if (!isStatic(w0, this.vars)) {
          this.dynamicProgram = true;
          if (!lone || ev) this.obf('program name only known at run time');
          if (w0.subNet) this.pipe('program name comes from the network');
          return;
        }
        if (!lone) this.obf('program name assembled from variables');
        w0.text = render(w0, this.vars);
      }
      if (w0.hex) this.obf('escape-encoded program name');
      if (w0.escMid || (w0.segs > 1 && w0.quoted)) this.obf('quote-split program name');
      const text = w0.text;
      if (w0.glob && text !== '[' && text !== '[[' && /[*?[]/.test(text)) this.obf('wildcard in program name');
      const name = progName(w0);
      if (!name) return;
      if (/[\\/]/.test(text)) this.runFile(w0);
      const alias = this.aliases.get(name);
      if (alias !== undefined && !w0.quoted && hop === 0) {
        this.addProgram(name);
        this.analyze([alias, ...ws.slice(1).map((w) => w.text)].join(' '), dia === 'cmd' ? 'posix' : dia, d + 1, ev);
        return;
      }
      this.addProgram(name);
      info.name = name;
      const next = this.dispatch(name, w0, ws.slice(1), dia, d, ev, info, redirs);
      if (!next) return;
      ws = next;
    }
  }

  private dispatch(name: string, w0: Word, args: Word[], dia: Dialect, d: number, ev: boolean, info: StageInfo, redirs: Redirect[]): Word[] | undefined {
    const texts = (): string[] => args.map((w) => w.text);
    const psAlias = dia === 'powershell' && !/\.exe$/i.test(w0.text) ? PS_ALIASES[name] : undefined;
    const canon = psAlias ?? PS_ANYWHERE[name] ?? name;
    if (canon !== name) this.addProgram(canon);
    if (canon.includes('-')) {
      const r = this.psCmd(canon, args, d, info);
      if (r !== false) return r;
    }
    if (dia === 'cmd') {
      const r = this.cmdBuiltin(name, args, d);
      if (r !== false) return r;
    }

    // Wrappers: strip their options and continue with the wrapped command.
    switch (name) {
      case 'sudo': case 'doas': case 'pkexec': {
        const o = name === 'sudo'
          ? getopt(args, 'ugpChDrtUT', ['user', 'group', 'host', 'prompt', 'chdir', 'role', 'type', 'other-user', 'close-from', 'command-timeout'], true)
          : getopt(args, name === 'doas' ? 'uC' : '', ['user'], true);
        if (o.rest >= args.length) {
          if (/[si]/.test(o.short) || o.long.has('shell') || o.long.has('login')) {
            info.stdin = true;
            info.shell = true;
          }
          return undefined;
        }
        return args.slice(o.rest);
      }
      case 'su': {
        const o = getopt(args, 'cgGs', ['command', 'group', 'supp-group', 'shell', 'whitelist-environment'], false);
        const c = o.vals.get('c') ?? o.vals.get('command');
        if (c) for (const t of c) this.analyze(t, 'posix', d + 1, true);
        else {
          info.stdin = true;
          info.shell = true;
        }
        return undefined;
      }
      case 'env': {
        let k = 0;
        for (; k < args.length; k++) {
          const t = (args[k] as Word).text;
          if (t === '--') {
            k++;
            break;
          }
          if (t === '-S' || t === '--split-string' || /^-S.|^--split-string=/.test(t)) {
            const v = t === '-S' || t === '--split-string' ? args[++k]?.text : t.replace(/^(-S|--split-string=)/, '');
            if (v !== undefined) this.analyze([v, ...args.slice(k + 1).map((w) => w.text)].join(' '), 'posix', d + 1, ev);
            return undefined;
          }
          if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') {
            k++;
            continue;
          }
          if (t.startsWith('-') || ASSIGN.test(t)) continue;
          break;
        }
        if (k >= args.length) {
          this.envDump = true;
          return undefined;
        }
        return args.slice(k);
      }
      case 'nohup': case 'builtin': case 'setsid': case 'unbuffer': case 'noglob': case 'nocorrect':
        return args.slice(getopt(args, '', [], true).rest);
      case 'time':
        return args.slice(getopt(args, 'fo', ['format', 'output'], true).rest);
      case 'nice':
        return args.slice(getopt(args, 'n', ['adjustment'], true).rest);
      case 'ionice': {
        const o = getopt(args, 'cnp', ['class', 'classdata', 'pid', 'pgid', 'uid'], true);
        return o.vals.has('p') ? undefined : args.slice(o.rest);
      }
      case 'timeout':
        return args.slice(getopt(args, 'sk', ['signal', 'kill-after'], true).rest + 1);
      case 'stdbuf':
        return args.slice(getopt(args, 'ioe', ['input', 'output', 'error'], true).rest);
      case 'command': {
        const o = getopt(args, '', [], true);
        return /[vV]/.test(o.short) ? undefined : args.slice(o.rest);
      }
      case 'exec':
        return args.slice(getopt(args, 'a', [], true).rest);
      case 'chroot': {
        const o = getopt(args, '', ['userspec', 'groups'], true);
        return args.slice(o.rest + 1);
      }
      case 'busybox':
        return args;
      case 'xargs':
        return args.slice(getopt(args, 'IndPLsEa', ['replace', 'max-args', 'delimiter', 'max-procs', 'max-lines', 'max-chars', 'eof', 'arg-file', 'process-slot-var'], true).rest);
      case 'watch': {
        const o = getopt(args, 'nq', ['interval', 'equexit'], true);
        const rest = args.slice(o.rest);
        if (o.short.includes('x') || o.long.has('exec')) return rest;
        if (rest.length) this.analyze(rest.map((w) => w.text).join(' '), 'posix', d + 1, ev);
        return undefined;
      }
      case 'flock': {
        const o = getopt(args, 'wEc', ['timeout', 'conflict-exit-code', 'command'], true);
        const c = o.vals.get('c') ?? o.vals.get('command');
        const rest = args.slice(o.rest + 1);
        if (c?.[0] !== undefined) this.analyze(c[0], 'posix', d + 1, ev);
        else if (rest[0]?.text === '-c' || rest[0]?.text === '--command') {
          if (rest[1]) this.inline(rest[1], 'posix', d);
        } else return rest;
        return undefined;
      }
      case 'strace': case 'ltrace':
        return args.slice(getopt(args, 'oepsuEabIOPSX', [], true).rest);
      case 'trap':
        if (args[0] && !args[0].text.startsWith('-')) this.inline(args[0], 'posix', d);
        return undefined;
      case 'script': {
        const o = getopt(args, 'cEIOT', ['command', 'echo', 'log-in', 'log-out', 'log-timing'], false);
        for (const c of o.vals.get('c') ?? o.vals.get('command') ?? []) this.analyze(c, 'posix', d + 1, true);
        return undefined;
      }
    }

    if (SHELLS.has(name)) {
      this.shell(args, d, info, redirs);
      return undefined;
    }
    if (SCRIPT_INTERP.test(name)) {
      this.scriptInterp(name, args, d, info, redirs);
      return undefined;
    }
    if (name === 'powershell' || name === 'pwsh' || name === 'powershell_ise') {
      this.powershell(args, d, info);
      return undefined;
    }
    if (name === 'cmd') {
      const k = args.findIndex((w) => /^\/[ck]$/i.test(w.text));
      if (k < 0) {
        info.stdin = true;
        return undefined;
      }
      const rest = args.slice(k + 1);
      if (rest.some((w) => w.subNet)) this.pipe('downloaded text executed by cmd');
      if (rest.length) this.analyze(rest.map((w) => w.text).join(' '), 'cmd', d + 1, true);
      return undefined;
    }
    if (PKG.has(name)) {
      this.pkg(name, args);
      return undefined;
    }
    if (name in NET_HOST_FIRST) {
      this.hostFirst(name, args);
      return undefined;
    }
    if (URL_PROGRAMS.has(name)) {
      let any = false;
      for (const w of args) {
        if (w.text.startsWith('-')) continue;
        const h = urlHost(w.text) ?? bareHost(w.text);
        if (h) {
          this.net(h, urlHost(w.text) ? w.text : undefined);
          any = true;
        }
      }
      if (!any) this.net();
      return undefined;
    }
    if (/^mkfs(\.|$)|^mke2fs$|^mkswap$|^wipefs$|^mkntfs$|^newfs/.test(name)) {
      this.destr(name);
      return undefined;
    }

    switch (name) {
      case 'eval':
        this.evalWords(args, 'posix', d);
        return undefined;
      case 'source': case '.': {
        const f = args[0];
        if (!f) return undefined;
        if (f.text === '/dev/stdin' || f.text === '-') {
          info.stdin = true;
          info.shell = true;
        }
        this.runFile(f);
        return undefined;
      }
      case 'alias':
        for (const w of args) {
          const m = /^([^=\s]+)=(.*)$/s.exec(w.text);
          if (m) this.aliases.set((m[1] as string).toLowerCase(), m[2] as string);
        }
        return undefined;
      case 'export': case 'declare': case 'typeset': case 'local': case 'readonly': {
        const named = args.filter((w) => !w.text.startsWith('-'));
        if (!named.length && (name === 'export' || /[px]/.test(args.map((w) => w.text).join('')))) this.envDump = true;
        for (const w of named) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.text);
          if (m && isStatic(w, this.vars)) this.vars.set(m[1] as string, w.text.slice(m[0].length));
        }
        return undefined;
      }
      case 'printenv':
        if (!args.length) this.envDump = true;
        return undefined;
      case 'set':
        if (!args.length) this.envDump = true;
        return undefined;
      case 'compgen':
        if (texts().some((t) => /^-[a-z]*[ve]/.test(t))) this.envDump = true;
        return undefined;
      case 'find':
        this.find(args, dia, d, ev);
        return undefined;
      case 'rm': case 'unlink': case 'rmdir': {
        const o = getopt(args, '', [], false);
        const targets = o.pos.map((w) => w.text);
        this.deletes.push(...targets);
        if (name === 'rm') {
          const r = /[rR]/.test(o.short) || o.long.has('recursive');
          const f = o.short.includes('f') || o.long.has('force');
          if ((r && f) || o.long.has('no-preserve-root') || (r && targets.some((t) => ROOTISH.test(t)))) this.destr('rm -rf');
        }
        return undefined;
      }
      case 'shred': {
        const o = getopt(args, 'ns', ['iterations', 'size', 'random-source'], false);
        const t = o.pos.map((w) => w.text);
        this.writes.push(...t);
        if (o.short.includes('u') || [...o.long].some((l) => l.startsWith('remove'))) this.deletes.push(...t);
        this.destr('shred');
        return undefined;
      }
      case 'truncate': {
        const o = getopt(args, 'sr', ['size', 'reference'], false);
        this.writes.push(...o.pos.map((w) => w.text));
        if ([...(o.vals.get('s') ?? []), ...(o.vals.get('size') ?? [])].some((v) => /^0+[KMGTPEZY]?(i?B)?$/i.test(v))) this.destr('truncate -s 0');
        return undefined;
      }
      case 'dd':
        for (const w of args) {
          const t = w.text;
          if (t.startsWith('of=')) {
            const p = t.slice(3);
            if (/^\/dev\//.test(p) && !isSink(p)) this.destr('dd to a device');
            else if (!isSink(p)) {
              this.writes.push(p);
              info.outFiles.push(p);
            }
          } else if (t.startsWith('if=') && !/^\/dev\//.test(t.slice(3))) this.reads.push(t.slice(3));
        }
        return undefined;
      case 'chmod': case 'chown': case 'chgrp': {
        const o = getopt(args, '', ['reference', 'from'], false);
        const pos = o.pos.map((w) => w.text);
        const spec = o.long.has('reference') ? undefined : pos.shift();
        this.writes.push(...pos);
        const rec = o.short.includes('R') || o.long.has('recursive');
        if (rec && (pos.some((t) => ROOTISH.test(t)) || (name === 'chmod' && /^(0?777|a\+rwx|ugo\+rwx|\+rwx|o\+w|a\+w)$/.test(spec ?? '')))) this.destr(`${name} -R`);
        return undefined;
      }
      case 'cp': case 'mv': case 'install': case 'ln': {
        const o = getopt(args, name === 'install' ? 'tmogSb' : 'tS', ['target-directory', 'suffix', 'mode', 'owner', 'group'], false);
        const pos = o.pos.map((w) => w.text);
        const dest = o.vals.get('t')?.[0] ?? o.vals.get('target-directory')?.[0] ?? (pos.length > 1 ? pos.pop() : undefined);
        if (dest) this.writes.push(dest);
        if (name === 'mv') this.deletes.push(...pos);
        else if (name !== 'ln') this.reads.push(...pos);
        return undefined;
      }
      case 'touch': case 'mkdir':
        this.writes.push(...getopt(args, name === 'touch' ? 'dtr' : 'm', ['date', 'reference', 'mode', 'context'], false).pos.map((w) => w.text));
        return undefined;
      case 'tee': {
        const t = getopt(args, '', ['output-error'], false).pos.map((w) => w.text).filter((p) => !isSink(p) && p !== '-');
        if (t.length) this.writeRedirection = true;
        this.writes.push(...t);
        info.outFiles.push(...t);
        return undefined;
      }
      case 'sed': {
        const o = getopt(args, 'efl', ['expression', 'file', 'line-length'], false);
        if (o.short.includes('i') || [...o.long].some((l) => l.startsWith('in-place'))) {
          const pos = o.pos.map((w) => w.text);
          if (!o.vals.has('e') && !o.vals.has('expression') && !o.vals.has('f') && !o.vals.has('file')) pos.shift();
          this.writes.push(...pos);
        }
        return undefined;
      }
      case 'cat': case 'head': case 'tail': case 'less': case 'more': case 'strings': case 'od': case 'hexdump':
        this.reads.push(...getopt(args, name === 'head' || name === 'tail' ? 'nc' : '', ['lines', 'bytes'], false).pos.map((w) => w.text).filter((t) => t !== '-'));
        return undefined;
      case 'git':
        this.git(args);
        return undefined;
      case 'curl':
        this.curl(args, info);
        return undefined;
      case 'wget':
        this.wget(args, info);
        return undefined;
      case 'scp': case 'rsync':
        this.copyRemote(name, args);
        return undefined;
      case 'dig': case 'nslookup': case 'host': {
        let any = false;
        for (const w of args) {
          if (w.text.startsWith('-') || w.text.startsWith('+')) continue;
          const h = bareHost(w.text.replace(/^@/, ''));
          if (h) {
            this.net(h);
            any = true;
          }
        }
        if (any || name !== 'host') this.net();
        return undefined;
      }
      case 'socat': {
        this.net();
        for (const t of texts()) {
          const m = /^(?:tcp[46]?(?:-connect)?|udp[46]?(?:-connect)?|openssl(?:-connect)?|ssl|socks4a?|proxy):([^:,]+)/i.exec(t);
          if (m) this.net((m[1] as string).toLowerCase());
          if (/^(exec|system):/i.test(t)) this.pipe('socat connects the network to a program');
        }
        return undefined;
      }
      case 'openssl': {
        const t = texts();
        if (t[0] === 's_client') {
          const c = t[t.indexOf('-connect') + 1];
          this.net(c && t.includes('-connect') ? anyHost(c) : undefined);
        } else if (t[0] === 's_server') this.net();
        if ((t[0] === 'enc' || t[0] === 'base64') && t.includes('-d')) this.dec();
        return undefined;
      }
      case 'base64': case 'base32': case 'basenc': {
        const o = getopt(args, 'w', ['wrap'], false);
        if (/[dD]/.test(o.short) || o.long.has('decode')) {
          this.dec();
          info.b64 = name === 'base64';
        }
        return undefined;
      }
      case 'xxd':
        if (texts().some((t) => /^-[a-z]*r/.test(t) || t === '-revert')) this.dec();
        return undefined;
      case 'uudecode': case 'rev': case 'gunzip': case 'zcat': case 'bunzip2': case 'bzcat': case 'unxz': case 'xzcat': case 'zstdcat': case 'unzstd':
        this.dec();
        return undefined;
      case 'gzip': case 'bzip2': case 'xz': case 'zstd':
        if (texts().some((t) => /^-[a-z]*d/.test(t) || t === '--decompress' || t === '--uncompress')) this.dec();
        return undefined;
      case 'tr':
        if (texts().some((t) => /n-za-m|N-ZA-M/.test(t))) this.dec();
        return undefined;
      case 'printf': {
        const fmt = args.find((w, k) => !w.text.startsWith('-') && args[k - 1]?.text !== '-v');
        if (fmt && (fmt.hex || /\\x[0-9a-f]|\\[0-7]{3}|\\u[0-9a-f]{4}/i.test(fmt.text))) this.dec();
        if (args.every((w) => isStatic(w, this.vars))) info.literal = args.map((w) => w.text).join(' ');
        return undefined;
      }
      case 'echo': {
        let k = 0;
        let e = false;
        while (k < args.length && /^-[neE]+$/.test((args[k] as Word).text)) e = e || (args[k++] as Word).text.includes('e');
        const rest = args.slice(k);
        if (rest.some((w) => w.hex) || (e && rest.some((w) => /\\x[0-9a-f]|\\0?[0-7]{3}/i.test(w.text)))) this.dec();
        if (rest.every((w) => isStatic(w, this.vars))) info.literal = rest.map((w) => w.text).join(' ');
        return undefined;
      }
      case 'certutil': {
        const low = texts().map((t) => t.toLowerCase());
        if (low.some((t) => /^[-/]decode(hex)?$/.test(t))) this.dec();
        if (low.some((t) => /^[-/](urlcache|verifyctl)$/.test(t)) || low.some((t) => urlHost(t))) {
          for (const t of texts()) if (urlHost(t)) this.net(urlHost(t), t);
          this.net();
        }
        return undefined;
      }
      case 'bitsadmin': {
        for (const t of texts()) if (urlHost(t)) this.net(urlHost(t), t);
        if (texts().some((t) => /^\/(transfer|addfile)$/i.test(t))) this.net();
        return undefined;
      }
      case 'format':
        if (args.some((w) => /^[a-z]:\\?$/i.test(w.text))) this.destr('format');
        return undefined;
      case 'diskpart':
        this.destr('diskpart');
        return undefined;
      case 'diskutil':
        if (texts().some((t) => /^(erase|zero|randomize|secureErase|partitionDisk|reformat)/i.test(t))) this.destr('diskutil erase');
        return undefined;
      case 'vssadmin': case 'wbadmin':
        if (texts().some((t) => t.toLowerCase() === 'delete')) this.destr(`${name} delete`);
        return undefined;
      case 'cipher':
        if (texts().some((t) => /^\/w/i.test(t))) this.destr('cipher /w');
        return undefined;
    }
    return undefined;
  }

  private shell(args: Word[], d: number, info: StageInfo, redirs: Redirect[]): void {
    let hasC = false;
    let hasS = false;
    let k = 0;
    for (; k < args.length; k++) {
      const t = (args[k] as Word).text;
      if (t === '--' || t === '-') {
        k++;
        break;
      }
      if (t === '--rcfile' || t === '--init-file') {
        k++;
        continue;
      }
      if (t === '--command') {
        hasC = true;
        continue;
      }
      if (t.startsWith('--')) continue;
      if (/^[-+][A-Za-z]+$/.test(t)) {
        if (t[0] === '-' && t.includes('c')) hasC = true;
        if (t[0] === '-' && t.includes('s')) hasS = true;
        if (/[oO]/.test(t.slice(1))) k++;
        continue;
      }
      break;
    }
    const first = args[k];
    if (hasC && first) {
      this.inline(first, 'posix', d);
      return;
    }
    if (first && !hasS) {
      this.runFile(first);
      return;
    }
    info.stdin = true;
    info.shell = true;
    this.feedBodies(redirs, d);
  }

  private scriptInterp(name: string, args: Word[], d: number, info: StageInfo, redirs: Redirect[]): void {
    const isPy = /^(python|py|pypy)/.test(name);
    const codeFlags = isPy ? ['-c'] : name === 'php' ? ['-r'] : name.startsWith('node') ? ['-e', '--eval', '-p', '--print'] : ['-e', '-E'];
    const valFlags = isPy ? ['-W', '-X', '-Q'] : name.startsWith('node') ? ['-r', '--require', '--import', '--loader'] : name === 'ruby' ? ['-r', '-I', '-C'] : name === 'php' ? ['-d', '-c', '-t', '-f', '-z'] : ['-I'];
    const codes: Word[] = [];
    let module: string | undefined;
    let file: Word | undefined;
    let stdinDash = false;
    let k = 0;
    for (; k < args.length; k++) {
      const t = (args[k] as Word).text;
      if (t === '-') {
        stdinDash = true;
        break;
      }
      if (t === '--') {
        file = args[k + 1];
        break;
      }
      if (isPy && t === '-m') {
        module = args[++k]?.text;
        k++;
        break;
      }
      if (isPy && /^-m./.test(t)) {
        module = t.slice(2);
        k++;
        break;
      }
      if (name === 'php' && t === '-S') {
        const v = args[++k]?.text;
        this.net(v ? anyHost(v) : undefined);
        continue;
      }
      if (codeFlags.includes(t) || (isPy && /^-[A-Za-z]*c$/.test(t)) || ((name === 'perl' || name === 'ruby') && /^-[A-Za-z]*[eE]$/.test(t))) {
        const c = args[++k];
        if (c) codes.push(c);
        if (isPy || name === 'php') break;
        continue;
      }
      if (valFlags.includes(t)) {
        k++;
        continue;
      }
      if (t.startsWith('-')) continue;
      file = args[k];
      break;
    }
    if (module !== undefined) {
      if (/^(http\.server|SimpleHTTPServer|CGIHTTPServer|smtpd|pyftpdlib|aiosmtpd)$/.test(module)) {
        this.net();
        this.why(`network: python -m ${module}`);
      }
      if (module === 'pip') this.pkg('pip', args.slice(k));
      return;
    }
    for (const c of codes) {
      if (c.subNet) this.pipe('downloaded code executed inline');
      this.code(c.text, d);
    }
    if (codes.length) return;
    if (file && !stdinDash) {
      this.runFile(file);
      return;
    }
    info.stdin = true;
    for (const r of redirs) if (r.body !== undefined) this.code(r.body, d);
  }

  /** Inline interpreter code (python -c, node -e…): URLs, network APIs, shell-outs, decode-and-exec. */
  private code(text: string, d: number): void {
    this.texts.push(text);
    for (const m of text.matchAll(URL_RE)) if (!/^file:/i.test(m[0])) this.net(urlHost(m[0]), m[0]);
    if (/\b(urllib|requests\.(get|post|put|request|Session)|http\.client|socket\.socket|socket\.create_connection|fetch\(|https?\.(get|request)\(|Net::HTTP|LWP::|IO::Socket|open-uri|TCPSocket|curl_init|fsockopen|XMLHttpRequest|WebSocket)/.test(text)) this.net();
    if (/b64decode|base64\.decodebytes|atob\(|Buffer\.from\([^)]*['"]base64['"]|decode_base64|unpack\(\s*['"]m|base64_decode|codecs\.decode/i.test(text) && /\b(exec|eval|system|popen|spawn|execSync|subprocess|compile)\b/.test(text)) this.obf('decodes and executes code');
    for (const m of text.matchAll(/\b(?:os\.system|os\.popen|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|system|execSync|spawnSync|popen|shell_exec|passthru|proc_open)\s*\(\s*[rbfu]?(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      this.analyze((m[2] as string).replace(/\\(["'\\`])/g, '$1'), 'posix', d + 1, true);
    }
  }

  private powershell(args: Word[], d: number, info: StageInfo): void {
    const valueOpts = /^-(executionpolicy|ep|ex|file|f|windowstyle|w|configurationname|workingdirectory|wd|version|v|outputformat|of|o|inputformat|if|psconsolefile|settingsfile|custompipename|encodedarguments|ea)$/i;
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as Word;
      const t = w.text;
      if (/^[-/](c|co|com|comm|comma|comman|command)$/i.test(t)) {
        const rest = args.slice(k + 1);
        if (rest.length === 1 && rest[0]?.text === '-') {
          info.stdin = true;
          return;
        }
        if (rest.some((x) => x.subNet)) this.pipe('downloaded text executed by PowerShell');
        if (rest.length) this.analyze(rest.map((x) => x.text).join(' '), 'powershell', d + 1, true);
        return;
      }
      if (/^[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/i.test(t)) {
        const v = args[k + 1]?.text ?? '';
        this.obf('PowerShell -EncodedCommand');
        let decoded = '';
        try {
          decoded = Buffer.from(v, 'base64').toString('utf16le');
        } catch {
          decoded = '';
        }
        if (decoded) this.analyze(decoded, 'powershell', d + 1, true);
        return;
      }
      if (/^[-/](file|f)$/i.test(t)) {
        const f = args[k + 1];
        if (f) this.runFile(f);
        return;
      }
      if (valueOpts.test(t)) {
        k++;
        continue;
      }
      if (/^[-/]/.test(t) && !w.quoted) continue;
      const rest = args.slice(k);
      if (/\.ps1$/i.test(t)) {
        this.runFile(w);
        return;
      }
      this.analyze(rest.map((x) => x.text).join(' '), 'powershell', d + 1, true);
      return;
    }
    info.stdin = true;
  }

  private psCmd(canon: string, args: Word[], d: number, info: StageInfo): Word[] | undefined | false {
    switch (canon) {
      case 'remove-item': {
        const p = psArgs(args, ['path', 'literalpath', 'filter', 'include', 'exclude', 'credential', 'stream'], ['recurse', 'force', 'confirm', 'whatif']);
        this.deletes.push(...p.pos, ...(p.named.get('path') ?? []), ...(p.named.get('literalpath') ?? []));
        const posixRf = [...p.sw].some((s) => /^[a-z]+$/.test(s) && s.includes('r') && s.includes('f') && s.length <= 3);
        if ((p.sw.has('recurse') && p.sw.has('force')) || posixRf) this.destr('Remove-Item -Recurse -Force');
        return undefined;
      }
      case 'invoke-webrequest': case 'invoke-restmethod': case 'start-bitstransfer': {
        const p = psArgs(
          args,
          ['uri', 'outfile', 'method', 'body', 'headers', 'infile', 'source', 'destination', 'proxy', 'credential', 'contenttype', 'useragent', 'websession', 'sessionvariable', 'timeoutsec', 'maximumredirection', 'certificate', 'form', 'token', 'authentication'],
          ['usebasicparsing', 'passthru', 'usedefaultcredentials', 'skipcertificatecheck'],
        );
        let any = false;
        for (const t of [...p.pos, ...(p.named.get('uri') ?? []), ...(p.named.get('source') ?? []), ...(p.named.get('proxy') ?? [])]) {
          const h = urlHost(t) ?? bareHost(t);
          if (h) {
            this.net(h, urlHost(t) ? t : undefined);
            any = true;
          }
        }
        if (!any) this.net();
        for (const f of [...(p.named.get('outfile') ?? []), ...(p.named.get('destination') ?? [])]) {
          this.writes.push(f);
          info.outFiles.push(f);
        }
        this.reads.push(...(p.named.get('infile') ?? []));
        return undefined;
      }
      case 'invoke-expression': {
        if (!args.length) {
          info.stdin = true;
          return undefined;
        }
        const cmdArg = args.findIndex((w) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w.text));
        this.evalWords(cmdArg >= 0 ? args.slice(cmdArg + 1) : args, 'powershell', d);
        return undefined;
      }
      case 'new-object':
        if (args.some((w) => /net\.(webclient|sockets\.(tcp|udp)client|http\.httpclient)/i.test(w.text))) this.net();
        return undefined;
      case 'start-process': {
        const p = psArgs(args, ['filepath', 'argumentlist', 'workingdirectory', 'verb', 'redirectstandardoutput', 'redirectstandardinput', 'redirectstandarderror', 'credential', 'windowstyle'], ['wait', 'nonewwindow', 'passthru', 'loaduserprofile', 'usenewenvironment']);
        const file = p.named.get('filepath')?.[0] ?? p.pos[0];
        const al = p.named.get('argumentlist') ?? p.pos.slice(1);
        if (file) this.analyze(`& '${file.replace(/'/g, "''")}' ${al.join(' ').replace(/,/g, ' ')}`, 'powershell', d + 1, true);
        return undefined;
      }
      case 'invoke-command': {
        const p = psArgs(args, ['computername', 'scriptblock', 'filepath', 'argumentlist', 'credential', 'session', 'port'], ['asjob', 'usessl']);
        for (const h of p.named.get('computername') ?? []) this.net(h.toLowerCase());
        return undefined;
      }
      case 'set-content': case 'add-content': case 'out-file': case 'new-item': case 'clear-content': case 'tee-object': {
        const p = psArgs(args, ['path', 'literalpath', 'filepath', 'value', 'encoding', 'itemtype', 'name', 'inputobject', 'variable', 'width'], ['force', 'append', 'nonewline', 'passthru', 'noclobber']);
        const t = p.named.get('path')?.[0] ?? p.named.get('filepath')?.[0] ?? p.named.get('literalpath')?.[0] ?? p.pos[0];
        if (t && !isSink(t)) {
          this.writes.push(t);
          info.outFiles.push(t);
          if (canon === 'tee-object') this.writeRedirection = true;
        }
        return undefined;
      }
      case 'copy-item': case 'move-item': case 'rename-item': {
        const p = psArgs(args, ['path', 'literalpath', 'destination', 'newname', 'filter', 'include', 'exclude', 'credential'], ['recurse', 'force', 'container', 'passthru']);
        const dest = p.named.get('destination')?.[0] ?? p.named.get('newname')?.[0] ?? p.pos[1];
        const src = p.named.get('path')?.[0] ?? p.named.get('literalpath')?.[0] ?? p.pos[0];
        if (dest) this.writes.push(dest);
        if (src) (canon === 'copy-item' ? this.reads : this.deletes).push(src);
        return undefined;
      }
      case 'get-content': {
        const p = psArgs(args, ['path', 'literalpath', 'totalcount', 'tail', 'encoding', 'delimiter', 'readcount', 'stream'], ['raw', 'wait']);
        const t = [...p.pos, ...(p.named.get('path') ?? []), ...(p.named.get('literalpath') ?? [])];
        if (t.some((x) => /^env:/i.test(x))) this.envDump = true;
        this.reads.push(...t.filter((x) => !/^env:/i.test(x)));
        return undefined;
      }
      case 'get-childitem': case 'get-item':
        if (args.some((w) => /^env:\\?\*?$/i.test(w.text))) this.envDump = true;
        return undefined;
      case 'format-volume': case 'clear-disk': case 'initialize-disk': case 'remove-partition':
        this.destr(canon);
        return undefined;
    }
    return false;
  }

  private cmdBuiltin(name: string, args: Word[], d: number): Word[] | undefined | false {
    const r = args.map((w) => w.text);
    const low = r.map((t) => t.toLowerCase());
    const sw = (x: string): boolean => low.some((t) => t === x || t.startsWith(x + ':'));
    const targets = r.filter((t) => !t.startsWith('/'));
    const tail = (rest: Word[]): Word[] | undefined => {
      const t = rest.map((w) => w.text).join(' ').trim();
      if (t.startsWith('(')) {
        this.analyze(t.replace(/^\(|\)$/g, ''), 'cmd', d + 1, false);
        return undefined;
      }
      return rest;
    };
    switch (name) {
      case 'del': case 'erase':
        this.deletes.push(...targets);
        if (sw('/s') && (sw('/q') || sw('/f'))) this.destr('del /s /q');
        return undefined;
      case 'rd': case 'rmdir':
        this.deletes.push(...targets);
        if (sw('/s') && sw('/q')) this.destr('rd /s /q');
        return undefined;
      case 'copy': case 'move': case 'xcopy': case 'robocopy':
        if (targets.length > 1) this.writes.push(targets[targets.length - 1] as string);
        if (name === 'move') this.deletes.push(...targets.slice(0, -1));
        return undefined;
      case 'type':
        this.reads.push(...targets);
        return undefined;
      case 'set':
        if (!args.length) this.envDump = true;
        return undefined;
      case 'call':
        return args;
      case 'start': {
        let k = 0;
        if (args[0]?.quoted) k++;
        while (k < args.length && (args[k] as Word).text.startsWith('/')) k += /^\/d$/i.test((args[k] as Word).text) ? 2 : 1;
        return args.slice(k);
      }
      case 'if': {
        let k = 0;
        if (low[k] === '/i') k++;
        if (low[k] === 'not') k++;
        if (low[k] === 'exist' || low[k] === 'defined' || low[k] === 'errorlevel' || low[k] === 'cmdextversion') k += 2;
        else if (r[k]?.includes('==')) k++;
        else k += 3;
        return tail(args.slice(k));
      }
      case 'for': {
        const k = low.indexOf('do');
        return k >= 0 ? tail(args.slice(k + 1)) : undefined;
      }
    }
    return false;
  }

  private find(args: Word[], dia: Dialect, d: number, ev: boolean): void {
    let k = 0;
    while (k < args.length && /^-(H|L|P|O\d*|D)$/.test((args[k] as Word).text)) k += (args[k] as Word).text === '-D' ? 2 : 1;
    const roots: string[] = [];
    while (k < args.length && !/^[-(!)]/.test((args[k] as Word).text)) roots.push((args[k++] as Word).text);
    for (; k < args.length; k++) {
      const t = (args[k] as Word).text;
      if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
        const start = ++k;
        while (k < args.length && (args[k] as Word).text !== ';' && (args[k] as Word).text !== '+') k++;
        this.argv(args.slice(start, k), dia, d + 1, ev, freshInfo(), []);
      } else if (t === '-delete') {
        this.destr('find -delete');
        this.deletes.push(...(roots.length ? roots : ['.']));
      } else if (t === '-fprint' || t === '-fprint0' || t === '-fprintf' || t === '-fls') {
        const f = args[++k]?.text;
        if (f) this.writes.push(f);
      }
    }
  }

  private git(args: Word[]): void {
    let k = 0;
    for (; k < args.length; k++) {
      const t = (args[k] as Word).text;
      if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--config-env') {
        k++;
        continue;
      }
      if (t.startsWith('-')) continue;
      break;
    }
    const sub = args[k]?.text;
    const rest = args.slice(k + 1);
    switch (sub) {
      case 'reset':
        if (rest.some((w) => w.text === '--hard')) this.destr('git reset --hard');
        return;
      case 'clean': {
        const o = getopt(rest, 'e', ['exclude'], false);
        if (o.short.includes('f') || o.long.has('force')) this.destr('git clean -f');
        return;
      }
      case 'push': {
        const o = getopt(rest, 'o', ['repo', 'receive-pack', 'exec', 'push-option'], false);
        if (o.long.has('force') || o.long.has('force-with-lease') || o.long.has('mirror') || o.long.has('delete') || o.long.has('prune') || /[fd]/.test(o.short)) this.destr('git push --force/--delete');
        const pos = o.pos.map((w) => w.text);
        if (pos.slice(1).some((p) => p.startsWith('+') || (p.startsWith(':') && p.length > 1))) this.destr('git push +refspec / :delete');
        for (const r of [pos[0], ...(o.vals.get('repo') ?? [])]) if (r) this.gitRemote(r);
        return;
      }
      case 'clone': case 'fetch': case 'pull': case 'ls-remote': case 'submodule': case 'remote': case 'archive':
        for (const w of rest) this.gitRemote(w.text.replace(/^--remote=/, ''));
        return;
    }
  }

  private gitRemote(t: string): void {
    if (/^file:/i.test(t) || t.startsWith('-')) return;
    const h = remoteHost(t);
    if (h && (urlHost(t) || t.includes('@') || h.includes('.'))) this.net(h, urlHost(t) ? t : undefined);
  }

  private curl(args: Word[], info: StageInfo): void {
    const o = getopt(
      args,
      'dHoXuAeFTxbcKmwrECUYyzQP',
      ['data', 'data-raw', 'data-binary', 'data-urlencode', 'data-ascii', 'header', 'output', 'request', 'user', 'user-agent', 'referer', 'form', 'form-string', 'upload-file', 'proxy',
        'cookie', 'cookie-jar', 'config', 'max-time', 'connect-timeout', 'write-out', 'range', 'cert', 'key', 'cacert', 'capath', 'resolve', 'connect-to', 'url', 'retry', 'retry-delay',
        'retry-max-time', 'limit-rate', 'max-filesize', 'interface', 'dns-servers', 'doh-url', 'proxy-user', 'oauth2-bearer', 'json', 'output-dir', 'unix-socket', 'local-port', 'aws-sigv4', 'variable', 'max-redirs'],
      false,
    );
    const urls = [...o.pos.map((w) => w.text), ...(o.vals.get('url') ?? [])];
    let any = false;
    for (const t of urls) {
      if (/^file:/i.test(t)) {
        this.reads.push(t.replace(/^file:\/\//i, ''));
        continue;
      }
      const u = urlHost(t);
      const h = u ?? bareHost(t);
      if (h) {
        this.net(h, u ? t : undefined);
        any = true;
      }
    }
    for (const p of [...(o.vals.get('x') ?? []), ...(o.vals.get('proxy') ?? [])]) this.net(urlHost(p) ?? bareHost(p));
    const meta = !urls.length && (o.long.has('version') || o.long.has('help') || /[Vh]/.test(o.short));
    const localOnly = urls.length > 0 && urls.every((t) => /^file:/i.test(t));
    if (!any && !meta && !localOnly) this.net();
    for (const f of [...(o.vals.get('o') ?? []), ...(o.vals.get('output') ?? [])]) {
      if (f === '-') continue;
      this.writes.push(f);
      info.outFiles.push(f);
    }
    if (o.short.includes('O') || o.long.has('remote-name')) {
      for (const t of urls) {
        const n = (t.split(/[?#]/)[0] ?? '').split('/').pop();
        if (n) info.outFiles.push(n);
      }
    }
    for (const key of ['d', 'data', 'data-binary', 'data-urlencode', 'data-ascii', 'F', 'form', 'json']) {
      for (const v of o.vals.get(key) ?? []) {
        const m = /(?:^|=)[@<]([^;]+)/.exec(v) ?? (key === 'data-urlencode' ? /^[^=]*@(.+)$/.exec(v) : null);
        if (m && m[1] !== '-') this.reads.push(m[1] as string);
      }
    }
    this.reads.push(...(o.vals.get('T') ?? []), ...(o.vals.get('upload-file') ?? []));
  }

  private wget(args: Word[], info: StageInfo): void {
    const o = getopt(
      args,
      'OoaiPeUtTwQlARDIXB',
      ['output-document', 'output-file', 'append-output', 'input-file', 'directory-prefix', 'execute', 'user-agent', 'tries', 'timeout', 'wait', 'header', 'post-data', 'post-file', 'body-data',
        'body-file', 'user', 'password', 'http-user', 'http-password', 'referer', 'load-cookies', 'save-cookies', 'method', 'level', 'accept', 'reject', 'domains', 'exclude-domains', 'base',
        'config', 'ca-certificate', 'certificate', 'private-key', 'limit-rate', 'quota', 'read-timeout', 'dns-timeout', 'connect-timeout', 'bind-address'],
      false,
    );
    const urls = o.pos.map((w) => w.text);
    let any = false;
    for (const t of urls) {
      const u = urlHost(t);
      const h = u ?? bareHost(t);
      if (h) {
        this.net(h, u ? t : undefined);
        any = true;
      }
    }
    if (!any) this.net();
    const out = [...(o.vals.get('O') ?? []), ...(o.vals.get('output-document') ?? [])];
    for (const f of out) {
      if (f === '-') continue;
      this.writes.push(f);
      info.outFiles.push(f);
    }
    if (!out.length) for (const t of urls) {
      const n = (t.split(/[?#]/)[0] ?? '').split('/').pop();
      if (n) info.outFiles.push(n);
    }
    this.reads.push(...(o.vals.get('post-file') ?? []), ...(o.vals.get('body-file') ?? []), ...(o.vals.get('i') ?? []), ...(o.vals.get('input-file') ?? []));
  }

  private hostFirst(name: string, args: Word[]): void {
    const o = getopt(args, NET_HOST_FIRST[name] as string, [], false);
    if ((name === 'nc' || name === 'ncat' || name === 'netcat') && (o.vals.has('e') || o.vals.has('c') || o.long.has('exec') || o.long.has('sh-exec'))) this.pipe(`${name} runs a program for the remote end`);
    for (const j of o.vals.get('J') ?? []) for (const h of j.split(',')) this.net(anyHost(h));
    const first = o.pos[0]?.text;
    this.net(first !== undefined ? anyHost(first) : undefined);
  }

  private copyRemote(name: string, args: Word[]): void {
    const o =
      name === 'scp'
        ? getopt(args, 'cFiJloPSD', [], false)
        : getopt(args, 'eTBfM', ['rsh', 'filter', 'exclude', 'include', 'exclude-from', 'include-from', 'files-from', 'password-file', 'port', 'temp-dir', 'log-file', 'backup-dir', 'suffix', 'chmod',
            'chown', 'block-size', 'max-size', 'min-size', 'bwlimit', 'timeout', 'contimeout', 'partial-dir', 'compare-dest', 'copy-dest', 'link-dest', 'out-format', 'info', 'debug', 'usermap',
            'groupmap', 'iconv', 'sockopts', 'address', 'protocol', 'skip-compress', 'remote-option', 'rsync-path', 'log-file-format', 'modify-window', 'max-delete'], false);
    for (const j of o.vals.get('J') ?? []) this.net(anyHost(j));
    const pos = o.pos.map((w) => w.text);
    pos.forEach((t, idx) => {
      const h = remoteHost(t);
      if (h) this.net(h, urlHost(t) ? t : undefined);
      else if (idx === pos.length - 1 && pos.length > 1) this.writes.push(t);
      else this.reads.push(t);
    });
  }

  private pkg(name: string, args: Word[]): void {
    const texts = args.map((w) => w.text);
    for (const t of texts) {
      const v = t.replace(/^--?[\w-]+=/, '').replace(/^[\w.-]+\s*@\s*(?=[a-z+]+:\/\/)/i, '').replace(/^git\+/, '');
      const u = urlHost(v);
      if (u && !/^file:/i.test(v)) this.net(u, v);
      else {
        const m = /^git@([\w.-]+):/.exec(v);
        if (m) this.net((m[1] as string).toLowerCase());
      }
    }
    if (name === 'go' && /^(get|install|run|mod)$/.test(texts[0] ?? '')) {
      for (const t of texts.slice(1)) {
        const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i.exec(t);
        if (m) this.net((m[1] as string).toLowerCase());
      }
    }
  }

  result(): ShellAnalysis {
    const clean = (a: string[]): string[] => [...new Set(a.filter((p) => p !== '' && p !== '{}' && p !== '-'))];
    const out: ShellAnalysis = {
      programs: this.programs,
      destructive: this.destructive,
      network: this.network,
      hosts: this.hosts,
      urls: this.urls,
      obfuscated: this.obfuscated,
      pipeToShell: this.pipeToShell,
      writeRedirection: this.writeRedirection,
      writes: clean(this.writes),
      deletes: clean(this.deletes),
      reads: clean(this.reads),
      envVars: envVarsOf(this.texts, this.cmdTexts),
      envDump: this.envDump || this.texts.some((t) => ENV_DUMP.test(t)),
      heredoc: this.heredoc,
      dynamicProgram: this.dynamicProgram,
      reasons: this.reasons,
    };
    if (this.program !== undefined) out.program = this.program;
    if (this.parseError !== undefined) out.parseError = this.parseError;
    return out;
  }
}

function envVarsOf(texts: string[], cmdTexts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t.includes('$') && !/environ|printenv|process\.env|ENV|getenv|GetEnvironment/i.test(t)) continue;
    for (const m of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const n = m[1] as string;
      if (n.toLowerCase() === 'env' && t[(m.index ?? 0) + m[0].length] === ':') continue;
      out.add(n);
    }
    for (const m of t.matchAll(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)/gi)) out.add(m[1] as string);
    for (const re of EXTRA_ENV) for (const m of t.matchAll(re)) out.add(m[1] as string);
  }
  for (const t of cmdTexts) for (const m of t.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%|!([A-Za-z_][A-Za-z0-9_]*)!/g)) out.add((m[1] ?? m[2]) as string);
  return [...out].filter((n) => !n.startsWith('__'));
}

/** Analyze a shell command line. Never throws. */
export function analyzeShell(command: string, dialect: Dialect = 'posix'): ShellAnalysis {
  const a = new Analyzer();
  try {
    a.analyze(command, dialect, 0, false);
  } catch (e) {
    a.fail(e instanceof Error ? e.message : String(e), command.slice(0, MAX_INPUT));
  }
  return a.result();
}

/** Quote one argv element so the joined string re-parses to the same argv (POSIX rules). */
export function quoteArg(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
