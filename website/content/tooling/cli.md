---
title: CLI
description: 用 weisql 命令校验、打包、解包、检查与签名数据包，掌握每个选项、默认值和退出码。
sidebar_position: 40
---

`@weisql/cli` 是数据包的命令行入口：校验目录或 `.wsql` 容器、打包解包、生成与验证签名、授权发布密钥，以及在不打开 Runtime 的情况下检查包内容。读完本页你应当能把 `validate` 接进 CI，并选对容器与签名相关命令。

CLI 很薄：校验逻辑都在 `@weisql/sdk`，这一层只负责解析参数、格式化输出与退出码。

## 最小示例

```bash
# 校验目录（默认 L1/L2 + L3 尺寸与 SHA-256）
npx weisql validate ./examples/fixture

# 额外核对 Parquet 内容（需要 @weisql/duckdb-adapter）
npx weisql validate ./examples/fixture --l4

# 打包成单文件，并检查未经 Manifest 声明的文件
npx weisql pack ./examples/fixture --output ./examples/fixture.wsql
npx weisql inspect ./examples/fixture
```

成功时最后一行是 `OK`；失败时 stderr 打印 `FAILED (n issues)` 与逐条 `[stage] CODE: message`。仓库当前尚未发布 npm 包，本地开发可直接用 `node packages/cli/dist/bin.js` 替代 `npx weisql`，参见 [快速开始](/start/quickstart)。

## 命令一览

| 命令 | 目标 | 作用 |
| --- | --- | --- |
| `validate <dir\|file.wsql>` | 目录或容器 | 逐级校验 Manifest、资源完整性与可选 L4/签名 |
| `pack <dir>` | 目录 | 打包成 `.wsql`，可 gzip、可只打声明资源 |
| `unpack <file.wsql>` | 容器 | 先验证全部摘要，再解包到目录 |
| `keygen` | 无 | 生成 Ed25519 密钥对 |
| `sign <dir\|file.wsql>` | 目录或容器 | 签名 Manifest，或追加协同签名 |
| `verify-signature <dir\|file.wsql>` | 目录或容器 | 验证签名，可固定发布者或根密钥 |
| `authorize <dir\|file.wsql>` | 目录或容器 | 用根密钥授权发布密钥，并写入有效期 |
| `inspect <dir\|file.wsql>` | 目录或容器 | 汇总表、向量、全文索引、签名与未声明文件 |

## 选项

| 选项 | 适用命令 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--mode <none\|manifest\|all>` | `validate` | `all` | `all` 校验尺寸与 SHA-256；`manifest` 只校验尺寸；`none` 只做结构校验 |
| `--l4` | `validate` | 关闭 | 通过 DuckDB 核对 Parquet 列名、类型与行数 |
| `--signature` | `validate` | 关闭 | 要求存在有效 Manifest 签名 |
| `--trusted <keyId>` | `validate` / `verify-signature` | 未设置 | 固定发布者指纹，可重复 |
| `--require <n>` | `validate` / `verify-signature` | 未设置 | 要求 n 个固定密钥都签过名（背书策略） |
| `--trusted-root <keyId>` | `validate` / `verify-signature` | 未设置 | 固定根密钥指纹，可重复 |
| `--key <pem>` | `sign` / `authorize` | 未设置 | `sign` 的私钥；`authorize` 的可选重签私钥 |
| `--public <pem>` | `sign` | 从私钥派生 | 公钥路径 |
| `--add` | `sign` | 关闭 | 追加协同签名，而不是替换已有签名 |
| `--root <pem>` | `authorize` | 必填 | 根私钥 |
| `--signer <pem>` | `authorize` | 必填 | 被授权的发布公钥 |
| `--days <n>` | `authorize` | 365 | 授权有效期，取值 1–3650 |
| `--compress` | `pack` | 关闭 | 逐条目 gzip，容器格式 1.1.0 |
| `--only-declared` | `pack` | 关闭 | 只打包 Manifest 与声明资源，报告被跳过的文件 |
| `--output <path\|prefix>` | `pack` / `unpack` / `keygen` | 见各命令 | 输出路径或密钥前缀 |
| `--json` | 大多数命令 | 关闭 | 输出机器可读 JSON |
| `--help`, `-h` | 全局 | — | 打印用法 |

## 行为与边界

- 目标是普通文件时按 `.wsql` 容器处理，否则按目录处理；两条路径共用同一套 Manifest 校验。
- 失败不会修改输入包；`pack`/`unpack` 只写 `--output` 指定的位置，`sign`/`authorize` 才会改写 Manifest 或容器。
- 退出码只有 0、1、2 三种，适合直接作为 CI 闸门。
- `--json` 只改变输出格式，不改变校验范围。
- `--l4` 会实际打开包并加载 DuckDB，因此需要可用的 `@weisql/duckdb-adapter` 与本机原生绑定。
- 打包与解包都保留包内相对路径；容器条目按路径排序，压缩是逐条目的。

## validate

校验顺序是固定的：

1. `manifest.json` 存在、可解析，并通过 Manifest V1 L1/L2 校验；
2. 按 `--mode` 校验每个声明资源：`all` 尺寸 + SHA-256，`manifest` 只校验尺寸，`none` 跳过资源；
3. 指定 `--l4` 时，通过 DuckDB 打开包并核对 Parquet；
4. 指定 `--signature` 时验证签名与信任策略。

目标是 `.wsql` 文件时自动走容器分支：先校验容器每个条目的摘要，再按 Manifest 做同样的 L1/L2/L3。`--json` 输出包含 `ok`、`target`、`kind`、`mode`、`datasetId`、`container`、`l4`、`signature`、`integrity` 与 `issues`；每个 issue 带 `stage`、稳定 `code`、消息与 `details`（例如 `details.path`）。

`--mode manifest` 只能发现长度变化，无法发现同长度内容篡改；这是模式的既定差异，不是 bug。`--l4` 在没有安装 `@weisql/duckdb-adapter` 时报告 `[l4] SQL_UNSUPPORTED`，不会崩溃。

## pack 与 unpack

```bash
npx weisql pack ./my-package --output ./my-package.wsql
npx weisql pack ./my-package --compress --output ./my-package.wsql
npx weisql pack ./my-package --only-declared --output ./my-package.wsql
npx weisql unpack ./my-package.wsql --output ./extracted
```

- `pack` 递归收集目录、按路径排序，要求存在 `manifest.json`；`--output` 省略时写到当前目录的 `<目录名>.wsql`；
- `--compress` 逐条目 gzip，写入容器格式 `1.1.0`；不加时是未压缩的 `1.0.0`；
- `--only-declared` 只保留 Manifest 与声明资源；声明资源缺失会直接报错，未声明文件会列在 `skipped` 中；
- `unpack` **先校验全部摘要再写盘**，被篡改的容器不会留下半可信目录；`--output` 省略时用去掉扩展名的文件名；
- 容器路径包含 `..`、绝对路径、反斜杠或空段时，解析阶段即拒绝。

`pack` 不接受 `--mode`，传了会以用法错误退出。容器格式与读取方式见 [容器与完整性](/sdk/containers)。

## 签名与授权

```bash
npx weisql keygen --output ./keys/release
npx weisql sign ./my-package --key ./keys/release.key.pem
npx weisql verify-signature ./my-package --trusted <keyId>
npx weisql authorize ./my-package \
  --root ./keys/root.key.pem \
  --signer ./keys/release.pub.pem \
  --key ./keys/release.key.pem \
  --days 365
```

- `keygen` 以 `--output` 为前缀，写出 `<prefix>.key.pem`（权限 0600）与 `<prefix>.pub.pem`，并打印 `keyId`；省略时前缀是 `weisql-signing-key`；
- `sign --key` 是必填项；`--public` 省略时从私钥派生；`--add` 追加协同签名，用于密钥轮换；
- `verify-signature` 支持 `--trusted`、`--require`、`--trusted-root`；签名有效退出 0，无效退出 1；
- `authorize` 需要 `--root` 与 `--signer`，`--days` 默认 365；带 `--key` 时会在同一步重新签名，因为授权声明本身在被签名载荷内；
- 对 `.wsql` 容器签名会重写容器，并保留原有压缩方式。

签名证明「持有对应私钥」，不证明发布者身份本身；消费者仍需通过 `--trusted` 或 `--trusted-root` 固定信任锚。

## inspect

`inspect` 不打开 Runtime，也不执行查询，只读取 Manifest 与目录/容器条目，输出：

- 表名、列数与字节数；
- 向量集合的数量、维度、度量与是否存在持久化索引；
- 全文索引的文档数、词项数与是否包含正文；
- 签名是否存在、是否有效；
- 声明文件数、声明字节数，以及**存在但未被 Manifest 声明的文件**。

它适合发布前发现漏传、多传与忘记签名的包。容器模式下会额外显示文件数与压缩方式。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 包有效，或命令成功 |
| `1` | 包无效，或命令执行失败（校验失败、签名无效、摘要不符） |
| `2` | 用法错误（未知命令/选项、缺少参数、非法 `--mode`） |

CI 可以直接依赖这三个码：校验失败与参数写错必须区分开。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 退出码 2，`unknown option` | 选项拼写错误或该命令不支持 | 对照上表；`--mode` 只属于 `validate` |
| `[manifest] RESOURCE_NOT_FOUND` | 目录里没有 `manifest.json` | 确认目标路径与包根 |
| `[resources] RESOURCE_INTEGRITY_FAILED` | 尺寸或 SHA-256 不符、ID Map 内容不一致 | 重新构建包，不要手改摘要 |
| `[l4] SQL_UNSUPPORTED` | 未安装 `@weisql/duckdb-adapter` | 安装适配器，或去掉 `--l4` |
| `SIGNATURE_INVALID` | 签名被篡改、密钥不匹配或授权过期 | 重新签名/授权，核对 `--trusted` 指纹 |
| `unpack` 拒绝写入 | 容器条目路径越界或摘要不符 | 视为不可信容器，不要绕过校验 |

## 延伸阅读

- [构建数据包](/tooling/build-package)：`buildPackage()` 如何生成可校验的包。
- [容器与完整性](/sdk/containers)：`.wsql` 布局与 `ContainerReader`。
- [完整性与签名](/sdk/integrity-and-signing)：Ed25519 签名与信任策略。
- [部署到 CDN](/tooling/deploy-cdn)：打包之后的上传与托管要求。
- [Manifest 参考](/reference/manifest)：各字段的语义。
- [容器格式](https://github.com/fengjutian/WeiSQL/blob/main/docs/WSQL_CONTAINER.md)。
