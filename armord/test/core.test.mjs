import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, compile, policyHash } from '@armoriq/policy-ir';
import { parseYaml } from '@armoriq/policy-ir/document';
import { Engine, PlanRegistry, PolicyStore, SIGNATURE_HEADER, generateSigningKey, loadTrustedKeys, servicePlan, signFile, verifyIntentToken } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'armord-core-'));
const notes = readFileSync(join(here, 'fixtures', 'notes-policy.yaml'), 'utf8');

function agentDoc() {
  const src = notes.replace('target: {device: local}', 'target: {agent: agent-1}');
  const doc = compile(parseYaml(src).source, [], { policyId: 'p-notes' }).document;
  doc.policyHash = policyHash(doc);
  return doc;
}

/** A fetch stand-in that answers like GET /policy/bundles/current (shape verified live). */
function bundleFetch(body, { etag = '"sha256:abc"', status = 200, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { etag, ...headers } });
  };
  return { fetchImpl, calls };
}

function remoteStore(fetchImpl, extra = {}) {
  return new PolicyStore({ remote: { endpoint: 'https://api.example', apiKey: 'k', agentId: 'agent-1', cacheDir: tmp(), fetchImpl, ...extra } });
}

test('remote: SDK bundle shape, agent by id or name, ETag revalidation', async () => {
  const doc = agentDoc();
  const { fetchImpl, calls } = bundleFetch({ orgId: 'o', agents: [{ agentId: 'other', policy: null }, { agentId: 'agent-1', name: 'notes-bot', policy: { name: 'notes', policyId: 'p-notes', document: doc }, tools: [] }] });
  const store = remoteStore(fetchImpl);
  const engine = new Engine(store);
  assert.equal(engine.decide({ tool: 'read_note', arguments: {} }).verdict, 'block', 'nothing fetched yet: unavailable');
  await store.refreshRemote();
  assert.equal(store.remoteStatus(), 'current');
  assert.equal(engine.decide({ tool: 'read_note', arguments: {} }).verdict, 'allow');
  assert.equal(engine.decide({ tool: 'delete_note', arguments: {} }).verdict, 'block');
  assert.match(calls[0].url, /\/policy\/bundles\/current\?agent=agent-1$/);
  await store.refreshRemote();
  assert.equal(calls[1].headers['If-None-Match'], '"sha256:abc"', 'second fetch revalidates with the ETag');
});

test('remote: unresolved, inactive, no active policy, and a tampered document', async () => {
  const decide = async (body) => {
    const store = remoteStore(bundleFetch(body).fetchImpl);
    await store.refreshRemote();
    return new Engine(store).decide({ tool: 'read_note', arguments: {} });
  };
  assert.match((await decide({ agents: [] })).reason, /agent_unresolved/);
  assert.equal((await decide({ agents: [{ agentId: 'agent-1', inactive: true }] })).reason, 'agent_inactive');
  assert.equal((await decide({ agents: [{ agentId: 'agent-1', policy: null }] })).verdict, 'allow', 'SDK: no active policy allows');
  const tampered = { ...agentDoc(), defaults: { ...agentDoc().defaults, tools: 'allow' } };
  const d = await decide({ agents: [{ agentId: 'agent-1', policy: { document: tampered } }] });
  assert.equal(d.verdict, 'block', 'a document failing its policyHash must never fall back to allow');
});

test('remote: a bundle not confirmed for the stale window blocks (SDK: 300 s)', async () => {
  const store = remoteStore(bundleFetch({ agents: [{ agentId: 'agent-1', policy: { document: agentDoc() } }] }).fetchImpl, { staleSeconds: 0.05 });
  await store.refreshRemote();
  const engine = new Engine(store);
  assert.equal(engine.decide({ tool: 'read_note', arguments: {} }).verdict, 'allow');
  await new Promise((r) => setTimeout(r, 80));
  assert.match(engine.decide({ tool: 'read_note', arguments: {} }).reason, /policy-bundle-stale/);
  assert.equal(new Engine(store, { onStale: 'last-known' }).decide({ tool: 'read_note', arguments: {} }).verdict, 'allow');
});

test('remote: the bundle inventory adds capabilities to a call', async () => {
  const src = notes.replace('target: {device: local}', 'target: {agent: agent-1}').replace('rules:', 'rules:\n      shell: block');
  const doc = compile(parseYaml(src).source, [], { policyId: 'p' }).document;
  const store = remoteStore(bundleFetch({ agents: [{ agentId: 'agent-1', policy: { document: doc }, tools: [{ name: 'read_note', server: 'notes', capabilities: ['shell'] }] }] }).fetchImpl);
  await store.refreshRemote();
  assert.equal(new Engine(store).decide({ tool: 'read_note', arguments: {}, mcpServer: 'notes' }).verdict, 'block');
});

test('remote: signed bundles are verified, and can be required', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const body = JSON.stringify({ agents: [{ agentId: 'agent-1', policy: { document: agentDoc() } }] });
  const sig = sign(null, Buffer.from(body), privateKey).toString('base64');
  const good = remoteStore(bundleFetch(body, { headers: { [SIGNATURE_HEADER]: sig } }).fetchImpl, { requireSigned: true });
  good.options.trustedKeys = [publicKey];
  await good.refreshRemote();
  assert.equal(good.remoteStatus(), 'current');
  const unsigned = remoteStore(bundleFetch(body).fetchImpl, { requireSigned: true });
  await unsigned.refreshRemote();
  assert.equal(unsigned.remoteStatus(), 'unavailable');
  assert.match(unsigned.remoteError, /signed bundles are required/);
  const forged = remoteStore(bundleFetch(body.replace('agent-1', 'agent-1 '), { headers: { [SIGNATURE_HEADER]: sig } }).fetchImpl);
  forged.options.trustedKeys = [publicKey];
  await forged.refreshRemote();
  assert.match(forged.remoteError, /signature does not verify/);
});

test('local: with requireSigned only files signed by a trusted key load', () => {
  const home = tmp();
  generateSigningKey(join(home, 'keys'), join(home, 'trusted'), 'me');
  const file = join(home, 'p.yaml');
  writeFileSync(file, notes);
  signFile(file, readFileSync(join(home, 'keys', 'me.private.pem'), 'utf8'));
  const trustedKeys = loadTrustedKeys(join(home, 'trusted'));
  const store = new PolicyStore({ requireSigned: true, trustedKeys });
  store.addSource(file, notes, readFileSync(`${file}.sig`, 'utf8'));
  assert.equal(store.localDocuments().length, 1);
  store.addSource('edited.yaml', notes.replace('delete_note: block', 'delete_note: allow'), readFileSync(`${file}.sig`, 'utf8'));
  store.addSource('unsigned.yaml', notes);
  assert.equal(store.localDocuments().length, 1);
  assert.deepEqual(store.problems.filter((p) => p.code === 'unsigned_policy').map((p) => p.file), ['edited.yaml', 'unsigned.yaml']);
});

function iapToken(privateKey, publicKey, fields = {}) {
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const t = { plan_hash: 'abc123', issued_at: 1, expires_at: Date.now() / 1000 + 600, policy: { allow: ['*'] }, identity: { user: 'u' }, public_key: raw, version: '1', ...fields };
  const payload = { plan_hash: t.plan_hash, issued_at: t.issued_at, expires_at: t.expires_at, policy: t.policy, identity: t.identity, public_key: t.public_key, version: t.version };
  t.signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('hex');
  return { token: t };
}

test('intent tokens: verified like the SDK, but only against the trusted IAP key', () => {
  const iap = generateKeyPairSync('ed25519');
  const attacker = generateKeyPairSync('ed25519');
  assert.equal(verifyIntentToken(iapToken(iap.privateKey, iap.publicKey), iap.publicKey).ok, true);
  const selfSigned = verifyIntentToken(iapToken(attacker.privateKey, attacker.publicKey), iap.publicKey);
  assert.equal(selfSigned.ok, false, 'a token carrying its own key proves nothing');
  assert.match(selfSigned.reason, /not the trusted IAP key/);
  const t = iapToken(iap.privateKey, iap.publicKey);
  t.token.plan_hash = 'other';
  assert.match(verifyIntentToken(t, iap.publicKey).reason, /does not verify/);
  assert.match(verifyIntentToken(iapToken(iap.privateKey, iap.publicKey, { expires_at: 1 }), iap.publicKey).reason, /expired/);
  assert.match(verifyIntentToken(iapToken(iap.privateKey, iap.publicKey), null).reason, /no trusted IAP public key/);
});

test('plans: drift and argument binding, pending plans bind to the next session', () => {
  const store = new PolicyStore();
  store.addSource('p.yaml', notes.replace('default: block', 'default: allow'));
  const plans = new PlanRegistry(() => null);
  const engine = new Engine(store, {}, plans);
  plans.register({ host: 'claude-code', goal: 'read note 7', steps: [{ tool: 'read_note', args: { id: '7' } }, { tool: 'mcp__docs__*' }] });
  const ask = (tool, args) => engine.decide({ tool, arguments: args, host: 'claude-code', sessionId: 's1' });
  assert.equal(ask('read_note', { id: '7' }).verdict, 'allow');
  assert.match(ask('read_note', { id: '8' }).reason, /intent mismatch/);
  assert.match(ask('publish_note', { id: '7' }).reason, /intent drift/);
  assert.equal(ask('mcp__docs__search', {}).verdict, 'allow');
  assert.equal(ask('register_intent_plan', {}).verdict, 'allow', 'the plan tool itself is never drift');
  assert.equal(engine.decide({ tool: 'publish_note', arguments: {}, host: 'claude-code', sessionId: 's2' }).verdict, 'hold', 'another session has no plan');
  assert.match(new Engine(store, { requirePlan: true }, plans).decide({ tool: 'read_note', arguments: {}, sessionId: 's3' }).reason, /no intent plan/);
  assert.throws(() => plans.register({ steps: [{ tool: 'x' }], intentToken: { token: {} } }), /intent token refused/);
});

test('self-protection: armord state, keys and hook configs', () => {
  const store = new PolicyStore();
  store.addSource('allow.yaml', notes.replace('default: block', 'default: allow'));
  const engine = new Engine(store, { home: join(homedir(), '.armoriq', 'armord') });
  const v = (tool, args) => engine.decide({ tool, arguments: args });
  assert.equal(v('Write', { file_path: '~/.armoriq/armord/policies/starter.yaml' }).verdict, 'block');
  assert.equal(v('Read', { file_path: '~/.armoriq/armord/keys/local.private.pem' }).verdict, 'block');
  assert.equal(v('Read', { file_path: '~/.armoriq/credentials.json' }).verdict, 'block');
  assert.equal(v('Read', { file_path: '~/.armoriq/armord/audit.jsonl' }).verdict, 'allow', 'reading the audit log is fine');
  assert.equal(v('Edit', { file_path: join(tmpdir(), 'proj', '.claude', 'settings.json') }).verdict, 'hold');
  assert.equal(v('Bash', { command: 'rm -rf ~/.armoriq/armord/policies' }).verdict, 'block');
  assert.equal(v('Bash', { command: 'pkill -f "armord start"' }).verdict, 'block');
  assert.equal(new Engine(store, { selfProtect: false }).decide({ tool: 'Write', arguments: { file_path: '~/.armoriq/armord/x' } }).verdict, 'allow');
});

test('service definitions per platform carry no API key', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = servicePlan('/opt/armord/dist/cli.js', platform);
    const text = JSON.stringify(p);
    assert.match(text, /cli\.js/);
    assert.doesNotMatch(text, /ARMORIQ_API_KEY|ak_live/);
    assert.ok(p.enable.length > 0 && p.disable.length > 0);
  }
  assert.match(servicePlan('/x/cli.js', 'win32').enable[0].join(' '), /schtasks \/Create .*ONLOGON/);
});

test('live control plane (ARMORD_LIVE=1 with ARMORIQ_API_KEY)', { skip: process.env.ARMORD_LIVE !== '1' }, async () => {
  const res = await fetch('https://api.armoriq.ai/iap/public-key');
  const { loadPublicKey } = await import('../dist/index.js');
  assert.ok(loadPublicKey(await res.json()), 'the live IAP key parses as Ed25519');
  const store = new PolicyStore({ remote: { endpoint: 'https://api.armoriq.ai', apiKey: process.env.ARMORIQ_API_KEY, agentId: process.env.ARMORD_AGENT_ID ?? 'no-such-agent', cacheDir: tmp() } });
  await store.refreshRemote();
  assert.equal(store.remoteError, null, store.remoteError ?? '');
  assert.equal(store.remoteStatus(), 'current');
  await store.refreshRemote();
  assert.equal(store.remoteStatus(), 'current', 'a 304 revalidation keeps it current');
});

test('a rule keyed by the bare tool name applies to a qualified mcp__server__tool call', () => {
  const store = new PolicyStore();
  store.addSource('p.yaml', notes);
  const engine = new Engine(store);
  assert.equal(engine.decide({ tool: 'mcp__notes__delete_note', arguments: {} }).verdict, 'block');
  assert.equal(engine.decide({ tool: 'mcp__notes__read_note', arguments: {} }).verdict, 'allow');
  assert.equal(engine.decide({ tool: 'read_note', arguments: {}, mcpServer: 'notes' }).verdict, 'allow');
});
