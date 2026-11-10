// Offline stand-in for ArmorIQ Intent Gateway, speaking the Anthropic Messages API (non streaming).
//
// node:http only, no dependencies, listens on 127.0.0.1. It does what the real gateway does with
// each model turn, with a scripted provider in place of Anthropic:
//
//   /v1/t/<key>/v1/messages            record only: the reply passes through, nothing is checked
//   /v1/t/<key>/a/<agent>/v1/messages  each tool_use block is checked against policy.yaml.
//                                      Allowed blocks pass unchanged. Blocked and held blocks are
//                                      removed and the reply's text ends with
//                                      'Tool call "<name>" was blocked by policy: <rule>'.
//
// A hold works like a block at the gateway today, whatever OFFLINE_APPROVAL says: the real
// gateway creates an approval request, but approving it does not release the call.
//
// Run it on its own (port 8788) and point agent.mjs at it with ARMORIQ_GATEWAY_HOST:
//   node offline/gateway.mjs

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { respond } from './scripted-provider.mjs';

const ROUTE = /^\/v1\/t\/([^/]+)(?:\/a\/([^/]+))?\/v1\/messages$/;
const LABEL = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' };

const log = (line) => console.log(`[armoriq] ${line}`);
const note = (line) => console.log(`[gateway] ${line}`);

// Reads the small subset of YAML that policy.yaml uses: name, default_action, and a rules list
// of `- tool:` / `action:` pairs. No YAML dependency needed.
function loadPolicy() {
  const file = process.env.OFFLINE_POLICY ?? new URL('../policy.yaml', import.meta.url);
  const policy = { name: 'policy', default_action: 'block', rules: [] };
  let rule = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^name:\s*(\S+)/))) policy.name = m[1];
    else if ((m = line.match(/^default_action:\s*(\S+)/))) policy.default_action = m[1];
    else if ((m = line.match(/^\s*-\s*tool:\s*(\S+)/))) policy.rules.push((rule = { tool: m[1] }));
    else if (rule && (m = line.match(/^\s+action:\s*(\S+)/))) rule.action = m[1];
  }
  return policy;
}

// Returns { action, reason, rule } for a tool name, from the policy file only.
function decide(policy, toolName) {
  const rule = policy.rules.find((r) => r.tool === toolName);
  if (rule) {
    return { action: rule.action, reason: `policy ${policy.name}: ${toolName} -> ${rule.action}`, rule: `${rule.action}:${toolName}#0` };
  }
  const action = policy.default_action;
  return { action, reason: `policy ${policy.name}: no rule for ${toolName}, default_action -> ${action}`, rule: `default_action:${action}` };
}

const firstUserText = (messages) => {
  const content = messages.find((m) => m.role === 'user')?.content ?? '';
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
};

const seenUsers = new Set();

// One model turn: ask the scripted provider, then apply policy the way the gateway does.
function handleTurn(agentId, userEmail, body) {
  const messages = body.messages ?? [];
  const content = respond(messages);
  const toolUses = content.filter((b) => b.type === 'tool_use');
  const names = toolUses.map((b) => b.name);
  if (userEmail && !seenUsers.has(userEmail)) {
    seenUsers.add(userEmail);
    note(`request from ${userEmail} (X-User-Email, not forwarded to the provider)`);
  }

  let out = content;
  if (toolUses.length > 0 && !agentId) {
    note(`recorded: ${names.join(', ')} (no agent in the URL, nothing checked)`);
  } else if (toolUses.length > 0) {
    const policy = loadPolicy();
    log(`plan: ${firstUserText(messages)} -> ${names.join(', ')}`);
    const notes = [];
    out = content.filter((block) => {
      if (block.type !== 'tool_use') return true;
      const { action, reason, rule } = decide(policy, block.name);
      const suffix = action === 'hold' ? '; hold acts as block at the gateway today' : '';
      log(`check ${block.name}: ${LABEL[action] ?? 'BLOCKED'} (${reason}${suffix})`);
      log(`args ${block.name}: ${JSON.stringify(block.input)}`);
      if (action === 'allow') return true;
      notes.push(`Tool call "${block.name}" was blocked by policy: ${rule}`);
      return false;
    });
    if (notes.length > 0) {
      const text = out.find((b) => b.type === 'text');
      if (text) text.text = `${text.text}\n\n${notes.join('\n')}`;
      else out.unshift({ type: 'text', text: notes.join('\n') });
    }
  }

  const stillCalling = out.some((b) => b.type === 'tool_use');
  return {
    id: `msg_offline_${messages.length}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'offline-model',
    content: out,
    stop_reason: stillCalling ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function send(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// Starts the stand-in on 127.0.0.1 and resolves to its origin, e.g. http://127.0.0.1:53111.
export function startGateway(port = 0) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const match = req.method === 'POST' && ROUTE.exec(req.url);
      if (!match) {
        return send(res, 404, {
          type: 'error',
          error: { type: 'not_found_error', message: `stand-in gateway: ${req.method} ${req.url} is not served; expected <base>/v1/messages` },
        });
      }
      if (!req.headers['x-api-key']) {
        return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'missing provider key' } });
      }
      send(res, 200, handleTurn(match[2], req.headers['x-user-email'], JSON.parse(raw || '{}')));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.unref(); // let the process exit when the agent is done
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startGateway(Number(process.env.OFFLINE_GATEWAY_PORT ?? 8788));
  note(`stand-in gateway on ${url}; set ARMORIQ_GATEWAY_HOST=${url} and run agent.mjs. Ctrl+C to stop.`);
  setInterval(() => {}, 1 << 30);
}
