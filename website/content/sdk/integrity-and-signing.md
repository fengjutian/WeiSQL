---
title: 完整性与签名
description: 配置 verifyChecksums 做 L3 校验，并用 Ed25519 对 Manifest 签名、固定发布者、要求多签背书或通过根密钥授权。
sidebar_position: 27
---

本页讲两件不同的事：资源完整性（字节是否与 Manifest 声明一致）和 Manifest 签名（发布者身份是否可信）。读完后你能选择校验级别，并用 CLI 或 SDK 完成签名、验签与密钥授权。

## 最小示例

打开时校验全部资源：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  verifyChecksums: "all",
});
```

命令行签名与验签：

```bash
npx weisql keygen --output ./release
npx weisql sign ./demo --key ./release.key.pem --public ./release.pub.pem
npx weisql verify-signature ./demo --trusted sha256:...
```

## verifyChecksums 策略

| 策略 | 行为 | 访问资源 |
| --- | --- | --- |
| `none`（默认） | 只做 L1/L2 | 否 |
| `manifest` | 用 `stat` 比对每个资源的实际长度 | 是，但不整读 |
| `all` | 分块增量计算 SHA-256，并校验 ID Map 与 ID 索引内容 | 是，完整读取 |

`all` 验证字节内容；`manifest` 只保证长度，**不使用 `all` 就无法发现同长度的内容篡改**。

`open({ verifyChecksums })` 在 Adapter 接触资源之前完成；非 `none` 时必须同时提供 `resourceReader`，否则 `INVALID_ARGUMENT`。校验失败会关闭 Reader，不会留下半开实例。

## verifyManifestResources()

也可以脱离 `open()` 单独调用：

```ts
import { verifyManifestResources, NodeFileResourceReader } from "@weisql/sdk";

const report = await verifyManifestResources({
  manifest,
  reader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  options: { mode: "all", chunkBytes: 1024 * 1024 },
});

console.log(report.checkedResources, report.sizeVerified, report.hashesVerified);
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `"none" \| "manifest" \| "all"` | `"manifest"` | 单独调用时默认校验尺寸 |
| `maxResourceBytes` | `number` | 64 MiB | 单资源声明字节上限 |
| `maxTotalBytes` | `number` | 512 MiB | 全部唯一资源声明字节上限 |
| `chunkBytes` | `number` | 1 MiB | 哈希时的分块大小 |
| `signal` | `AbortSignal` | 无 | 取消校验 |

返回 `IntegrityReport`：`checkedResources`、`sizeVerified`、`hashesVerified`、`totalDeclaredBytes`。三个计数刻意分开：“检查了声明”“验证了实际长度”“完整读取并验证了哈希”不是同一件事。

流程：

1. 枚举 Manifest 声明去重后的资源；
2. 累加声明字节，并在读取前检查单资源与总预算；
3. 再次校验规范相对路径；
4. 调用 `stat`，实际长度必须等于 `bytes`；
5. `all` 模式下分块读取全文并比对 SHA-256；
6. `all` 模式额外校验向量字节公式、ID Map 偏移与 JSONL 内容、ID 索引的排序与行覆盖。

`mode: "none"` 返回全零报告，不访问 Reader。

## 完整性错误

| 情况 | 错误码 |
| --- | --- |
| 声明尺寸不符、短读、摘要不符 | `RESOURCE_INTEGRITY_FAILED` |
| 预算超限 | `RESOURCE_INTEGRITY_FAILED` |
| ID Map 偏移或 JSONL 损坏 | `RESOURCE_INTEGRITY_FAILED` |
| ID 索引未排序、重复行或类型不符 | `RESOURCE_INTEGRITY_FAILED` |
| 路径不安全 | `PATH_INVALID` |
| 操作被取消 | `QUERY_CANCELLED` |
| Reader 不报告 `size` | `RESOURCE_INTEGRITY_FAILED` |

SHA-256 只证明“内容与 Manifest 声明一致”，不证明发布者身份。来源真实性要靠 HTTPS/CDN 或下面的签名。

## Manifest 签名

`signManifest()` 使用 Ed25519（WebCrypto），签名覆盖去掉 `signature`/`signatures` 后的规范化 Manifest：

```ts
import { signManifest, verifyManifestSignature } from "@weisql/sdk";

const signed = await signManifest(manifest, {
  privateKeyPem,
  publicKeyPem,          // WebCrypto 无法从私钥推导公钥，必须一起提供
});

const result = await verifyManifestSignature(signed, {
  trustedKeyIds: ["sha256:..."],
});
console.log(result.valid, result.keyId, result.reason);
```

签名对象的字段：`algorithm: "ed25519"`、`keyId`、`publicKey`（Base64 SPKI）、`value`（Base64 签名）。`keyId` 是公钥 SPKI 的 SHA-256 指纹，格式 `sha256:<hex>`。签名载荷带域分隔符，避免被当作其他文档的签名重放。

| API | 行为 |
| --- | --- |
| `signManifest()` | 替换已有签名，只保留一个 |
| `countersignManifest()` | 追加协同签名，保留已有签名 |
| `manifestSignatures()` | 返回生效的签名列表 |

协同签名最多 8 个；同一 `keyId` 重复签名抛 `INVALID_ARGUMENT`。`--add` 用于密钥轮换：新密钥先协同签名，等消费者都固定新指纹后再移除旧签名。

## 验签策略

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `trustedKeyIds` | 无 | 固定的发布者指纹；不提供时自签名包也会被接受 |
| `minimumTrustedSignatures` | `1` | 至少多少个固定密钥签过名；大于 1 时必须提供 `trustedKeyIds` |
| `trustedRootKeyIds` | 无 | 固定根指纹；设置后要求至少一条有效授权链 |
| `now` | `Date.now()` | 覆盖当前时间，便于确定性测试 |

返回字段包括 `valid`、`keyId`（首个签名）、`keyIds`、`reason`、`signatures`（逐个签名的校验结果）、`trustedKeyIds`（实际签名的固定密钥）与 `authorizations`；使用根授权时还有 `authorized`。

`reason` 的取值：`missing-signature`、`unsupported-algorithm`、`key-id-mismatch`、`untrusted-key`、`invalid-key`、`bad-signature`、`insufficient-trusted-signatures`、`unauthorized-root`。

安全前提：SDK 没有内置信任库。不提供任何固定指纹时，验签只证明“包与其内嵌公钥一致”，不能证明发布者是谁。

## 根密钥授权

根密钥可以授权一个发布密钥，消费者只固定根指纹：

```ts
import { authorizeSigner, addAuthorization } from "@weisql/sdk";

const authorization = await authorizeSigner({
  rootPrivateKeyPem,
  rootPublicKeyPem,
  signerPublicKeyPem,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
});

const next = addAuthorization(manifest, authorization);
```

授权载荷绑定 `rootKeyId`、`rootPublicKey`、`keyId`、`publicKey` 与有效期；有效期是左闭右开。授权记录最多 8 条，同一 `keyId` 不能重复授权。

`verifyAuthorizations()` 逐条返回 `valid` 与 `reason`：`root-signature`、`expired`、`not-yet-valid`、`unsigned-key`、`invalid-key`、`untrusted-root`。注意两个独立条件：

- 被授权的密钥必须自己也签了 Manifest，否则是 `unsigned-key`；
- 授权必须由固定的根签发且在有效期内，否则不构成有效链。

## CLI

```bash
npx weisql keygen --output ./release
npx weisql sign ./demo --key ./release.key.pem
npx weisql sign ./demo --key ./rotate.key.pem --add
npx weisql verify-signature ./demo --trusted sha256:... --require 1
npx weisql authorize ./demo --root ./root.key.pem --signer ./release.pub.pem \
  --key ./release.key.pem --days 365
npx weisql validate ./demo --signature --trusted-root sha256:...
```

`authorize` 会修改 Manifest，而已有签名不再覆盖新内容；传入 `--key` 可在同一步重新签名，否则会报错要求重新签名。`validate --signature` 把签名检查并入发布前校验，`--trusted`、`--require`、`--trusted-root` 可组合使用。

## 行为边界

- 签名只覆盖 Manifest，不覆盖资源字节；资源一致性由 L3 负责，两者需要同时使用。
- `verifyChecksums` 与签名互不替代：前者防损坏，后者证明持钥者发布过该 Manifest。
- 不支持证书链、时间戳服务或阈值签名；多签是验证方策略，每个签名者仍持有完整私钥。
- 浏览器与 Node 共用同一 WebCrypto 实现，但真实浏览器的密钥导入行为未在所有版本上验证。
- CLI 的密钥文件权限、HSM 与密钥托管不在范围内。

## 延伸阅读

- [资源完整性校验规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_INTEGRITY_SPEC.md)
- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
- [发布流程](https://github.com/fengjutian/WeiSQL/blob/main/docs/RELEASE_PROCESS.md)
