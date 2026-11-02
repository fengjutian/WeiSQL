import { useEffect, useState } from "react";
import type { VectorHit } from "@weisql/sdk";
import { useWeiSQL } from "./useWeiSQL";

const baseUrl = `${import.meta.env.BASE_URL}datasets/demo/`;

export function App() {
  const { db, error } = useWeiSQL(baseUrl);
  const [hits, setHits] = useState<readonly VectorHit[]>([]);

  // The smoke test waits for this marker, mirroring tools/browser-probe's
  // window.__PROBE_RESULT contract.
  useEffect(() => {
    if (db === null) return;

    let cancelled = false;
    db.vector
      .search("document_embeddings", [1, 0], { topK: 3 })
      .then((next) => {
        if (cancelled) return;
        setHits(next);
        window.__SMOKE_RESULT = {
          ok: true,
          state: db.state,
          ids: next.map((hit) => hit.id),
          capabilities: db.capabilities(),
        };
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        window.__SMOKE_RESULT = { ok: false, error: String(reason) };
      });

    return () => {
      cancelled = true;
    };
  }, [db]);

  if (error) {
    return <p role="alert">数据包加载失败：{error.message}</p>;
  }

  if (db === null) {
    return <p>正在加载索引…</p>;
  }

  return (
    <main>
      <h1>WeiSQL · Vite + React</h1>
      <p>
        状态：<strong>{db.state}</strong>
      </p>
      <ul>
        {hits.map((hit) => (
          <li key={hit.id}>
            {String(hit.id)} · {hit.distance.toFixed(4)}
          </li>
        ))}
      </ul>
    </main>
  );
}
