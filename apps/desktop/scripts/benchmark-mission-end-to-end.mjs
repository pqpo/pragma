/* global window, document, requestAnimationFrame, MutationObserver, HTMLTextAreaElement */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import electronPath from "electron";
import {
  E2E_GROUPS,
  enrichRound,
  summarize,
  summarizeByRole,
  verifyBackgroundModelOverlap,
  parseCoreTerminalConsole,
  readDiagnosticRecords,
} from "./mission-e2e-benchmark-result.mjs";
import { rendererScenarioRun } from "./mission-e2e-benchmark-scenarios.mjs";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
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
    "background-load": { type: "boolean", default: false },
  },
});
if (!values["source-home"])
  throw new Error("Pass --source-home for the existing provider configuration.");
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Invalid sample count.");
const groups = values.groups.split(",");
if (groups.some((group) => !E2E_GROUPS.includes(group)))
  throw new Error("Unknown benchmark group.");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "pragma-mission-e2e-"));
const home = join(temporary, "pragma");
const keychain = createNativeOsKeychain();
const source = resolve(values["source-home"]);
const sourceData = join(source, "data");
const data = join(home, "data");
let createdKey = false;
const startedAt = new Date().toISOString();
const rounds = [];
const launches = [];
const failures = [];
let phase = "provider-configuration";
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
  phase = "credentials";
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
    backgroundLoad: values["background-load"],
    dslApiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  };
  await mkdir(configuration.workspace, { recursive: true });
  const main = join(temporary, "main.cjs");
  phase = "desktop-scenarios";
  for (const group of groups) {
    const launchCount = group === "cold" ? samples : 1;
    for (let launch = 0; launch < launchCount; launch++) {
      const launchedAt = Date.now();
      await writeFile(
        main,
        harness(
          { ...configuration, group, samples: group === "cold" ? 1 : samples, launchedAt },
          join(desktop, "out/main/index.js"),
        ),
      );
      const result = await runElectron(main);
      rounds.push(...(result.rounds ?? []));
      launches.push({ group, launchedAt, ...result.startup, background: result.background });
      failures.push(...(result.failures ?? []));
      if (result.error) failures.push({ group, phase: "renderer", error: result.error });
    }
  }
  phase = "diagnostic-enrichment";
  const records = await readDiagnosticRecords(join(home, "archives/diagnostics/desktop"));
  enrichResults(records);
  const output = {
    schemaVersion: "pragma.mission-e2e-benchmark/v1",
    startedAt,
    build: "production",
    cpu: cpus()[0]?.model,
    model: values.model,
    thinking: values.thinking,
    workload: values["background-load"]
      ? "Isolated synthetic Automation and Memory capture/curator configuration; actual activity recorded per launch. No copied user automations."
      : "Full Desktop with default background services; isolated empty business data. Real provider. No copied user automations.",
    backgroundLoad: values["background-load"],
    launches,
    failures,
    verification: {
      realModelSamples: rounds.filter(
        (round) =>
          Number.isFinite(round.timeline?.dispatch) && !round.error && round.status === "succeeded",
      ).length,
      validMeasuredRounds: rounds.filter(
        (round) =>
          round.status === "succeeded" && !round.error && round.measurementIssues.length === 0,
      ).length,
      exactCoreEventTrigger:
        "immediate-core uses existing execution.terminal_committed synchronous console marker; occurredAt is Core fact time, observedAt and relay delay are separate",
      backgroundExtraction:
        "Job running is only a claim observation; complete correlated curator Runtime attempts must overlap actual foreground rounds.",
    },
    summary: Object.fromEntries(
      values.groups
        .split(",")
        .map((group) => [group, summarize(rounds.filter((round) => round.group === group))]),
    ),
    summaryByRole: Object.fromEntries(
      groups.map((group) => [
        group,
        summarizeByRole(rounds.filter((round) => round.group === group)),
      ]),
    ),
    summaryPolicy:
      "summary combines all roles for continuity; use summaryByRole for initial/followup comparisons. Only succeeded, enriched rounds without measurement issues enter percentiles; metric omissions and all excluded reasons are counted. Four-missions retains four initial rounds and samples followup sends per owner.",
    rounds,
  };
  if (values.output)
    await writeFile(resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const records = await readDiagnosticRecords(join(home, "archives/diagnostics/desktop")).catch(
    () => [],
  );
  enrichResults(records);
  const output = {
    schemaVersion: "pragma.mission-e2e-benchmark/v1",
    startedAt,
    build: "production",
    model: values.model,
    thinking: values.thinking,
    groups,
    rounds,
    launches,
    failures: [...failures, { phase, error: error.message }],
    verification: {
      realModelSamples: rounds.filter(
        (round) =>
          Number.isFinite(round.timeline?.dispatch) && round.status === "succeeded" && !round.error,
      ).length,
      status: "failed",
    },
  };
  if (values.output)
    await writeFile(resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  process.send?.({ phase: "credentials-cleanup" });
  if (createdKey)
    await keychain.delete(
      SECRET_STORE_SERVICE,
      `home:${createHash("sha256").update(`${data}\0default`).digest("hex")}:master-key:v1`,
    );
  await rm(temporary, { recursive: true, force: true });
}

function enrichResults(records) {
  for (const round of rounds) enrichRound(round, records);
  for (const launch of launches) {
    if (!launch.background?.enabled) continue;
    const launchRounds = rounds.filter((round) => round.launchId === launch.launchedAt);
    verifyBackgroundModelOverlap(launch.background, launchRounds, records);
    for (const failure of launch.background.failures.filter(
      (failure) => failure.phase === "memory-model-overlap",
    ))
      if (
        !failures.some(
          (existing) => existing.phase === failure.phase && existing.launchId === launch.launchedAt,
        )
      )
        failures.push({ ...failure, group: launch.group, launchId: launch.launchedAt });
  }
}

function runElectron(main) {
  return new Promise((resolveRun, reject) => {
    const environment = {
      ...process.env,
      PRAGMA_HOME: home,
      PRAGMA_LOG_LEVEL: "info",
      PRAGMA_BENCHMARK_LAUNCHED_AT: String(Date.now()),
    };
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
      if (code !== 0 || !result)
        reject(new Error(`Desktop benchmark exited ${code}: ${errorText}`));
      else resolveRun(result);
    });
  });
}
function harness(configuration, entry) {
  const renderer =
    ["cold", "new", "warm"].includes(configuration.group) && !configuration.backgroundLoad
      ? rendererRun
      : rendererScenarioRun;
  return `const processStartedAt = Date.now();
const { app } = require('electron');
const { pathToFileURL } = require('node:url');
const configuration = ${JSON.stringify(configuration)};
configuration.launchedAt = Number(process.env.PRAGMA_BENCHMARK_LAUNCHED_AT);
configuration.processStartedAt = processStartedAt;
let benchmarkWindow;
const coreRelayFailures = [];
if (configuration.group === 'immediate-core') {
 const parseCoreMarker = ${parseCoreTerminalConsole.toString()};
 const consoleInfo = console.info.bind(console);
 console.info = (payload, ...rest) => {
  const marker = parseCoreMarker(payload, Date.now());
  consoleInfo(payload, ...rest);
  if (marker && benchmarkWindow && !benchmarkWindow.isDestroyed()) {
   void benchmarkWindow.webContents.executeJavaScript('window.__pragmaE2ECoreTerminal?.(' + JSON.stringify(marker) + ')').catch((error) => {
    coreRelayFailures.push({phase: 'core-terminal-relay', error: error.message});
    console.error('PRAGMA_E2E_CORE_RELAY_FAILURE:' + error.message);
   });
  }
 };
}
app.setPath('userData', ${JSON.stringify(join(temporary, "electron-user-data"))});
app.on('browser-window-created', (_event, window) => {
 benchmarkWindow ??= window;
 configuration.windowCreatedAt = Date.now();
 window.webContents.once('did-finish-load', async () => {
  configuration.rendererLoadedAt = Date.now();
  try {
   const result = await window.webContents.executeJavaScript('window.__pragmaE2EBaselineRun = ' + ${JSON.stringify(rendererRun.toString())} + '; (' + (${renderer.toString()}).toString() + ')(' + JSON.stringify(configuration) + ')');
   result.failures = [...(result.failures ?? []), ...coreRelayFailures];
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
  const startup = {
    launchedAt: configuration.launchedAt,
    processStartedAt: configuration.processStartedAt,
    windowCreatedAt: configuration.windowCreatedAt,
    rendererLoadedAt: configuration.rendererLoadedAt,
    bridgeReadyAt: Date.now(),
    startupMs: Date.now() - configuration.launchedAt,
  };
  const executors = await api.listMissionExecutors();
  const executor =
    executors.find((entry) => entry.name === "Pragma" && entry.kind !== "flow") ??
    executors.find((entry) => entry.kind === "expert");
  if (!executor) throw new Error("No Expert executor.");
  const rounds = [];
  const terminalStatuses = new Map();
  const currentSamples = new Map();
  const previousExecutions = new Map();
  const creationMarkers = new Map();
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
      launchId: configuration.launchedAt,
      role: first ? "initial" : "followup",
      presentation: "foreground-ui",
      ...(first ? creationMarkers.get(mission.id) : {}),
      missionId: mission.id,
      clickAt: Date.now(),
      previousId: previousExecutions.get(mission.id),
      controlUpdates: [],
    };
    rounds.push(sample);
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
      sample.previousExecutionId = sample.previousId;
      delete sample.previousId;
      sample.status = terminal;
    } catch (error) {
      sample.error = error.message;
      throw error;
    } finally {
      stopControl();
      observing.disconnect();
      currentSamples.delete(mission.id);
    }
  };
  const create = async () => {
    const createStartedAt = Date.now();
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
    creationMarkers.set(mission.id, { createStartedAt, createFinishedAt: Date.now() });
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
    return { rounds, startup };
  } catch (error) {
    return { rounds, startup, error: error.message };
  } finally {
    stop();
  }
}
