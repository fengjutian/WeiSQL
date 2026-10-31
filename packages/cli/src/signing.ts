import { createPublicKey } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContainerReader, addAuthorization, authorizeSigner, countersignManifest, createContainer, generateSigningKeyPair, manifestSignatures, signManifest, validateManifest, verifyManifestSignature } from "@weisql/sdk";
import type { VerifyManifestSignatureResult, WeiSQLManifest } from "@weisql/sdk";

export interface SigningKeyFiles {
  keyId: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

/** Writes an Ed25519 key pair; the private key is created with mode 0600. */
export async function generateKeyFiles(prefix: string): Promise<SigningKeyFiles> {
  const resolved = path.resolve(prefix);
  const pair = await generateSigningKeyPair();
  const privateKeyPath = `${resolved}.key.pem`;
  const publicKeyPath = `${resolved}.pub.pem`;
  await writeFile(privateKeyPath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
  await chmod(privateKeyPath, 0o600).catch(() => undefined);
  await writeFile(publicKeyPath, pair.publicKeyPem, "utf8");
  return { keyId: pair.keyId, privateKeyPath, publicKeyPath };
}

export interface SignPackageOptions {
  /** Package directory or `.wsql` container. */
  target: string;
  privateKeyPath: string;
  /** Optional; derived from the private key with node:crypto when omitted. */
  publicKeyPath?: string;
  /** Add a co-signature instead of replacing existing ones (key rotation). */
  add?: boolean;
}

export interface SignPackageResult {
  target: string;
  kind: "directory" | "container";
  keyId: string;
  keyIds: readonly string[];
  datasetId: string;
}

export async function signPackage(options: SignPackageOptions): Promise<SignPackageResult> {
  const target = path.resolve(options.target);
  const privateKeyPem = await readFile(options.privateKeyPath, "utf8");
  const publicKeyPem = options.publicKeyPath === undefined
    ? createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString()
    : await readFile(options.publicKeyPath, "utf8");

  const isContainer = path.extname(target).toLowerCase() === ".wsql";
  if (!isContainer) {
    const manifestPath = path.join(target, "manifest.json");
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    const signed = await applySignature(manifest, options.add === true, { privateKeyPem, publicKeyPem });
    await writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
    return { target, kind: "directory", keyId: signed.signature?.keyId ?? manifestKeys(signed)[0]!, keyIds: manifestKeys(signed), datasetId: manifest.datasetId };
  }

  const reader = new ContainerReader(new Uint8Array(await readFile(target)));
  try {
    const manifestEntry = reader.header.files.find(entry => entry.path === "manifest.json");
    if (manifestEntry === undefined) throw new Error("container has no manifest.json");
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(await reader.read("manifest.json"))));
    const signed = await applySignature(manifest, options.add === true, { privateKeyPem, publicKeyPem });
    const files = [];
    for (const entry of reader.header.files) {
      files.push({
        path: entry.path,
        bytes: entry.path === "manifest.json"
          ? new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}\n`)
          : await reader.read(entry.path),
      });
    }
    const container = await createContainer(files, { compress: reader.header.compression === "gzip" });
    await writeFile(target, container);
    return { target, kind: "container", keyId: signed.signature?.keyId ?? manifestKeys(signed)[0]!, keyIds: manifestKeys(signed), datasetId: manifest.datasetId };
  } finally {
    await reader.close();
  }
}

export interface VerifySignatureOptions {
  target: string;
  trustedKeyIds?: readonly string[];
  /** How many pinned keys must have signed (endorsement policy). */
  minimumTrustedSignatures?: number;
  /** Root fingerprints pinned instead of individual signer keys. */
  trustedRootKeyIds?: readonly string[];
}

export interface VerifySignatureResult extends VerifyManifestSignatureResult {
  target: string;
  kind: "directory" | "container";
  datasetId: string;
}

export async function verifyPackageSignature(options: VerifySignatureOptions): Promise<VerifySignatureResult> {
  const target = path.resolve(options.target);
  const isContainer = path.extname(target).toLowerCase() === ".wsql";
  let manifest: WeiSQLManifest;
  let kind: "directory" | "container";

  if (isContainer) {
    const reader = new ContainerReader(new Uint8Array(await readFile(target)));
    try {
      manifest = validateManifest(JSON.parse(new TextDecoder().decode(await reader.read("manifest.json"))));
    } finally {
      await reader.close();
    }
    kind = "container";
  } else {
    manifest = validateManifest(JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8")));
    kind = "directory";
  }

  const result = await verifyManifestSignature(manifest, {
    ...(options.trustedKeyIds === undefined ? {} : { trustedKeyIds: options.trustedKeyIds }),
    ...(options.minimumTrustedSignatures === undefined ? {} : { minimumTrustedSignatures: options.minimumTrustedSignatures }),
    ...(options.trustedRootKeyIds === undefined ? {} : { trustedRootKeyIds: options.trustedRootKeyIds }),
  });
  return { ...result, target, kind, datasetId: manifest.datasetId };
}

export interface AuthorizePackageOptions {
  target: string;
  /** Root private key; the root public key is derived with node:crypto. */
  rootPrivateKeyPath: string;
  /** The release key being authorized. */
  signerPublicKeyPath: string;
  /** Validity window length in days, starting now. */
  days: number;
  /** When given, the package is re-signed with this key in the same step. */
  signerPrivateKeyPath?: string;
  now?: number;
}

export interface AuthorizePackageResult {
  target: string;
  kind: "directory" | "container";
  rootKeyId: string;
  keyId: string;
  validFrom: string;
  validUntil: string;
  resigned: boolean;
  keyIds: readonly string[];
  datasetId: string;
}

/**
 * Adds a root-key authorization. Because the delegation is part of the signed
 * payload, adding one to an already-signed package invalidates the signature;
 * the caller must pass the signer key so the package leaves valid.
 */
export async function authorizePackage(options: AuthorizePackageOptions): Promise<AuthorizePackageResult> {
  if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 3650) {
    throw new Error("--days must be an integer between 1 and 3650");
  }
  const target = path.resolve(options.target);
  const isContainer = path.extname(target).toLowerCase() === ".wsql";
  const rootPrivateKeyPem = await readFile(options.rootPrivateKeyPath, "utf8");
  const rootPublicKeyPem = createPublicKey(rootPrivateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const signerPublicKeyPem = await readFile(options.signerPublicKeyPath, "utf8");
  const start = options.now ?? Date.now();
  const authorization = await authorizeSigner({
    rootPrivateKeyPem,
    rootPublicKeyPem,
    signerPublicKeyPem,
    validFrom: new Date(start).toISOString(),
    validUntil: new Date(start + options.days * 86_400_000).toISOString(),
  });

  const signerPrivateKeyPem = options.signerPrivateKeyPath === undefined
    ? undefined
    : await readFile(options.signerPrivateKeyPath, "utf8");

  const apply = async (manifest: WeiSQLManifest): Promise<WeiSQLManifest> => {
    let next = addAuthorization(manifest, authorization);
    if (signerPrivateKeyPem !== undefined) {
      next = await signManifest(next, { privateKeyPem: signerPrivateKeyPem, publicKeyPem: signerPublicKeyPem });
      return next;
    }
    if (manifestSignatures(next).length > 0) {
      throw new Error("existing signatures no longer cover the manifest; pass --key to re-sign");
    }
    return next;
  };

  if (!isContainer) {
    const manifestPath = path.join(target, "manifest.json");
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    const next = await apply(manifest);
    await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return {
      target,
      kind: "directory",
      rootKeyId: authorization.rootKeyId,
      keyId: authorization.keyId,
      validFrom: authorization.validFrom,
      validUntil: authorization.validUntil,
      resigned: signerPrivateKeyPem !== undefined,
      keyIds: manifestKeys(next),
      datasetId: manifest.datasetId,
    };
  }

  const reader = new ContainerReader(new Uint8Array(await readFile(target)));
  try {
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(await reader.read("manifest.json"))));
    const next = await apply(manifest);
    const files = [];
    for (const entry of reader.header.files) {
      files.push({
        path: entry.path,
        bytes: entry.path === "manifest.json"
          ? new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`)
          : await reader.read(entry.path),
      });
    }
    const container = await createContainer(files, { compress: reader.header.compression === "gzip" });
    await writeFile(target, container);
    return {
      target,
      kind: "container",
      rootKeyId: authorization.rootKeyId,
      keyId: authorization.keyId,
      validFrom: authorization.validFrom,
      validUntil: authorization.validUntil,
      resigned: signerPrivateKeyPem !== undefined,
      keyIds: manifestKeys(next),
      datasetId: manifest.datasetId,
    };
  } finally {
    await reader.close();
  }
}

/** Unused helper kept for symmetry with the container tests. */
export async function withTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-sign-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function applySignature(
  manifest: WeiSQLManifest,
  add: boolean,
  keys: { privateKeyPem: string; publicKeyPem: string },
): Promise<WeiSQLManifest> {
  return add ? countersignManifest(manifest, keys) : signManifest(manifest, keys);
}

function manifestKeys(manifest: WeiSQLManifest): string[] {
  if (manifest.signatures !== undefined && manifest.signatures.length > 0) return manifest.signatures.map(item => item.keyId);
  return manifest.signature === undefined ? [] : [manifest.signature.keyId];
}
