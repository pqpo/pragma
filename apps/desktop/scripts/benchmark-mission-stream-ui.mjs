import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { build } from "esbuild";

import { parseMissionStreamBenchmarkResult } from "./mission-stream-benchmark-result.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-mission-stream-ui-benchmark-"));
const resultPrefix = "PRAGMA_MISSION_STREAM_UI_BENCHMARK:";

try {
  const entryPath = join(temporaryRoot, "benchmark.tsx");
  const bundlePath = join(temporaryRoot, "benchmark.js");
  const htmlPath = join(temporaryRoot, "index.html");
  const mainPath = join(temporaryRoot, "main.cjs");
  await writeFile(
    entryPath,
    benchmarkEntry(
      resolve(desktopRoot, "src/renderer/src/pages/missions/mission-chat-composer.tsx"),
      resolve(desktopRoot, "src/renderer/src/pages/missions/mission-conversation-model.ts"),
      resolve(desktopRoot, "src/renderer/src/pages/missions/mission-live-entry-store.ts"),
      resolve(desktopRoot, "src/renderer/src/pages/missions/mission-chat-presentation.tsx"),
    ),
    "utf8",
  );
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
      reject(new Error("Mission stream UI benchmark exceeded 90 seconds."));
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
            `Mission stream UI benchmark failed with exit code ${String(code)}.\n${stderr || stdout}`,
          ),
        );
        return;
      }
      try {
        resolveResult(parseMissionStreamBenchmarkResult(resultLine, resultPrefix));
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
app.commandLine.appendSwitch("enable-precise-memory-info");
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
  await window.loadFile(${JSON.stringify(htmlPath)});
});
`;
}

function benchmarkEntry(componentPath, modelPath, storePath, presentationPath) {
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MissionChatComposer } from ${JSON.stringify(componentPath)};
import { applyMissionChatUpdateBatch } from ${JSON.stringify(modelPath)};
import { MissionLiveEntryStore } from ${JSON.stringify(storePath)};
import { MissionChatEntryView } from ${JSON.stringify(presentationPath)};

const mission = {
  schemaVersion: "pragma.mission/v10",
  origin: { type: "user" },
  id: "00000000-0000-4000-8000-000000000000",
  title: "Mission stream benchmark",
  goal: "Measure composer input while Mission output is streaming.",
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

function App({ entry, liveEntryStore }) {
  return <>
    <section id="streamed-entry">
      <MissionChatEntryView
        entry={entry}
        liveEntryStore={liveEntryStore}
        missionId={mission.id}
        paintExecutionId={entry.executionId}
      />
    </section>
    <MissionChatComposer
    mission={mission}
    mentionCandidates={[]}
    imageUnsupported={false}
    isFlow={false}
    sending={false}
    clientOperationBusy={false}
    compactingContext={false}
    hasPendingQueuedMessage={false}
    executionActive={true}
    interruptible={true}
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
    />
  </>;
}

const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const percentile = (samples, fraction) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};

async function measure(entryCount, streaming) {
  const rootElement = document.getElementById("root");
  const root = createRoot(rootElement);
  let snapshot = {
    missionId: mission.id,
    revision: 1,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      id: "answer-" + index,
      kind: "assistant",
      executionId: "execution-" + index,
      content: "seed",
      streaming: true,
      createdAt: "2026-09-18T00:00:00.000Z",
    })),
    page: {},
    pendingInteractions: [],
  };
  const targetId = snapshot.entries.at(-1).id;
  const targetEntry = snapshot.entries.at(-1);
  const liveEntryStore = new MissionLiveEntryStore();
  liveEntryStore.reset(snapshot.entries);
  flushSync(() => root.render(<App entry={targetEntry} liveEntryStore={liveEntryStore} />));
  await nextPaint();
  const output = document.getElementById("streamed-entry");
  let outputMutationCount = 0;
  const mutationObserver = new MutationObserver((records) => {
    outputMutationCount += records.length;
  });
  mutationObserver.observe(output, { childList: true, subtree: true, characterData: true });
  let stopped = false;
  let streamOperations = 0;
  const pump = () => {
    if (stopped) return;
    const result = applyMissionChatUpdateBatch(snapshot, [{
      missionId: mission.id,
      streamId: "00000000-0000-4000-8000-000000000099",
      revision: snapshot.revision + 1,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: targetId, field: "content", delta: "x" }],
    }], {
      deferContentEntries: true,
      readEntry: (entryId) => liveEntryStore.get(entryId),
    });
    for (const entry of result.changedEntries.values()) liveEntryStore.publish(entry);
    snapshot = result.snapshot;
    streamOperations += 1;
    requestAnimationFrame(pump);
  };
  let longTaskCount = 0;
  let longTaskMs = 0;
  const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskMs += entry.duration;
        }
      })
    : undefined;
  observer?.observe({ type: "longtask" });
  const heapBefore = performance.memory?.usedJSHeapSize;
  if (streaming) requestAnimationFrame(pump);
  const textarea = document.querySelector("textarea");
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const samples = [];
  let samplesWithStreamProgress = 0;
  for (let index = 0; index < 40; index += 1) {
    const operationsBeforeSample = streamOperations;
    const startedAt = performance.now();
    nativeValueSetter.call(textarea, "fixed-length-draft-" + String(index).padStart(2, "0"));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextPaint();
    if (streamOperations > operationsBeforeSample) samplesWithStreamProgress += 1;
    samples.push(performance.now() - startedAt);
  }
  stopped = true;
  await nextPaint();
  mutationObserver.disconnect();
  observer?.disconnect();
  const heapAfter = performance.memory?.usedJSHeapSize;
  const liveContent = liveEntryStore.get(targetId)?.content ?? "";
  if (!output.textContent.includes(liveContent)) {
    throw new Error("Rendered Mission output did not reach the latest live entry content.");
  }
  root.unmount();
  rootElement.replaceChildren();
  return {
    mode: streaming ? "streaming" : "static",
    entries: entryCount,
    samples: samples.length,
    streamOperations,
    samplesWithStreamProgress,
    inputToPaintP50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    inputToPaintP95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    longTaskCount,
    longTaskMs: Number(longTaskMs.toFixed(2)),
    outputMutationCount,
    renderedStreamCharacters: Math.max(0, liveContent.length - targetEntry.content.length),
    heapDeltaMiB: heapBefore === undefined || heapAfter === undefined
      ? undefined
      : Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(3)),
  };
}

(async () => {
  const results = [];
  for (const entryCount of [100, 1000, 5000]) {
    results.push(await measure(entryCount, false));
    results.push(await measure(entryCount, true));
  }
  document.title = ${JSON.stringify(resultPrefix)} + JSON.stringify({
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    results,
  });
})().catch((error) => {
  document.title = ${JSON.stringify(resultPrefix)} + JSON.stringify({ error: String(error?.stack ?? error) });
});
`;
}
