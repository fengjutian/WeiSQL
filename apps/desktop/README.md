# WeiSQL Desktop（Tauri 客户端）

用 Tauri 2 + TypeScript 写的 WeiSQL 数据包桌面客户端：打开一个数据包目录或 `.wsql` 单文件，浏览表结构，执行只读 SQL，做精确向量检索与 BM25 全文检索。查询全部在本机完成，不需要数据库服务。

![WeiSQL Desktop](../../docs/assets/desktop-client.png)

## 能做什么

- **打开目录**：通过原生文件对话框选择数据包目录，按需读取字节范围；打开时执行 L3 完整性校验（尺寸 + SHA-256）。
- **打开 `.wsql`**：把单文件容器当作随机访问字节源，只读容器头部和查询涉及的区间，不把整个文件读进内存。
- **概览**：数据集、格式、表、列类型、主键、向量集合、全文索引与能力矩阵。
- **只读 SQL**：DuckDB-Wasm 在 WebView 内运行，首次使用时才加载约 34 MB 的 WASM 和同源的 parquet 扩展；写语句会被适配器拒绝。
- **向量检索**：精确搜索，支持 `topK`；加列过滤时走 `exact-filter-first`（先 SQL 过滤再算距离）。
- **全文检索**：BM25，支持 CJK 按字分词、`topK` 与分数展示。
- **诊断**：读取调用次数、读取字节、SQL 运行时状态。
- 内置示例数据包，首次启动即可试用（浏览器预览模式会自动打开）。

## 运行

前置条件：

- Node.js 20+
- Rust stable（`cargo`、`rustc`）
- Windows 需要 WebView2（Windows 10/11 一般已预装）
- `cargo-tauri` CLI（`cargo install tauri-cli --version "^2"`，本仓库开发机已安装）

```bash
# 仓库根目录
npm install
npm run desktop:dev        # = cd apps/desktop && cargo tauri dev

# 只跑前端（浏览器预览，自动打开内置示例，便于调 UI）
npm run desktop:web
```

首次运行 `apps/desktop/scripts/prepare-assets.mjs` 会：

1. 从 `node_modules/@duckdb/duckdb-wasm/dist` 复制 `duckdb-eh.wasm` 与 worker 到 `public/duckdb/`；
2. 下载（并缓存）与 WASM 内核版本匹配的 `parquet` 扩展到 `public/extensions/<version>/wasm_eh/`；
3. 复制 `examples/fixture` 并在副本上生成全文索引，作为 `public/sample/`。

这些产物都在 `.gitignore` 中，可随时 `node scripts/prepare-assets.mjs --force` 重建。

## 构建安装包

```bash
npm run desktop:build      # = cargo tauri build
```

产物在 `apps/desktop/src-tauri/target/release/bundle/`（Windows 为 MSI/NSIS，macOS 为 app/dmg，Linux 为 deb/AppImage）。只验证编译、不打包时可运行：

```bash
cargo tauri build --debug --no-bundle
```

## 测试

```bash
npm run desktop:test       # 浏览器 E2E：内置示例、SQL、向量检索、全文检索
npm run test:rust --workspace @weisql/desktop   # Rust 命令单元测试（范围、越界、目录遍历）
```

E2E 用系统 Chrome/Edge 或 Playwright 缓存中的 Chromium 跑构建产物（`vite preview`），并输出截图到 `docs/assets/desktop-client.png`。

## 结构

```text
apps/desktop/
├── src/                     # 前端（Vite + 原生 TS，无 UI 框架）
│   ├── app.ts               # 打开包、渲染、SQL/向量/全文交互
│   ├── backend.ts           # Tauri invoke 封装（stat/read_range/read_file/list_files）
│   ├── readers.ts           # ResourceReader / ContainerByteSource / 示例包读取器
│   ├── duckdb.ts            # 懒加载 DuckDB-Wasm 适配器与同源资源 URL
│   ├── dom.ts               # DOM 与格式化辅助
│   ├── node-shim.ts         # 构建期替代 SDK 中未使用的 Node 内置模块
│   └── main.ts              # 启动、拖放
├── src-tauri/
│   ├── src/lib.rs           # 4 个文件读取命令 + 单元测试
│   └── tauri.conf.json      # 窗口、构建、打包配置
├── scripts/
│   ├── prepare-assets.mjs   # WASM / 扩展 / 示例包
│   └── make-icon.mjs        # 生成应用图标源图
└── test/ui.e2e.mjs          # Playwright E2E
```

### 读取路径

```text
WebView (SDK Runtime, DuckDB-Wasm)
   │  ResourceReader.readRange(relativePath, {start, end})
   ▼
CountingReader → BackendDirectoryReader / StreamingContainerReader
   │  invoke("read_range", { path, start, end })
   ▼
Rust: 校验绝对路径、范围边界 → File::seek + read_exact → raw ArrayBuffer
```

- 前端只传绝对路径和字节区间；Rust 侧拒绝相对路径、反向区间、越界区间和超过 512 MiB 的单次读取。
- 目录读取器拒绝 `..`、绝对路径和反斜杠，避免 Manifest 把读取带出用户选择的目录。
- 打开时 `verifyChecksums: "all"`，与 CLI 的 `weisql validate` 使用同一套 L3 校验。
- `.wsql` 走 `StreamingContainerReader`，只在需要时读取容器内的文件区间。

## 已知限制（MVP）

- 只读：没有编辑、导入、构建或签名 UI。
- SQL 结果一次性返回；`sqlStream()` 已在 SDK 中提供，但 UI 暂未接入。
- 未接入 ANN（USearch）适配器；当前只有精确向量检索。
- 打包体积受 DuckDB-Wasm 影响（约 40 MB 量级）；仅在选择 SQL/过滤时才实例化。
- Tauri 的 CSP 目前为 `null`（WASM、Worker 与自定义协议需要）；正式发布前应改为显式白名单。
- 浏览器预览只能打开内置示例，原生文件对话框与 `.wsql` 路径需要 Tauri 运行时。
