# 可运行的前端框架示例

`website/content/examples/frameworks.md` 里的代码在这里有对应实现，并由 Chromium 冒烟测试保证「文档里的代码真的能跑」。

## 组成

```text
examples/frameworks/
├── run.mjs              # 构建所有 app + 跑冒烟
├── smoke.mjs            # Playwright 断言：READY、命中数、206 分段读取
├── serve.mjs            # 支持 Range 的静态服务器（Vite preview 不保证 206）
├── sync-fixture.mjs     # 把 examples/fixture 复制进各 app 的静态目录
├── vite-react/          # Vite + React 示例（文档 2.x）
│   ├── src/useWeiSQL.ts # 文档 2.1 节的 hook，逐行对应
│   └── src/App.tsx      # 打开数据包、跑一次向量检索并发布 window.__SMOKE_RESULT
└── sveltekit/           # SvelteKit 示例（文档 6.x）
    └── src/routes/+page.svelte  # onMount + $state.raw，与文档 6.1 对应
```

数据包是生成产物：`sync-fixture.mjs` 从 `examples/fixture` 复制，各 app 的 `public/datasets/` 与 `static/datasets/` 都已被 gitignore。

## 运行

```bash
npm run build                 # 仓库根目录，先生成 packages/sdk/dist
npm run frameworks:install    # 只装示例 app 的依赖（不是 workspace）
npm run test:frameworks       # 构建 app + Chromium 冒烟
```

`test:frameworks` 需要 `playwright-core`（根依赖）与任意 Chromium：Playwright 缓存、`CHROME_PATH`、系统 Chrome/Edge 都可以。找不到浏览器时脚本以退出码 2 结束，不会静默跳过。

## 冒烟断言

页面在 `window.__SMOKE_RESULT` 发布结果，脚本据此断言：

- `state === "READY"`，`capabilities().vectorExactSearch === true`；
- 向量检索返回 3 条命中（fixture 是 3 行、2 维、cosine）；
- 服务器至少记录到一次 `.f32` 的 `206 Partial Content`——证明数据包是按 Range 分段读取，而不是整包下载；
- `/datasets/` 下没有任何 4xx/5xx（浏览器自己请求的 `/favicon.ico` 不计）。

## 新增一个框架

1. 在 `examples/frameworks/<name>/` 建 app，`@weisql/sdk` 用 `file:../../../packages/sdk` 引用；
2. 让页面在打开数据包并完成一次查询后写入 `window.__SMOKE_RESULT = { ok, state, ids, capabilities }`；
3. 在 `run.mjs` 的 `APPS` 里加一项；
4. 在 `sync-fixture.mjs` 的 `TARGETS` 里加静态目录（如果该框架不是 `public/` 布局）；
5. 在 CI 的 browser job 里加安装 + `npm run test:frameworks` 已覆盖。

当前覆盖：Vite + React、SvelteKit。两者共用同一套冒烟脚本与 Range 静态服务器；新增框架只要实现 `window.__SMOKE_RESULT` 契约。
