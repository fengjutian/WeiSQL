# WeiSQL AI 文档与基准工程

当前版本：文档与 Rust 精确搜索基线 `0.2.0-draft`

> 状态说明：技术规范和 API 仍是草案。Rust exact-search 基线是一个小型可运行的正确性参考实现，不是生产级向量引擎；没有任何性能结论在未运行的情况下被预先声称。

## 文档

- `docs/TECHNICAL_SPEC_V1.md`：总体技术规范和架构。
- `docs/ENGINEERING_ROADMAP.md`：工程设计补充、测试矩阵和 P0–P3 实施路线。
- `docs/MANIFEST_SPEC_V1.md`：Manifest V1 字段、版本、向量数据与完整性规则。
- `docs/MANIFEST_SCHEMA_V1.json`：Manifest JSON Schema 草案。
- `docs/MANIFEST_SCHEMA_V1_CANDIDATE.json`：待评审的新字段形状候选，不用于当前 Runtime。
- `docs/SQL_ADAPTER_CONTRACT.md`：SQL 引擎适配器生命周期、参数绑定与结果映射契约。
- `docs/VECTOR_ADAPTER_CONTRACT.md`：向量引擎适配器距离、过滤、ID 与排序契约。
- `docs/RESOURCE_READER_CONTRACT.md`：浏览器与 Node.js 的统一资源读取、安全和 Range 契约。
- `docs/BENCHMARK_PROTOCOL_V1.md`：性能测试协议。
- `docs/SDK_API_CONTRACT_V1.md`：TypeScript SDK 语义、错误码和安全边界。
- `docs/DECISION_LOG.md`：架构决策及冻结条件。
- `examples/manifest/valid-minimal.json`：有效 Manifest 结构样例（文件摘要和大小仅为示例占位，不对应真实 Parquet 文件）。
- `examples/manifest/invalid-traversal.json`：路径穿越负例。
- `crates/vector-benchmark/`：标准库 Rust exact cosine-search baseline 和测试。

## 运行 Rust 基线

需要安装 Rust stable 工具链。在本目录运行：

```bash
cargo test --manifest-path crates/vector-benchmark/Cargo.toml
cargo run --release --manifest-path crates/vector-benchmark/Cargo.toml -- 10000 128 10
```

参数依次为向量数量、维度、Top-K。默认数据是确定性合成数据，适用于冒烟验证；性能对比前应使用 `BENCHMARK_PROTOCOL_V1.md` 中定义的数据集、预热、重复次数和环境记录。

## 重要限制

- 当前没有实现 DuckDB、USearch、WASM、Netlify 适配器。
- 当前没有实现 `.wsql` 二进制容器。
- Manifest 运行时校验器已覆盖路径唯一、表/列引用等主要跨字段规则；真实资源的字节数和 SHA-256 内容校验仍未实现。
- 不要把样例里的 SHA-256 和字节数作为真实文件信息。
