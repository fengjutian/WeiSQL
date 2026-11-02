/**
 * Browser smoke test for one example app.
 *
 * Mirrors `tools/browser-probe/run.mjs`: the page publishes `window.__SMOKE_RESULT`
 * once it has opened the package and run a query, so the assertion does not depend
 * on markup or styling. The static server records Range responses, which proves the
 * package was read in slices rather than downloaded whole.
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { serveDirectory } from "./serve.mjs";

function findChromium() {
  const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const cached = [];
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith("chromium")) continue;
      cached.push(path.join(cache, entry, "chrome-win64", "chrome.exe"));
      cached.push(path.join(cache, entry, "chrome-linux", "chrome"));
    }
  }
  const candidates = [
    process.env.CHROME_PATH,
    ...cached,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

export async function smokeApp({ name, distDirectory, expectedIds = 3 }) {
  const executablePath = findChromium();
  if (executablePath === undefined) {
    throw new Error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  }

  const server = await serveDirectory(distDirectory);
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`);
  });

  let result;
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__SMOKE_RESULT !== undefined, undefined, { timeout: 60_000 });
    result = await page.evaluate(() => window.__SMOKE_RESULT);
  } catch (error) {
    console.error(`[${name}] smoke did not finish: ${String(error).slice(0, 400)}`);
    console.error(logs.join("\n"));
    await browser.close();
    await server.close();
    throw error;
  }

  await browser.close();
  await server.close();

  const failures = [];
  if (result?.ok !== true) failures.push(`app reported failure: ${result?.error ?? "unknown"}`);
  if (result?.state !== "READY") failures.push(`state was ${String(result?.state)}, expected READY`);
  if ((result?.ids?.length ?? 0) !== expectedIds) {
    failures.push(`expected ${expectedIds} hits, received ${result?.ids?.length ?? 0}`);
  }
  if (result?.capabilities?.vectorExactSearch !== true) {
    failures.push("capabilities().vectorExactSearch was not true");
  }

  const ranges = server.log.filter((entry) => entry.status === 206);
  const vectorRanges = ranges.filter((entry) => entry.path.endsWith(".f32"));
  if (vectorRanges.length === 0) failures.push("no 206 response for the vector file");
  // Only package requests matter; browsers probe /favicon.ico on their own.
  const badStatuses = server.log.filter((entry) => entry.status >= 400 && entry.path.startsWith("/datasets/"));
  if (badStatuses.length > 0) failures.push(`http errors: ${JSON.stringify(badStatuses)}`);

  console.log(
    JSON.stringify(
      {
        app: name,
        browser: executablePath,
        state: result?.state,
        ids: result?.ids,
        ranges: { total: server.log.length, partial: ranges.length, vector: vectorRanges.length },
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) {
    throw new Error(`[${name}] ${failures.join("; ")}`);
  }
}
