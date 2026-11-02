import { useEffect, useState } from "react";
import {
  open,
  HttpResourceReader,
  type WeiSQLDatabase,
} from "@weisql/sdk";

/**
 * The hook from the docs (`/docs/examples/frameworks#2-react-hook`).
 * Kept verbatim so the smoke test proves the documented lifecycle actually works.
 */
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
