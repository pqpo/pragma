import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createRuntimeSessionRecord,
  updateRuntimeSessionRecord,
  createStaticRuntimeResolver,
  createNoopLoggerProvider,
  PragmaPaths,
  type RuntimeAdapter,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  createMissionDeletionService,
  createSqliteExecutionStore,
  readDeletedExecutionUsageSource,
} from "@pragma/local-host";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaExpertResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { createPragmaLogger } from "@pragma/core";
import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createMissionStore } from "@pragma/local-host";
import { createDesktopMissionTestApplication } from "./fixtures/desktop-mission-test-application.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
const roots: string[] = [];
const stores: ReturnType<typeof createSqliteExecutionStore>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(
    roots
      .splice(0)
      .map(
        async (root) =>
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});
async function fixture(
  closeSession: () => Promise<void> = async () => {},
  providedRuntime?: RuntimeAdapter,
) {
  const root = await mkdtemp(join(tmpdir(), "pragma-delete-integration-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: join(root, "state") });
  const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
  const profile = runtimeFixture(providedRuntime?.descriptor.id);
  if (providedRuntime !== undefined)
    profile.spec.config = {
      runtimeId: providedRuntime.descriptor.id,
      providerId: "openai",
      model: process.env.PRAGMA_MISSION_DELETE_MODEL,
    };
  const snapshot = await project.publish({
    expectedRevision: 0,
    resources: [profile, expertFixture()],
  });
  const usage = vi.fn(async () => await new Promise<void>(() => {}));
  const deletion = createMissionDeletionService({
    paths,
    logger: createPragmaLogger(createNoopLoggerProvider(), { component: "test" }),
    ports: {
      usage,
      memory: async () => {},
      drafts: async () => {},
      claims: async () => {},
      settlement: async () => {},
    },
    stepTimeoutMs: 10,
  });
  const missions = createMissionStore({
    missionsPath: join(root, "missions"),
    isDeletionFenced: async (id) => (await deletion.read(id)) !== undefined,
  });
  const mission = await missions.create({
    workspace: { path: root, basename: "workspace" },
    goal: "Deletion test",
    project: { id: snapshot.projectId, revision: snapshot.revision },
    executor: missionExecutorSnapshot(expertFixture()),
  });
  const runtime =
    providedRuntime ??
    defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "native" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "done", runtimeSessionId: "native" }),
      mapEvent: () => ({ events: [] }),
      closeSession,
    });
  const executions = createSqliteExecutionStore({ pragmaHome: paths.root });
  stores.push(executions);
  const runner = createDesktopMissionTestApplication({
    missions,
    project,
    executionStore: executions,
    pragmaHome: paths.root,
    deletionService: deletion,
    capabilityStore: {} as CapabilityStore,
    capabilityCredentials: {} as CapabilityCredentialStore,
    capabilitiesPath: join(root, "capabilities"),
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
    loggerProvider: createNoopLoggerProvider(),
    assertExecutorReady: async () => undefined,
  });
  return { root, paths, missions, mission, runner, executions, deletion, usage };
}
describe("Mission deletion integration", () => {
  it("retains owners with an additional unconfirmed Runtime and retries after confirmation", async () => {
    const target = await fixture();
    await target.runner.startRun(target.mission.id);
    await vi.waitFor(
      async () =>
        expect((await target.missions.get(target.mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 10_000 },
    );
    const mission = await target.missions.get(target.mission.id);
    const foreign = await createRuntimeSessionRecord({
      paths: target.paths,
      owner: { type: "expert-session", ownerId: mission.execution!.sessionId! },
      systemSessionId: "foreign-native",
      agentId: "expert",
      runtime: { id: "fake", kind: "fake", displayName: "Fake" },
      workspace: target.root,
    });
    await expect(target.runner.delete(target.mission.id)).rejects.toMatchObject({
      code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
    });
    await access(target.missions.storagePath!(target.mission.id));
    await updateRuntimeSessionRecord(target.paths, foreign, { processState: "stopped" });
    await target.runner.delete(target.mission.id);
    await expect(access(target.missions.storagePath!(target.mission.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retains the owner graph when Native close rejects and retries the original stop", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw new Error("Native close rejected.");
      })
      .mockImplementation(async () => undefined);
    const target = await fixture(close);
    await target.runner.startRun(target.mission.id);
    await vi.waitFor(
      async () =>
        expect((await target.missions.get(target.mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 10_000 },
    );
    await expect(target.runner.delete(target.mission.id)).rejects.toMatchObject({
      code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
    });
    await access(target.missions.storagePath!(target.mission.id));
    expect((await target.deletion.read(target.mission.id))?.phase).toBe("prepared");
    expect(close).toHaveBeenCalledOnce();
    await target.runner.delete(target.mission.id);
    expect(close).toHaveBeenCalledTimes(2);
    await expect(access(target.missions.storagePath!(target.mission.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("commits with hung cleanup, shares duplicate deletes, and rejects late Mission writes", async () => {
    const target = await fixture();
    await Promise.all([
      target.runner.delete(target.mission.id),
      target.runner.delete(target.mission.id),
    ]);
    await target.runner.delete(target.mission.id);
    await expect(access(target.missions.storagePath!(target.mission.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(target.usage).not.toHaveBeenCalled();
    expect((await target.deletion.read(target.mission.id))?.phase).toBe("committed");
    await expect(target.missions.updateContextMounts(target.mission.id, [])).rejects.toThrow(
      "MISSION_DELETION_PENDING",
    );
    await expect(
      target.missions.create({
        id: target.mission.id,
        goal: "Late create",
        workspace: target.mission.workspace,
        project: target.mission.project,
        executor: target.mission.executor,
      }),
    ).rejects.toThrow("MISSION_DELETION_PENDING");
    await target.deletion.runOnce();
    expect(target.usage).toHaveBeenCalledOnce();
    expect((await target.deletion.read(target.mission.id))?.steps.memory.done).toBe(true);
  });
  it("retains files on unconfirmed native stop and allows retry after the same stop finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closes = 0;
    const close = async () => {
      closes += 1;
      await gate;
    };
    const target = await fixture(close);
    await target.runner.startRun(target.mission.id);
    await vi.waitFor(
      async () =>
        expect((await target.missions.get(target.mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 10_000 },
    );
    const executionId = (await target.missions.get(target.mission.id)).execution!.id;
    const nativeTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback, delay, ...args) =>
        nativeTimeout(callback, delay === 15_000 ? 30 : delay, ...args)) as typeof setTimeout);
    await expect(target.runner.delete(target.mission.id)).rejects.toMatchObject({
      code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
    });
    await access(target.missions.storagePath!(target.mission.id));
    expect((await target.deletion.read(target.mission.id))?.phase).toBe("prepared");
    release();
    timeoutSpy.mockRestore();
    await target.runner.delete(target.mission.id);
    expect(closes).toBe(1);
    const record = (await target.deletion.read(target.mission.id))!;
    const source = await readDeletedExecutionUsageSource(
      target.paths,
      record.deletionId,
      executionId,
    );
    expect(source?.invocations.length).toBeGreaterThan(0);
    expect(source?.events.some((event) => event.type === "runtime.usage.observed")).toBe(true);
    await expect(access(target.missions.storagePath!(target.mission.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
  it.runIf(process.env.PRAGMA_MISSION_DELETE_NATIVE === "1")(
    "retains and retries deletion with a real suspended Codex process",
    async () => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let ready = false;
      const runtime = createCodexRuntime({
        spawn: (command, args, options) => {
          child = spawn(command, [...args], { ...options, stdio: "pipe" });
          let buffer = "";
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop()!;
            for (const line of lines) {
              try {
                if (JSON.parse(line).result?.thread?.id) ready = true;
              } catch {
                /* Only RPC replies matter. */
              }
            }
          });
          return child;
        },
      });
      const target = await fixture(undefined, runtime);
      const running = target.runner.startRun(target.mission.id);
      void running.catch(() => undefined);
      let suspended = false;
      try {
        await vi.waitFor(() => expect(ready).toBe(true), { timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        process.kill(child!.pid!, "SIGSTOP");
        suspended = true;
        const started = performance.now();
        await expect(target.runner.delete(target.mission.id)).rejects.toMatchObject({
          code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
        });
        await access(target.missions.storagePath!(target.mission.id));
        process.stdout.write(
          `MISSION_DELETE_NATIVE_TIMEOUT ${Math.round(performance.now() - started)}ms\n`,
        );
        process.kill(child!.pid!, "SIGCONT");
        suspended = false;
        const retry = performance.now();
        await target.runner.delete(target.mission.id);
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
        await expect(access(target.missions.storagePath!(target.mission.id))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
        process.stdout.write(
          `MISSION_DELETE_NATIVE_RETRY ${Math.round(performance.now() - retry)}ms\n`,
        );
      } finally {
        if (suspended) process.kill(child!.pid!, "SIGCONT");
        await target.runner.delete(target.mission.id).catch(() => undefined);
      }
    },
    60_000,
  );
  it.runIf(process.env.PRAGMA_MISSION_DELETE_BENCHMARK === "1")(
    "measures completed Mission deletion at 0, 10 and 100 Executions",
    async () => {
      const report: { executions: number; p95Ms: number; samples: number[] }[] = [];
      for (const count of [0, 10, 100]) {
        const samples: number[] = [];
        for (let sample = 0; sample < 5; sample++) {
          const target = await fixture();
          for (let index = 0; index < count; index++) {
            const id = randomUUID();
            const now = new Date().toISOString();
            const definition = { id: "flow", kind: "flow" as const };
            await target.executions.create(
              {
                schemaVersion: "pragma.execution/v12",
                executionId: id,
                version: 0,
                kind: "flow",
                definition,
                rootInvocationId: "root",
                status: "succeeded",
                input: null,
                state: {},
                lastAppliedSequence: 0,
                createdAt: now,
                updatedAt: now,
              },
              {
                invocationId: "root",
                rootInvocationId: "root",
                contextId: "context",
                definition,
                status: "succeeded",
                pendingExpertMessages: [],
                input: null,
                createdAt: now,
                updatedAt: now,
              },
            );
            const messageId = index === 0 ? target.mission.initialMessageId : randomUUID();
            if (index > 0)
              await target.missions.appendUserMessage(target.mission.id, {
                id: messageId,
                content: "historical turn",
                createdAt: now,
              });
            await target.missions.appendExecutionReference({
              missionId: target.mission.id,
              inputMessageId: messageId,
              executionId: id,
              createdAt: now,
            });
          }
          const started = performance.now();
          await target.runner.delete(target.mission.id);
          samples.push(Math.round(performance.now() - started));
        }
        const sorted = samples.toSorted((a, b) => a - b);
        report.push({ executions: count, p95Ms: sorted.at(-1)!, samples });
      }
      await writeFile(
        join(tmpdir(), "pragma-mission-deletion-benchmark.json"),
        JSON.stringify(report, null, 2),
      );
      process.stdout.write(`MISSION_DELETE_BENCHMARK ${JSON.stringify(report)}\n`);
      expect(report.every((row) => row.p95Ms < 1_000)).toBe(true);
    },
    600_000,
  );
});
function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      avatarId: "pragma.avatar.expert.default",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function runtimeFixture(runtimeId = "fake", providerId = "test"): PragmaRuntimeProfileResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile",
    metadata: {
      id: "rdzgnq05qfqcpqcm",
      name: "Writer Runtime",
      description: "Runtime used by the test writer.",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId, providerId, model: "test-model" },
    },
  };
}
