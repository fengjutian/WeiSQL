# 发布流程

- 状态：**尚未发布到任何 registry**；本文定义首次发布前必须满足的条件
- 适用包：`@weisql/sdk`、`@weisql/duckdb-adapter`、`@weisql/duckdb-wasm-adapter`、`@weisql/usearch-adapter`、`@weisql/cli`
- 自动检查：`npm run release:check`

## 1. 包与依赖方向

```text
@weisql/sdk              （无运行时依赖）
├── @weisql/duckdb-adapter
├── @weisql/duckdb-wasm-adapter
├── @weisql/usearch-adapter
└── @weisql/cli
```

- 四个下游包都依赖 `@weisql/sdk`，方向单向，不允许反向依赖。
- 下游包对 SDK 使用 caret 范围（`^0.1.0`），由 `release:check` 校验：范围必须跟踪本地版本，禁止 `*`。
- 0.x 阶段五个包**同步发版**。原因：0.x 的 minor 升级允许破坏性变更，跨包范围匹配过于脆弱，同步发版能避免「SDK 0.2 + adapter 0.1」的组合没人测过。

## 2. 版本规则（SemVer）

**Major（x.0.0）**：任何需要数据包或调用方改动的变更。

- Manifest V1 的字段、语义或路径规则发生不兼容变化（`formatVersion` 需同步升级）
- 公开 API 的方法签名、返回形状、错误码集合不兼容变化
- `SqlAdapter` / `VectorAdapter` 契约不兼容变化
- CLI 退出码语义变化

**Minor（0.x 递增）**：新增能力且保持兼容。

- 新增可选字段、可选参数、新能力声明字段
- 新增 Adapter 包或新策略（如 `vector-first`）
- 新增 CLI 子命令或 `--json` 字段

**Patch**：修复缺陷、性能、文档，无契约变化。

**判定为破坏性的具体例子**（避免临场争论）：

| 变更 | 级别 |
| --- | --- |
| `VectorHit` 增加必填字段 | Major |
| `VectorHit.diagnostics` 增加可选字段 | Minor |
| 错误码重命名（如 `INDEX_NOT_FOUND`） | Major |
| 新增错误码 | Minor |
| `index.params` 增加一种参数键 | Minor（读取方须拒绝未知必需参数） |
| 默认 `expansionSearch` 调整 | Minor（影响结果，但不影响契约） |
| 修正文档措辞、日志格式 | Patch |

## 3. 发布前检查清单

按顺序执行，任何一步失败即停止：

```bash
npm ci                      # 锁定文件必须干净可复现
npm run build
npm run typecheck
npm test                    # SDK 169 + DuckDB 19 + USearch 12 + CLI 20
npm run release:check       # 打包元数据、依赖范围（含 peer）、README、dist 产物
node packages/cli/dist/bin.js validate examples/fixture --l4   # L1–L4 全链路
```

可选但建议在「声称某能力可用」之前执行：

```bash
npm run probe:browser       # 浏览器路径（需要 Chromium）
npm run probe:playground
npm run probe:parity        # Node ↔ Chromium 语义对照
npm run bench -- --ann      # 刷新基准与召回口径
```

人工检查：

1. `CHANGELOG.md` 已按包更新，且版本号与 `package.json` 一致；
2. 每个包 `README.md` 的能力描述与实际实现一致（不得出现「已支持」但只有设计文档的能力）；
3. **LICENSE 已确定**（见 §7）；
4. 任何新增的性能或召回数字都带环境与口径，且不是单机一次运行的结论。

打包内容预检：

```bash
npm run release:pack          # tarball content check for every workspace, no publishing
npm run release:pack:self-test  # proves the checks reject source/test/license problems
```

打包内容预检：

```bash
npm run release:pack          # tarball content check for every workspace, no publishing
npm run release:pack:self-test  # proves the checks reject source/test/license problems
npm run release:publish       # preflight + per-package `npm publish --dry-run`
```

确认产物只包含 `dist/`、`README.md`、`package.json`，不包含源码、`node_modules` 或测试。

## 4. 发布

发布脚本按依赖顺序执行，默认是 **dry run**（不发布任何东西）：

```bash
npm run release:publish                 # 预检 + 每个包 npm publish --dry-run
npm run release:publish -- --apply      # 真正发布，不可撤销
npm run release:publish -- --apply --otp 123456
```

脚本在第一个包离开本机前完成检查：npm 登录态（`npm whoami`）、`@weisql` scope 归属、每个包的 `dist/index.js` 是否存在、目标版本在 registry 上是否仍是 404、工作区是否干净。任一包的目标版本已存在就整体中止——0.x 阶段五个包同步发版，不允许只发一半。发布过程中途失败时，脚本会列出已发布的包和仍未发布的包，并提示版本不可回退。

手动发布的等价命令（顺序不能变，SDK 必须最先）：

```bash
npm publish --workspace @weisql/sdk
npm publish --workspace @weisql/duckdb-adapter
npm publish --workspace @weisql/duckdb-wasm-adapter
npm publish --workspace @weisql/usearch-adapter
npm publish --workspace @weisql/cli
```

- 不需要再手写 `--access public`：五个包的 `publishConfig.access` 都是 `public`，`release:check` 会强制这一点。作用域包默认 restricted，免费组织下发布会直接失败。
- 使用 npm token 或 2FA，不要把令牌写进仓库或脚本。
- 已发布版本**不可撤销**；只能 `npm deprecate` 标记并发布补丁。

## 5. 发布后验证

```bash
mkdir /tmp/weisql-install && cd /tmp/weisql-install
npm init -y && npm i @weisql/sdk @weisql/cli
npx weisql validate /path/to/a/real/package
```

再跑一个最小脚本：`open()` → `vector.search()` → 期望 ID 与距离。发布前在本地通过、发布后在干净目录安装失败，说明打包配置有问题。

## 6. 回滚

1. `npm deprecate @weisql/sdk@x.y.z "reason"` 标记问题版本；
2. 修复后发布 `x.y.z+1`（或 y+1 若含契约变化）；
3. 数据包不受影响：Manifest V1 与包格式未变时，旧数据包在新 SDK 上仍然可读；
4. 若 Manifest 发生不兼容变化，必须在 `DECISION_LOG.md` 增加 ADR，并提供迁移说明。

## 7. 当前阻塞项

CI 已配置（`.github/workflows/ci.yml`）：`npm ci` → build → typecheck → test → release:check → 示例包校验，Ubuntu 与 Windows 双平台；另有独立作业校验 fixture 可复现性并构建文本/ANN 派生索引。`probe:*` 与 `bench` **不在闸门内**（需要 Chromium / Python / 稳定机器），因此浏览器与性能结论仍须本地验证并在文档中注明环境。

| 项 | 状态 |
| --- | --- |
| npm 组织与访问令牌 | 未配置：本机 `npm whoami` 返回 401，需要 `npm login` 或设置 `NODE_AUTH_TOKEN`；`@weisql` scope 归属需用 `npm org ls weisql` 确认 |
| 多机基准复现 | 未做，`BENCHMARK_HARNESS.md` 的数字仅代表一台机器 |

打包元数据已补齐并由 `release:check` 强制：`publishConfig.access = "public"`、`repository.url` / `repository.directory`、`homepage`、`keywords`。缺少这些字段会直接让检查失败，而不是等到 `npm publish` 才报错。

在 npm 组织与令牌落地之前，不应对外宣称「已发布」。
