import { existsSync, readdirSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";
import { createProbeServer } from "./server.mjs";

const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
const chromiumDir = readdirSync(cache).find(entry => entry.startsWith("chromium-"));
const executablePath = path.join(cache, chromiumDir, "chrome-win64", "chrome.exe");
if (!existsSync(executablePath)) throw new Error("chromium not found");

const target = process.argv[2];
mkdirSync(path.dirname(target), { recursive: true });

const probe = createProbeServer();
const port = await probe.listen();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${port}/playground/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__PLAYGROUND_STATE?.ok === true, undefined, { timeout: 60_000 });
await page.screenshot({ path: target, fullPage: true });
console.log(`screenshot: ${target}`);
await browser.close();
await probe.close();
