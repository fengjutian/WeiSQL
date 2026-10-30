# @weisql/sdk

WeiSQL AI 的只读 TypeScript SDK 骨架。当前版本提供：

- `validateManifest()`：Manifest V1 结构、路径和跨字段校验。
- `open()`：获取并校验远程 Manifest，返回生命周期受控的数据库对象。
- 稳定的 `WeiSQLError` 错误码。
- SQL 与向量查询的公开类型和输入边界。

SQL、Parquet 和向量索引适配器尚未接入。调用查询接口会返回明确的
`SQL_UNSUPPORTED` 或 `INDEX_NOT_FOUND`，不会模拟查询结果。

## 开发

在仓库根目录运行：

```sh
npm install
npm test
npm run typecheck
```

## Manifest 校验

```ts
import { validateManifest } from "@weisql/sdk";

const manifest = validateManifest(JSON.parse(source));
```

校验器除 JSON Schema 中的字段规则外，还检查：

- 路径穿越、绝对路径、反斜杠、URL scheme 和空路径段；
- 所有资源的规范化路径唯一性；
- `primaryKey` 是否引用已声明列；
- 向量的 `sourceTable` 和 `idColumn` 引用；
- 数值是否为 JavaScript 安全整数；
- Manifest 主版本是否受支持。
