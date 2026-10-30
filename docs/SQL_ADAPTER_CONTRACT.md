# WeiSQL AI SQL Adapter 契约

- 状态：V1 契约与 Runtime 注入边界已实现；DuckDB 实现待完成
- 首个目标实现：DuckDB（Node.js）与 DuckDB-Wasm（浏览器）

## 1. 职责

SQL Adapter 将 WeiSQL 的统一 SQL 请求交给具体 SQL 引擎。公共 SDK 不暴露 DuckDB connection、relation、extension 等引擎专用类型。

`WeiSQLManifest`、`ResourceReader`、`SQLValue` 和标准错误码由公共类型层统一定义，Adapter 不得创建不兼容副本。

## 2. 接口基线

```ts
export interface SqlQueryOptions {
  signal?: AbortSignal;
}

export interface SqlAdapterCapabilities {
  engine: string;
  engineVersion?: string;
  parameterBinding: boolean;
  parquet: boolean;
  supportedFeatures: readonly string[];
  cancellation: "native" | "best-effort" | "unsupported";
}

export interface SqlAdapterOpenContext {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  signal?: AbortSignal;
}

export interface SqlAdapter {
  readonly capabilities: Readonly<SqlAdapterCapabilities>;

  open(context: SqlAdapterOpenContext): Promise<void>;

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly SQLValue[],
    options?: SqlQueryOptions,
  ): Promise<readonly T[]>;

  close(): Promise<void>;
}
```

V1 的 `ResourceReader` 按逻辑路径提供完整或范围字节读取。路径策略、大小限制和所请求的完整性验证必须在资源交给引擎前完成，详见 `RESOURCE_READER_CONTRACT.md`。

## 3. 生命周期

- 新建 Adapter 后必须先调用 `open()`，成功后才能查询。
- 同一实例重复 `open()` 的行为必须明确；V1 建议拒绝并返回稳定生命周期错误。
- `close()` 必须幂等，可重复调用。
- `close()` 应释放 connection、Worker、WASM、临时注册文件和其他引擎资源。
- 关闭后调用 `query()` 返回 `DATABASE_CLOSED`。
- `open()` 失败后不得留下可查询的半初始化实例。

## 4. 参数绑定与只读边界

- 所有用户值必须通过引擎参数绑定传入，不得拼接到 SQL 字符串。
- `parameterBinding: true` 只有在实际查询路径支持绑定时才能声明。
- 若某操作无法安全绑定参数，该操作不得接受不可信输入。
- V1 只允许只读查询。SDK 与 Adapter 都应阻止写入、DDL、扩展安装和外部副作用；具体语句分类和 DuckDB 防护策略必须由实现测试证明。
- 参数数量或类型不匹配必须转换为稳定、可诊断的 WeiSQL 错误。

## 5. SQL 方言与能力

WeiSQL 不承诺不同引擎具有完整 SQL 方言一致性。`supportedFeatures` 应使用文档化的稳定标识；调用不支持的语法或功能返回 `SQL_UNSUPPORTED`。

能力声明必须反映当前实例和运行时的真实能力，不能根据包名推断。例如浏览器 DuckDB-Wasm 与 Node.js DuckDB 可声明不同功能。

首版只需实现 DuckDB Adapter；接口可替换不等于必须立即支持多个引擎。

## 6. 结果映射

公共 `SQLValue` 为：

```ts
type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
```

Adapter 必须文档化并测试：

- SQL `NULL` 映射为 `null`；
- 超出 JavaScript 安全整数范围的整数不得无提示转为 `number`，应使用 `bigint` 或明确拒绝；
- 二进制值映射为 `Uint8Array`；
- 时间戳到 `Date` 的时区与精度规则；
- Decimal、Interval、嵌套类型等非基础类型的支持状态；
- 列名冲突和引擎专用值的处理。

返回数组和行对象按公共契约视为只读。

## 7. 取消语义

- 查询前已经终止的 `AbortSignal` 必须返回 `QUERY_CANCELLED`。
- `cancellation: native` 表示底层工作确实可中断；`best-effort` 表示 SDK 尝试中断但可能等待底层完成；`unsupported` 表示只停止等待或直接拒绝带取消要求的操作。
- Adapter 不得在底层仍持续消耗资源时虚报“执行已取消”；诊断信息应区分调用方已取消和引擎工作已终止。

## 8. 错误归一化

Adapter 必须将引擎错误转换为 WeiSQL 稳定错误码，不向公共 API 泄漏依赖专用异常类型。诊断信息可以包含引擎、版本和安全的错误摘要，但不得默认记录完整查询、参数或敏感资源内容。

最低映射包括：`DATABASE_CLOSED`、`QUERY_CANCELLED`、`SQL_UNSUPPORTED`、`RESOURCE_NOT_FOUND`、`RESOURCE_INTEGRITY_FAILED` 和 `INTERNAL_ERROR`。

## 9. 一致性测试

每个 SQL Adapter 必须通过同一套契约测试：

1. 打开有效 Manifest 并注册表资源；
2. 参数化值不被解释为 SQL 语法；
3. `null`、大整数、二进制和时间值按规则映射；
4. 不支持功能返回稳定错误；
5. 查询前取消与查询中取消符合能力声明；
6. `close()` 可调用两次；
7. 关闭后查询返回 `DATABASE_CLOSED`；
8. 打开失败不会留下半初始化资源；
9. 只读策略拒绝写入与外部副作用。

当前仓库已提供公共 `SqlAdapter` 类型、Runtime 初始化/查询/关闭接线，以及初始化失败清理和参数透传测试。尚未实现 DuckDB 或 DuckDB-Wasm Adapter；现有测试 Adapter 仅用于验证生命周期契约，不证明真实 SQL 引擎能力。

