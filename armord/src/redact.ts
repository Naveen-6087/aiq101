// Secret redaction for tool results on their way to the model. Pattern-based and conservative:
// it targets well-known credential shapes, not "anything that looks random".

const PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['aws-secret', /(aws_secret_access_key\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40}["']?/gi],
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['armoriq-key', /\bak_(live|test)_[A-Za-z0-9]{16,}\b/g],
];

export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [label, re] of PATTERNS) {
    out = out.replace(re, (match: string, prefix?: string) => {
      count++;
      // keep an `aws_secret_access_key=` style prefix so the shape of the file stays readable
      return label === 'aws-secret' && typeof prefix === 'string' ? `${prefix}[REDACTED:${label}]` : `[REDACTED:${label}]`;
    });
  }
  return { text: out, count };
}

/** Redact every string inside a JSON value. */
export function redact<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: out, count };
}
