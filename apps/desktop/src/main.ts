import { openPath, start } from "./app.js";

start().catch(error => {
  const status = document.getElementById("status");
  if (status !== null) status.textContent = `初始化失败：${String(error)}`;
  console.error(error);
});

// Drag and drop only exists in the desktop shell; the browser preview keeps the
// same UI without registering a Tauri-only listener.
if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        const path = event.payload.paths[0];
        if (path !== undefined) void openPath(path);
      }
    }),
  ).catch(() => undefined);
}
