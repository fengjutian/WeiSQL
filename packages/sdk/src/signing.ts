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
import type { ManifestSignature, WeiSQLManifest } from "./types.js";

const DOMAIN = "weisql-manifest-v1\n";
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

/** Bytes that are actually signed: domain separator plus the Manifest without its signature. */
export function manifestSigningPayload(manifest: WeiSQLManifest): Uint8Array {
  const { signature: _signature, ...rest } = manifest;
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

export async function signManifest(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<WeiSQLManifest> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    arrayBufferOf(pemToDer(options.privateKeyPem, "PRIVATE KEY")),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const spki = pemToDer(options.publicKeyPem, "PUBLIC KEY");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, arrayBufferOf(manifestSigningPayload(manifest))));
  const signed: WeiSQLManifest = {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      keyId: await keyIdOf(spki),
      publicKey: bytesToBase64(spki),
      value: bytesToBase64(signature),
    },
  };
  return signed;
}

export interface VerifyManifestSignatureOptions {
  /** Pin expected publisher fingerprints. A self-signed package is otherwise accepted. */
  trustedKeyIds?: readonly string[];
}

export interface VerifyManifestSignatureResult {
  valid: boolean;
  keyId?: string;
  reason?: "missing-signature" | "unsupported-algorithm" | "key-id-mismatch" | "untrusted-key" | "invalid-key" | "bad-signature";
}

export async function verifyManifestSignature(
  manifest: WeiSQLManifest,
  options: VerifyManifestSignatureOptions = {},
): Promise<VerifyManifestSignatureResult> {
  const signature = manifest.signature as ManifestSignature | undefined;
  if (signature === undefined) return { valid: false, reason: "missing-signature" };
  if (signature.algorithm !== "ed25519") return { valid: false, reason: "unsupported-algorithm" };

  let spki: Uint8Array;
  try {
    spki = base64ToBytes(signature.publicKey);
  } catch {
    return { valid: false, reason: "invalid-key" };
  }
  const actualKeyId = await keyIdOf(spki);
  if (actualKeyId !== signature.keyId) return { valid: false, keyId: actualKeyId, reason: "key-id-mismatch" };
  if (options.trustedKeyIds !== undefined && !options.trustedKeyIds.includes(signature.keyId)) {
    return { valid: false, keyId: signature.keyId, reason: "untrusted-key" };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", arrayBufferOf(spki), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { valid: false, keyId: signature.keyId, reason: "invalid-key" };
  }
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, arrayBufferOf(base64ToBytes(signature.value)), arrayBufferOf(manifestSigningPayload(manifest)));
  return ok ? { valid: true, keyId: signature.keyId } : { valid: false, keyId: signature.keyId, reason: "bad-signature" };
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
