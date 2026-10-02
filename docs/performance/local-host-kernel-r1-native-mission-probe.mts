import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

// Run from the candidate checkout with its Node 24 + tsx runtime.
// This tests the default Local Host / CLI run composition. It does
// not replace Desktop Runner ownership, observers, UI, or crash-replay smoke.
// No mock Runtime, stores, Mission lease, command consumer, or release hook.
const repo = process.cwd();
const core = await import(pathToFileURL(join(repo, "packages/core/dist/index.js")).href);
const host = await import(pathToFileURL(join(repo, "packages/local-host/dist/index.js")).href);
const { createCodexRuntime } = await import(
  pathToFileURL(join(repo, "packages/runtime/codex/dist/index.js")).href
);
const temporary = await mkdtemp(join(tmpdir(), "pragma-pr353-mission-native-"));
const home = join(temporary, "pragma");
const workspace = join(temporary, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(home, { recursive: true });
const output = resolve(process.argv[2] ?? "/tmp/pragma-pr353-native-mission-smoke.json");
const report: any = {
  schemaVersion: "pragma.pr353-native-mission-smoke/v1",
  startedAt: new Date().toISOString(),
  scope:
    "Actual Local Host run application + Mission command Inbox + SQLite + FileExpertSessionStore + Native Codex. Default CLI run lifetime; no release override. Reopen is graceful resource release plus new composition, not a crash-replay claim. Desktop UI/observer and performance acceptance are not covered.",
  node: process.version,
  assertions: [],
  errors: [],
  operations: [],
  nativeEvents: [],
  completeSmokePassed: false,
  processExitConfirmed: false,
};
const token = randomUUID().replaceAll("-", "").slice(0, 12);
const memoryMarker = `HOST_MEMORY_${token}`;
const initialMarker = `INITIAL_${token}`;
const queueMarker = `QUEUED_${token}`;
const steerMarker = `STEERED_${token}`;
const reopenMarker = `REOPENED_${token}`;
const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex");
let missionId: string | undefined;
let current: any;
let phase = "setup";
const compositions: any[] = [];
const events: any[] = [];
const loggerProvider = core.createConsoleLoggerProvider({ minimumLevel: "error" });
function errorRecord(error: any): any {
  // Record only error diagnostics, never auth files, environment values,
  // credentials or Runtime debug payloads. Recursively preserve causes.
  let message = String(error?.message ?? error);
  message = message.replaceAll(temporary, "[isolated-root]").replaceAll(repo, "[checkout]");
  message = message
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{24,}\b/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  return {
    name: error?.name ?? "Error",
    code: error?.code,
    message: message.slice(0, 1500),
    ...(error?.cause ? { cause: errorRecord(error.cause) } : {}),
    ...(Array.isArray(error?.errors) ? { errors: error.errors.map(errorRecord) } : {}),
  };
}
function check(id: string, passed: boolean, details?: any) {
  report.assertions.push({
    id,
    status: passed ? "passed" : "failed",
    ...(details ? { details } : {}),
  });
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 150_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function until(label: string, fn: () => Promise<any>, ms = 90_000): Promise<any> {
  const deadline = Date.now() + ms;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label} was not observed within ${ms} ms`);
}
async function compose(): Promise<any> {
  const runtime = createCodexRuntime({
    ...(process.env.PRAGMA_RUNTIME_PROBE_MODEL
      ? { defaultModelName: process.env.PRAGMA_RUNTIME_PROBE_MODEL }
      : {}),
    ...(process.env.PRAGMA_RUNTIME_PROBE_THINKING
      ? { defaultThinkingLevel: process.env.PRAGMA_RUNTIME_PROBE_THINKING }
      : {}),
  });
  const runtimes = core.createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: runtime.descriptor.id,
  });
  const executions = host.createSqliteExecutionStore({ pragmaHome: home });
  const sessions = core.createFileExpertSessionStore({ executions, pragmaHome: home });
  const lifecycle = host.createLocalHostMissionController({
    missionsPath: join(home, "data/missions"),
    onPollingError: ({ error }: any) =>
      report.errors.push({ phase: "mission-polling", ...errorRecord(error) }),
  });
  const expert = await core.defineExpert({
    id: "pr0bexpt00000001",
    name: "Native Mission Control Smoke",
    description: "Isolated acceptance probe",
    instructions:
      "Obey the exact marker requests. Use shell when requested. Preserve the marker in memory.",
    scope: "test",
    tags: [],
    workspace,
    pragmaHome: home,
    defaultRuntimeId: runtime.descriptor.id,
    loggerProvider,
    hooks: { onStreamEvent: ({ event }: any) => events.push(event) },
  });
  const executors = [
    {
      definition: expert,
      descriptor: {
        schemaVersion: "pragma.integration-executor/v1",
        ref: { kind: "expert", id: expert.id },
        name: "Native Mission Control Smoke",
        description: "Isolated acceptance probe",
        source: "built_in",
        availability: { status: "ready", blockingCodes: [] },
        workspace: { required: true, allowNonGitDirectory: true },
        capabilities: { interactive: true, resumable: true, steerable: true, supportsQueue: true },
      },
    },
  ];
  const executorPort = host.createCoreRunExecutorPort({
    pragmaHome: home,
    runtimes,
    executions,
    sessions,
    loggerProvider,
    executors,
    createHostContextBindings: async ({ missionId }: any) =>
      host.createLocalHostMissionBoardBindings({ pragmaHome: home, missionId }),
  });
  const mission = host.createControllerRunMissionPort(lifecycle.controller, {
    ownerScope: lifecycle.ownerScope,
  });
  const adapter = host.createLocalHostCoreMissionControlAdapter({
    pragmaHome: home,
    runtimes,
    executions,
    sessions,
    loggerProvider,
    executors,
    mission,
    ownerAccess: executorPort.ownerAccess,
    resolveActiveOwner: executorPort.resolveActiveOwner,
    resolveMissionBinding: async (id: string) =>
      host.findMissionPinnedBinding(
        (await lifecycle.controller.readSnapshot({ missionId: id })).events,
      ),
    createHostContextBindings: async ({ missionId }: any) =>
      host.createLocalHostMissionBoardBindings({ pragmaHome: home, missionId }),
    hasPendingMissionCommands: async (id: string) =>
      (await lifecycle.controller.listOperations({ missionId: id })).some((op: any) =>
        ["queued", "applying"].includes(op.state),
      ),
    releaseMissionOwner: async (id: string) => lifecycle.ownerScope.release(id),
  });
  const control = host.createMissionControlApplication({
    controller: lifecycle.controller,
    ownerScope: lifecycle.ownerScope,
    consumer: adapter.consumer,
    onOwnerStartError: ({ error }: any) =>
      report.errors.push({ phase: "owner-start", ...errorRecord(error) }),
    assertAcquisitionAllowed: adapter.assertAcquisitionAllowed,
    resolveStrictTarget: adapter.resolveStrictTarget,
    resolveExecutionTarget: adapter.resolveExecutionTarget,
    waitExecution: adapter.waitExecution,
    client: { surface: "cli", version: "pr353-native-smoke", instanceId: randomUUID() },
  });
  adapter.bindApplication(control);
  const run = host.createLocalHostRunApplication({
    executors: executorPort,
    mission,
    commandConsumer: adapter.consumer,
  });
  const value = {
    runtime,
    runtimes,
    executions,
    sessions,
    lifecycle,
    executorPort,
    adapter,
    control,
    run,
    expert,
    closed: false,
  };
  compositions.push(value);
  return value;
}
async function command(kind: string, payload: any, expectedExecutionId?: string): Promise<any> {
  const requestId = randomUUID();
  const submission = await current.control.submit({
    missionId,
    requestId,
    kind,
    payload,
    ...(expectedExecutionId ? { expectedExecutionId } : {}),
  });
  let terminal: any;
  try {
    terminal = await current.control.waitForTerminal({
      missionId,
      requestId,
      timeoutMs: 45_000,
      pollIntervalMs: 100,
    });
  } catch (error) {
    const snapshot = await current.lifecycle.controller.readSnapshot({ missionId });
    const operations = await current.lifecycle.controller.listOperations({ missionId });
    report.failedCommandBoundary = {
      requestId,
      kind,
      owner: submission.owner,
      lease: snapshot.snapshot.lease,
      ownerGuard: current.lifecycle.ownerScope.currentGuard(missionId),
      ownerPresent: Boolean(current.executorPort.ownerAccess.controlOwner(missionId)),
      operations: operations.map((op: any) => ({
        requestId: op.requestId,
        state: op.state,
        error: op.error,
      })),
      identity: await rootIdentity(),
    };
    throw error;
  }
  report.operations.push({
    requestId,
    kind,
    state: terminal.state,
    result: terminal.result,
    owner: submission.owner,
  });
  check(`${kind}.${requestId}.applied`, terminal.state === "applied", { state: terminal.state });
  if (terminal.state !== "applied")
    throw new Error(`Mission command ${kind} ended as ${terminal.state}`);
  return terminal;
}
async function rootIdentity(): Promise<any> {
  const session = await current.sessions.get(missionId);
  const context = session?.contexts?.[session.rootContextId];
  return {
    sessionId: session?.sessionId,
    contextId: session?.rootContextId,
    systemSessionId: context?.snapshot?.systemSessionId,
    runtimeSession: context?.snapshot?.runtimeSession,
  };
}
async function shutdown(value: any, preserve: boolean) {
  if (value.closed) return;
  const errors: any[] = [];
  if (missionId) {
    const owner = value.executorPort.ownerAccess.controlOwner(missionId);
    if (owner?.kind === "session") {
      try {
        if (preserve)
          await bounded(owner.session.releaseAfterTerminal(), "graceful Host release", 30_000);
        else
          await bounded(
            owner.session.close("Native Mission smoke cleanup"),
            "Session cleanup",
            30_000,
          );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await value.lifecycle.ownerScope.release(missionId);
      await value.lifecycle.ownerScope.stop(missionId);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await bounded(value.executions.close(), "SQLite close", 30_000);
  } catch (error) {
    errors.push(error);
  }
  value.closed = true;
  if (errors.length) throw new AggregateError(errors, "Host resource shutdown failed");
}
try {
  current = await compose();
  const availability = await current.runtime.canUse();
  check("native.available", availability.usable);
  if (!availability.usable) throw new Error("Native Codex is unavailable");
  phase = "initial-run";
  const requestId = randomUUID();
  const initial = await current.run.start({
    requestId,
    command: "expert.run",
    executor: { kind: "expert", id: current.expert.id },
    workspace: {
      schemaVersion: "pragma.integration-workspace/v1",
      requestedPath: workspace,
      canonicalPath: workspace,
      displayName: "isolated-native-smoke",
      identityHash: `sha256:${fingerprint(workspace)}`,
      access: { exists: true, readable: true, writable: true },
      source: "explicit",
    },
    prompt: `Remember the exact marker ${memoryMarker}. Use your shell to sleep 30 seconds before replying with ${initialMarker} and the remembered marker.`,
    detach: false,
  });
  missionId = initial.missionId;
  // Capture a real production-finalization rejection immediately; do not hide
  // a first-terminal / queued-successor release race behind a no-op release.
  const initialOutcome = initial.outcome.then(
    (outcome: any) => ({ outcome }),
    (error: any) => ({ error }),
  );
  await until("actual Native turn start", async () =>
    events.some(
      (event: any) =>
        event.type === "thought.delta" ||
        event.type === "tool.started" ||
        (event.type === "progress" && event.payload?.stage === "turn/started"),
    ),
  );
  const before = await rootIdentity();
  check(
    "native.initial.owner-binding-persisted",
    Boolean(before.sessionId && before.contextId && before.systemSessionId),
  );
  report.initialIdentity = before;
  phase = "mission-enqueue";
  const queued = await command("send", {
    kind: "send",
    input: {
      prompt: `Recall the exact HOST_MEMORY marker from the first turn and reply with it plus ${queueMarker}.`,
      attachments: [],
    },
  });
  const queueExecutionId = queued.result?.executionId;
  if (!queueExecutionId)
    throw new Error("Applied queue command did not return an Execution identity");
  const owner = current.executorPort.ownerAccess.controlOwner(missionId);
  const promptQueue = await owner.session.getPromptQueue();
  const queuedItem = promptQueue.find((prompt: any) => prompt.executionId === queueExecutionId);
  check("mission.queue.durable-queued-before-initial-terminal", queuedItem?.status === "queued");
  const originalExecutionId = initial.executionId;
  if (!originalExecutionId) throw new Error("Initial run has no Execution identity");
  phase = "mission-strict-steer";
  const steered = await command(
    "steer",
    {
      kind: "steer",
      input: {
        prompt: `Change the current first-turn answer: reply with exactly ${steerMarker}.`,
        attachments: [],
      },
    },
    originalExecutionId,
  );
  check("mission.steer.same-execution", steered.result?.executionId === originalExecutionId);
  const terminal = await bounded(initialOutcome, "initial run outcome");
  if (terminal.error) {
    report.errors.push({ phase: "initial-run-finalization", ...errorRecord(terminal.error) });
    check("initial-run.production-finalization", false);
  } else {
    check("initial-run.production-finalization", terminal.outcome.status === "succeeded");
  }
  const original = await bounded(
    current.adapter.waitExecution({ missionId, executionId: originalExecutionId }),
    "original Execution",
  );
  check(
    "mission.steer.actual-consumption",
    original.status === "succeeded" && String(original.result).includes(steerMarker),
  );
  const queueResult = await bounded(
    current.adapter.waitExecution({ missionId, executionId: queueExecutionId }),
    "queued Execution",
  );
  check(
    "mission.queue.actual-consumption",
    queueResult.status === "succeeded" &&
      String(queueResult.result).includes(queueMarker) &&
      String(queueResult.result).includes(memoryMarker),
  );
  await until("idle durable Session", async () => {
    const state = await current.sessions.get(missionId);
    const prompts = await owner.session.getPromptQueue();
    return (
      !state.activeExecutionId &&
      !prompts.some((p: any) => ["queued", "running"].includes(p.status))
    );
  });
  const preReopen = await rootIdentity();
  report.preReopenIdentity = preReopen;
  check(
    "native.terminal.identity-persisted",
    Boolean(preReopen.runtimeSession?.id && preReopen.systemSessionId),
  );
  check(
    "native.queue.reuses-owner-binding",
    before.sessionId === preReopen.sessionId &&
      before.contextId === preReopen.contextId &&
      before.systemSessionId === preReopen.systemSessionId,
  );
  phase = "graceful-host-reopen";
  await shutdown(current, true);
  current = await compose();
  check(
    "host.reopen.starts-without-process-local-owner",
    !current.executorPort.ownerAccess.controlOwner(missionId),
  );
  const recovered = await command("send", {
    kind: "send",
    input: {
      prompt: `Recall the exact HOST_MEMORY marker from our earlier conversation. Reply with it and ${reopenMarker}.`,
      attachments: [],
    },
  });
  const recoveredExecutionId = recovered.result?.executionId;
  if (!recoveredExecutionId)
    throw new Error("Reopened Mission send returned no Execution identity");
  const recoveredResult = await bounded(
    current.adapter.waitExecution({ missionId, executionId: recoveredExecutionId }),
    "reopened Mission Execution",
  );
  check(
    "host.reopen.actual-native-context-recall",
    recoveredResult.status === "succeeded" &&
      String(recoveredResult.result).includes(memoryMarker) &&
      String(recoveredResult.result).includes(reopenMarker),
  );
  const afterReopen = await rootIdentity();
  report.reopenedIdentity = afterReopen;
  check(
    "host.reopen.exact-owned-native-identity",
    preReopen.sessionId === afterReopen.sessionId &&
      preReopen.contextId === afterReopen.contextId &&
      preReopen.systemSessionId === afterReopen.systemSessionId &&
      preReopen.runtimeSession?.id === afterReopen.runtimeSession?.id &&
      preReopen.runtimeSession?.type === afterReopen.runtimeSession?.type,
  );
  // Execution terminal precedes recovered-owner projection and resource release.
  // Observe the real automatic release before closing its authoritative store.
  await until("recovered owner automatic release", async () => {
    if (
      current.executorPort.ownerAccess.controlOwner(missionId) ||
      current.lifecycle.ownerScope.currentGuard(missionId)
    )
      return false;
    const ended = await current.lifecycle.controller.readSnapshot({ missionId });
    return ended.snapshot.lease === undefined;
  });
  check(
    "host.reopen.owner-auto-released",
    !current.executorPort.ownerAccess.controlOwner(missionId) &&
      !current.lifecycle.ownerScope.currentGuard(missionId),
  );
  const snapshot = await current.lifecycle.controller.readSnapshot({ missionId });
  check(
    "host.reopen.terminal-projected-before-release",
    snapshot.events.some(
      (event: any) =>
        event.type === "run.succeeded" && event.data?.executionId === recoveredExecutionId,
    ),
  );
  report.missionEventTypes = snapshot.events.map((event: any) => event.type);
  check("mission.binding.pinned-durable", Boolean(host.findMissionPinnedBinding(snapshot.events)));
} catch (error) {
  report.errors.push({ phase, ...errorRecord(error) });
  check(`${phase}.completed`, false);
} finally {
  // Preserve observations if an unexpected cleanup failure prevents final output.
  // Actual successful exit is still certified only by the external supervisor.
  report.observationsCapturedBeforeCleanup = true;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  for (const value of compositions.toReversed()) {
    try {
      await shutdown(value, false);
    } catch (error) {
      report.errors.push({ phase: "cleanup", ...errorRecord(error) });
      check("cleanup.completed", false);
    }
  }
  report.nativeEvents = events.map((event: any) => ({
    type: event.type,
    stage: event.payload?.stage,
  }));
  report.finishedAt = new Date().toISOString();
  report.completeSmokePassed =
    report.errors.length === 0 && report.assertions.every((a: any) => a.status === "passed");
  // Only the external supervisor can certify actual process exit.
  report.processExitConfirmed = false;
  if (!report.completeSmokePassed)
    report.retainedIsolatedRoot = "[isolated-root retained locally; not a source-user Home]";
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        output,
        completeSmokePassed: report.completeSmokePassed,
        assertions: report.assertions,
        errors: report.errors,
      },
      null,
      2,
    ),
  );
  // Keep failed recovery evidence available for diagnosis; successful runs may
  // remove their isolated auth/config/session copies after all shutdowns.
  if (report.completeSmokePassed) await rm(temporary, { recursive: true, force: true });
  process.exitCode = report.completeSmokePassed ? 0 : 1;
}
