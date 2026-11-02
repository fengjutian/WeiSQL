import { onMounted, onUnmounted, shallowRef } from "vue";
import {
  open,
  HttpResourceReader,
  type WeiSQLDatabase,
} from "@weisql/sdk";

/**
 * The composable from the docs (`/docs/examples/frameworks#5-vue-3--nuxt`).
 * `shallowRef` keeps the runtime instance out of Vue's deep proxy.
 */
export function useWeiSQL(baseUrl: string) {
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

  return { db, error };
}
