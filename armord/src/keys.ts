// Ed25519 keys and signatures: trusted keys, signed local policies, signed bundles, and the
// IAP intent-token checks the Python SDK performs (crypto_verify.py), byte for byte.

import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@armoriq/policy-ir';

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Load an Ed25519 public key from PEM, JWK (OKP), raw hex, or base64/base64url raw or DER. */
export function loadPublicKey(material: unknown): KeyObject | null {
  try {
    if (material && typeof material === 'object' && !Buffer.isBuffer(material)) {
      const o = material as Record<string, unknown>;
      if (o.kty === 'OKP' && typeof o.x === 'string') return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: o.x }, format: 'jwk' });
      const inner = o.public_key ?? o.publicKey ?? o.pem ?? o.key ?? o.jwk;
      return inner === undefined ? null : loadPublicKey(inner);
    }
    const text = Buffer.isBuffer(material) ? material.toString('utf8') : String(material ?? '').trim();
    if (!text) return null;
    let key: KeyObject;
    if (text.includes('-----BEGIN')) key = createPublicKey(text);
    else if (/^[0-9a-fA-F]{64}$/.test(text)) key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(text, 'hex')]), format: 'der', type: 'spki' });
    else {
      const bytes = b64urlDecode(text);
      key = bytes.length === 32 ? createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' }) : createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    }
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Raw 32-byte public key as hex, for comparing two keys. */
export function rawHex(key: KeyObject): string {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(ED25519_SPKI_PREFIX.length).toString('hex');
}

export function verifySignature(key: KeyObject, message: Buffer | string, signature: Buffer): boolean {
  try {
    return signature.length === 64 && edVerify(null, Buffer.isBuffer(message) ? message : Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}

/** Decode a signature given as hex or base64/base64url. */
export function decodeSignature(s: string): Buffer {
  const t = s.trim();
  return /^[0-9a-fA-F]{128}$/.test(t) ? Buffer.from(t, 'hex') : b64urlDecode(t);
}

/** Every public key in a directory of trusted keys (`*.pub`, `*.pem`, `*.jwk`). */
export function loadTrustedKeys(dir: string): KeyObject[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(pub|pem|jwk|key)$/i.test(f) && !/private/i.test(f))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      return f.endsWith('.jwk') ? loadPublicKey(JSON.parse(text)) : loadPublicKey(text);
    })
    .filter((k): k is KeyObject => k !== null);
}

/** A new signing key pair: private PEM written owner-only, public PEM added to the trusted dir. */
export function generateSigningKey(keysDir: string, trustedDir: string, name: string): { privateFile: string; publicFile: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  mkdirSync(trustedDir, { recursive: true });
  const privateFile = join(keysDir, `${name}.private.pem`);
  const publicFile = join(trustedDir, `${name}.pub`);
  if (existsSync(privateFile)) throw new Error(`${privateFile} already exists`);
  writeFileSync(privateFile, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { mode: 0o600 });
  writeFileSync(publicFile, publicKey.export({ format: 'pem', type: 'spki' }) as string);
  return { privateFile, publicFile };
}

/** Detached signature over a file's exact bytes, written next to it as `<file>.sig` (base64). */
export function signFile(file: string, privateKeyPem: string): string {
  const sig = edSign(null, readFileSync(file), privateKeyPem).toString('base64');
  writeFileSync(`${file}.sig`, sig + '\n');
  return `${file}.sig`;
}

export function verifyDetached(content: Buffer | string, signature: string | undefined, trusted: KeyObject[]): boolean {
  if (!signature || trusted.length === 0) return false;
  const sig = decodeSignature(signature);
  return trusted.some((k) => verifySignature(k, Buffer.isBuffer(content) ? content : Buffer.from(content), sig));
}

/**
 * The IAP intent token check from the Python SDK (`verify_intent_token_signature`): Ed25519 over
 * the canonical JSON of the signed fields. One difference, on purpose: the SDK verifies against the
 * public key carried inside the token, which proves nothing about who signed it. Here the token's
 * key must also equal the trusted IAP key.
 */
export function verifyIntentToken(rawToken: unknown, trustedIapKey: KeyObject | null): { ok: boolean; reason: string; planHash?: string; expiresAt?: number } {
  const outer = (rawToken ?? {}) as Record<string, unknown>;
  const t = ((outer.token ?? outer) as Record<string, unknown>) ?? {};
  const publicKeyHex = typeof t.public_key === 'string' ? t.public_key : '';
  const signatureHex = typeof t.signature === 'string' ? t.signature : '';
  const planHash = typeof t.plan_hash === 'string' ? t.plan_hash : '';
  if (!publicKeyHex || !signatureHex || !planHash) return { ok: false, reason: 'token is missing public_key, signature or plan_hash' };
  if (!trustedIapKey) return { ok: false, reason: 'no trusted IAP public key (set ARMORIQ_IAP_PUBLIC_KEY or let armord fetch /iap/public-key)' };
  if (publicKeyHex.toLowerCase() !== rawHex(trustedIapKey)) return { ok: false, reason: 'token was signed by a key that is not the trusted IAP key' };
  const payload: Record<string, unknown> = {
    plan_hash: t.plan_hash ?? null,
    issued_at: t.issued_at ?? null,
    expires_at: t.expires_at ?? null,
    policy: t.policy ?? null,
    identity: t.identity ?? null,
    public_key: t.public_key ?? null,
    version: t.version ?? null,
  };
  if (t.allowed_operations) payload.allowed_operations = t.allowed_operations;
  if (t.resource_scope) payload.resource_scope = t.resource_scope;
  const ok = verifySignature(trustedIapKey, canonicalJson(payload), Buffer.from(signatureHex, 'hex'));
  if (!ok) return { ok: false, reason: 'token signature does not verify' };
  const expiresAt = typeof t.expires_at === 'number' ? t.expires_at : typeof t.expires_at === 'string' ? Date.parse(t.expires_at) / 1000 : undefined;
  if (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt * 1000 < Date.now()) return { ok: false, reason: 'token has expired', planHash };
  return expiresAt !== undefined ? { ok: true, reason: 'verified', planHash, expiresAt } : { ok: true, reason: 'verified', planHash };
}
