<script lang="ts">
  import { onMount } from "svelte";
  import {
    open,
    HttpResourceReader,
    type WeiSQLDatabase,
  } from "@weisql/sdk";

  const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;

  let db = $state.raw<WeiSQLDatabase | null>(null);
  let error = $state<Error | null>(null);
  let hits = $state<Array<string | number>>([]);

  onMount(() => {
    const controller = new AbortController();
    let disposed = false;

    open({
      manifestUrl: `${baseUrl}manifest.json`,
      resourceReader: new HttpResourceReader({ baseUrl }),
      cache: { maxCacheBytes: 32 * 1024 * 1024 },
      signal: controller.signal,
    })
      .then(async (instance) => {
        if (disposed) {
          await instance.close();
          return;
        }
        db = instance;

        const found = await instance.vector.search("document_embeddings", [1, 0], { topK: 3 });
        if (disposed) return;

        hits = found.map((hit) => hit.id);
        window.__SMOKE_RESULT = {
          ok: true,
          state: instance.state,
          ids: hits,
          capabilities: instance.capabilities(),
        };
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        error = reason as Error;
        window.__SMOKE_RESULT = { ok: false, error: String(reason) };
      });

    return () => {
      disposed = true;
      controller.abort();
      void db?.close();
    };
  });
</script>

{#if error}
  <p role="alert">数据包加载失败：{error.message}</p>
{:else if db}
  <h1>WeiSQL · SvelteKit</h1>
  <p>状态：<strong>{db.state}</strong></p>
  <ul>
    {#each hits as id}
      <li>{id}</li>
    {/each}
  </ul>
{:else}
  <p>正在加载索引…</p>
{/if}
