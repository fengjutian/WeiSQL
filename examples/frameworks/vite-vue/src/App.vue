<script setup lang="ts">
import { ref, watch } from "vue";
import type { VectorHit } from "@weisql/sdk";
import { useWeiSQL } from "./useWeiSQL";

const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;
const { db, error } = useWeiSQL(baseUrl);
const hits = ref<readonly VectorHit[]>([]);

// Publish the smoke marker once the runtime is ready, mirroring the React app.
watch(db, async (current) => {
  if (!current) return;
  const found = await current.vector.search("document_embeddings", [1, 0], { topK: 3 });
  hits.value = found;
  window.__SMOKE_RESULT = {
    ok: true,
    state: current.state,
    ids: found.map((hit) => hit.id),
    capabilities: current.capabilities(),
  };
});
</script>

<template>
  <main>
    <h1>WeiSQL · Vue 3</h1>
    <p v-if="error" role="alert">数据包加载失败：{{ error.message }}</p>
    <template v-else-if="db">
      <p>状态：<strong>{{ db.state }}</strong></p>
      <ul>
        <li v-for="hit in hits" :key="hit.id">{{ hit.id }} · {{ hit.distance.toFixed(4) }}</li>
      </ul>
    </template>
    <p v-else>正在加载索引…</p>
  </main>
</template>
