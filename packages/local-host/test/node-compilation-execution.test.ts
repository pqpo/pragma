import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExpertSessionStore,
  createRuntimeSessionRecord,
  readRuntimeSessionsForOwners,
  updateRuntimeSessionRecord,
  createStaticRuntimeResolver,
  PragmaPaths,
} from "@pragma/core";
import { createLocalHostCoreMissionControlAdapter } from "../src/core-control-adapter.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { createMissionPinnedBinding } from "../src/missions/controller/pinned-binding.ts";
import { MissionCommandSchema } from "@pragma/shared/integration";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import {
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

async function fixture(fail = false, checkpoint = false, running = false) {
  const home = await mkdtemp(join(tmpdir(), "pragma-node-compiled-execution-"));
  roots.push(home);
  const pending = new Map<string, (error: Error) => void>();
  const restore = vi.fn(({ systemSessionId }: { systemSessionId: string }) => ({
    id: `native-${systemSessionId}`,
  }));
  const stop = vi.fn((session: { id: string }) =>
    pending.get(session.id)?.(new Error("Native stopped")),
  );
  const driver = defineRuntimeTestDriver<never, { readonly id: string }>({
    descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
    createSession: ({ systemSessionId }) => ({ id: `native-${systemSessionId}` }),
    restoreSession: restore,
    cancelTurn: stop,
    closeSession: stop,
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (session) => {
      if (fail) throw new Error("fixture execution failure");
      if (running && pending.size === 0)
        await new Promise<never>((_resolve, reject) => pending.set(session.id, reject));
      return { outputText: "done", runtimeSessionId: session.id };
    },
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
  };
}

describe("default Node compilation reaches persisted Execution", { timeout: 15_000 }, () => {
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
        const checkpoint = (await createFileExpertSessionStore({
          pragmaHome: f.home,
          executions: source,
        }).readSnapshot(started.missionId))!;
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
        await coldSessions.transact(started.missionId, () => ({
          result: undefined,
          session: checkpoint.session,
          prompts: checkpoint.prompts,
        }));
        for (const event of checkpoint.events)
          await coldSessions.appendEvent(started.missionId, event);
        const nativeRecords = await readRuntimeSessionsForOwners(sourcePaths, [started.missionId]);
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
