/**
 * Manifest signing with Ed25519 through WebCrypto.
 *
 * The signature covers the canonical Manifest (sorted keys, no whitespace) with
 * the `signature` field removed, prefixed by a domain separator so the bytes
 * cannot be replayed as a signature over some other document.
 *
 * `keyId` is the SHA-256 fingerprint of the public key. The SDK has no trust
 * store: callers pin `trustedKeyIds` explicitly, because a self-signed package
 * proves integrity since publication, not who the publisher is.
 */
import { WeiSQLError } from "./errors.js";
import { sha256Hex } from "./sha256.js";
import type { ManifestAuthorization, ManifestSignature, WeiSQLManifest } from "./types.js";

const DOMAIN = "weisql-manifest-v1\n";
const AUTHORIZATION_DOMAIN = "weisql-authorization-v1\n";
const encoder = new TextEncoder();

/** Deterministic JSON: object keys sorted, no whitespace, arrays keep order. */
export function canonicalJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return "null";
    const type = typeof input;
    if (type === "string") return JSON.stringify(input);
    if (type === "boolean") return input ? "true" : "false";
    if (type === "number") {
      if (!Number.isFinite(input as number)) throw new WeiSQLError("INVALID_ARGUMENT", "Canonical JSON cannot encode a non-finite number");
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map(item => encode(item)).join(",")}]`;
    if (type === "object") {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;
    }
    throw new WeiSQLError("INVALID_ARGUMENT", `Canonical JSON cannot encode ${type}`);
  };
  return encode(value);
}

/** The signatures that apply to a Manifest, in declaration order. */
export function manifestSignatures(manifest: WeiSQLManifest): ManifestSignature[] {
  if (manifest.signatures !== undefined && manifest.signatures.length > 0) return [...manifest.signatures];
  return manifest.signature === undefined ? [] : [manifest.signature];
}

/** Bytes that are actually signed: domain separator plus the Manifest without its signatures. */
export function manifestSigningPayload(manifest: WeiSQLManifest): Uint8Array {
  const { signature: _signature, signatures: _signatures, ...rest } = manifest;
  return encoder.encode(DOMAIN + canonicalJson(rest));
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function keyIdOf(publicKeySpki: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(publicKeySpki)}`;
}

export interface SigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

/** Generates an Ed25519 key pair in PEM (PKCS#8 private, SPKI public) form. */
export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    privateKeyPem: derToPem(pkcs8, "PRIVATE KEY"),
    publicKeyPem: derToPem(spki, "PUBLIC KEY"),
    keyId: await keyIdOf(spki),
  };
}

export interface SignManifestOptions {
  privateKeyPem: string;
  /**
   * WebCrypto cannot derive a public key from a private one, so the pair must be
   * supplied together. The CLI derives it with node:crypto when only the private
   * key is given.
   */
  publicKeyPem: string;
}

export const MAX_SIGNATURES = 8;

async function createSignature(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<ManifestSignature> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    arrayBufferOf(pemToDer(options.privateKeyPem, "PRIVATE KEY")),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const spki = pemToDer(options.publicKeyPem, "PUBLIC KEY");
  const value = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, arrayBufferOf(manifestSigningPayload(manifest))));
  return {
    algorithm: "ed25519",
    keyId: await keyIdOf(spki),
    publicKey: bytesToBase64(spki),
    value: bytesToBase64(value),
  };
}

/** Replaces any existing signature with a single one from `options`. */
export async function signManifest(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<WeiSQLManifest> {
  const signature = await createSignature(manifest, options);
  const { signature: _old, signatures: _oldList, ...rest } = manifest;
  return { ...rest, signature };
}

/**
 * Adds a co-signature, keeping the existing ones. This is how a key rotation is
 * performed: the new key co-signs while the old key's signature is still valid,
 * and the old signature is dropped once every consumer has pinned the new key.
 */
export async function countersignManifest(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<WeiSQLManifest> {
  const existing = manifestSignatures(manifest);
  const signature = await createSignature(manifest, options);
  if (existing.some(item => item.keyId === signature.keyId)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "This key has already signed the Manifest", { keyId: signature.keyId });
  }
  if (existing.length >= MAX_SIGNATURES) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A Manifest accepts at most eight signatures", { count: existing.length });
  }
  const { signature: _single, signatures: _list, ...rest } = manifest;
  return { ...rest, signatures: [...existing, signature] };
}

export interface AuthorizationPayload {
  algorithm: "ed25519";
  rootKeyId: string;
  rootPublicKey: string;
  keyId: string;
  publicKey: string;
  validFrom: string;
  validUntil: string;
}

/**
 * Bytes a root key signs to authorize a signer key.
 *
 * Only the payload fields are canonicalised: a stored ManifestAuthorization also
 * carries `value`, and hashing that would never match the signature.
 */
export function authorizationSigningPayload(record: AuthorizationPayload | ManifestAuthorization): Uint8Array {
  const payload: AuthorizationPayload = {
    algorithm: "ed25519",
    rootKeyId: record.rootKeyId,
    rootPublicKey: record.rootPublicKey,
    keyId: record.keyId,
    publicKey: record.publicKey,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
  return encoder.encode(AUTHORIZATION_DOMAIN + canonicalJson(payload));
}

export interface AuthorizeSignerOptions {
  rootPrivateKeyPem: string;
  rootPublicKeyPem: string;
  /** The signer key being authorized; must also sign the Manifest to matter. */
  signerPublicKeyPem: string;
  validFrom: string;
  validUntil: string;
}

/**
 * Issues a root-signed authorization for one signer key.
 *
 * The authorization binds key ids, public keys and the validity window, so it
 * cannot be replayed onto a different signer or extended by editing the record.
 */
export async function authorizeSigner(options: AuthorizeSignerOptions): Promise<ManifestAuthorization> {
  const from = Date.parse(options.validFrom);
  const until = Date.parse(options.validUntil);
  if (Number.isNaN(from) || Number.isNaN(until)) throw new WeiSQLError("INVALID_ARGUMENT", "Authorization window must use ISO timestamps", { validFrom: options.validFrom, validUntil: options.validUntil });
  if (from >= until) throw new WeiSQLError("INVALID_ARGUMENT", "Authorization window must end after it starts", { validFrom: options.validFrom, validUntil: options.validUntil });

  const rootSpki = pemToDer(options.rootPublicKeyPem, "PUBLIC KEY");
  const signerSpki = pemToDer(options.signerPublicKeyPem, "PUBLIC KEY");
  const payload: AuthorizationPayload = {
    algorithm: "ed25519",
    rootKeyId: await keyIdOf(rootSpki),
    rootPublicKey: bytesToBase64(rootSpki),
    keyId: await keyIdOf(signerSpki),
    publicKey: bytesToBase64(signerSpki),
    validFrom: options.validFrom,
    validUntil: options.validUntil,
  };
  const rootKey = await crypto.subtle.importKey(
    "pkcs8",
    arrayBufferOf(pemToDer(options.rootPrivateKeyPem, "PRIVATE KEY")),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const value = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, rootKey, arrayBufferOf(authorizationSigningPayload(payload))));
  return { ...payload, value: bytesToBase64(value) };
}

export const MAX_AUTHORIZATIONS = 8;

/** Adds an authorization; the manifest still has to be signed by the authorized key. */
export function addAuthorization(manifest: WeiSQLManifest, authorization: ManifestAuthorization): WeiSQLManifest {
  const existing = manifest.authorizations ?? [];
  if (existing.some(item => item.keyId === authorization.keyId)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "This signer key is already authorized", { keyId: authorization.keyId });
  }
  if (existing.length >= MAX_AUTHORIZATIONS) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A Manifest accepts at most eight authorizations", { count: existing.length });
  }
  return { ...manifest, authorizations: [...existing, authorization] };
}

export interface AuthorizationVerification {
  keyId: string;
  rootKeyId: string;
  valid: boolean;
  reason?: "root-signature" | "expired" | "not-yet-valid" | "unsigned-key" | "invalid-key" | "untrusted-root";
}

export interface VerifyAuthorizationOptions {
  /** Root fingerprints the caller pins. */
  trustedRootKeyIds?: readonly string[];
  /** Overrides `Date.now()`; useful for deterministic tests. */
  now?: number;
}

/** Verifies every delegation chain independently; results include the reason for each failure. */
export async function verifyAuthorizations(
  manifest: WeiSQLManifest,
  options: VerifyAuthorizationOptions = {},
): Promise<AuthorizationVerification[]> {
  const authorizations = manifest.authorizations ?? [];
  if (authorizations.length === 0) return [];
  const signed = new Set(manifestSignatures(manifest).map(item => item.keyId));
  const now = options.now ?? Date.now();
  const results: AuthorizationVerification[] = [];

  for (const record of authorizations) {
    const base = { keyId: record.keyId, rootKeyId: record.rootKeyId };
    if (!signed.has(record.keyId)) {
      results.push({ ...base, valid: false, reason: "unsigned-key" });
      continue;
    }
    if (options.trustedRootKeyIds !== undefined && !options.trustedRootKeyIds.includes(record.rootKeyId)) {
      results.push({ ...base, valid: false, reason: "untrusted-root" });
      continue;
    }
    let rootSpki: Uint8Array;
    try {
      rootSpki = base64ToBytes(record.rootPublicKey);
    } catch {
      results.push({ ...base, valid: false, reason: "invalid-key" });
      continue;
    }
    if (await keyIdOf(rootSpki) !== record.rootKeyId) {
      results.push({ ...base, valid: false, reason: "invalid-key" });
      continue;
    }
    const from = Date.parse(record.validFrom);
    const until = Date.parse(record.validUntil);
    if (now < from) {
      results.push({ ...base, valid: false, reason: "not-yet-valid" });
      continue;
    }
    if (now >= until) {
      results.push({ ...base, valid: false, reason: "expired" });
      continue;
    }
    let rootKey: CryptoKey;
    try {
      rootKey = await crypto.subtle.importKey("spki", arrayBufferOf(rootSpki), { name: "Ed25519" }, false, ["verify"]);
    } catch {
      results.push({ ...base, valid: false, reason: "invalid-key" });
      continue;
    }
    const payload = authorizationSigningPayload(record);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, rootKey, arrayBufferOf(base64ToBytes(record.value)), arrayBufferOf(payload));
    results.push(ok ? { ...base, valid: true } : { ...base, valid: false, reason: "root-signature" });
  }
  return results;
}

export interface VerifyManifestSignatureOptions {
  /** Pin expected publisher fingerprints. A self-signed package is otherwise accepted. */
  trustedKeyIds?: readonly string[];
  /**
   * Endorsement policy: how many distinct pinned keys must have signed. Defaults
   * to 1. This is verifier-side policy, not threshold cryptography: each signer
   * still holds their own complete key.
   */
  minimumTrustedSignatures?: number;
  /**
   * Root fingerprints the caller pins. When set, at least one valid delegation
   * chain must authorize a signing key; the release keys themselves stay unpinned.
   */
  trustedRootKeyIds?: readonly string[];
  /** Overrides `Date.now()` for deterministic verification. */
  now?: number;
}

export interface SignatureVerification {
  keyId: string;
  valid: boolean;
  reason?: "unsupported-algorithm" | "key-id-mismatch" | "invalid-key" | "bad-signature";
}

export interface VerifyManifestSignatureResult {
  valid: boolean;
  /** First signature's fingerprint; kept for callers that only handle one signature. */
  keyId?: string;
  keyIds: string[];
  reason?: "missing-signature" | "unsupported-algorithm" | "key-id-mismatch" | "untrusted-key" | "invalid-key" | "bad-signature" | "insufficient-trusted-signatures" | "unauthorized-root";
  signatures: SignatureVerification[];
  /** Pinned keys that actually signed this Manifest. */
  trustedKeyIds: string[];
  /** Delegation-chain results; empty when the Manifest declares none. */
  authorizations?: AuthorizationVerification[];
  /** True when a valid chain from a pinned root authorizes a signing key. */
  authorized?: boolean;
}

export async function verifyManifestSignature(
  manifest: WeiSQLManifest,
  options: VerifyManifestSignatureOptions = {},
): Promise<VerifyManifestSignatureResult> {
  const minimum = options.minimumTrustedSignatures ?? 1;
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new WeiSQLError("INVALID_ARGUMENT", "minimumTrustedSignatures must be a positive integer", { minimumTrustedSignatures: options.minimumTrustedSignatures });
  }
  if (minimum > 1 && options.trustedKeyIds === undefined) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A multi-signature requirement needs trustedKeyIds to count against", { minimumTrustedSignatures: minimum });
  }

  const signatures = manifestSignatures(manifest);
  if (signatures.length === 0) return { valid: false, keyIds: [], signatures: [], trustedKeyIds: [], reason: "missing-signature" };

  const payload = manifestSigningPayload(manifest);
  const results: SignatureVerification[] = [];
  for (const signature of signatures) {
    results.push(await verifyOne(signature, payload));
  }
  const keyIds = signatures.map(signature => signature.keyId);
  const trusted = options.trustedKeyIds === undefined
    ? []
    : results.filter(item => item.valid && options.trustedKeyIds!.includes(item.keyId)).map(item => item.keyId);

  const authorizations = await verifyAuthorizations(manifest, {
    ...(options.trustedRootKeyIds === undefined ? {} : { trustedRootKeyIds: options.trustedRootKeyIds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const delegated = authorizations.filter(item => item.valid);
  const authorized = options.trustedRootKeyIds === undefined
    ? undefined
    : delegated.length > 0;

  const failed = results.find(item => !item.valid);
  if (failed !== undefined) {
    return {
      valid: false,
      keyId: keyIds[0]!,
      keyIds,
      signatures: results,
      trustedKeyIds: trusted,
      authorizations,
      ...(authorized === undefined ? {} : { authorized }),
      ...(failed.reason === undefined ? {} : { reason: failed.reason }),
    };
  }
  if (authorized === false) {
    return {
      valid: false,
      keyId: keyIds[0]!,
      keyIds,
      signatures: results,
      trustedKeyIds: trusted,
      authorizations,
      authorized: false,
      reason: "unauthorized-root",
    };
  }
  if (options.trustedKeyIds !== undefined && trusted.length < minimum) {
    return {
      valid: false,
      keyId: keyIds[0]!,
      keyIds,
      signatures: results,
      trustedKeyIds: trusted,
      authorizations,
      ...(authorized === undefined ? {} : { authorized }),
      reason: trusted.length === 0 ? "untrusted-key" : "insufficient-trusted-signatures",
    };
  }
  return {
    valid: true,
    keyId: keyIds[0]!,
    keyIds,
    signatures: results,
    trustedKeyIds: trusted,
    authorizations,
    ...(authorized === undefined ? {} : { authorized }),
  };
}

async function verifyOne(signature: ManifestSignature, payload: Uint8Array): Promise<SignatureVerification> {
  if (signature.algorithm !== "ed25519") return { keyId: signature.keyId, valid: false, reason: "unsupported-algorithm" };
  let spki: Uint8Array;
  try {
    spki = base64ToBytes(signature.publicKey);
  } catch {
    return { keyId: signature.keyId, valid: false, reason: "invalid-key" };
  }
  const actualKeyId = await keyIdOf(spki);
  if (actualKeyId !== signature.keyId) return { keyId: signature.keyId, valid: false, reason: "key-id-mismatch" };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", arrayBufferOf(spki), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { keyId: signature.keyId, valid: false, reason: "invalid-key" };
  }
  try {
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, arrayBufferOf(base64ToBytes(signature.value)), arrayBufferOf(payload));
    return ok ? { keyId: signature.keyId, valid: true } : { keyId: signature.keyId, valid: false, reason: "bad-signature" };
  } catch {
    return { keyId: signature.keyId, valid: false, reason: "invalid-key" };
  }
}

function pemToDer(pem: string, label: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (match === null) throw new WeiSQLError("INVALID_ARGUMENT", `PEM does not contain a ${label} block`);
  return base64ToBytes(match[1]!.replace(/\s+/g, ""));
}

function derToPem(der: Uint8Array, label: string): string {
  const base64 = bytesToBase64(der);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
