import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-composer-benchmark-"));
const resultPrefix = "PRAGMA_COMPOSER_BENCHMARK:";

try {
  const entryPath = join(temporaryRoot, "benchmark.tsx");
  const bundlePath = join(temporaryRoot, "benchmark.js");
  const htmlPath = join(temporaryRoot, "index.html");
  const mainPath = join(temporaryRoot, "main.cjs");
  const componentPath = resolve(
    desktopRoot,
    "src/renderer/src/pages/missions/mission-chat-composer.tsx",
  );

  await writeFile(entryPath, benchmarkEntry(componentPath), "utf8");
  await build({
    absWorkingDir: desktopRoot,
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".jpg": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
    nodePaths: [
      resolve(desktopRoot, "node_modules"),
      resolve(desktopRoot, "../..", "node_modules"),
    ],
    logLevel: "warning",
  });
  await writeFile(
    htmlPath,
    '<!doctype html><html><body><main id="root"></main><script src="./benchmark.js"></script></body></html>',
    "utf8",
  );
  await writeFile(mainPath, benchmarkMain(htmlPath, resultPrefix), "utf8");

  const output = await runElectron(mainPath);
  process.stdout.write(
    `${JSON.stringify(
      {
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
          memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
        },
        ...output,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runElectron(mainPath) {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [mainPath], {
      cwd: desktopRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Composer benchmark exceeded 90 seconds."));
    }, 90_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const resultLine = stdout.split(/\r?\n/u).find((line) => line.startsWith(resultPrefix));
      if (code !== 0 || resultLine === undefined) {
        reject(
          new Error(
            `Composer benchmark failed with exit code ${String(code)}.\n${stderr || stdout}`,
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(resultLine.slice(resultPrefix.length));
        if (result !== null && typeof result === "object" && "error" in result) {
          reject(new Error(`Composer benchmark renderer failed.\n${String(result.error)}`));
          return;
        }
        resolveResult(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function benchmarkMain(htmlPath, prefix) {
  return `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  window.on("page-title-updated", (event, title) => {
    if (!title.startsWith(${JSON.stringify(prefix)})) return;
    event.preventDefault();
    process.stdout.write(title + "\\n");
    app.quit();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write("Renderer exited: " + JSON.stringify(details) + "\\n");
    app.exit(1);
  });
  await window.loadFile(${JSON.stringify(htmlPath)});
});
`;
}

function benchmarkEntry(componentPath) {
  return `
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MissionChatComposer } from ${JSON.stringify(componentPath)};

const mission = {
  schemaVersion: "pragma.mission/v10",
  origin: { type: "user" },
  id: "00000000-0000-4000-8000-000000000000",
  title: "Composer benchmark",
  goal: "Measure isolated Mission composer input.",
  initialMessageId: "00000000-0000-4000-8000-000000000001",
  toolPermissionMode: "request-approval",
  workspace: { path: "/workspace/expert-mesh", basename: "expert-mesh" },
  project: { id: "studio", revision: 1 },
  contextMounts: [],
  executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Benchmark" },
  lifecycleStatus: "active",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

function App({ blockCount, mode, renderCounter }) {
  renderCounter.current += 1;
  const blocks = useRef(Array.from({ length: blockCount }, (_, index) => "message-" + index));
  const [coupledDraft, setCoupledDraft] = useState("");
  const coupledInputRef = useRef(null);
  useEffect(() => {
    if (mode !== "coupled" || coupledInputRef.current === null) return;
    const input = coupledInputRef.current;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 130) + "px";
  }, [coupledDraft, mode]);
  return <div>
    <section id="conversation">
      {blocks.current.map((block) => <article key={block}>{block}</article>)}
    </section>
    {mode === "coupled" ? <textarea
      ref={coupledInputRef}
      value={coupledDraft}
      onChange={(event) => setCoupledDraft(event.target.value)}
    /> : <MissionChatComposer
      mission={mission}
      mentionCandidates={[]}
      imageUnsupported={false}
      isFlow={false}
      sending={false}
      clientOperationBusy={false}
      compactingContext={false}
      hasPendingQueuedMessage={false}
      executionActive={false}
      interruptible={false}
      interrupting={false}
      recoveryAvailable={false}
      awaitingRequest={false}
      toolbarOptions={null}
      contextWindowControl={null}
      onSubmit={() => {}}
      onInterrupt={() => {}}
      onRecover={() => {}}
      onError={() => {}}
      onAttachmentLimit={() => {}}
      onAttachmentsAccepted={() => {}}
    />}
  </div>;
}

const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const percentile = (samples, fraction) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};

async function measure(blockCount, mode) {
  const rootElement = document.getElementById("root");
  const root = createRoot(rootElement);
  const renderCounter = { current: 0 };
  let conversationMutations = 0;
  let longTaskMs = 0;
  let longTaskCount = 0;
  flushSync(() => root.render(
    <App blockCount={blockCount} mode={mode} renderCounter={renderCounter} />,
  ));
  await nextPaint();
  const longTaskObserver = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskMs += entry.duration;
        }
      })
    : undefined;
  longTaskObserver?.observe({ type: "longtask" });
  const conversation = document.getElementById("conversation");
  const mutationObserver = new MutationObserver((records) => {
    conversationMutations += records.length;
  });
  mutationObserver.observe(conversation, { childList: true, subtree: true, characterData: true });
  const textarea = document.querySelector("textarea");
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  ).set;
  const nativeScrollHeight = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollHeight",
  )?.get ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")?.get;
  let layoutReadCount = 0;
  let layoutReadMs = 0;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get() {
      const startedAt = performance.now();
      const height = nativeScrollHeight?.call(textarea) ?? 24;
      layoutReadMs += performance.now() - startedAt;
      layoutReadCount += 1;
      return height;
    },
  });
  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    const startedAt = performance.now();
    nativeValueSetter.call(textarea, "fixed-length-draft-" + String(index).padStart(2, "0"));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextPaint();
    samples.push(performance.now() - startedAt);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  mutationObserver.disconnect();
  longTaskObserver?.disconnect();
  const result = {
    mode,
    blocks: blockCount,
    samples: samples.length,
    inputToPaintP50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    inputToPaintP95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    inputLongTaskCount: samples.filter((sample) => sample >= 50).length,
    observedLongTaskCount: longTaskCount,
    observedLongTaskMs: Number(longTaskMs.toFixed(2)),
    pageRenderCount: renderCounter.current,
    conversationMutationCount: conversationMutations,
    layoutReadCount,
    layoutReadMs: Number(layoutReadMs.toFixed(3)),
  };
  root.unmount();
  rootElement.replaceChildren();
  return result;
}

(async () => {
  const results = [];
  for (const blockCount of [100, 1000, 5000]) {
    results.push(await measure(blockCount, "coupled"));
    results.push(await measure(blockCount, "isolated"));
  }
  document.title = ${JSON.stringify(resultPrefix)} + JSON.stringify({
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    results,
  });
})().catch((error) => {
  document.title = ${JSON.stringify(resultPrefix)} + JSON.stringify({ error: String(error?.stack ?? error) });
});
`;
}
