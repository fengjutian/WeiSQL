---
title: 前端框架集成
description: 在 React、Vue、Svelte、Next.js 与 Vite 中打开 WeiSQL 数据包、管理生命周期与处理 SSR 的可复制示例。
sidebar_position: 39
hero:
  kicker: "示例 · 框架"
  title: "接进现有前端"
  lead: "Runtime 是浏览器端库：在框架的挂载/卸载生命周期里打开与关闭，不要放到模块顶层。"
  chips: ["React", "Vue", "Svelte", "Next.js", "Vite"]
hide_title: true
---

## 1. React Hook

把 `open()` 放进 effect，卸载时中止并关闭：

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

不要在组件函数体或模块顶层调用 `open()`：每次渲染都会新建实例，且无法可靠清理。

## 2. Next.js App Router

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

数据包放在 `public/datasets/demo/`，URL 用 `/datasets/demo/`。如果部署在子路径，改成 `${process.env.NEXT_PUBLIC_BASE_PATH}/datasets/demo/`。

## 3. Vite + React

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

## 4. Vue 3 / Nuxt

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

Nuxt 中把这个组件包进 `<ClientOnly>`，或对使用它的路由设置 `ssr: false`：

```vue
<template>
  <ClientOnly>
    <SearchPanel />
  </ClientOnly>
</template>
```

数据包放在 `public/datasets/demo/`；Nuxt 的 `public/` 等价于 Vite 的 `public/`。

### 不要用 `useAsyncData` 缓存 Runtime 实例

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

它不会在组件卸载时 `close()`，还可能把同一个实例复用给多个页面。需要共享时，用 `useState` 保存**是否已打开**，并让每个页面自己管理实例；或者写一个只在本组件生命周期内有效的 composable。

## 5. SvelteKit

Svelte 的 `onMount` 只在浏览器执行，返回的函数用于清理：

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

SvelteKit 的静态资源放在 `static/datasets/demo/`，构建后路径是 `/datasets/demo/`。不要在 `+page.server.ts` 里调用 `open()`。

### Svelte 5 runes

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

普通 `$state` 会递归代理对象，类实例不需要这种代理；用 `$state.raw` 还能避免代理带来的性能开销。

## 6. 常见的 SSR 与打包问题

<details>
<summary>为什么不能把 open() 放在模块顶层？</summary>

模块顶层代码会在 SSR、预渲染或每次热更新时执行，可能拿不到 `window`/`fetch`，也无法在组件卸载时关闭实例。始终把它放进 `useEffect` 或事件回调。

</details>

<details>
<summary>Next.js 需要 `dynamic(..., { ssr: false })` 吗？</summary>

如果只在客户端组件里调用 `open()`，通常不需要。SDK 本身不依赖 Node 内置模块；真正依赖浏览器的是 `fetch` 与 Range 响应。若你的组件在模块顶层访问 `window`，再做动态导入。

</details>

<details>
<summary>开发环境跨域怎么办？</summary>

Vite 用 `server.proxy`，Next.js 用 `rewrites`，把 `/datasets` 代理到静态文件服务；生产环境则确保 CDN 返回 `Access-Control-Allow-Origin` 并暴露 `Content-Range`。

</details>

<details>
<summary>为什么生产环境返回 200 而不是 206？</summary>

静态服务器忽略了 Range，常见于压缩或重写层。检查 `Accept-Ranges: bytes`、代理是否缓存了完整响应，以及是否对数据包做了 gzip 重编码。必要时改用 `.wsql` 容器。

</details>

## 相关页面

- [浏览器示例](/docs/examples/browser)
- [部署到 CDN](/docs/tooling/deploy-cdn)
- [资源读取与缓存](/docs/sdk/resource-readers)
