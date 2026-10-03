import {
  createLocalHostContextStoreReader,
  SNAPSHOT_STORAGE_MARKER,
} from "../src/resources/context-store-reader.ts";
import { ContextStoreSchema } from "@pragma/shared";
import type { Expert } from "@pragma/core";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExpertSessionStore,
  createRuntimeSessionRecord,
  readRuntimeSessionsForOwners,
  updateRuntimeSessionRecord,
  createStaticRuntimeResolver,
  PragmaPaths,
  EXECUTION_RECOVERY_CLAIM_STATE_KEY,
} from "@pragma/core";
import { createLocalHostCoreMissionControlAdapter } from "../src/core-control-adapter.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { createMissionPinnedBinding } from "../src/missions/controller/pinned-binding.ts";
import { MissionCommandSchema } from "@pragma/shared/integration";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import {
  RuntimeContextRecordSchema,
  CapabilityDefinitionSchema,
  CapabilityManifestSchema,
  isTerminalExecutionStatus,
} from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostNodeApplication } from "../src/node-application.ts";
import * as nodeCompiler from "../src/node-mission-compiler.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { createLocalHostProjectCatalogFromHome } from "../src/project-catalog.ts";
import { createLocalHostResourceResolvers } from "../src/resources/resolvers.ts";
import { createMissionControllerStore } from "../src/missions/controller/mission-controller-store.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";
import { createMissionSessionAssociationResolver } from "../src/missions/session-association.ts";
import {
  createPublishedProjectResources,
  PUBLISHED_FLOW_ID,
  PUBLISHED_TEAM_ID,
  writePublishedProjectFixture,
} from "./fixtures/published-project.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function fixture(
  fail = false,
  checkpoint = false,
  running = false,
  probe?: (agent: Expert) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-node-compiled-execution-"));
  roots.push(home);
  const pending = new Map<string, (error: Error) => void>();
  const restore = vi.fn(({ systemSessionId }: { systemSessionId: string }) => ({
    id: `native-${systemSessionId}`,
  }));
  const stop = vi.fn((session: { id: string }) =>
    pending.get(session.id)?.(new Error("Native stopped")),
  );
  const startTurn = vi.fn(async (session: { readonly id: string }) => {
    if (fail) throw new Error("fixture execution failure");
    if (running && pending.size === 0)
      await new Promise<never>((_resolve, reject) => pending.set(session.id, reject));
    return { outputText: "done", runtimeSessionId: session.id };
  });
  const driver = defineRuntimeTestDriver<never, { readonly id: string }>({
    descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
    createSession: async ({ systemSessionId, agent }) => {
      await probe?.(agent);
      return { id: `native-${systemSessionId}` };
    },
    restoreSession: restore,
    cancelTurn: stop,
    closeSession: stop,
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn,
    mapEvent: () => ({ events: [] }),
  });
  const canUse = vi.spyOn(driver, "canUse").mockReturnValue({ usable: true });
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [driver],
  });
  const resources = [...createPublishedProjectResources()];
  const expert = resources.find((resource) => resource.kind === "Expert")!;
  if (expert.kind !== "Expert") throw new Error("Missing fixture Expert.");
  const capabilityId = "00000000-0000-4000-8000-000000000051";
  const resourceId = "pcr7npvx0gv8fpka";
  expert.spec.capabilities = [{ ref: `capability:${resourceId}`, kind: "tools" }];
  resources.push(
    PragmaCapabilityResourceSchema.parse({
      apiVersion: expert.apiVersion,
      kind: "Capability",
      metadata: { id: resourceId, name: "Fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: `binding:desktop-capability.${Buffer.from(capabilityId).toString("base64url")}`,
        config: { key: "fixture" },
      },
    }),
  );
  if (checkpoint) {
    const flow = resources.find((resource) => resource.kind === "Flow")!;
    if (flow.kind !== "Flow") throw new Error("Missing fixture Flow.");
    flow.spec.graph.steps["approve"] = {
      human: {
        selectionMode: "single",
        prompt: { segments: [{ text: "Continue?" }] },
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    };
    flow.spec.graph.transitions["run"] = "approve";
    flow.spec.graph.transitions["approve"] = { end: true };
  }
  await writePublishedProjectFixture(home, resources);
  const paths = new PragmaPaths({ pragmaHome: home });
  const capabilityRoot = join(paths.dataRoot(), "capabilities", capabilityId);
  const definition = CapabilityDefinitionSchema.parse({
    kind: "code_service",
    name: "Fixture",
    description: "Fixture",
    language: "javascript",
    timeoutMs: 1000,
    tool: {
      name: "fixture_tool",
      description: "Fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      source: "function main() { return {}; }",
    },
  });
  await mkdir(join(capabilityRoot, "revisions", "000003"), { recursive: true });
  const date = new Date().toISOString();
  await writeFile(
    join(capabilityRoot, "capability.json"),
    JSON.stringify(
      CapabilityManifestSchema.parse({
        schemaVersion: "pragma.capability/v4",
        id: capabilityId,
        runtimeKey: "fixture_tool_capability",
        name: "Fixture",
        kind: "code_service",
        latestRevision: 3,
        activeRevision: 3,
        createdAt: date,
        updatedAt: date,
      }),
    ),
  );
  await writeFile(
    join(capabilityRoot, "revisions", "000003", "definition.json"),
    JSON.stringify(definition),
  );
  await writeFile(
    join(capabilityRoot, "health.json"),
    JSON.stringify({ revision: 3, status: "ready", checkedAt: date }),
  );
  const app = createLocalHostNodeApplication({
    pragmaHome: home,
    runtimes,
    client: { surface: "cli", version: "test", instanceId: randomUUID() },
    workspace: {
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
      realpath: async (path) => path,
    },
  });
  const workspace = await app.resolveWorkspace(home);
  return {
    home,
    runtimes,
    app,
    workspace,
    canUse,
    capabilityId,
    expertId: expert.metadata.id,
    pending,
    restore,
    stop,
    capabilityDefinition: definition,
    startTurn,
  };
}

describe("default Node compilation reaches persisted Execution", { timeout: 15_000 }, () => {
  it.each(["expert", "team"] as const)(
    "rejects a live %s process lease and resumes the same Session after SIGKILL without redelivering its Native turn",
    async (kind) => {
      const f = await fixture();
      const started = await f.app.run!.start({
        requestId: randomUUID(),
        command: `${kind}.run`,
        executor: { kind, id: kind === "expert" ? f.expertId : PUBLISHED_TEAM_ID },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: "initial",
        detach: false,
      });
      expect((await started.outcome).status).toBe("succeeded");
      const paths = new PragmaPaths({ pragmaHome: f.home });
      const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
      const launcher = readFileSync(join(repositoryRoot, "node_modules", ".bin", "tsx"), "utf8");
      const loaderPackage = launcher.match(
        /node_modules\/\.pnpm\/([^/]+)\/node_modules\/tsx/u,
      )?.[1];
      if (loaderPackage === undefined) throw new Error("Could not locate tsx loader.");
      const loader = join(
        repositoryRoot,
        "node_modules",
        ".pnpm",
        loaderPackage,
        "node_modules",
        "tsx",
        "dist",
        "loader.mjs",
      );
      const requestId = randomUUID();
      const child = spawn(
        process.execPath,
        [
          "--import",
          loader,
          join(import.meta.dirname, "fixtures", "node-execution-crash-process.ts"),
          f.home,
          started.missionId,
          requestId,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let diagnostics = "";
      child.stderr!.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      const sessions = createFileExpertSessionStore({ pragmaHome: f.home, executions });
      const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
      let desktop: ReturnType<typeof createLocalHostNodeApplication> | undefined;
      try {
        await vi.waitFor(
          async () => {
            if (child.exitCode !== null) throw new Error(`Crash fixture exited: ${diagnostics}`);
            let ready: unknown;
            try {
              ready = JSON.parse(await readFile(join(f.home, "crash-ready.json"), "utf8"));
            } catch (error) {
              throw new Error(`Crash fixture has not reached Native dispatch: ${diagnostics}`, {
                cause: error,
              });
            }
            expect(ready).toMatchObject({ requestId });
          },
          { timeout: 10_000 },
        );
        const activeMission = await missions.get(started.missionId);
        const sessionId = activeMission.execution!.sessionId!;
        const before = (await sessions.get(sessionId))!;
        const root = before.contexts[before.rootContextId]!;
        desktop = createLocalHostNodeApplication({
          pragmaHome: f.home,
          runtimes: f.runtimes,
          client: { surface: "desktop", version: "test", instanceId: randomUUID() },
          workspace: {
            stat: async () => ({ isDirectory: () => true }),
            access: async () => undefined,
            realpath: async (path) => path,
          },
        });
        await expect(
          desktop.resumeMission!({ missionId: started.missionId, requestId: randomUUID() }),
        ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
        const lease = JSON.parse(await readFile(paths.expertSessionLease(sessionId), "utf8")) as {
          expiresAt: string;
        };
        // Wait for the actual persisted Session lease; no active database, WAL,
        // Session tree or lock state is copied or patched by this test.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(lease.expiresAt) + 100 - Date.now())),
        );
        await desktop.resumeMission!({ missionId: started.missionId, requestId: randomUUID() });
        const after = (await sessions.get(sessionId))!;
        expect(after.rootContextId).toBe(before.rootContextId);
        expect(after.contexts[after.rootContextId]?.snapshot).toEqual(root.snapshot);
        expect((await missions.get(started.missionId)).execution?.sessionId).toBe(sessionId);
        expect(f.startTurn).toHaveBeenCalledTimes(1);
        expect(
          (await readFile(join(f.home, "native-dispatches.jsonl"), "utf8")).trim().split("\n"),
        ).toHaveLength(1);
        const turn = (await sessions.listPrompts(sessionId)).find(
          (prompt) => prompt.requestId === requestId,
        )!;
        expect((await executions.get(turn.executionId))?.status).toBe("interrupted");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exited;
        }
        await desktop?.missionControl!.stopOwner(started.missionId);
        executions.close();
      }
    },
    60_000,
  );

  it("takes over a real Flow Native crash without redispatching the interrupted Invocation", async () => {
    const f = await fixture();
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    const launcher = readFileSync(join(repositoryRoot, "node_modules", ".bin", "tsx"), "utf8");
    const loaderPackage = launcher.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/tsx/u)?.[1];
    if (loaderPackage === undefined) throw new Error("Could not locate tsx loader.");
    const loader = join(
      repositoryRoot,
      "node_modules",
      ".pnpm",
      loaderPackage,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    );
    const requestId = randomUUID();
    const child = spawn(
      process.execPath,
      [
        "--import",
        loader,
        join(import.meta.dirname, "fixtures", "node-execution-crash-process.ts"),
        f.home,
        "flow-fresh",
        requestId,
        f.home,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let diagnostics = "";
    child.stderr!.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    const paths = new PragmaPaths({ pragmaHome: f.home });
    const executions = createSqliteExecutionStore({ pragmaHome: f.home });
    const controller = createMissionControllerStore({ missionsPath: paths.missionsRoot() });
    const desktop = createLocalHostNodeApplication({
      pragmaHome: f.home,
      runtimes: f.runtimes,
      client: { surface: "desktop", version: "test", instanceId: randomUUID() },
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
    });
    let started: { missionId: string; executionId: string } | undefined;
    try {
      await vi.waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`Flow crash fixture exited: ${diagnostics}`);
          try {
            started = JSON.parse(await readFile(join(f.home, "flow-started.json"), "utf8"));
            expect(
              JSON.parse(await readFile(join(f.home, "crash-ready.json"), "utf8")),
            ).toMatchObject({ requestId });
          } catch (error) {
            throw new Error(`Flow Native dispatch not ready: ${diagnostics}`, { cause: error });
          }
        },
        { timeout: 10_000 },
      );
      const target = started!;
      expect(target.executionId).toEqual(expect.any(String));
      const invocation = (await executions.listInvocations(target.executionId)).find(
        (item) => item.invocationId !== target.executionId && item.contextId !== undefined,
      )!;
      expect(invocation).toBeDefined();
      const context = RuntimeContextRecordSchema.parse(
        await executions.getContext(target.executionId, invocation.contextId!),
      );
      expect(context.snapshot).toBeDefined();
      await expect(
        desktop.resumeMission!({ missionId: target.missionId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      const record = (await executions.get(target.executionId))!;
      const claim = record.state[EXECUTION_RECOVERY_CLAIM_STATE_KEY] as { expiresAt: string };
      const lease = (await controller.readSnapshot({ missionId: target.missionId })).snapshot
        .lease!;
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.max(
            0,
            Math.max(
              Date.parse(claim.expiresAt),
              lease === undefined ? 0 : Date.parse(lease.expiresAt),
            ) +
              100 -
              Date.now(),
          ),
        ),
      );
      await expect(
        desktop.resumeMission!({ missionId: target.missionId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
      const restored = RuntimeContextRecordSchema.parse(
        await executions.getContext(target.executionId, invocation.contextId!),
      );
      expect(restored.contextId).toBe(context.contextId);
      expect(restored.snapshot).toEqual(context.snapshot);
      expect(f.startTurn).not.toHaveBeenCalled();
      expect(
        (await readFile(join(f.home, "native-dispatches.jsonl"), "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      expect((await executions.get(target.executionId))?.status).toBe("failed");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
      if (started !== undefined) await desktop.missionControl!.stopOwner(started.missionId);
      executions.close();
    }
  }, 60_000);

  it.each([false, true])(
    "persists a changed-authority successor and reopens its original Context and Native Session (controller-only=%s)",
    async (controllerOnly) => {
      const f = await fixture();
      const started = await f.app.run!.start({
        requestId: randomUUID(),
        command: "expert.run",
        executor: { kind: "expert", id: f.expertId },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: "first",
        detach: false,
      });
      expect((await started.outcome).status).toBe("succeeded");
      const paths = new PragmaPaths({ pragmaHome: f.home });
      const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
      const original = await missions.get(started.missionId);
      if (controllerOnly) await rm(join(missions.storagePath!(started.missionId), "mission.yaml"));
      const capabilityRoot = join(paths.dataRoot(), "capabilities", f.capabilityId);
      await mkdir(join(capabilityRoot, "revisions", "000004"), { recursive: true });
      await writeFile(
        join(capabilityRoot, "revisions", "000004", "definition.json"),
        JSON.stringify({
          ...f.capabilityDefinition,
          description: "Changed authority",
        }),
      );
      const date = new Date().toISOString();
      await writeFile(
        join(capabilityRoot, "capability.json"),
        JSON.stringify(
          CapabilityManifestSchema.parse({
            schemaVersion: "pragma.capability/v4",
            id: f.capabilityId,
            runtimeKey: "fixture_tool_capability",
            name: "Fixture",
            kind: "code_service",
            latestRevision: 4,
            activeRevision: 4,
            createdAt: date,
            updatedAt: date,
          }),
        ),
      );
      await writeFile(
        join(capabilityRoot, "health.json"),
        JSON.stringify({ revision: 4, status: "ready", checkedAt: date }),
      );
      const requestId = randomUUID();
      await f.app.missionControl!.submit({
        missionId: started.missionId,
        requestId,
        kind: "send",
        payload: { kind: "send", input: { prompt: "after authority change" } },
      });
      const accepted = await f.app.missionControl!.waitForTerminal({
        missionId: started.missionId,
        requestId,
        timeoutMs: 5_000,
      });
      expect(accepted, JSON.stringify(accepted.error)).toMatchObject({ state: "applied" });
      const executionId = accepted.result!["executionId"] as string;
      await f.app.missionControl!.waitExecution!({ missionId: started.missionId, executionId });
      await f.app.missionControl!.stopOwner(started.missionId);
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      const sessions = createFileExpertSessionStore({ pragmaHome: f.home, executions });
      const resolveSession = createMissionSessionAssociationResolver({
        controller: createMissionControllerStore({
          missionsPath: paths.missionsRoot(),
          missionPath: missions.storagePath,
        }),
        executions,
        sessions,
        repositorySessionId: async () =>
          controllerOnly ? undefined : (await missions.get(started.missionId)).execution?.sessionId,
      });
      const successorSessionId = await resolveSession(started.missionId);
      expect(successorSessionId).toBeDefined();
      expect(successorSessionId).not.toBe(original.execution?.sessionId);
      const before = (await sessions.get(successorSessionId!))!;
      const beforeRoot = before.contexts[before.rootContextId]!;
      if (controllerOnly) {
        const compacting = createMissionControllerStore({
          missionsPath: paths.missionsRoot(),
          missionPath: missions.storagePath,
          retention: {
            events: { maxCount: 1, maxBytes: 1024 },
            terminalCommands: { maxCount: 1, maxBytes: 2048 },
          },
        });
        const guard = await compacting.claim({
          missionId: started.missionId,
          claimId: randomUUID(),
          leaseMs: 30_000,
        });
        try {
          await compacting.write({
            missionId: started.missionId,
            guard,
            operation: async ({ appendEvent }) => {
              for (let index = 0; index < 4; index++)
                await appendEvent("output.chunk", { chunk: "x".repeat(600) });
            },
          });
          await compacting.compactRetention({ missionId: started.missionId });
          expect(await resolveSession(started.missionId)).toBe(successorSessionId);
          expect(
            (await sessions.get(successorSessionId!))?.contexts[before.rootContextId]?.snapshot,
          ).toEqual(beforeRoot.snapshot);
        } finally {
          await compacting.release({ missionId: started.missionId, guard });
        }
      }
      const cold = createLocalHostNodeApplication({
        pragmaHome: f.home,
        runtimes: f.runtimes,
        client: { surface: "desktop", version: "test", instanceId: randomUUID() },
        workspace: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => undefined,
          realpath: async (path) => path,
        },
      });
      try {
        const continuation = randomUUID();
        await cold.missionControl!.submit({
          missionId: started.missionId,
          requestId: continuation,
          kind: "send",
          payload: { kind: "send", input: { prompt: "reopened" } },
        });
        const applied = await cold.missionControl!.waitForTerminal({
          missionId: started.missionId,
          requestId: continuation,
          timeoutMs: 5_000,
        });
        expect(applied, JSON.stringify(applied.error)).toMatchObject({ state: "applied" });
        await cold.missionControl!.waitExecution!({
          missionId: started.missionId,
          executionId: applied.result!["executionId"] as string,
        });
        await cold.missionControl!.stopOwner(started.missionId);
        const after = (await sessions.get(successorSessionId!))!;
        expect(after.rootContextId).toBe(before.rootContextId);
        expect(after.contexts[after.rootContextId]?.snapshot).toEqual(beforeRoot.snapshot);
        expect(await resolveSession(started.missionId)).toBe(successorSessionId);
        if (controllerOnly) await expect(missions.get(started.missionId)).rejects.toThrow();
      } finally {
        await cold.missionControl!.stopOwner(started.missionId);
        executions.close();
      }
    },
  );
  it.each(["scalar input", 42, ["array input"], null])(
    "runs a schema-less Flow with non-object input %j using controller facts",
    async (input) => {
      const f = await fixture();
      const started = await f.app.run!.start({
        requestId: randomUUID(),
        command: "flow.run",
        executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        input,
        detach: false,
      });
      expect((await started.outcome).status).toBe("succeeded");
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      const missions = createMissionStore({
        missionsPath: new PragmaPaths({ pragmaHome: f.home }).missionsRoot(),
      });
      try {
        expect((await executions.get(started.executionId!))?.input).toEqual(input);
        await expect(missions.get(started.missionId)).rejects.toMatchObject({
          code: "mission_not_found",
        });
      } finally {
        executions.close();
      }
    },
  );

  it.each([false, true])(
    "resumes a real HumanTask through the Node facade without replaying its Expert effect (controller-only=%s)",
    { timeout: 20_000 },
    async (controllerOnly) => {
      const f = await fixture(false, true);
      const started = await f.app.run!.start({
        requestId: randomUUID(),
        command: "flow.run",
        executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        input: controllerOnly ? "controller-only input" : {},
        detach: false,
      });
      expect((await started.outcome).status).toBe("input_required");
      const store = createSqliteExecutionStore({ pragmaHome: f.home });
      const original = await store.listContexts(started.executionId!);
      const paths = new PragmaPaths({ pragmaHome: f.home });
      const originalNative = await readRuntimeSessionsForOwners(paths, [started.executionId!]);
      expect(f.startTurn).toHaveBeenCalledOnce();
      await f.app.dispose?.();
      const cold = createLocalHostNodeApplication({
        pragmaHome: f.home,
        runtimes: f.runtimes,
        client: { surface: "desktop", version: "test", instanceId: randomUUID() },
      });
      try {
        const resumed = await cold.resumeMission!({
          missionId: started.missionId,
          requestId: randomUUID(),
          onHumanInteraction: async () => ({
            kind: "respond",
            response: { answers: { "Continue?": "Yes" } },
          }),
        });
        expect(resumed.execution.status).toBe("succeeded");
        expect(f.startTurn).toHaveBeenCalledOnce();
        expect(
          (await store.listContexts(started.executionId!)).map((context) => context.snapshot),
        ).toEqual(original.map((context) => context.snapshot));
        expect(await readRuntimeSessionsForOwners(paths, [started.executionId!])).toEqual(
          originalNative,
        );
      } finally {
        await cold.dispose?.();
        store.close();
      }
    },
  );

  it.each(["expert", "team", "flow"] as const)(
    "records compiled environment and active Capability revision for %s",
    async (kind) => {
      const f = await fixture();
      const id =
        kind === "expert" ? f.expertId : kind === "team" ? PUBLISHED_TEAM_ID : PUBLISHED_FLOW_ID;
      const catalog = createLocalHostProjectCatalogFromHome({
        pragmaHome: f.home,
        runtimes: f.runtimes,
      });
      const resolved = await catalog.resolve({ ref: { kind, id }, workspace: f.workspace });
      const active = await createLocalHostResourceResolvers({
        pragmaHome: f.home,
      }).capabilityAuthority.resolve(f.capabilityId);
      expect(resolved?.compilation?.capabilities).toEqual([active]);
      expect(resolved?.environment?.resources).toEqual([
        { kind: "capability", id: f.capabilityId, revision: 3, fingerprint: active.fingerprint },
      ]);
      const handle = await f.app.run!.start({
        requestId: randomUUID(),
        command: `${kind}.run`,
        executor: { kind, id },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: "done",
        detach: false,
      });
      const outcome = await handle.outcome;
      expect("error" in outcome ? outcome.error : undefined).toBeUndefined();
      expect(outcome).toMatchObject({ status: "succeeded" });
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      try {
        const record = await executions.get(handle.executionId!);
        expect(record?.environment).toEqual(resolved?.environment);
        expect(record?.environment?.resources?.[0]).toMatchObject({
          revision: 3,
          fingerprint: active.fingerprint,
        });
      } finally {
        executions.close();
      }
    },
  );

  it("interrupts a cold default Node Flow after readiness API and Capability become unavailable", async () => {
    const f = await fixture(false, true);
    const started = await f.app.run!.start({
      requestId: randomUUID(),
      command: "flow.run",
      executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
      project: { projectId: "studio", revision: 1 },
      workspace: f.workspace,
      detach: false,
    });
    expect((await started.outcome).status).toBe("input_required");
    // Override the Host-facing adapter readiness API. The test driver's
    // separately configured Native Session availability remains usable, so
    // this verifies compile/preflight isolation, not cancellation of an
    // unavailable Native provider.
    f.canUse.mockReturnValue({ usable: false, reason: "Host readiness API unavailable" });
    f.canUse.mockClear();
    await rm(
      join(new PragmaPaths({ pragmaHome: f.home }).dataRoot(), "capabilities", f.capabilityId),
      { recursive: true },
    );
    const cold = createLocalHostNodeApplication({
      pragmaHome: f.home,
      runtimes: f.runtimes,
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
    });
    const requestId = randomUUID();
    await cold.missionControl!.submit({
      missionId: started.missionId,
      requestId,
      kind: "interrupt",
      payload: { kind: "interrupt", reason: "Stop cold Flow" },
    });
    const operation = await cold.missionControl!.waitForTerminal({
      missionId: started.missionId,
      requestId,
      timeoutMs: 5_000,
    });
    expect(operation.state).toBe("applied");
    // This counter covers the external adapter API, not Native Session probes.
    expect(f.canUse).not.toHaveBeenCalled();
    const executions = createSqliteExecutionStore({ pragmaHome: f.home });
    try {
      expect((await executions.get(started.executionId!))?.status).toBe("cancelled");
    } finally {
      executions.close();
    }
    const sendRequestId = randomUUID();
    await cold.missionControl!.submit({
      missionId: started.missionId,
      requestId: sendRequestId,
      kind: "send",
      payload: { kind: "send", input: { prompt: "continue" } },
    });
    const rejected = await cold.missionControl!.waitForTerminal({
      missionId: started.missionId,
      requestId: sendRequestId,
      timeoutMs: 5_000,
    });
    expect(rejected).toMatchObject({ state: "rejected", error: { code: "RUNTIME_UNAVAILABLE" } });
    await cold.missionControl!.stopOwner(started.missionId);
    expect(f.canUse).toHaveBeenCalled();
  });

  it.each(["expert", "team"] as const)(
    "interrupts a cold running %s Session without execution readiness or current Capability",
    async (kind) => {
      const f = await fixture(false, false, true);
      const id = kind === "expert" ? f.expertId : PUBLISHED_TEAM_ID;
      const started = await f.app.run!.start({
        requestId: randomUUID(),
        command: `${kind}.run`,
        executor: { kind, id },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: "keep running",
        detach: false,
      });
      const source = createSqliteExecutionStore({ pragmaHome: f.home });
      let coldStore: ReturnType<typeof createSqliteExecutionStore> | undefined;
      let control: ReturnType<typeof createLocalHostCoreMissionControlAdapter> | undefined;
      try {
        await vi.waitFor(() => expect(f.pending.size).toBe(1));
        const original = await source.get(started.executionId!);
        const home = await mkdtemp(join(tmpdir(), "pragma-cold-running-"));
        roots.push(home);
        const sourcePaths = new PragmaPaths({ pragmaHome: f.home });
        const coldPaths = new PragmaPaths({ pragmaHome: home });
        const originalMission = await createMissionStore({
          missionsPath: sourcePaths.missionsRoot(),
        }).get(started.missionId);
        const sessionId = originalMission.execution!.sessionId!;
        const checkpoint = (await createFileExpertSessionStore({
          pragmaHome: f.home,
          executions: source,
        }).readSnapshot(sessionId))!;
        // Only immutable published resources are copied. Active stores are
        // rebuilt from their authoritative snapshots, never SQLite/WAL files
        // or directories containing atomically replaced temporary files.
        await cp(sourcePaths.projectsRoot(), coldPaths.projectsRoot(), { recursive: true });
        await cp(sourcePaths.contentObjectsRoot(), coldPaths.contentObjectsRoot(), {
          recursive: true,
        });
        coldStore = createSqliteExecutionStore({ pragmaHome: home });
        for (const executionId of checkpoint.session.executionIds) {
          const execution = (await source.get(executionId))!;
          const invocations = await source.listInvocations(executionId);
          await coldStore.create(
            execution,
            invocations.find((entry) => entry.invocationId === execution.rootInvocationId)!,
          );
          await coldStore.commit({
            commitId: `checkpoint:${executionId}`,
            executionId,
            invocationPuts: invocations.filter(
              (entry) => entry.invocationId !== execution.rootInvocationId,
            ),
            contextPuts: await source.listContexts(executionId),
            agentPuts: await source.listAgents(executionId),
            events: (await source.readEvents(executionId)).map((event) => ({
              eventId: event.eventId,
              invocationId: event.invocationId,
              type: event.type,
              data: event.data,
              occurredAt: event.occurredAt,
            })),
          });
        }
        const coldSessions = createFileExpertSessionStore({
          pragmaHome: home,
          executions: coldStore,
        });
        await coldSessions.create(checkpoint.session);
        await coldSessions.transact(sessionId, () => ({
          result: undefined,
          session: checkpoint.session,
          prompts: checkpoint.prompts,
        }));
        for (const event of checkpoint.events) await coldSessions.appendEvent(sessionId, event);
        const nativeRecords = await readRuntimeSessionsForOwners(sourcePaths, [sessionId]);
        expect(nativeRecords.length).toBeGreaterThan(0);
        for (const record of nativeRecords) {
          await createRuntimeSessionRecord({
            paths: coldPaths,
            owner: record.owner,
            systemSessionId: record.systemSessionId,
            agentId: record.expertId,
            runtime: { ...record.runtime, displayName: "Fixture" },
            workspace: record.currentWorkspace,
          });
          await updateRuntimeSessionRecord(coldPaths, record, {});
        }
        f.canUse.mockReturnValue({ usable: false, reason: "Host readiness API unavailable" });
        f.canUse.mockClear();
        const catalog = createLocalHostProjectCatalogFromHome({
          pragmaHome: home,
          runtimes: f.runtimes,
        });
        const project = (await catalog.listProjects())[0]!;
        const binding = createMissionPinnedBinding({
          requestId: randomUUID(),
          payloadHash: `sha256:${"a".repeat(64)}`,
          command: `${kind}.run`,
          executor: {
            source: "project",
            ref: { kind, id },
            project: {
              projectId: "studio",
              revision: 1,
              fingerprint: project.fingerprint,
            },
          },
          workspace: { canonicalPath: f.home, identityHash: `sha256:${"a".repeat(64)}` },
          provenance: "new_run",
        });
        const owners = new MissionExecutionOwner();
        control = createLocalHostCoreMissionControlAdapter({
          ownerAccess: owners,
          pragmaHome: home,
          runtimes: f.runtimes,
          executions: coldStore,
          executors: catalog.resolve,
          resolveMissionBinding: async () => binding,
          resolveExecutionId: async () => started.executionId,
          resolveSessionId: async () => sessionId,
        });
        const command = MissionCommandSchema.parse({
          schemaVersion: "pragma.mission-command/v2",
          commandId: randomUUID(),
          missionId: started.missionId,
          kind: "interrupt",
          payload: { kind: "interrupt", reason: "Stop cold running Session" },
          request: {
            schemaVersion: "pragma.integration-request/v1",
            requestId: randomUUID(),
            payloadHash: `sha256:${"a".repeat(64)}`,
            requestedAt: new Date().toISOString(),
            client: { surface: "cli", version: "test", instanceId: randomUUID() },
          },
          state: "accepted",
          createdAt: new Date().toISOString(),
        });
        await expect(
          control.consumer.apply({
            command,
            guard: { claimId: randomUUID(), fencingToken: "1" },
            signal: new AbortController().signal,
            deadlineAt: new Date(Date.now() + 30_000).toISOString(),
          }),
        ).resolves.toMatchObject({ result: { targetStatus: "interrupted" } });
        expect(f.canUse).not.toHaveBeenCalled();
        expect((await coldStore.get(started.executionId!))?.status).toBe("interrupted");
        expect((await coldStore.get(started.executionId!))?.environment).toEqual(
          original?.environment,
        );
        // Existing ExpertSession recovery marks an abandoned running turn
        // interrupted. It does not provide Flow's Native stop protocol.
        expect(f.restore).not.toHaveBeenCalled();
        await control.release(started.missionId);
        const send = MissionCommandSchema.parse({
          ...command,
          commandId: randomUUID(),
          kind: "send",
          request: { ...command.request, requestId: randomUUID() },
          payload: { kind: "send", input: { prompt: "continue after resources restored" } },
        });
        const apply = () =>
          control!.consumer.apply({
            command: send,
            guard: { claimId: randomUUID(), fencingToken: "2" },
            signal: new AbortController().signal,
            deadlineAt: new Date(Date.now() + 30_000).toISOString(),
          });
        await expect(apply()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
        await cp(
          join(new PragmaPaths({ pragmaHome: f.home }).dataRoot(), "capabilities", f.capabilityId),
          join(coldPaths.dataRoot(), "capabilities", f.capabilityId),
          { recursive: true },
        );
        f.canUse.mockReturnValue({ usable: true });
        const continued = await apply();
        const executionId = continued.result.executionId as string;
        const owner = owners.controlOwner(started.missionId);
        if (owner?.kind !== "session") throw new Error("Expected the continued Session owner.");
        // Execution terminal status is committed before Session/queue cleanup.
        // Wait for Core's processing barrier before testing terminal release.
        expect(await owner.session.waitForPromptProcessing()).toBe("idle");
        await vi.waitFor(async () =>
          expect((await coldStore!.get(executionId))?.status).toBe("succeeded"),
        );
        await control.release(started.missionId);
        control = undefined;
      } finally {
        await control?.release(started.missionId);
        const originalRecord = await source.get(started.executionId!);
        if (originalRecord !== undefined && !isTerminalExecutionStatus(originalRecord.status)) {
          await started.cancel("fixture cleanup");
        }
        await started.outcome;
        await f.app.missionControl!.stopOwner(started.missionId);
        source.close();
        coldStore?.close();
      }
    },
  );

  it("invalidates successful readiness when the default Node execution fails", async () => {
    const createCompiler = nodeCompiler.createLocalHostNodeMissionCompiler;
    let compiler: nodeCompiler.LocalHostNodeMissionCompiler | undefined;
    let invalidate: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(nodeCompiler, "createLocalHostNodeMissionCompiler").mockImplementation((options) => {
      compiler = createCompiler(options);
      invalidate = vi.spyOn(compiler.readiness, "invalidate");
      return compiler;
    });
    const f = await fixture(true);
    const request = {
      command: "expert.run" as const,
      executor: { kind: "expert" as const, id: f.expertId },
      project: { projectId: "studio", revision: 1 },
      workspace: f.workspace,
      prompt: "fail",
      detach: false,
    };
    const first = await f.app.run!.start({ ...request, requestId: randomUUID() });
    expect((await first.outcome).status).toBe("failed");
    expect(invalidate).toHaveBeenCalledOnce();
    const probes = f.canUse.mock.calls.length;
    if (compiler === undefined) throw new Error("Default Node compiler was not created.");
    await compiler.assertReady(
      compiler.service.createRequestScope({
        id: first.missionId,
        project: { id: "studio", revision: 1 },
        executor: { kind: "expert", ref: `expert:${f.expertId}`, name: "Fixture" },
        workspace: { path: f.home },
        contextMounts: [],
      }),
    );
    expect(f.canUse).toHaveBeenCalledTimes(probes + 1);
  });
});

it(
  "takes over a persisted mounted Mission with readable, immutable Knowledge",
  { timeout: 15_000 },
  async () => {
    const storeId = randomUUID();
    const namespace = `mission-knowledge:${storeId}`;
    const reads: unknown[] = [];
    const f = await fixture(false, false, false, async (agent) => {
      reads.push(await agent.contextSystem.read({ namespace, id: "knowledge.md" }));
      expect(
        await agent.contextSystem.edit({
          namespace,
          id: "knowledge.md",
          mode: "replace",
          content: "must not write",
        }),
      ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    });
    const paths = new PragmaPaths({ pragmaHome: f.home });
    const knowledge = await writePublishedKnowledgeFixture(f.home, storeId);
    const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
    const requestId = randomUUID();
    const mission = await missions.create({
      initialMessageId: requestId,
      workspace: { path: f.home, basename: "workspace" },
      goal: "Read Mission Knowledge",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: `expert:${f.expertId}`, name: "Expert" },
      contextMounts: [{ kind: "context-store", storeId }],
    });
    const started = await f.app.run!.startAttached({
      missionId: mission.id,
      request: {
        requestId,
        command: "expert.run",
        executor: { kind: "expert", id: f.expertId },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: mission.goal,
        detach: false,
      },
    });
    expect((await started.outcome).status).toBe("succeeded");
    expect(reads).toEqual([
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          content: expect.stringContaining("Original published content"),
        }),
      }),
    ]);
    expect((await knowledge.resolve(storeId)).store).toBeDefined();
    expect((await missions.get(mission.id)).contextMounts).toEqual(mission.contextMounts);
    const draftRequestId = randomUUID();
    const unavailableDraft = await missions.create({
      initialMessageId: draftRequestId,
      workspace: { path: f.home, basename: "workspace" },
      goal: "Unavailable Knowledge draft",
      project: mission.project,
      executor: mission.executor,
      contextMounts: [{ kind: "context-store-draft", draftId: randomUUID() }],
    });
    await expect(
      f.app.run!.startAttached({
        missionId: unavailableDraft.id,
        request: {
          requestId: draftRequestId,
          command: "expert.run",
          executor: { kind: "expert", id: f.expertId },
          project: { projectId: "studio", revision: 1 },
          workspace: f.workspace,
          prompt: unavailableDraft.goal,
          detach: false,
        },
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { reason: "mission_knowledge_draft_adapter_unavailable" },
    });
    expect(reads).toHaveLength(1);
    await f.app.dispose?.();
  },
);

async function writePublishedKnowledgeFixture(home: string, storeId: string) {
  const paths = new PragmaPaths({ pragmaHome: home });
  const knowledge = createLocalHostContextStoreReader({ storesPath: paths.contextStoresRoot() });
  await mkdir(knowledge.contentRoot(storeId), { recursive: true });
  await writeFile(
    join(knowledge.contentRoot(storeId), "knowledge.md"),
    "# Knowledge\nOriginal published content",
  );
  const snapshot = await knowledge.buildSnapshot(storeId, 1);
  const revisionRoot = join(knowledge.storePath(storeId), "revisions", "00000001");
  await mkdir(revisionRoot, { recursive: true });
  await writeFile(
    join(revisionRoot, "snapshot.json"),
    JSON.stringify(await knowledge.persistSnapshotManifest(storeId, snapshot)),
  );
  const timestamp = new Date().toISOString();
  await writeFile(
    knowledge.manifestPath(storeId),
    JSON.stringify(
      ContextStoreSchema.parse({
        schemaVersion: "pragma.context-store/v4",
        id: storeId,
        name: "Published Knowledge",
        description: "",
        type: "file",
        status: "ready",
        source: { origin: "created" },
        contentRevision: 1,
        snapshotHash: snapshot.snapshotHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
  );
  await writeFile(
    join(knowledge.storePath(storeId), SNAPSHOT_STORAGE_MARKER),
    JSON.stringify({
      schemaVersion: "pragma.context-store-snapshot-storage/v2",
      storeId,
      migratedAt: timestamp,
    }),
  );
  return knowledge;
}

it(
  "cold-stops a waiting Flow with unavailable mounted Knowledge without touching executable resources",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true);
    const storeId = randomUUID();
    const knowledge = await writePublishedKnowledgeFixture(f.home, storeId);
    const paths = new PragmaPaths({ pragmaHome: f.home });
    const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
    const requestId = randomUUID();
    const mission = await missions.create({
      initialMessageId: requestId,
      workspace: { path: f.home, basename: "workspace" },
      goal: "Flow awaiting human",
      flowInput: {},
      project: { id: "studio", revision: 1 },
      executor: { kind: "flow", ref: `flow:${PUBLISHED_FLOW_ID}`, name: "Flow" },
      contextMounts: [{ kind: "context-store", storeId }],
    });
    const started = await f.app.run!.startAttached({
      missionId: mission.id,
      request: {
        requestId,
        command: "flow.run",
        executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        input: {},
        detach: false,
      },
    });
    expect((await started.outcome).status).toBe("input_required");
    await f.app.dispose?.();
    await rm(knowledge.storePath(storeId), { recursive: true });
    f.canUse.mockReturnValue({ usable: false, reason: "Unavailable readiness" });
    f.canUse.mockClear();
    const before = createSqliteExecutionStore({ pragmaHome: f.home });
    const originalEnvironment = (await before.get(started.executionId!))?.environment;
    const originalContexts = await before.listContexts(started.executionId!);
    const originalNative = await readRuntimeSessionsForOwners(paths, [started.executionId!]);
    expect(originalNative).toHaveLength(1);
    before.close();
    const cold = createLocalHostNodeApplication({
      pragmaHome: f.home,
      runtimes: f.runtimes,
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
    });
    try {
      const interruptRequestId = randomUUID();
      await cold.missionControl!.submit({
        missionId: mission.id,
        requestId: interruptRequestId,
        kind: "interrupt",
        payload: { kind: "interrupt", reason: "Stop with unavailable Knowledge" },
      });
      expect(
        await cold.missionControl!.waitForTerminal({
          missionId: mission.id,
          requestId: interruptRequestId,
          timeoutMs: 5_000,
        }),
      ).toMatchObject({ state: "applied" });
      expect(f.canUse).not.toHaveBeenCalled();
      expect(f.restore).toHaveBeenCalledWith(
        expect.objectContaining({ systemSessionId: originalNative[0]!.systemSessionId }),
      );
      const restoredNative = await readRuntimeSessionsForOwners(paths, [started.executionId!]);
      expect(
        restoredNative.map((record) => ({
          owner: record.owner,
          systemSessionId: record.systemSessionId,
          runtimeSessionRef: record.runtimeSessionRef,
        })),
      ).toEqual(
        originalNative.map((record) => ({
          owner: record.owner,
          systemSessionId: record.systemSessionId,
          runtimeSessionRef: record.runtimeSessionRef,
        })),
      );
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      try {
        expect(await executions.get(started.executionId!)).toMatchObject({
          status: "cancelled",
          environment: originalEnvironment,
        });
        expect(await executions.listContexts(started.executionId!)).toEqual(originalContexts);
      } finally {
        executions.close();
      }
      expect((await missions.get(mission.id)).contextMounts).toEqual(mission.contextMounts);
      f.canUse.mockReturnValue({ usable: true });
      const normalRequestId = randomUUID();
      await cold.missionControl!.submit({
        missionId: mission.id,
        requestId: normalRequestId,
        kind: "send",
        payload: { kind: "send", input: { prompt: "Normal execution still requires Knowledge" } },
      });
      expect(
        await cold.missionControl!.waitForTerminal({
          missionId: mission.id,
          requestId: normalRequestId,
          timeoutMs: 5_000,
        }),
      ).toMatchObject({ state: "rejected" });
      expect(f.restore).toHaveBeenCalledTimes(1);
      expect(await readRuntimeSessionsForOwners(paths, [started.executionId!])).toHaveLength(1);
    } finally {
      await cold.dispose?.();
    }
  },
);
