/* global window, document, requestAnimationFrame, MutationObserver, HTMLTextAreaElement */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import electronPath from "electron";
import {
  createSecretStore,
  createNativeOsKeychain,
  SECRET_STORE_SERVICE,
} from "@pragma/local-host";

const { values } = parseArgs({
  options: {
    "source-home": { type: "string" },
    samples: { type: "string", default: "20" },
    model: { type: "string", default: "deepseek-v4-flash" },
    thinking: { type: "string", default: "medium" },
    groups: { type: "string", default: "cold,new,warm" },
    output: { type: "string" },
  },
});
if (!values["source-home"])
  throw new Error("Pass --source-home for the existing provider configuration.");
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Invalid sample count.");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "pragma-mission-e2e-"));
const home = join(temporary, "pragma");
const keychain = createNativeOsKeychain();
const source = resolve(values["source-home"]);
const sourceData = join(source, "data");
const data = join(home, "data");
let createdKey = false;
const startedAt = new Date().toISOString();
try {
  const providers = JSON.parse(await readFile(join(sourceData, "model-providers.json"), "utf8"));
  const provider = providers.providers.find((item) =>
    item.models.some((model) => model.id === values.model),
  );
  if (!provider) throw new Error("Requested model is absent from the source configuration.");
  const originalSecrets = createSecretStore({
    root: join(sourceData, "credentials/secret-store"),
    dataRoot: sourceData,
    keychain,
  });
  const benchmarkSecrets = createSecretStore({
    root: join(data, "credentials/secret-store"),
    dataRoot: data,
    keychain,
  });
  if (provider.apiKeySecretRef) {
    const handle = await originalSecrets.get(provider.apiKeySecretRef);
    try {
      provider.apiKeySecretRef = await benchmarkSecrets.put({
        owner: provider.apiKeySecretRef.owner,
        value: handle.bytes(),
      });
      createdKey = true;
    } finally {
      handle.dispose();
    }
  }
  // Isolate all missions, sessions and artifacts; do not clone user executions or automations.
  process.send?.({ phase: "credentials-ready" });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(
    join(data, "model-providers.json"),
    JSON.stringify({ ...providers, providers: [provider] }),
    { mode: 0o600 },
  );
  await mkdir(join(home, "state"), { recursive: true });
  await copyFile(
    join(source, "state/desktop-settings.json"),
    join(home, "state/desktop-settings.json"),
  );
  const configuration = {
    home,
    workspace: join(temporary, "workspace"),
    providerId: provider.id,
    model: values.model,
    thinking: values.thinking,
  };
  await mkdir(configuration.workspace, { recursive: true });
  const main = join(temporary, "main.cjs");
  const rounds = [];
  for (const group of values.groups.split(",")) {
    if (!["cold", "new", "warm"].includes(group)) throw new Error("Unknown benchmark group.");
    const launches = group === "cold" ? samples : 1;
    for (let launch = 0; launch < launches; launch++) {
      await writeFile(
        main,
        harness(
          { ...configuration, group, samples: group === "cold" ? 1 : samples },
          join(desktop, "out/main/index.js"),
        ),
      );
      const result = await runElectron(main);
      rounds.push(...result.rounds);
    }
  }
  const records = await diagnosticRecords(join(home, "archives/diagnostics/desktop"));
  for (const round of rounds) {
    const executionRecords = records.filter(
      (record) =>
        record.scope?.executionId === round.executionId ||
        record.attributes?.executionId === round.executionId,
    );
    const timestamp = (event) => {
      const record = executionRecords.find((entry) => entry.event === event);
      return record ? Date.parse(record.occurredAt) : undefined;
    };
    const dispatch = timestamp("runtime.model_request_dispatched");
    const finished = timestamp("runtime.model_request_finished");
    const terminal = timestamp("execution.terminal_committed");
    const release = timestamp("session.active_binding_released");
    const observer = timestamp("mission.observer_settled");
    const acceptance = records
      .filter(
        (record) =>
          record.event === "mission.inbox_durable" &&
          (record.scope?.missionId === round.missionId ||
            record.attributes?.missionId === round.missionId) &&
          Date.parse(record.occurredAt) >= round.clickAt,
      )
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0];
    const accepted = acceptance ? Date.parse(acceptance.occurredAt) : undefined;
    const controlAvailable = round.controlUpdates?.find((update) => update.at >= accepted)?.at;
    Object.assign(round, {
      clickToDispatchMs: difference(dispatch, round.clickAt),
      durableAcceptToControlAvailableMs: difference(controlAvailable, accepted),
      runtimeTextToPaintMs: difference(round.textPaintAt, timestamp("runtime.first_text_delta")),
      runtimeReasoningToPaintMs: difference(
        round.reasoningPaintAt,
        timestamp("runtime.first_reasoning_delta"),
      ),
      sdkTextTtftMs: difference(timestamp("runtime.first_text_delta"), dispatch),
      sdkReasoningTtftMs: difference(timestamp("runtime.first_reasoning_delta"), dispatch),
      sdkDurationMs: difference(finished, dispatch),
      modelEndToCoreTerminalMs: difference(terminal, finished),
      coreTerminalToPaintMs: difference(round.terminalPaintAt, terminal),
      sessionReleaseAfterCoreMs: difference(release, terminal),
      observerAfterCoreMs: difference(observer, terminal),
    });
    round.measurementIssues = [
      "clickToDispatchMs",
      "durableAcceptToControlAvailableMs",
      "runtimeTextToPaintMs",
      "modelEndToCoreTerminalMs",
      "coreTerminalToPaintMs",
      "sessionReleaseAfterCoreMs",
    ].filter((metric) => !Number.isFinite(round[metric]) || round[metric] < 0);
    round.timeline = {
      dispatch,
      accepted,
      controlAvailable,
      finished,
      terminal,
      release,
      observer,
      runtimeText: timestamp("runtime.first_text_delta"),
      runtimeReasoning: timestamp("runtime.first_reasoning_delta"),
    };
  }
  const output = {
    schemaVersion: "pragma.mission-e2e-benchmark/v1",
    startedAt,
    build: "production",
    cpu: cpus()[0]?.model,
    model: values.model,
    thinking: values.thinking,
    workload:
      "Full Desktop with default background services; isolated empty business data. Real provider. No copied user automations.",
    summary: Object.fromEntries(
      values.groups
        .split(",")
        .map((group) => [group, summarize(rounds.filter((round) => round.group === group))]),
    ),
    rounds,
  };
  if (values.output)
    await writeFile(resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  process.send?.({ phase: "credentials-cleanup" });
  if (createdKey)
    await keychain.delete(
      SECRET_STORE_SERVICE,
      `home:${createHash("sha256").update(`${data}\0default`).digest("hex")}:master-key:v1`,
    );
  await rm(temporary, { recursive: true, force: true });
}

function difference(end, start) {
  return !Number.isFinite(end) || !Number.isFinite(start)
    ? null
    : Math.round((end - start) * 100) / 100;
}
function summarize(rounds) {
  const metrics = [
    "clickToDispatchMs",
    "durableAcceptToControlAvailableMs",
    "runtimeTextToPaintMs",
    "runtimeReasoningToPaintMs",
    "sdkTextTtftMs",
    "sdkReasoningTtftMs",
    "sdkDurationMs",
    "modelEndToCoreTerminalMs",
    "coreTerminalToPaintMs",
    "sessionReleaseAfterCoreMs",
    "observerAfterCoreMs",
  ];
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = rounds
        .map((round) => round[metric])
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((a, b) => a - b);
      return [
        metric,
        {
          samples: values.length,
          p50: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)] ?? null,
          p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null,
        },
      ];
    }),
  );
}
async function diagnosticRecords(root) {
  const records = [];
  for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, item.name);
    if (item.isDirectory()) records.push(...(await diagnosticRecords(path)));
    else if (item.name.startsWith("operations-") && item.name.endsWith(".jsonl"))
      for (const line of (await readFile(path, "utf8")).split("\n"))
        if (line) records.push(JSON.parse(line));
  }
  return records;
}
function runElectron(main) {
  return new Promise((resolveRun, reject) => {
    const environment = { ...process.env, PRAGMA_HOME: home, PRAGMA_LOG_LEVEL: "info" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [main], {
      cwd: desktop,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let result;
    let errorText = "";
    let buffered = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Desktop benchmark exceeded 10 minutes."));
    }, 600_000);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines)
        if (line.startsWith("PRAGMA_E2E_RESULT:"))
          result = JSON.parse(line.slice("PRAGMA_E2E_RESULT:".length));
    });
    child.stderr.on("data", (chunk) => {
      errorText = (errorText + chunk).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !result || result.error)
        reject(new Error(result?.error ?? `Desktop benchmark exited ${code}: ${errorText}`));
      else resolveRun(result);
    });
  });
}
function harness(configuration, entry) {
  return `const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const configuration = ${JSON.stringify(configuration)};
app.setPath('userData', ${JSON.stringify(join(temporary, "electron-user-data"))});
app.on('browser-window-created', (_event, window) => {
 window.webContents.once('did-finish-load', async () => {
  try {
   const result = await window.webContents.executeJavaScript('(' + (${rendererRun.toString()}).toString() + ')(' + JSON.stringify(configuration) + ')');
   console.log('PRAGMA_E2E_RESULT:' + JSON.stringify(result));
  } catch (error) { console.log('PRAGMA_E2E_RESULT:' + JSON.stringify({error: error.message})); }
  app.quit();
 });
});
import(pathToFileURL(${JSON.stringify(entry)}).href);`;
}
async function rendererRun(configuration) {
  const api = window.pragmaDesktop;
  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  const wait = async (check, name) => {
    const end = performance.now() + 120_000;
    while (performance.now() < end) {
      const result = await check();
      if (result) return result;
      await delay(20);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const painted = async () =>
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  await wait(
    () => api.getBridgeSnapshot().then((snapshot) => snapshot.startup.status === "ready"),
    "Bridge startup",
  );
  const executors = await api.listMissionExecutors();
  const executor =
    executors.find((entry) => entry.name === "Pragma" && entry.kind !== "flow") ??
    executors.find((entry) => entry.kind === "expert");
  if (!executor) throw new Error("No Expert executor.");
  const rounds = [];
  const terminalStatuses = new Map();
  const currentSamples = new Map();
  const previousExecutions = new Map();
  const stop = api.subscribeMissionStatusUpdates((update) => {
    const execution = update.execution;
    if (!execution) return;
    const sample = currentSamples.get(update.missionId);
    if (sample && execution.id !== sample.previousId) sample.executionId = execution.id;
    if (["succeeded", "failed", "cancelled"].includes(execution.status))
      terminalStatuses.set(execution.id, execution.status);
  });
  const run = async (mission, first) => {
    const sample = {
      group: configuration.group,
      missionId: mission.id,
      clickAt: Date.now(),
      previousId: previousExecutions.get(mission.id),
      controlUpdates: [],
    };
    currentSamples.set(mission.id, sample);
    const stopControl = api.subscribeMissionChat(mission.id, (update) => {
      if (update.kind === "patch" && update.patches.some((patch) => patch.type === "queue.update"))
        sample.controlUpdates.push({ at: Date.now(), revision: update.revision });
    });
    let terminal;
    const observing = new MutationObserver(() => {
      for (const [selector, field] of [
        [".mission-assistant-message[data-mission-execution-id]", "textPaintAt"],
        [".mission-thinking-entry[data-mission-execution-id]", "reasoningPaintAt"],
      ]) {
        const entries = [...document.querySelectorAll(selector)];
        const element = entries.find(
          (item) =>
            item.dataset.missionExecutionId === sample.executionId && item.textContent.trim(),
        );
        if (element && sample[field] === undefined) {
          sample[field] = "pending";
          void painted().then(() => {
            sample[field] = Date.now();
          });
        }
      }
      const status = document.querySelector(".mission-detail-status-bar");
      if (
        sample.executionId &&
        status?.dataset.missionExecutionId === sample.executionId &&
        ["succeeded", "failed", "cancelled"].includes(status.dataset.missionStatus) &&
        sample.terminalPaintAt === undefined
      ) {
        sample.terminalPaintAt = "pending";
        void painted().then(() => {
          sample.terminalPaintAt = Date.now();
        });
      }
    });
    observing.observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    try {
      if (first) {
        sample.clickAt = Date.now();
        const button = await wait(
          () =>
            [...document.querySelectorAll("button")].find(
              (item) =>
                /^(运行|Run)$/i.test(item.getAttribute("aria-label") ?? "") && !item.disabled,
            ),
          "Initial Run button",
        );
        sample.clickAt = Date.now();
        button.click();
        await wait(
          () => sample.executionId && sample.executionId !== sample.previousId,
          "Execution admission",
        );
      } else {
        const textarea = await wait(
          () => document.querySelector(".mission-chat-composer textarea:not(:disabled)"),
          "Composer",
        );
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
          textarea,
          "只回复ok，不要调用工具。",
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await painted();
        const button = await wait(
          () =>
            [...document.querySelectorAll(".mission-chat-composer button")].find(
              (item) =>
                /^(发送|Send)$/i.test(item.getAttribute("aria-label") ?? "") && !item.disabled,
            ),
          "Send button",
        );
        sample.clickAt = Date.now();
        button.click();
        await wait(
          () => sample.executionId && sample.executionId !== sample.previousId,
          "Execution admission",
        );
      }
      terminal = await wait(() => terminalStatuses.get(sample.executionId), "Core terminal");
      if (terminal !== "succeeded") throw new Error(`Mission ended ${terminal}`);
      await wait(() => typeof sample.terminalPaintAt === "number", "Terminal paint");
      await delay(50);
      previousExecutions.set(mission.id, sample.executionId);
      delete sample.previousId;
      rounds.push(sample);
    } finally {
      stopControl();
      observing.disconnect();
      currentSamples.delete(mission.id);
    }
  };
  const create = async () => {
    const mission = await api.createMission({
      workspace: configuration.workspace,
      executor: { ref: executor.ref },
      input: { kind: "prompt", value: "只回复ok，不要调用工具。", attachments: [] },
      modelOverride: {
        providerId: configuration.providerId,
        modelId: configuration.model,
        thinkingLevel: configuration.thinking,
      },
    });
    document.querySelectorAll(".navigation-item")[1].click();
    const row = await wait(() => document.querySelector(".mission-row-open"), "Mission row");
    row.click();
    await wait(
      () => document.querySelector(".mission-detail-status-bar")?.dataset.missionId === mission.id,
      "Mission detail",
    );
    await painted();
    return mission;
  };
  try {
    if (configuration.group === "warm") {
      const mission = await create();
      await run(mission, true);
      rounds.length = 0;
      for (let index = 0; index < configuration.samples; index++) await run(mission, false);
      await api.deleteMission(mission.id);
    } else
      for (let index = 0; index < configuration.samples; index++) {
        const mission = await create();
        await run(mission, true);
        await api.deleteMission(mission.id);
      }
    await delay(500);
    return { rounds };
  } finally {
    stop();
  }
}
