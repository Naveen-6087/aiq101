// A small, dependency free copy of the two plugins' policy matching, so the pack can be
// tested before either plugin is installed. It mirrors, as closely as we could read them:
//
//   ArmorClaude 0.2.9 (armoriq/armorClaude @ 3195800)
//     scripts/lib/policy-ir.mjs   validatePolicyIr, parseBashCommand, conditionValue,
//                                 conditionMatches, evaluatePolicyIr (deny overrides)
//     scripts/lib/engine.mjs      require_approval -> Claude Code's native "ask" prompt (HELD)
//   ArmorCodex 0.3.2 (armoriq/armorCodex @ 443af85)
//     plugins/armorcodex/scripts/lib/policy.mjs   evaluatePolicy (first match wins, default allow)
//     plugins/armorcodex/scripts/lib/common.mjs   matchesScalar, matchParams, matchesAnyStringField
//     plugins/armorcodex/scripts/lib/engine.mjs   any !allowed decision -> PreToolUse deny
//
// What it leaves out: intent plan checks, crypto policy binding, the protected policy file
// guard, data class detection, and OPA mode. Those run in the real plugins around this step.

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- ArmorClaude (armor.policy.v1)

const EFFECTS = new Set(['permit', 'forbid', 'require_approval']);
const DEFAULT_DECISIONS = new Set(['allow', 'deny', 'hold']);
const PRINCIPAL_TYPES = new Set(['agent', 'user', 'org', 'role']);
const ACTION_TYPES = new Set(['tool', 'mcp_server', 'mcp_tool', 'bash_program']);
const RESOURCE_TYPES = new Set(['workspace', 'file', 'directory', 'network', 'mcp_server', 'secret']);
const CONDITION_FIELDS = new Set(['tool.name', 'bash.program', 'bash.raw', 'bash.hasWriteRedirection', 'file.path', 'network.host', 'mcp.server']);
const CONDITION_OPS = new Set(['eq', 'in', 'not_in', 'matches', 'not_matches', 'starts_with', 'within_workspace']);
const KNOWN_TOOLS = new Set([
  '*', 'Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterPlanMode',
  'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Explore', 'Glob', 'Grep', 'ListMcpResourcesTool', 'LSP',
  'Monitor', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'PowerShell', 'PushNotification', 'Read',
  'ReadMcpResourceTool', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage', 'ShareOnboardingGuide', 'Skill',
  'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate', 'TeamCreate',
  'TeamDelete', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
]);

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const actionValues = (a) => (typeof a?.eq === 'string' ? [a.eq] : Array.isArray(a?.in) ? a.in : []);

// Same checks ArmorClaude runs on `/armorclaude:armor policy stage <json>` (validatePolicyIr).
export function validateClaudePolicy(p) {
  const errors = [];
  const extra = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));
  if (!isPlainObject(p)) return ['Policy must be a JSON object'];
  if (extra(p, ['schemaVersion', 'kind', 'metadata', 'defaults', 'statements']).length) errors.push('unknown root field');
  if (p.schemaVersion !== 'armor.policy.v1') errors.push('schemaVersion must be armor.policy.v1');
  if (p.kind !== 'PolicyProfile') errors.push('kind must be PolicyProfile');
  if (!isPlainObject(p.metadata)) errors.push('metadata must be an object');
  if (!isPlainObject(p.defaults)) errors.push('defaults must be an object');
  else {
    if (!DEFAULT_DECISIONS.has(p.defaults.decision)) errors.push('defaults.decision must be allow, deny, or hold');
    if (p.defaults.conflictResolution !== 'deny_overrides') errors.push('defaults.conflictResolution must be deny_overrides');
  }
  if (!Array.isArray(p.statements)) return [...errors, 'statements must be an array'];
  const seen = new Set();
  p.statements.forEach((s, i) => {
    const at = `statements[${i}]`;
    if (!isPlainObject(s)) return errors.push(`${at} must be an object`);
    if (extra(s, ['id', 'effect', 'principal', 'action', 'resource', 'conditions']).length) errors.push(`${at} unknown field`);
    if (typeof s.id !== 'string' || !s.id.trim()) errors.push(`${at}.id is required`);
    if (seen.has(s.id)) errors.push(`duplicate statement id ${s.id}`);
    seen.add(s.id);
    if (!EFFECTS.has(s.effect)) errors.push(`${at}.effect is invalid`);
    if (!isPlainObject(s.principal) || !PRINCIPAL_TYPES.has(s.principal.type) || !s.principal.id) errors.push(`${at}.principal is invalid`);
    if (!isPlainObject(s.action) || !ACTION_TYPES.has(s.action.type) || (!s.action.eq && !s.action.in)) errors.push(`${at}.action is invalid`);
    else if (s.action.type === 'tool') {
      for (const t of actionValues(s.action)) if (!KNOWN_TOOLS.has(t)) errors.push(`unknown tool in ${at}: ${t}`);
    }
    if (!isPlainObject(s.resource) || !RESOURCE_TYPES.has(s.resource.type)) errors.push(`${at}.resource is invalid`);
    if (!Array.isArray(s.conditions)) errors.push(`${at}.conditions must be an array`);
    else s.conditions.forEach((c, j) => {
      if (!CONDITION_FIELDS.has(c?.field)) errors.push(`${at}.conditions[${j}] unknown field ${c?.field}`);
      if (!CONDITION_OPS.has(c?.op)) errors.push(`${at}.conditions[${j}] unknown op ${c?.op}`);
      if ((c?.op === 'matches' || c?.op === 'not_matches') && typeof c.value === 'string') {
        try { new RegExp(c.value); } catch (e) { errors.push(`${at}.conditions[${j}] bad regex: ${e.message}`); }
      }
    });
  });
  return errors;
}

export function parseBashCommand(command) {
  const raw = typeof command === 'string' ? command.trim() : '';
  const withoutEnv = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '');
  const program = withoutEnv.split(/\s+/)[0] || '';
  return {
    raw,
    program: program.replace(/^["'`]+|["'`]+$/g, ''),
    hasWriteRedirection: /(^|[^<])>{1,2}|\btee\b|\bsed\s+-i\b|\btruncate\b|\bdd\b/.test(raw),
  };
}

function conditionValue(field, toolName, params = {}) {
  const bash = parseBashCommand(params.command || '');
  if (field === 'tool.name') return toolName;
  if (field === 'bash.program') return bash.program;
  if (field === 'bash.raw') return bash.raw;
  if (field === 'bash.hasWriteRedirection') return bash.hasWriteRedirection;
  if (field === 'file.path') return params.file_path || params.path || '';
  if (field === 'network.host') {
    try {
      const url = params.url || String(params.command || '').match(/https?:\/\/[^\s'"]+/)?.[0] || '';
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  }
  if (field === 'mcp.server') return String(toolName).split('__')[1] || '';
  return undefined;
}

function conditionMatches(c, toolName, params) {
  const actual = conditionValue(c.field, toolName, params);
  const expected = c.value;
  switch (c.op) {
    case 'eq': return actual === expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
    case 'matches': return typeof expected === 'string' && new RegExp(expected).test(String(actual));
    case 'not_matches': return typeof expected === 'string' && !new RegExp(expected).test(String(actual));
    case 'starts_with': return typeof expected === 'string' && String(actual).startsWith(expected);
    // ArmorClaude ignores `value` here: true for relative paths without "..".
    case 'within_workspace': return typeof actual === 'string' && !actual.startsWith('/') && !actual.includes('..');
    default: return false;
  }
}

function statementMatches(s, toolName, params) {
  const values = actionValues(s.action);
  const toolHit = values.includes('*') || values.some((v) => lower(v) === lower(toolName));
  return toolHit && (s.conditions || []).every((c) => conditionMatches(c, toolName, params));
}

// Returns { verdict: ALLOWED|HELD|BLOCKED, rule } the way ArmorClaude's PreToolUse hook would.
export function evaluateClaude(policy, toolName, params) {
  const matches = policy.statements.filter((s) => statementMatches(s, toolName, params || {}));
  const forbid = matches.find((s) => s.effect === 'forbid');
  if (forbid) return { verdict: 'BLOCKED', rule: forbid.id };
  const hold = matches.find((s) => s.effect === 'require_approval');
  if (hold) return { verdict: 'HELD', rule: hold.id };
  const permit = matches.find((s) => s.effect === 'permit');
  if (permit) return { verdict: 'ALLOWED', rule: permit.id };
  const d = policy.defaults.decision;
  return { verdict: d === 'allow' ? 'ALLOWED' : d === 'hold' ? 'HELD' : 'BLOCKED', rule: `default ${d}` };
}

// ---------------------------------------------------------------- ArmorCodex ({ rules: [] })

const TOOL_ALIASES = { exec_command: 'bash', shell: 'bash', local_shell: 'bash', unified_exec: 'bash', 'container.exec': 'bash' };
const codexToolName = (n) => TOOL_ALIASES[lower(n)] ?? lower(n);
const OPERATOR_KEYS = new Set(['$equals', '$contains', '$startsWith', '$endsWith', '$matches', '$pathContains']);
const isMatcherSpec = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OPERATOR_KEYS.has(k));

function canonicalizePath(input) {
  if (typeof input !== 'string') return '';
  let p = input.trim();
  p = p.replace(/(^|[\s"'`(=:])~(?=\/)/g, '$1$HOME');
  p = p.replace(/\$\{?HOME\}?/g, '<HOME>');
  p = p.replace(/\/(?:home|Users)\/[^/\s'"`)]+/gi, '<HOME>');
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  return p.toLowerCase();
}

function matchesScalar(spec, actual) {
  if (!isMatcherSpec(spec)) return spec === actual;
  if (typeof actual !== 'string' && typeof actual !== 'number') return false;
  const hay = String(actual);
  for (const [op, raw] of Object.entries(spec)) {
    const needle = String(raw);
    switch (op) {
      case '$equals': if (hay !== needle) return false; break;
      case '$contains': if (!hay.toLowerCase().includes(needle.toLowerCase())) return false; break;
      case '$startsWith': if (!hay.toLowerCase().startsWith(needle.toLowerCase())) return false; break;
      case '$endsWith': if (!hay.toLowerCase().endsWith(needle.toLowerCase())) return false; break;
      case '$matches':
        try { if (!new RegExp(needle, 'i').test(hay)) return false; } catch { return false; }
        break;
      case '$pathContains': {
        const a = canonicalizePath(hay);
        const n = canonicalizePath(needle);
        const stripped = n.replace(/^<home>\/?/, '');
        if (!(a.includes(n) || (stripped && a.includes(stripped)))) return false;
        break;
      }
      default: return false;
    }
  }
  return true;
}

// Simplified matchParams: flat keys only (all this pack uses), missing key -> no match.
function matchParams(ruleParams, input) {
  for (const [key, spec] of Object.entries(ruleParams)) {
    const actual = input?.[key];
    if (actual === undefined) return false;
    if (!matchesScalar(spec, actual)) return false;
  }
  return true;
}

function matchesAnyStringField(spec, input, depth = 0) {
  if (depth > 4 || input === null || input === undefined) return false;
  if (typeof input === 'string') return matchesScalar(spec, input);
  if (Array.isArray(input)) return input.some((e) => matchesAnyStringField(spec, e, depth + 1));
  if (isPlainObject(input)) return Object.values(input).some((v) => matchesAnyStringField(spec, v, depth + 1));
  return false;
}

export function validateCodexRules(rules) {
  const errors = [];
  rules.forEach((r, i) => {
    if (!r.id || !r.tool || !['allow', 'deny', 'require_approval'].includes(r.action)) errors.push(`rules[${i}] needs id, tool, and a valid action (normalizeRule would drop it)`);
    if (r.anyParam && !isMatcherSpec(r.anyParam)) errors.push(`rules[${i}].anyParam is not an operator matcher`);
    for (const spec of [r.anyParam, ...Object.values(r.params || {})]) {
      if (spec?.$matches) { try { new RegExp(spec.$matches, 'i'); } catch (e) { errors.push(`rules[${i}] bad regex: ${e.message}`); } }
    }
  });
  return errors;
}

// Returns { verdict, rule }. ArmorCodex has no approval prompt: a require_approval rule makes
// the PreToolUse hook deny, so it shows up here as BLOCKED with the rule's action noted.
export function evaluateCodex(rules, toolName, params) {
  for (const r of rules) {
    const rt = lower(r.tool);
    const hit = r.tool === '*' || (rt.length > 1 && rt.endsWith('*')
      ? codexToolName(toolName).startsWith(rt.slice(0, -1))
      : codexToolName(r.tool) === codexToolName(toolName));
    if (!hit) continue;
    if (r.params && !matchParams(r.params, params || {})) continue;
    if (r.anyParam && !matchesAnyStringField(r.anyParam, params || {})) continue;
    if (r.action === 'allow') return { verdict: 'ALLOWED', rule: r.id };
    return { verdict: 'BLOCKED', rule: r.action === 'deny' ? r.id : `${r.id} (require_approval, denied: Codex has no hold prompt)` };
  }
  return { verdict: 'ALLOWED', rule: 'no rule matched, default allow' };
}
