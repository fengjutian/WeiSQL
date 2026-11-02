---
title: Builder、完整性与签名 API
description: buildPackage、validateManifest、verifyManifestResources 与 Ed25519 签名、验签、根密钥授权函数的完整签名、选项、默认值和返回类型。
sidebar_position: 75
hero:
  kicker: "API · 构建与签名"
  title: "从 Parquet 到可信发布"
  lead: "Builder、L3 校验、Ed25519 与根授权。"
  chips: ["buildPackage", "L3", "Ed25519"]
hide_title: true
examples: [build]
---


本页汇总“生成并认证数据包”的公开 API：Builder 写出 Manifest 与资源，`verifyManifestResources()` 做 L3 校验，签名函数为 Manifest 绑定发布者身份。读完后你应该能按源码签名正确调用，并知道每个错误来自哪个阶段。

## buildPackage()

```ts
function buildPackage(options: BuildPackageOptions): Promise<BuildReport>;
```

`buildPackage()` 从已有 Parquet、原始向量和业务 ID 生成不可变数据包。它不接受 CSV/JSON，也不推断列类型；Parquet 内容由调用方负责。

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `outputDirectory` | `string` | 无 | 输出目录；会被解析为绝对路径 |
| `datasetId` | `string` | 无 | 非空数据集标识，写入 Manifest |
| `tables` | `readonly BuilderTableInput[]` | 无 | 至少一项，表名不可重复 |
| `vectorCollections` | `readonly BuilderVectorInput[]` | 无 | 至少一项，集合名不可重复 |
| `metadata` | `WeiSQLManifest["metadata"]` | 无 | `title`、`description`、`createdAt`、`builderVersion` |
| `signing` | `{ privateKeyPem: string; publicKeyPem: string }` | 无 | 构建时签名，包落盘即为签名状态 |
| `overwrite` | `boolean` | `false` | 新包通过校验后才替换旧目录 |
| `jobId` | `string` | 随机 UUID | 用于诊断与暂存目录命名 |
| `signal` | `AbortSignal` | 无 | 取消校验阶段；已取消抛 `QUERY_CANCELLED` |

`metadata.builderVersion` 未提供时写入 `"weisql-builder/0.2.0"`；`metadata` 整体未提供时 Manifest 不写该字段。

### BuilderTableInput

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | 表名，写入 Manifest 并用于 `data/<name>.parquet` |
| `parquetPath` | `string` | 是 | 已存在的普通文件；相对路径按当前工作目录解析 |
| `columns` | `readonly ColumnDescriptor[]` | 是 | 至少一列，字段为 `name`、`type`、`nullable` |
| `primaryKey` | `readonly string[]` | 是 | 列名数组；会原样写入 Manifest |
| `rowIds` | `readonly (string \| number)[]` | 否 | Parquet 行顺序的主键值；提供时校验向量 ID 成员关系 |

### BuilderVectorInput

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | 向量集合名 |
| `tableName` | `string` | 是 | 必须引用本批次已声明的表 |
| `idColumn` | `string` | 是 | 必须是该表已声明列 |
| `metric` | `"cosine" \| "l2" \| "ip"` | 是 | 写入 Manifest 的度量 |
| `vectors` | `readonly (Float32Array \| readonly number[])[]` | 是 | 每行一个向量，按 ID Map 行序 |
| `ids` | `readonly (string \| number)[]` | 是 | 与 `vectors` 等长；非空字符串或安全整数 |
| `dimension` | `number` | 空集合时必填 | 正安全整数且不超过 65536，否则取首向量长度 |
| `uniqueIds` | `boolean` | `true` | 为 `true` 时拒绝重复 ID，并生成 `idIndex` |

`BuildStage` 为 `CREATED`、`VALIDATING`、`BUILDING`、`VERIFYING`、`PUBLISHING`、`PUBLISHED`、`FAILED`。成功报告的 `stage` 固定为 `"PUBLISHED"`；失败会抛 `WeiSQLError`，`details` 含 `jobId`、失败时的 `stage`、`stagingCleaned` 与 `outputDirectory`。

### BuildReport

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `jobId` | `string` | 本次构建标识 |
| `datasetId` | `string` | 传入的数据集标识 |
| `stage` | `"PUBLISHED"` | 成功阶段 |
| `outputDirectory` | `string` | 已发布的绝对目录 |
| `manifest` | `WeiSQLManifest` | 已重新读取并校验的 Manifest |
| `artifacts` | `readonly BuildArtifact[]` | 按路径排序的文件清单，含 `path`、`bytes`、`sha256` |
| `integrity` | `IntegrityReport` | 发布前 L3 自检结果 |
| `signature` | `{ keyId: string }` | 仅签名构建存在 |
| `warnings` | `readonly string[]` | 未完全验证的项，见下文 |
| `startedAt` / `finishedAt` | `string` | ISO 时间戳 |

### warnings 与原子发布

未提供 `rowIds` 时，Builder 不伪装已完成成员校验，而是追加格式精确为 `id-membership-unverified:<collectionName>` 的警告。提供 `rowIds` 后，每个向量 ID 都必须出现在该数组中，否则抛 `INVALID_ARGUMENT`；`rowIds` 只用于构建期校验，不写入 Manifest。

- 资源先写入同级暂存目录 `<outputDirectory>.staging-<jobId>`，写完后重新读取并执行 L1/L2 与 `mode: "all"` 的 L3，再为全部文件计算摘要；
- 只有全部通过后才用一次 `rename()` 发布；
- `overwrite: false` 且目标已存在时抛 `INVALID_ARGUMENT`；
- `overwrite: true` 时先把旧目录改名为 `.old-<uuid>`，发布成功后再删除，发布失败则回滚旧目录；
- 拒绝发布到文件系统根、当前工作目录及其祖先，目标存在但不是目录也拒绝；
- 失败会尽力删除暂存目录，异常统一包装为 `WeiSQLError`：保留原错误码，未知异常映射为 `INTERNAL_ERROR`。

## validateManifest()

```ts
function validateManifest(manifest: unknown): WeiSQLManifest;
```

执行 Manifest V1 的 L1/L2 校验：必填字段、标量类型、路径安全、资源路径唯一、主键与列引用、向量集合与表的引用、`count × dimension × 4`、ID Map 偏移字节数、ID 索引类型与签名结构。失败抛 `MANIFEST_INVALID`，`details.issues` 是 `{ path, message }[]`；`formatVersion` 是字符串但不等于 `"1.0.0"` 时抛 `FORMAT_VERSION_UNSUPPORTED`。

返回的是传入对象本身（收窄为 `WeiSQLManifest`），不深拷贝、不补默认值。需要不可变副本时由调用方自行处理。

## verifyManifestResources()

```ts
function verifyManifestResources(input: {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  options?: IntegrityOptions;
}): Promise<IntegrityReport>;
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `"none" \| "manifest" \| "all"` | `"manifest"` | `none` 不访问资源；`manifest` 只比长度；`all` 增量哈希并校验内容 |
| `maxResourceBytes` | `number` | 64 MiB | 单资源声明字节上限，读取前检查 |
| `maxTotalBytes` | `number` | 512 MiB | 全部唯一资源声明字节上限 |
| `chunkBytes` | `number` | 1 MiB | 哈希时的分块大小 |
| `signal` | `AbortSignal` | 无 | 取消校验；触发后抛 `QUERY_CANCELLED` |

三个字节选项必须是正安全整数，否则抛 `INVALID_ARGUMENT`。返回 `IntegrityReport`：`checkedResources`（`stat` 过的唯一资源数）、`sizeVerified`（长度一致数）、`hashesVerified`（完整读取并比对 SHA-256 的数量）、`totalDeclaredBytes`（去重后声明字节总和）。

`mode: "none"` 直接返回全零报告。其余模式先枚举 `declaredResources()` 并累加预算，再逐个重新校验路径、`stat` 尺寸；`all` 模式额外校验向量字节公式、ID Map 偏移/JSONL 与 ID 索引排序。尺寸、摘要或内容不一致抛 `RESOURCE_INTEGRITY_FAILED`，路径不安全抛 `PATH_INVALID`。

## 签名 API

```ts
function generateSigningKeyPair(): Promise<SigningKeyPair>;
function keyIdOf(publicKeySpki: Uint8Array): Promise<string>;
```

`SigningKeyPair` 含 `privateKeyPem`（PKCS#8）、`publicKeyPem`（SPKI）与 `keyId`；`keyIdOf()` 返回公钥 SPKI 的 `sha256:<hex>` 指纹。签名对象 `ManifestSignature` 的字段是 `algorithm: "ed25519"`、`keyId`、`publicKey`（Base64 SPKI）、`value`（Base64 签名）。

```ts
function signManifest(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<WeiSQLManifest>;
function countersignManifest(manifest: WeiSQLManifest, options: SignManifestOptions): Promise<WeiSQLManifest>;
```

`SignManifestOptions` 只有 `privateKeyPem` 与 `publicKeyPem`；WebCrypto 无法从私钥推导公钥，两者必须成对提供。签名覆盖去掉 `signature`/`signatures` 后的规范化 Manifest，并带域分隔符。

- `signManifest()` 替换已有签名，结果只含 `signature`；
- `countersignManifest()` 保留已有签名并追加到 `signatures`；
- 同一 `keyId` 重复协同签名抛 `INVALID_ARGUMENT`；
- 最多 8 个签名（`MAX_SIGNATURES`），超出抛 `INVALID_ARGUMENT`。

```ts
function manifestSignatures(manifest: WeiSQLManifest): ManifestSignature[];
```

`signatures` 非空时按声明顺序返回它；否则返回 `signature` 的单元素数组；都没有则返回空数组。

```ts
function verifyManifestSignature(
  manifest: WeiSQLManifest,
  options?: VerifyManifestSignatureOptions,
): Promise<VerifyManifestSignatureResult>;
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `trustedKeyIds` | 无 | 固定的发布者指纹；不提供时自签名包也会被接受 |
| `minimumTrustedSignatures` | `1` | 至少多少个固定密钥签过；大于 1 时必须提供 `trustedKeyIds` |
| `trustedRootKeyIds` | 无 | 固定根指纹；设置后要求至少一条有效授权链 |
| `now` | `Date.now()` | 覆盖验证时刻，便于确定性测试 |

返回 `valid`、`keyId`（首个签名）、`keyIds`、`reason`、`signatures`（逐个校验结果）、`trustedKeyIds`（实际签名的固定密钥）、`authorizations`，使用根授权时还有 `authorized`。`reason` 取值包括 `missing-signature`、`unsupported-algorithm`、`key-id-mismatch`、`untrusted-key`、`invalid-key`、`bad-signature`、`insufficient-trusted-signatures`、`unauthorized-root`。

```ts
function authorizeSigner(options: AuthorizeSignerOptions): Promise<ManifestAuthorization>;
function addAuthorization(manifest: WeiSQLManifest, authorization: ManifestAuthorization): WeiSQLManifest;
function verifyAuthorizations(manifest: WeiSQLManifest, options?: VerifyAuthorizationOptions): Promise<AuthorizationVerification[]>;
```

`AuthorizeSignerOptions` 包含 `rootPrivateKeyPem`、`rootPublicKeyPem`、`signerPublicKeyPem`、`validFrom`、`validUntil`。有效期是左闭右开区间；时间无法解析或起点不早于终点抛 `INVALID_ARGUMENT`。`addAuthorization()` 返回新 Manifest，不修改入参；同一 `keyId` 重复授权或超过 8 条（`MAX_AUTHORIZATIONS`）抛 `INVALID_ARGUMENT`。授权本身不等于签名：被授权的密钥仍须自己签 Manifest，否则验签结果为 `unsigned-key`。

`verifyAuthorizations()` 逐条返回 `{ keyId, rootKeyId, valid, reason? }`；`reason` 为 `root-signature`、`expired`、`not-yet-valid`、`unsigned-key`、`invalid-key`、`untrusted-root`。`trustedRootKeyIds` 是调用方固定的根指纹；`now` 覆盖当前时间。

## Builder 最小示例

```ts
import { buildPackage } from "@weisql/sdk";

const report = await buildPackage({
  outputDirectory: "./demo",
  datasetId: "demo-documents",
  tables: [{
    name: "documents",
    parquetPath: "./source/documents.parquet",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "title", type: "string", nullable: false },
    ],
    primaryKey: ["id"],
    rowIds: ["doc-001", "doc-002"],
  }],
  vectorCollections: [{
    name: "document_embeddings",
    tableName: "documents",
    idColumn: "id",
    metric: "cosine",
    vectors: [[1, 0], [0, 1]],
    ids: ["doc-001", "doc-002"],
  }],
});

console.log(report.stage, report.integrity.hashesVerified, report.warnings);
```

## 签名与验签示例

```ts
import { generateSigningKeyPair, signManifest, verifyManifestSignature } from "@weisql/sdk";

const release = await generateSigningKeyPair();
const signed = await signManifest(report.manifest, {
  privateKeyPem: release.privateKeyPem,
  publicKeyPem: release.publicKeyPem,
});
const result = await verifyManifestSignature(signed, { trustedKeyIds: [release.keyId] });
console.log(result.valid, result.reason ?? "ok");
```

安全前提：SDK 没有内置信任库。不提供任何固定指纹时，验签只证明包与内嵌公钥一致；签名只覆盖 Manifest，不覆盖资源字节，资源一致性仍需 L3。

## 延伸阅读

- `/docs/tooling/build-package`：构建与发布的操作流程。
- `/docs/sdk/integrity-and-signing`：L3、签名、多签与根授权的使用场景。
- `/docs/sdk/containers`：把构建产物打包为 `.wsql`。
