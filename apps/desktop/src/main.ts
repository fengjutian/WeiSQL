import { openPath, start } from "./app.js";

// Test hook: the native file dialog cannot be driven from an automated browser,
// so the end-to-end check opens a path through the same entry point drag-and-drop
// uses. It only exists in the Tauri runtime.
declare global {
  interface Window {
    __WEISQL_OPEN__?: (path: string) => Promise<void>;
  }
}

start().catch(error => {
  const status = document.getElementById("status");
  if (status !== null) status.textContent = `初始化失败：${String(error)}`;
  console.error(error);
});

// Drag and drop only exists in the desktop shell; the browser preview keeps the
// same UI without registering a Tauri-only listener.
if ("__TAURI_INTERNALS__" in window) {
  window.__WEISQL_OPEN__ = openPath;
  void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        const path = event.payload.paths[0];
        if (path !== undefined) void openPath(path);
      }
    }),
  ).catch(() => undefined);
}
