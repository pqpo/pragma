import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Run with CHROMIUM_PATH pointing to Chrome/Chromium when it is not on PATH.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-home-missions-ui-"));
let browser;
let socket;
let server;
const pending = new Map();
let commandId = 0;
const timeout = setTimeout(() => {
  console.error("Home missions UI tests timed out");
  browser?.kill();
  process.exitCode = 1;
  socket?.close();
  server?.closeAllConnections();
  server?.close();
  for (const entry of pending.values()) entry.reject(new Error("Browser test timed out"));
}, 60_000);
try {
  await build({
    absWorkingDir: desktopRoot,
    stdin: {
      contents:
        'import { runHomeMissionsUiTests, prepareHomeMissionsVisual } from "./scripts/fixtures/home-missions-ui.tsx"; Object.assign(window, { runHomeMissionsUiTests, prepareHomeMissionsVisual });',
      resolveDir: desktopRoot,
    },
    outfile: join(temporaryRoot, "test.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".jpg": "dataurl", ".png": "dataurl", ".svg": "dataurl", ".ttf": "dataurl" },
    logLevel: "warning",
  });
  await writeFile(
    join(temporaryRoot, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script src="/test.js"></script></body></html>',
  );
  server = createServer(async (request, response) => {
    const name = new Map([
      ["/", "index.html"],
      ["/test.js", "test.js"],
      ["/test.css", "test.css"],
    ]).get(request.url);
    if (name === undefined) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
      );
      response.end(await readFile(join(temporaryRoot, name)));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = spawn(
    process.env.CHROMIUM_PATH ?? "chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(temporaryRoot, "profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = "";
    browser.on("error", reject);
    browser.on("exit", (code) =>
      reject(new Error(`Chromium exited (${code}): ${stderr.slice(-1000)}`)),
    );
    browser.stderr.on("data", (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveEndpoint(match[1]);
    });
  });
  const pages = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
  const page = pages.find((target) => target.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen;
    socket.onerror = reject;
  });
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    const request = pending.get(value.id);
    if (request === undefined) return;
    pending.delete(value.id);
    if (value.error) request.reject(new Error(JSON.stringify(value.error)));
    else request.resolve(value.result);
  };
  function send(method, params) {
    return new Promise((resolveResult, reject) => {
      const id = ++commandId;
      pending.set(id, { resolve: resolveResult, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await send("Page.enable", {});
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const loaded = new Promise((resolveLoaded) => {
    socket.addEventListener("message", function listener({ data }) {
      if (JSON.parse(data).method !== "Page.loadEventFired") return;
      socket.removeEventListener("message", listener);
      resolveLoaded();
    });
  });
  await send("Page.navigate", { url });
  await loaded;
  const result = await send("Runtime.evaluate", {
    expression: "window.runHomeMissionsUiTests()",
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  async function evaluate(expression) {
    const value = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (value.exceptionDetails)
      throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  }
  await evaluate('document.querySelector(".mission-new-button").focus()');
  for (const modifiers of [0, 8]) {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", modifiers });
    }
  }
  if (!(await evaluate('document.activeElement.matches(".mission-new-button:focus-visible")'))) {
    throw new Error("New mission button has no visible keyboard focus");
  }
  for (const [language, width, height, scale] of [
    ["en", 1440, 900, 1],
    ["zh-Hans", 1080, 700, 1],
    ["zh-Hant", 1152, 720, 1.25],
    ["en", 1080, 700, 1.5],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await evaluate(`window.prepareHomeMissionsVisual(${JSON.stringify(language)})`);
  }
  console.log(JSON.stringify({ ...result.result.value, nativeKeyboard: true }));
} finally {
  clearTimeout(timeout);
  socket?.close();
  browser?.kill();
  server?.closeAllConnections();
  server?.close();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
