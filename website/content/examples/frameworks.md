---
title: 前端框架集成
description: 在 React、Vue、Svelte、Solid、Remix、Astro 与 Next.js 中打开 WeiSQL 数据包：实例放在哪、何时关闭、查询如何取消、错误如何呈现，以及 SSR 与子路径部署的可复制示例。
sidebar_position: 39
hero:
  kicker: "示例 · 框架"
  title: "接进现有前端"
  lead: "Runtime 是浏览器端库：在框架的挂载/卸载生命周期里打开与关闭，不要放到模块顶层。"
  chips: ["React", "Vue", "Svelte", "Solid", "Remix", "Astro"]
hide_title: true
---

本页不只给一段 `open()` 的代码，而是把 WeiSQL 接进真实前端时要处理的四件事讲清楚：**实例由谁持有、什么时候关闭、查询怎么取消、失败怎么给用户看**。生命周期与错误处理是跨框架共通的，先讲一遍，后面的框架示例只保留差异部分。

读完后你应该能判断：实例该放在组件、Provider 还是模块级单例里；路由切换与 React StrictMode 双挂载时怎样不泄漏 Reader；首屏该在什么时机打开数据包；以及托管不返回 `206` 时应该改哪一层。只想知道「我的框架用哪个钩子」，可以直接看 [1.1 节的速查表](#11-对应到各框架)。

前提只有两条：数据包已经构建并通过校验（见[构建与发布](/docs/examples/build)），托管支持 Range 且 CORS 暴露了 `Content-Range`（见[部署到 CDN](/docs/tooling/deploy-cdn)）。框架侧除 `@weisql/sdk` 外没有额外运行时依赖。

## 0. 先确认数据包与路径

目录形态的数据包就是一组静态文件，`manifest.json` 里的路径全部相对包根：

```text
public/datasets/demo/
├── manifest.json
├── data/documents.parquet
└── vectors/
    ├── document_embeddings.f32
    ├── document_embeddings.id-map.jsonl
    └── document_embeddings.id-map.offsets
```

同一个目录在不同框架里的落点不同，但构建后的 URL 都是 `/datasets/demo/`：

| 框架 | 源目录 | 构建后 URL |
| --- | --- | --- |
| Vite（React / Vue / Svelte SPA） | `public/datasets/demo/` | `/datasets/demo/` |
| Remix | `public/datasets/demo/` | `/datasets/demo/` |
| Next.js | `public/datasets/demo/` | `/datasets/demo/` |
| Nuxt | `public/datasets/demo/` | `/datasets/demo/` |
| SolidStart | `public/datasets/demo/` | `/datasets/demo/` |
| SvelteKit | `static/datasets/demo/` | `/datasets/demo/` |
| Astro | `public/datasets/demo/` | `/datasets/demo/` |
| 远端 CDN | 部署在任意静态托管 | `https://cdn.example.com/weisql/demo/` |

这张表只针对目录形态；改成 `.wsql` 单文件发布时不需要静态目录，见 [12.1 托管形态怎么选](#121-托管形态怎么选)。

三条容易踩的路径规则：

1. `baseUrl` 以 `/` 结尾。`HttpResourceReader` 会自动补一个，但 Manifest 里的相对路径会拼在它后面，写全更不容易错。
2. `manifestUrl` 指向 `manifest.json` 文件本身，不是目录。
3. 子路径部署时用框架自己的基路径变量，不要手写两套字符串（见各框架小节）。

先用一段与框架无关的代码确认数据包可用，把路径与 CORS 问题和生命周期问题分开排查：

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const baseUrl = "/datasets/demo/";

const db = await open({
  manifestUrl: `${baseUrl}manifest.json`,
  resourceReader: new HttpResourceReader({ baseUrl }),
  cache: { maxCacheBytes: 32 * 1024 * 1024 },
});

console.log(db.state); // "READY"
console.log(db.capabilities());

const hits = await db.text.search("documents_text", "dna", { topK: 5 });
console.log(hits.map((hit) => hit.id));

await db.close();
```

这段能跑通，剩下的失败就只可能来自框架的挂载时机、SSR 或打包配置。

## 1. 生命周期：所有框架同一个骨架

无论 React、Vue、Svelte、Solid 还是 Astro，正确的接法都是同一套四步：

| 阶段 | 做什么 | 为什么 |
| --- | --- | --- |
| 挂载 | 调用 `open()`，并把 `AbortSignal` 传进去 | 打开可能耗时，路由立刻切走时要能取消 |
| 就绪 | 保存实例，渲染查询 UI | 只有 `READY` 状态才能查询 |
| 卸载 | `abort()` + `close()` | Reader、缓存与 Adapter 都由 Runtime 持有，不关就泄漏 |
| 竞态 | 用 `disposed` 标记丢弃晚到的结果 | Promise 可能在组件卸载之后才 resolve |

骨架长这样，后面每个框架只是把它翻译成对应的生命周期钩子：

```ts
import { open, HttpResourceReader, type WeiSQLDatabase } from "@weisql/sdk";

let disposed = false;
let instance: WeiSQLDatabase | null = null;
const controller = new AbortController();

open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  signal: controller.signal,
})
  .then((db) => {
    if (disposed) {
      // 卸载之后才打开成功：立刻关掉，不要让它变成孤儿实例。
      void db.close();
      return;
    }
    instance = db;
  })
  .catch((reason: unknown) => {
    // 卸载或路由切换导致的取消不是错误，不要弹提示。
    if (disposed) return;
    console.error(reason);
  });

function cleanup(): void {
  disposed = true;
  controller.abort();
  void instance?.close();
}
```

四个常见错误，后果各不相同：

- **在组件函数体里调用 `open()`**：每次渲染都新建实例，且没人关闭；React 下会迅速耗尽连接与内存。
- **在模块顶层 `await open()`**：SSR、预渲染、HMR 时都会执行，浏览器里可能没有 `window`/`fetch`，服务端则拿到一份无法序列化的实例。
- **把实例塞进响应式代理**（`reactive()`、`$state`、`observable()`）：代理会递归遍历内部字段，查询路径变慢，还可能破坏内部 `#private` 字段。
- **卸载后仍然 `setState`**：React 18 不会警告，但会覆盖已经重建的 UI，表现为「切回页面时闪一下旧结果」。

`close()` 是幂等的，并发调用共享同一个关闭 Promise，所以清理函数里直接调用即可，不需要自己加 `closed` 标志去防重。

### 1.1 对应到各框架

同一套骨架落到八种框架上，只是钩子名字不同。如果你只想确认「我的框架该用哪个钩子」，看这张表就够，具体代码在对应小节：

| 框架 | 打开 | 释放 | 共享实例 | 主要陷阱 |
| --- | --- | --- | --- | --- |
| React（Vite / CRA） | `useEffect` | effect 清理函数 | Context Provider（2.2） | StrictMode 下 effect 执行两次 |
| Next.js App Router | 客户端组件里的 `useEffect` | effect 清理函数 | Provider 挂 `app/layout.tsx` | 不在 Server Component / loader 里打开 |
| Remix | `useEffect` | effect 清理函数 | Provider 挂 `app/root.tsx` | `loader` 在服务端执行，不能 `open()` |
| Vue 3 | `onMounted` | `onUnmounted` | `provide` / `inject`（5.1） | 用 `shallowRef`，不要 `reactive()` |
| Nuxt | `onMounted` | `onUnmounted` | `provide` / `inject` | 需要时 `<ClientOnly>` 或路由级 `ssr: false` |
| Svelte / SvelteKit | `onMount` | `onMount` 返回的函数 | `setContext` / `getContext` | Svelte 5 用 `$state.raw` |
| Solid / SolidStart | `onMount` | `onCleanup` | Context Provider | `createResource` 会在服务端执行 |
| Astro | `<script>` 或 island 的 `client:*` | 页面卸载；View Transitions 下监听 `astro:before-swap` | 模块级单例，或 island 内部自持 | `is:inline` / `define:vars` 会让脚本跳过打包 |

## 2. React Hook

### 2.1 单组件：useWeiSQL

把打开逻辑收进一个 hook，组件只消费 `{ db, error }`：

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  open,
  HttpResourceReader,
  type WeiSQLDatabase,
} from "@weisql/sdk";

export function useWeiSQL(baseUrl: string) {
  const [db, setDb] = useState<WeiSQLDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let instance: WeiSQLDatabase | null = null;
    let active = true;

    setDb(null);
    setError(null);

    open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      cache: { maxCacheBytes: 32 * 1024 * 1024 },
      signal: controller.signal,
    })
      .then((value) => {
        instance = value;
        if (active) setDb(value);
        else void value.close();
      })
      .catch((reason: unknown) => {
        if (active) setError(reason as Error);
      });

    return () => {
      active = false;
      controller.abort();
      if (instance) void instance.close();
    };
  }, [baseUrl]);

  return { db, error };
}
```

`effect` 的依赖只有 `baseUrl`：`baseUrl` 变化意味着换了一个数据包，重开是正确行为；组件重渲染不会触发重开。`active` 与 `controller` 各管一件事——前者丢弃过期结果，后者取消真实的网络 I/O。

不要在组件函数体里写 `useMemo(() => open(...), [])` 或 `useRef(open(...))`：`useMemo` 不保证不重复执行，`useRef` 的初始化表达式每次渲染都会求值，两者都可能留下没人关闭的实例。

### 2.2 多个组件共享一个实例：Provider

一个页面上有三处要用数据包时，不要各开一个实例——每个实例都有自己的 Reader、缓存与打开开销。把实例提升到最近公共祖先，用 Context 下发：

```tsx
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { HttpResourceReader, open, type WeiSQLDatabase } from "@weisql/sdk";

interface DatabaseState {
  db: WeiSQLDatabase | null;
  error: Error | null;
}

const DatabaseContext = createContext<DatabaseState>({ db: null, error: null });

export function WeiSQLProvider({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<DatabaseState>({ db: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    let instance: WeiSQLDatabase | null = null;
    let disposed = false;

    open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      cache: { maxCacheBytes: 32 * 1024 * 1024 },
      signal: controller.signal,
    })
      .then((value) => {
        instance = value;
        if (disposed) {
          void value.close();
          return;
        }
        setState({ db: value, error: null });
      })
      .catch((reason: unknown) => {
        if (disposed || controller.signal.aborted) return;
        setState({ db: null, error: reason as Error });
      });

    return () => {
      disposed = true;
      controller.abort();
      if (instance) void instance.close();
    };
  }, [baseUrl]);

  return (
    <DatabaseContext.Provider value={state}>{children}</DatabaseContext.Provider>
  );
}

export function useWeiSQLDatabase(): DatabaseState {
  return useContext(DatabaseContext);
}
```

Provider 之下所有组件共享同一个 `db`，`close()` 只在 Provider 卸载时发生一次。Provider 本身必须是客户端组件（`"use client"`），否则 `useEffect` 在服务端不会执行，子树永远停在加载态。

### 2.3 查询：新输入取消旧查询

搜索框是竞态的高发区：用户连打三个字，三个请求并发返回，最后到的可能是第一个。用 `AbortController` 取消上一次，并把「取消」和「失败」区分开：

```tsx
"use client";

import { useEffect, useState } from "react";
import type { TextHit, WeiSQLDatabase } from "@weisql/sdk";

export function useTextSearch(
  db: WeiSQLDatabase | null,
  indexName: string,
  query: string,
  topK = 5,
) {
  const [hits, setHits] = useState<readonly TextHit[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (db === null || query.trim() === "") {
      setHits([]);
      setPending(false);
      return;
    }

    const controller = new AbortController();
    setPending(true);

    db.text
      .search(indexName, query, { topK, signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setHits(next);
        setPending(false);
      })
      .catch(() => {
        // 被新查询取代：保留上一批结果，不要闪现错误。
        if (controller.signal.aborted) return;
        setHits([]);
        setPending(false);
      });

    return () => controller.abort();
  }, [db, indexName, query, topK]);

  return { hits, pending };
}
```

取消是 best-effort：调用方会收到 `QUERY_CANCELLED`，但底层读取不保证立刻停下；缓存层要等所有等待者都取消才中断底层请求。所以用 `signal.aborted` 判断，而不是去匹配错误消息或错误码文本。

### 2.4 StrictMode 与热更新

开发环境开启 `<StrictMode>` 时，React 会「挂载 → 卸载 → 再挂载」一遍 effect。上面的写法是安全的：第一次 `open()` 被 `abort()`，若它仍成功则立刻 `close()`；第二次重新打开。副作用是开发环境会多一次 Manifest 请求，生产环境不会。

两点注意：

- 如果你写「整个应用只允许打开一次」的断言，要么在测试里关掉 StrictMode，要么用第 10 节的引用计数单例。
- 把实例放在模块级变量时，HMR 换模块会留下孤儿实例（旧模块的清理函数拿不到新变量）。模块级单例适合生产，不适合当作开发期的缓存。

## 3. Next.js App Router

页面本身可以是 Server Component，只把查询面板标成客户端组件：

```tsx
// app/search-panel.tsx
"use client";

import { useState } from "react";
import { useWeiSQL } from "./use-weisql";

export function SearchPanel() {
  const { db, error } = useWeiSQL("/datasets/demo/");
  const [text, setText] = useState("dna");
  const [hits, setHits] = useState<Array<{ id: string | number }>>([]);

  if (error) return <p>数据包加载失败：{error.message}</p>;
  if (!db) return <p>正在加载索引…</p>;

  async function run() {
    const result = await db!.text.search("documents_text", text, {
      topK: 5,
    });
    setHits(result);
  }

  return (
    <div>
      <input value={text} onChange={(event) => setText(event.target.value)} />
      <button onClick={run}>搜索</button>
      <ul>
        {hits.map((hit) => (
          <li key={hit.id}>{hit.id}</li>
        ))}
      </ul>
    </div>
  );
}
```

```tsx
// app/page.tsx
import { SearchPanel } from "./search-panel";

export default function Page() {
  return <SearchPanel />;
}
```

如果多个路由都要用，把 Provider（2.2 节）挂到 `app/layout.tsx` 里，而不是每个页面各开一个：

```tsx
// app/providers.tsx
"use client";

import type { ReactNode } from "react";
import { WeiSQLProvider } from "./use-weisql";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WeiSQLProvider baseUrl={`${basePath}/datasets/demo/`}>
      {children}
    </WeiSQLProvider>
  );
}
```

```tsx
// app/layout.tsx
import type { ReactNode } from "react";
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

数据包放在 `public/datasets/demo/`，URL 用 `/datasets/demo/`。部署在子路径时设置 `basePath`，并把同样的前缀注入 `NEXT_PUBLIC_BASE_PATH`，两边保持一致；只改 `basePath` 而不改资源 URL，会出现「页面能开、Manifest 404」。

几个 Next.js 特有的边界：

- **不要在 Server Component、`generateStaticParams` 或 Route Handler 里 `open()`**。服务端即使能打开（Node 下 `fetch` 存在），得到的实例也无法序列化给浏览器，只会多一份没人关闭的资源。
- **`dynamic(..., { ssr: false })` 通常不需要**。只把 `open()` 放在客户端组件的 effect 里就够了；SDK 不依赖 Node 内置模块。只有在模块顶层访问 `window` 的第三方组件才需要动态导入。
- **生产环境不要让 `rewrites` 代理数据包**。代理层可能不转发 `Range`/`Content-Range`，直接把 CDN 的绝对 URL 传给 `open()`，并让 CDN 返回 CORS 头。

## 4. Vite + React

把数据包复制到 `public/datasets/demo`，用 `import.meta.env.BASE_URL` 兼容子路径部署：

```ts
const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [react()],
});
```

`base` 改成 `/app/` 时，`BASE_URL` 会自动变成 `/app/`，不需要手写两套路径。

开发期如果数据包不在同一个 dev server 上，用 `server.proxy` 把它挂到同源，避免 CORS 干扰调试：

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      "/datasets": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
```

代理只解决开发环境。生产环境要么把数据包放在同源静态目录，要么让 CDN 正确返回 CORS 头——不要把 `proxy` 当成生产方案，构建产物里没有它。

还有一条容易忽略：**不要用 `import` 引入 `.f32`、`.parquet` 这类资源**。Vite 会把它们当模块处理（小文件转 base64、大文件加哈希），而 Manifest 里的偏移量是按原始字节算的，Range 读取会立刻错位。数据包必须原样躺在 `public/` 里。

## 5. Vue 3 / Nuxt

用 `shallowRef` 保存实例，避免把 Runtime 类实例变成深层响应式对象：

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import {
  open,
  HttpResourceReader,
  type WeiSQLDatabase,
} from "@weisql/sdk";

const db = shallowRef<WeiSQLDatabase | null>(null);
const error = shallowRef<Error | null>(null);
let controller: AbortController | null = null;
let disposed = false;

onMounted(async () => {
  controller = new AbortController();
  try {
    const instance = await open({
      manifestUrl: "/datasets/demo/manifest.json",
      resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
      signal: controller.signal,
    });
    if (disposed) {
      await instance.close();
      return;
    }
    db.value = instance;
  } catch (reason) {
    if (!disposed) error.value = reason as Error;
  }
});

onUnmounted(() => {
  disposed = true;
  controller?.abort();
  void db.value?.close();
});
</script>
```

`reactive()` 和 `ref()` 会递归代理对象：`ref` 对类实例会走 `toReactive`，深层字段变成代理后，内部按 `this` 访问私有字段的方法可能直接抛错，查询也会变慢。`shallowRef` 只代理 `.value` 这一层，正合适。

### 5.1 抽成 composable 并在组件间共享

多个组件要用同一个实例时，用 `provide` / `inject` 下发 `shallowRef` 本身（不要下发 `.value`，那会丢掉响应性）：

```ts
// composables/useWeiSQL.ts
import { inject, onMounted, onUnmounted, provide, shallowRef } from "vue";
import { HttpResourceReader, open, type WeiSQLDatabase } from "@weisql/sdk";

const key = Symbol("weisql-database");

export function provideWeiSQL(baseUrl: string) {
  const db = shallowRef<WeiSQLDatabase | null>(null);
  const error = shallowRef<Error | null>(null);
  let controller: AbortController | null = null;
  let disposed = false;

  onMounted(async () => {
    controller = new AbortController();
    try {
      const instance = await open({
        manifestUrl: `${baseUrl}manifest.json`,
        resourceReader: new HttpResourceReader({ baseUrl }),
        cache: { maxCacheBytes: 32 * 1024 * 1024 },
        signal: controller.signal,
      });
      if (disposed) await instance.close();
      else db.value = instance;
    } catch (reason) {
      if (!disposed) error.value = reason as Error;
    }
  });

  onUnmounted(() => {
    disposed = true;
    controller?.abort();
    void db.value?.close();
  });

  provide(key, db);
  return { db, error };
}

export function useWeiSQLDatabase() {
  const db = inject(key);
  if (db === undefined) throw new Error("useWeiSQLDatabase() 必须在 provideWeiSQL() 之下使用");
  return db;
}
```

在根组件调用 `provideWeiSQL()`，子组件调用 `useWeiSQLDatabase()` 即可拿到同一个 `shallowRef`。

### 5.2 Nuxt 的 SSR 开关

Nuxt 默认对页面做 SSR，而 `onMounted` 只在浏览器执行，所以上面的写法本身是安全的。如果组件在服务端渲染阶段就访问浏览器 API，把它包进 `<ClientOnly>`，或对使用它的路由关掉 SSR：

```vue
<template>
  <ClientOnly>
    <SearchPanel />
  </ClientOnly>
</template>
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  app: { baseURL: "/app/" },
  routeRules: {
    "/search": { ssr: false },
  },
});
```

数据包放在 `public/datasets/demo/`；Nuxt 的 `public/` 等价于 Vite 的 `public/`。子路径部署时 `app.baseURL` 会同时影响页面与 `public/` 的 URL，但仍建议把 `baseUrl` 显式写成完整前缀，避免 `useRuntimeConfig` 与硬编码混用。

### 5.3 不要用 `useAsyncData` 缓存 Runtime 实例

`useAsyncData` 适合可序列化的数据，不适合带生命周期的 Runtime：

```ts
// 不推荐
const { data: db } = await useAsyncData("weisql", () =>
  open({
    manifestUrl: "/datasets/demo/manifest.json",
    resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  }),
  { server: false },
);
```

三个问题：它不会在组件卸载时 `close()`；`payload` 会尝试序列化返回值（类实例不可序列化）；同一个 key 还会把实例复用给后续页面。需要共享时，用 `useState` 保存**是否已打开**这类可序列化状态，让每个页面自己管理实例；或者用 5.1 节的 composable，把生命周期绑在组件树上。

## 6. SvelteKit

Svelte 的 `onMount` 只在浏览器执行，返回的函数用于清理，正好对应「打开 / 关闭」：

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import {
    open,
    HttpResourceReader,
    type WeiSQLDatabase,
  } from "@weisql/sdk";

  let db: WeiSQLDatabase | null = null;
  let error: Error | null = null;

  onMount(() => {
    const controller = new AbortController();
    let disposed = false;

    open({
      manifestUrl: "/datasets/demo/manifest.json",
      resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
      signal: controller.signal,
    })
      .then((instance) => {
        if (disposed) return instance.close();
        db = instance;
      })
      .catch((reason: unknown) => {
        if (!disposed) error = reason as Error;
      });

    return () => {
      disposed = true;
      controller.abort();
      void db?.close();
    };
  });
</script>

{#if error}
  <p>数据包加载失败：{error.message}</p>
{:else if db}
  <p>索引已就绪</p>
{:else}
  <p>正在加载索引…</p>
{/if}
```

SvelteKit 的静态资源放在 `static/datasets/demo/`，构建后路径是 `/datasets/demo/`（子路径部署时加 `paths.base`）。不要在 `+page.server.ts` 或 `+layout.server.ts` 里调用 `open()`——服务端实例无法传给浏览器，而且请求结束就该关闭。

### 6.1 Svelte 5 runes

Svelte 5 用 `$state.raw` 保存 Runtime 实例，避免被深度代理：

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import {
    open,
    HttpResourceReader,
    type WeiSQLDatabase,
  } from "@weisql/sdk";

  let db = $state.raw<WeiSQLDatabase | null>(null);
  let error = $state<Error | null>(null);

  onMount(() => {
    const controller = new AbortController();
    let disposed = false;

    open({
      manifestUrl: "/datasets/demo/manifest.json",
      resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
      signal: controller.signal,
    })
      .then((instance) => {
        if (disposed) return instance.close();
        db = instance;
      })
      .catch((reason: unknown) => {
        if (!disposed) error = reason as Error;
      });

    return () => {
      disposed = true;
      controller.abort();
      void db?.close();
    };
  });
</script>
```

普通 `$state` 会递归代理对象，类实例不需要这种代理；`$state.raw` 只在整体赋值时触发更新，既避开代理，也避免代理带来的性能开销。

### 6.2 SSR 与预渲染

默认保持 SSR 打开、只把读取放进 `onMount` 即可。如果页面本身就是纯客户端应用壳（例如编辑器），在 `+page.ts` 里关掉 SSR：

```ts
// src/routes/search/+page.ts
export const ssr = false;
```

此时不要再把 `prerender` 设为 `true`：预渲染只能拿到一个空壳，搜索引擎与首屏都看不到内容。需要 SEO 的页面应该保留 SSR，把数据包读取放在浏览器端进行。

## 7. Remix

Remix 的路由组件默认在服务端渲染，`loader` / `action` 也在服务端执行；能在浏览器跑的钩子只有 `useEffect`。所以接入方式与 React 完全一致，区别只在**不要把 `open()` 放进 loader**。

### 7.1 数据包与 `BASE_URL`

Remix v2 跑在 Vite 上，`public/` 原样发布。数据包 URL 用 `import.meta.env.BASE_URL` 拼接，它来自 `vite.config.ts` 的 `base`；子路径部署时让路由的 basename 与这个前缀一致，两边才不会一边能开、一边 404。

```ts
const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;
```

### 7.2 路由组件

```tsx
// app/routes/search.tsx
import { useEffect, useState } from "react";
import {
  open,
  HttpResourceReader,
  type WeiSQLDatabase,
} from "@weisql/sdk";

const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;

export default function SearchRoute() {
  const [db, setDb] = useState<WeiSQLDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let instance: WeiSQLDatabase | null = null;
    let disposed = false;

    open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      signal: controller.signal,
    })
      .then((value) => {
        instance = value;
        if (disposed) {
          void value.close();
          return;
        }
        setDb(value);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason as Error);
      });

    return () => {
      disposed = true;
      controller.abort();
      if (instance) void instance.close();
    };
  }, []);

  async function search(text: string) {
    if (db === null) return;
    const hits = await db.text.search("documents_text", text, { topK: 5 });
    console.log(hits.map((hit) => hit.id));
  }

  if (error) return <p>数据包加载失败：{error.message}</p>;
  if (db === null) return <p>正在加载索引…</p>;

  return <button onClick={() => void search("dna")}>搜索</button>;
}
```

`baseUrl` 在模块顶层求值时只读 `import.meta.env`，不碰浏览器 API，SSR 下也安全——这和「模块顶层 `await open()`」是两回事。

### 7.3 共享：把 Provider 挂到 `root.tsx`

多个路由都要用时，把 2.2 节的 Provider 放在 `root.tsx` 的 `<Outlet />` 外面，整个应用只打开一次：

```tsx
// app/root.tsx
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import { WeiSQLProvider } from "./use-weisql";

export default function App() {
  return (
    <html lang="zh-CN">
      <head>
        <Meta />
        <Links />
      </head>
      <body>
        <WeiSQLProvider baseUrl={`${import.meta.env.BASE_URL}datasets/demo/`}>
          <Outlet />
        </WeiSQLProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
```

React Router v7（Remix 的继任版本）把包名从 `@remix-run/react` 换成了 `react-router`，组件与生命周期不变。

### 7.4 为什么不能放进 loader

- `loader` 在服务端执行，返回值必须可序列化，`WeiSQLDatabase` 不符合；
- 服务端打开的实例没有卸载点，请求结束也不会自动 `close()`；
- 需要 SSR 首屏信息时，在 `loader` 里只读**可序列化的元信息**（数据集 ID、文档数、标题），Runtime 留给 `useEffect`。

Remix 的 SPA Mode（`ssr: false`）可以整体关掉服务端渲染，但并非必需：`useEffect` 方案在 SSR 下本来就安全，首屏只是先渲染「加载中」。

## 8. SolidStart

Solid 的组件函数只执行一次，没有依赖数组的概念；`onMount` 只在浏览器运行，`onCleanup` 负责释放。`createSignal` 不对对象做深层代理，可以直接保存 Runtime 实例。

### 8.1 组件

```tsx
// src/routes/search.tsx
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  open,
  HttpResourceReader,
  type TextHit,
  type WeiSQLDatabase,
} from "@weisql/sdk";

const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;

export default function SearchPanel() {
  const [db, setDb] = createSignal<WeiSQLDatabase | null>(null);
  const [error, setError] = createSignal<Error | null>(null);
  const [hits, setHits] = createSignal<readonly TextHit[]>([]);

  onMount(() => {
    const controller = new AbortController();
    let disposed = false;

    open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      cache: { maxCacheBytes: 32 * 1024 * 1024 },
      signal: controller.signal,
    })
      .then((value) => {
        if (disposed) {
          void value.close();
          return;
        }
        setDb(value);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason as Error);
      });

    onCleanup(() => {
      disposed = true;
      controller.abort();
      void db()?.close();
    });
  });

  async function search(text: string) {
    const current = db();
    if (current === null) return;
    setHits(await current.text.search("documents_text", text, { topK: 5 }));
  }

  return (
    <div>
      <Show when={error()}>
        {(reason) => <p>数据包加载失败：{reason().message}</p>}
      </Show>
      <Show when={db()} fallback={<p>正在加载索引…</p>}>
        <button onClick={() => void search("dna")}>搜索</button>
        <p>命中 {hits().length} 条</p>
      </Show>
    </div>
  );
}
```

在 `onMount` 内部注册的 `onCleanup` 属于当前组件，组件销毁时执行，等价于 React 的 effect 清理函数。注意 Solid 的 `Show` 子节点访问的是 signal 的 getter（`db()`、`hits()`），不要写成 `db` 本身。

### 8.2 输入驱动的查询

Solid 里「effect + cleanup」的等价物是 `createEffect` + `onCleanup`，天然处理「新输入取消旧查询」：

```tsx
import { createEffect, createSignal, onCleanup } from "solid-js";

const [query, setQuery] = createSignal("");

createEffect(() => {
  const current = db();
  const text = query().trim();
  if (current === null || text === "") {
    setHits([]);
    return;
  }

  const controller = new AbortController();
  onCleanup(() => controller.abort());

  void current.text
    .search("documents_text", text, { topK: 5, signal: controller.signal })
    .then((next) => {
      if (!controller.signal.aborted) setHits(next);
    })
    .catch(() => undefined);
});
```

每次 `query()` 变化，上一次 effect 的 `onCleanup` 先执行（`abort()`），再发起新查询；不需要手写依赖数组，Solid 会自动追踪 `query()` 的读取。

### 8.3 SSR

SolidStart 默认开启 SSR，`onMount` 不会在服务端执行，首屏渲染的是 fallback，水合后才打开数据包。两种需要额外处理的情况：

- **纯客户端应用**：在 `app.config.ts` 里全局关闭 SSR；
- **只有局部依赖浏览器**：把组件包进 SolidStart 的 `<ClientOnly>`，或只用 `isServer` 做条件渲染，不要在模块顶层用它绕过 `open()`。

## 9. Astro

Astro 默认输出零 JS 的静态页面：`.astro` 组件在服务端（构建时或按需渲染）执行，`<script>` 交给 Vite 打包后只在浏览器运行。读取数据包只有两条路——**页面脚本**或**客户端 island**。

### 9.1 直接写 `<script>`

```astro
---
// src/pages/search.astro
---

<div>
  <p id="status">正在加载索引…</p>
  <ul id="hits"></ul>
</div>

<script>
  import { open, HttpResourceReader } from "@weisql/sdk";

  const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;

  async function main() {
    const status = document.getElementById("status");
    const list = document.getElementById("hits");
    if (!status || !list) return;

    try {
      const db = await open({
        manifestUrl: `${baseUrl}manifest.json`,
        resourceReader: new HttpResourceReader({ baseUrl }),
        cache: { maxCacheBytes: 32 * 1024 * 1024 },
      });

      status.textContent = "索引已就绪";

      const hits = await db.text.search("documents_text", "dna", { topK: 5 });
      for (const hit of hits) {
        const item = document.createElement("li");
        item.textContent = String(hit.id);
        list.append(item);
      }
    } catch {
      status.textContent = "数据包加载失败，请稍后重试";
    }
  }

  void main();
</script>
```

两条限制：

- **不要加 `is:inline` 或 `define:vars`**。它们会让脚本退回内联执行、不经过 Vite 打包，`import "@weisql/sdk"` 会直接失败。
- 脚本里的 `import.meta.env.BASE_URL` 由 Vite 替换；改了 `base`，它跟着变。

### 9.2 用框架 island

已经写了 React / Vue / Solid / Svelte 组件时，直接把它们挂成 island：

```astro
---
import SearchPanel from "../components/SearchPanel";
---

<SearchPanel client:only="react" />
```

| 指令 | 行为 | 适合 |
| --- | --- | --- |
| `client:only="react"` | 完全跳过服务端渲染，只在浏览器挂载 | 组件在模块顶层就访问 `window`，或依赖浏览器存储 |
| `client:load` | 先 SSR 出骨架，水合后才执行 effect | 大多数情况；本页的 hook 在服务端渲染的就是「加载中」 |
| `client:visible` | 进入视口才加载 | 数据包读取可以推迟，例如首屏以下的检索面板 |
| `client:idle` | 主线程空闲后加载 | 非关键的辅助查询 |

`client:only` 需要先安装对应集成（`@astrojs/react`、`@astrojs/vue`、`@astrojs/solid-js`、`@astrojs/svelte`）。

### 9.3 生命周期

Astro 是多页应用：整页跳转时浏览器丢弃旧文档，连接与内存一起释放，不需要手动 `close()`。只有启用 View Transitions 时旧页面会被保留一小段时间，需要在离开前收尾——在 9.1 的脚本里把 `db` 提升为外层变量，再加一个监听：

```js
document.addEventListener("astro:before-swap", () => {
  void db?.close();
});
```

### 9.4 构建

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  base: "/app",
  integrations: [react()],
});
```

`public/` 原样复制到 `dist/`，数据包不参与打包；`base` 同时影响页面路由与 `BASE_URL`，所以 9.1 的 `baseUrl` 不需要再手写前缀。

## 10. 共享实例：引用计数单例

当同一份数据包被多个路由、多个挂载点（例如可切换的标签页）反复使用时，Provider 的层级可能不够用。这时可以用一个引用计数的模块级单例：第一个使用者触发 `open()`，最后一个离开时才 `close()`。

```ts
import { open, HttpResourceReader, type WeiSQLDatabase } from "@weisql/sdk";

interface SharedDatabase {
  promise: Promise<WeiSQLDatabase>;
  refs: number;
}

let shared: SharedDatabase | null = null;

export function acquireDatabase(baseUrl: string): Promise<WeiSQLDatabase> {
  if (shared === null) {
    const promise = open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      cache: { maxCacheBytes: 32 * 1024 * 1024 },
    });
    shared = { promise, refs: 0 };

    // 打开失败时必须清空，否则后续使用者会一直拿到同一个 rejected Promise。
    promise.catch(() => {
      if (shared !== null && shared.promise === promise) shared = null;
    });
  }

  shared.refs += 1;
  return shared.promise;
}

export function releaseDatabase(): void {
  if (shared === null) return;

  shared.refs -= 1;
  if (shared.refs > 0) return;

  const current = shared;
  shared = null;
  void current.promise.then((db) => db.close()).catch(() => undefined);
}
```

三条使用约束：

- **不要给共享的 `open()` 传组件级 `signal`**。一个组件卸载就 `abort()`，会把所有使用者一起取消。取消应该只发生在查询层，或者等到 `refs` 归零。
- **模块级变量在 SSR 下会跨请求共享**。单例必须在浏览器里懒创建（第一次 `acquire` 发生在 effect / `onMount` 中），不要在模块顶层立即执行。
- **失败后要允许重试**。上面的 `catch` 把 `shared` 置空，下一次 `acquire` 会重新打开；否则页面会卡在同一个错误上。

## 11. 错误处理：把错误码翻译成用户能行动的提示

不要按 `error.message` 分支，也不要直接把 SDK 的错误原文丢给用户。`WeiSQLError` 的 `code` 是稳定契约：

```ts
import { WeiSQLError } from "@weisql/sdk";

interface UserFacingError {
  title: string;
  detail: string;
  retryable: boolean;
}

export function describeDatabaseError(error: unknown): UserFacingError {
  if (!(error instanceof WeiSQLError)) {
    return { title: "加载失败", detail: "未知错误，请重试。", retryable: true };
  }

  switch (error.code) {
    case "CORS_OR_RANGE_UNSUPPORTED":
      return {
        title: "托管不支持按需读取",
        detail: "服务端忽略了 Range 请求，请改用支持 206 的托管，或发布为 .wsql。",
        retryable: false,
      };
    case "INVALID_RANGE_RESPONSE":
      return {
        title: "Range 响应不合法",
        detail: "检查 CDN 或代理是否改写了 Content-Range。",
        retryable: false,
      };
    case "RESOURCE_NOT_FOUND":
      return {
        title: "数据包不存在",
        detail: "检查 baseUrl 与 manifest.json 的路径，以及子路径前缀是否一致。",
        retryable: false,
      };
    case "MANIFEST_INVALID":
      return {
        title: "数据包描述无效",
        detail: "Manifest 校验失败，需要重新构建数据包。",
        retryable: false,
      };
    case "RESOURCE_INTEGRITY_FAILED":
      return {
        title: "数据包损坏",
        detail: "尺寸或摘要与 Manifest 不符，请重新发布，不要绕过校验。",
        retryable: false,
      };
    case "INDEX_NOT_FOUND":
      return {
        title: "索引不存在",
        detail: "检查索引名是否与 Manifest 声明一致。",
        retryable: false,
      };
    case "QUERY_CANCELLED":
      return { title: "查询已取消", detail: "已发起新的查询。", retryable: false };
    case "DATABASE_CLOSED":
      return {
        title: "数据库已关闭",
        detail: "组件已卸载或实例已释放，请重新进入页面。",
        retryable: true,
      };
    default:
      return { title: "加载失败", detail: "请重试；若持续失败，请查看控制台。", retryable: true };
  }
}
```

前端最常遇到的几类：

| 错误码 | 前端现象 | 处理 |
| --- | --- | --- |
| `CORS_OR_RANGE_UNSUPPORTED` | 打开或首次查询就失败，Network 里是 `200` | 启用 Range，或改用 `.wsql` 容器 |
| `INVALID_RANGE_RESPONSE` | 部分请求失败，`Content-Range` 与请求不符 | 检查 CDN / 代理是否改写响应 |
| `RESOURCE_NOT_FOUND` | 404，或跨域直接被浏览器拦下 | 修路径、加 CORS，注意大小写 |
| `MANIFEST_INVALID` | 打开即失败，`details.issues` 给出字段路径 | 重新构建，不要手改 Manifest |
| `RESOURCE_INTEGRITY_FAILED` | 发布后被改动、压缩重编码、漏传文件 | 重新发布；不要关闭校验来「修好」 |
| `QUERY_CANCELLED` | 用户连续输入时出现 | 静默忽略，不要提示 |
| `DATABASE_CLOSED` | 组件已卸载后仍有请求在飞 | 在清理函数里中止查询；提示可重试 |

「重试」按钮的正确实现不是 `location.reload()`，而是让 Provider 重新执行一次 effect——给 `useEffect` 加一个自增的 `attempt` 依赖：

```tsx
export function useDatabaseWithRetry(baseUrl: string) {
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 2.1 节的打开逻辑，依赖改为 [baseUrl, attempt]
  }, [baseUrl, attempt]);

  return { retry: () => setAttempt((value) => value + 1) };
}
```

## 12. 加载策略与性能

`open()` 默认只拉 Manifest 并做 L1/L2 校验，**不预读数据资源**；真正的 I/O 发生在第一次查询。这决定了首屏优化点在哪里。

| 选项 | 前端影响 | 建议 |
| --- | --- | --- |
| `verifyChecksums: "none"`（默认） | 打开最快，但损坏的包要到首次查询才暴露 | 开发与内网可用；对外发布建议至少 `"manifest"` |
| `verifyChecksums: "manifest"` | 打开时校验每个声明资源的尺寸，需要 `stat()`/`HEAD` | 大多数生产页面的折中 |
| `verifyChecksums: "all"` | 打开前读完并哈希所有资源，大包会明显拖慢首屏 | 只用于小包，或在后台预热 |
| `cache` | 自动把 Reader 包进 `CachedResourceReader`，`version` 取 `manifest.datasetId` | 浏览器端几乎总该开 |
| `maxResourceBytes` / `maxTotalBytes` | L3 校验的单资源 / 总预算，默认 64 MiB / 512 MiB | 包里有大 Parquet 时按实际调大 |
| `signal` | 取消打开过程 | 路由切换、组件卸载时传入 |

缓存参数（`cache` 字段）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxCacheBytes` | 32 MiB | 缓存按实际字节计算的上限 |
| `maxEntryBytes` | 1 MiB | 单条 Range 超过此值不进缓存 |
| `maxConcurrentReads` | 8 | 并发底层读取上限，超出排队 |
| `version` | 数据包 `datasetId` | 发布版本身份，进入缓存键 |

几条实践经验：

- **按需加载路由**。把 `open()` 放在查询页而不是首页；首页只用一张静态截图或说明文字，能省掉一次 Manifest 请求与全部初始化。
- **提前预热 Manifest**。在跳转前 `fetch` 一次 `manifest.json`，可以让浏览器 HTTP 缓存命中，但不要提前 `open()`——那会创建没人消费的实例。
- **先读 `capabilities()` 再渲染控件**。没有 `textSearch` 就不要显示搜索框，没有 `sql` 就不要显示 SQL 编辑器，避免用户点了才知道不支持。
- **全文检索有固定读取成本**。`text.search()` 每次查询都要整体读取文档长度文件（100 万文档约 4 MB），首查不要放在输入框的每次 `onChange` 上，至少加 200–300 ms 防抖。
- **精确向量检索按文件扫描**。分块读取只降低峰值内存，不减少总下载量；首屏体验取决于包大小，而不是缓存命中率。

### 12.1 托管形态怎么选

框架只决定「在哪里调用 `open()`」，不决定数据以什么形态发布。三种形态在任意框架里都可用：

| 形态 | 框架侧要做什么 | 适合 | 代价 |
| --- | --- | --- | --- |
| 目录（默认） | 包放 `public/`（SvelteKit 用 `static/`），`open({ manifestUrl, resourceReader: new HttpResourceReader(...) })` | 绝大多数页面；需要频繁更新单个资源 | 托管必须支持 Range 与 CORS，多文件容易漏传 |
| `.wsql` 整包 | 先 `fetch` 整个文件，再 `new ContainerReader(bytes)`，把解析出的 Manifest 传给 `open()` | 包较小、离线或 PWA、Electron | 首屏必须下载整包，失去按需读取 |
| `.wsql` 流式 | `StreamingContainerReader.open(createHttpContainerSource({ url }))`，从容器读出 `manifest.json` | 大容器，但想保留按需读取 | 托管仍要支持 Range；压缩条目内无法真正随机读 |

判断方法很简单：首屏能接受下载整包就选整包，否则用目录或流式。三条路的代码都在[浏览器示例](/docs/examples/browser)里，容器格式的语义见[单文件容器](/docs/sdk/containers)。

## 13. 测试与本地验证

先在命令行确认托管行为，再怀疑框架：

```bash
# 应返回 206 与匹配的 Content-Range
curl -s -D - -o /dev/null \
  -H "Range: bytes=0-15" \
  http://localhost:3000/datasets/demo/manifest.json
```

单元测试里不要依赖 jsdom：jsdom 没有真实的 `Range` 与 `ReadableStream`，`HttpResourceReader` 的校验会直接失败。两种可行做法：

- 用 `open({ manifest, resourceReader })` 注入一个假的 Reader，只测组件状态机；
- 用 `open({ fetch })` 替换 Manifest 请求，测错误分支（`RESOURCE_NOT_FOUND`、`MANIFEST_INVALID`）。

```ts
import { open, WeiSQLError } from "@weisql/sdk";

await expect(
  open({
    manifestUrl: "/missing/manifest.json",
    fetch: async () => new Response("not found", { status: 404 }),
  }),
).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
```

仓库里有一份与 2.1 节逐行对应的可运行示例：`examples/frameworks/` 下包含 Vite + React 与 SvelteKit 两套。`npm run test:frameworks` 会构建它们并用 Chromium 断言状态为 `READY`、命中 3 条，以及 `.f32` 至少被一次 `206` 分段读取。改完生命周期代码先跑这个，比手点页面快，也能挡住「能编译、打包后跑不起来」的回归。

端到端的 Range、CORS 与缓存行为，只能在真实浏览器里验收（Playwright 或手动），这与[部署到 CDN](/docs/tooling/deploy-cdn)的验收方式一致。

## 14. 常见问题

<details>
<summary>为什么不能把 open() 放在模块顶层？</summary>

模块顶层代码会在 SSR、预渲染或每次热更新时执行，可能拿不到 `window`/`fetch`，也无法在组件卸载时关闭实例；服务端执行时还会得到一份无法序列化给浏览器的实例。始终把它放进 `useEffect`、`onMounted` 或事件回调。

</details>

<details>
<summary>组件重渲染会不会重复打开？</summary>

不会。`open()` 在 effect / `onMounted` 里，只有依赖变化才重跑；组件重渲染不触发 effect。真正会重复打开的是把 `open()` 写在函数体、`useMemo` 或 `useRef` 初始化表达式里的写法。

</details>

<details>
<summary>StrictMode 下 open() 执行两次，是 bug 吗？</summary>

不是。React 18 开发环境会刻意执行「挂载 → 卸载 → 挂载」来暴露清理缺陷。只要清理函数里 `abort()` + `close()` 正确，第一次实例会被关掉，不会泄漏。生产环境不会双执行。

</details>

<details>
<summary>Next.js 需要 `dynamic(..., { ssr: false })` 吗？</summary>

如果只在客户端组件里调用 `open()`，通常不需要。SDK 的浏览器入口不引用 `node:` 模块——`NodeFileResourceReader` 与 `buildPackage` 只出现在 `node` 条件的入口里，所以普通打包不会拉进 `node:fs`；真正依赖浏览器的是 `fetch` 与 Range 响应。若你的组件在模块顶层访问 `window`，再考虑动态导入。

</details>

<details>
<summary>开发环境跨域怎么办？</summary>

Vite 用 `server.proxy`，Next.js 用 `rewrites`，把 `/datasets` 代理到静态文件服务；生产环境则确保 CDN 返回 `Access-Control-Allow-Origin` 并暴露 `Content-Range`。代理只解决开发期，不要依赖它上线。

</details>

<details>
<summary>为什么生产环境返回 200 而不是 206？</summary>

静态服务器忽略了 Range，常见于压缩、重写或对象存储的默认行为。检查 `Accept-Ranges: bytes`、代理是否缓存了完整响应，以及是否对数据包做了 gzip 重编码。必要时改用 `.wsql` 容器。

</details>

<details>
<summary>子路径部署后页面正常、数据 404？</summary>

页面路由与资源 URL 是两套配置：Vite / Remix 的 `base`、Next 的 `basePath`、Nuxt 的 `app.baseURL`、SvelteKit 的 `paths.base`、Astro 的 `base` 只影响页面与 `public/` 的默认前缀，`open()` 里的 `baseUrl` 仍然是你手写的字符串。两边必须一致，最好只保留一个常量。

</details>

<details>
<summary>能不能把 db 放进 Pinia / Redux / Zustand？</summary>

不建议。Runtime 是不可序列化的类实例，devtools 快照会遍历它，time-travel 恢复的是旧引用（可能已经 `close()`）。把「是否就绪、错误信息、当前查询」这类可序列化状态放进 store，实例留在 Provider 或单例里。

</details>

<details>
<summary>打包体积为什么变大了？</summary>

`@weisql/sdk` 本身不含引擎；如果你注入了 DuckDB-Wasm Adapter，WASM 与 worker 是额外资源，需要同源托管，首次加载还要拉取约 34 MB 的 WASM。只在真正需要 SQL 的路由里动态 `import()` 适配器。

</details>

<details>
<summary>Remix 的 loader 里能不能打开数据包？</summary>

不能。`loader` 在服务端执行，返回值必须可序列化，`WeiSQLDatabase` 不是；而且服务端实例没有卸载点，请求结束不会自动 `close()`。在 `loader` 里只返回数据集 ID、文档数这类元信息，Runtime 交给路由组件的 `useEffect`。

</details>

<details>
<summary>Solid 的 `createResource` 能替代 `onMount` 吗？</summary>

不建议。`createResource` 在 SSR 阶段也会执行，服务端拿到的实例同样无法序列化，而且它没有对应的清理钩子。用 `onMount` 打开、`onCleanup` 关闭；输入驱动的查询用 8.2 节的 `createEffect` + `onCleanup`。

</details>

<details>
<summary>Astro 的 `<script>` 里 `import` 报错？</summary>

脚本被加上了 `is:inline` 或 `define:vars`，这两者都会让 Astro 跳过 Vite 处理、直接内联输出，`import "@weisql/sdk"` 自然无法解析。去掉指令、改用普通 `<script>`，或者把逻辑放进 `client:only` 的框架 island。

</details>

<details>
<summary>首查很慢，是缓存没生效吗？</summary>

先看是不是 `verifyChecksums: "all"` 在打开阶段读完了整包，再看首查是不是全文检索（固定读取文档长度文件）。缓存只对之后的 Range 读取生效，第一次仍然要下载；它不会让精确向量检索少读字节。

</details>

## 15. 排查清单

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 页面一直「正在加载」 | Network 里有没有 `manifest.json` 请求 | 检查 `baseUrl` 末尾斜杠、`manifestUrl` 是否指向文件 |
| 控制台 `CORS_OR_RANGE_UNSUPPORTED` | `curl -H "Range: bytes=0-15"` 的返回码 | 开启 Range 支持，或改用 `.wsql` |
| `RESOURCE_NOT_FOUND` 但文件确实存在 | 大小写、子路径前缀、是否漏传 `vectors/` | 用 `weisql inspect` 对照 Manifest 声明 |
| 切路由后内存持续上涨 | 清理函数里有没有 `close()` | 补 `abort()` + `close()`，并确认 `close()` 只被调用一次也没关系 |
| 搜索结果错乱 | 是否并发发起多次查询 | 用 `AbortController` 取消上一次，只接受未取消的结果 |
| 生产 200、开发 206 | 托管是否压缩或重写 | 关掉动态压缩，或改用 `.wsql` |
| 帧率下降、对象被代理 | 是否用了 `reactive()` / `$state` | 改用 `shallowRef` / `$state.raw` |
| Astro 页面没有交互 | 脚本是否被 `is:inline` / `define:vars` 内联，或 island 漏了 `client:*` | 改成普通 `<script>`，或给组件加 `client:only` |
| Remix 路由切换后报 `DATABASE_CLOSED` | 查询是否在 effect 清理后才返回 | 卸载时 `abort()` + `close()`，忽略 `QUERY_CANCELLED` |
| 打开很慢 | `verifyChecksums` 是否为 `all` | 降到 `"manifest"`，把小包校验挪到后台 |

## 相关页面

- [浏览器示例](/docs/examples/browser)
- [构建与发布](/docs/examples/build)
- [部署到 CDN](/docs/tooling/deploy-cdn)
- [打开数据库与生命周期](/docs/sdk/open-and-lifecycle)
- [资源读取与缓存](/docs/sdk/resource-readers)
- [全文检索与混合检索](/docs/sdk/text-and-hybrid)
- [错误与错误码](/docs/sdk/errors)
- [浏览器与 Node.js 兼容性](https://github.com/fengjutian/WeiSQL/blob/main/docs/RUNTIME_COMPATIBILITY.md)
