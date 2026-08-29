import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStaticRuntimeResolver,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  type ExpertSessionStore,
  type ExecutionStore,
  type RuntimeAdapter,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { ExecutionRecordSchema, PromptRequestSchema } from "@pragma/shared";
import { ExecutorDescriptorSchema, type ExecutorReference } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  backfillMissionPinnedBinding,
  createControllerRunMissionPort,
  createCoreRunExecutorPort,
  createLocalHostCoreStores,
  createLocalHostMissionBoardBindings,
  createLocalHostRunApplication,
  createMissionControllerStore,
  hashCanonicalRunPayload,
  type LocalHostCoreExecutorDefinition,
  type LocalHostRunRequest,
  type MissionPinnedBindingBackfillResult,
  type LocalHostProjectCatalog,
} from "../src/index.ts";

const project = {
  projectId: "studio",
  revision: 7,
  fingerprint: "b".repeat(64),
} as const;
const workspace = {
  schemaVersion: "pragma.integration-workspace/v1" as const,
  requestedPath: "/workspace",
  canonicalPath: "/workspace",
  displayName: "workspace",
  identityHash: "sha256:c52ddf65534b7b46035084358ab7902be4bfef220bdb503ac7039cc861905b05",
  access: { exists: true, readable: true, writable: true },
  source: "mission" as const,
};

describe("Mission pinned binding backfill", () => {
  it.each([
    ["expert", "0123456789abcdef", "expert.run"],
    ["team", "123456789abcdefg", "team.run"],
    ["flow", "23456789abcdefgh", "flow.run"],
  ] as const)(
    "proves a real M7 writer fixture for %s using Core owner data",
    async (kind, id, command) => {
      const fixture = await createRealM7WriterFixture({ kind, id, command });
      try {
        const result = await backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project: fixture.project,
        });

        expect(result.disposition).toBe("appended");
        expect(result.binding).toMatchObject({
          provenance: "m7_payload_hash_backfill",
          command,
          executor: { source: "project", ref: { kind, id }, project: fixture.project },
        });
        expect(fixture.resolve).toHaveBeenCalledWith(
          expect.objectContaining({
            ref: { kind, id },
            projectId: fixture.project.projectId,
            revision: fixture.project.revision,
          }),
        );
        const events = (await fixture.controller.readSnapshot({ missionId: fixture.missionId }))
          .events;
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining([
            "mission.created",
            "run.accepted",
            "run.started",
            "mission.binding.pinned",
          ]),
        );
      } finally {
        await cleanup(fixture.root);
      }
    },
  );

  it.each([
    ["expert", "0123456789abcdef", "expert.run"],
    ["team", "123456789abcdefg", "team.run"],
  ] as const)(
    "proves the historical %s payload before appending a pin",
    async (kind, id, command) => {
      const fixture = await createFixture({ kind, id, command, prompt: "hello\r\nworld" });
      try {
        const result = await backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project,
        });
        expect(result.disposition).toBe("appended");
        expect(result.binding).toMatchObject({
          schemaVersion: "pragma.mission-pinned-binding/v1",
          command,
          provenance: "m7_payload_hash_backfill",
          executor: { source: "project", ref: { kind, id }, project },
        });
        expect(fixture.resolve).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: project.projectId, revision: project.revision }),
        );
        await expect(
          fixture.controller.readSnapshot({ missionId: fixture.missionId }),
        ).resolves.toMatchObject({
          events: [
            expect.objectContaining({ type: "mission.created" }),
            expect.objectContaining({ type: "run.accepted" }),
            expect.objectContaining({ type: "mission.binding.pinned" }),
          ],
        });
      } finally {
        await cleanup(fixture.root);
      }
    },
  );

  it("proves a historical Flow from the exact Execution v10 input", async () => {
    const fixture = await createFixture({
      kind: "flow",
      id: "23456789abcdefgh",
      command: "flow.run",
      input: { z: 1, a: ["keep-order"] },
    });
    try {
      const result = await backfillMissionPinnedBinding(fixture.ports, {
        missionId: fixture.missionId,
        project,
      });
      expect(result.binding.command).toBe("flow.run");
      expect(fixture.ports.controller).toBeDefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("fails closed without a project/revision pair and never resolves the head", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
    });
    const builtInResolver = vi.fn(async () => undefined);
    try {
      await expect(
        backfillMissionPinnedBinding(
          { ...fixture.ports, builtInResolver },
          { missionId: fixture.missionId },
        ),
      ).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
        details: {
          reason: "mission_pinned_binding_required",
          requiredOptions: ["--project", "--revision"],
        },
      });
      expect(fixture.resolve).not.toHaveBeenCalled();
      expect(builtInResolver).toHaveBeenCalledOnce();
      expect(
        (await fixture.controller.readSnapshot({ missionId: fixture.missionId })).events,
      ).not.toContainEqual(expect.objectContaining({ type: "mission.binding.pinned" }));
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies malformed mission.created evidence as storage corruption", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
      createdData: { requestId: "not-a-uuid" },
    });
    try {
      const before = await fixture.controller.readSnapshot({ missionId: fixture.missionId });
      await expect(
        backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORRUPTED" });
      expect(fixture.resolve).not.toHaveBeenCalled();
      await expect(
        fixture.controller.readSnapshot({ missionId: fixture.missionId }),
      ).resolves.toEqual(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("fails closed when the exact candidate produces a different historical hash", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
      descriptorFingerprint: "d".repeat(64),
    });
    try {
      await expect(
        backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project,
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
        details: { reason: "mission_pinned_binding_unprovable" },
      });
      expect(
        (await fixture.controller.readSnapshot({ missionId: fixture.missionId })).events,
      ).not.toContainEqual(expect.objectContaining({ type: "mission.binding.pinned" }));
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("fails closed when the exact revision candidate changes during revalidation", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
    });
    const changedDescriptor = ExecutorDescriptorSchema.parse({
      ...fixture.descriptor,
      project: { ...project, revision: 8, fingerprint: "c".repeat(64) },
    });
    fixture.resolve
      .mockImplementationOnce(async () => ({ descriptor: fixture.descriptor }))
      .mockImplementationOnce(async () => ({ descriptor: changedDescriptor }));
    try {
      await expect(
        backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project,
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
        details: { reason: "mission_pinned_binding_unprovable" },
      });
      expect(
        fixture.resolve.mock.calls.every(([input]) => input.revision === project.revision),
      ).toBe(true);
      expect(
        (await fixture.controller.readSnapshot({ missionId: fixture.missionId })).events,
      ).not.toContainEqual(expect.objectContaining({ type: "mission.binding.pinned" }));
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a future pinned-binding version without treating it as absent", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
    });
    try {
      const guard = await fixture.controller.claim({
        missionId: fixture.missionId,
        claimId: "88888888-8888-4888-8888-888888888888",
        leaseMs: 10_000,
      });
      await fixture.controller.write({
        missionId: fixture.missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.binding.pinned", {
            schemaVersion: "pragma.mission-pinned-binding/v2",
          });
        },
      });
      await fixture.controller.release({ missionId: fixture.missionId, guard });

      await expect(
        backfillMissionPinnedBinding(fixture.ports, {
          missionId: fixture.missionId,
          project,
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
        details: { reason: "mission_pinned_binding_required" },
      });
      expect(fixture.resolve).not.toHaveBeenCalled();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("is idempotent for concurrent proof-based repairs", async () => {
    const fixture = await createFixture({
      kind: "expert",
      id: "0123456789abcdef",
      command: "expert.run",
      prompt: "hello",
    });
    try {
      const results = await Promise.allSettled(
        [0, 1].map(
          async () =>
            await backfillMissionPinnedBinding(fixture.ports, {
              missionId: fixture.missionId,
              project,
            }),
        ),
      );
      const successful = results.filter(
        (result): result is PromiseFulfilledResult<MissionPinnedBindingBackfillResult> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(successful.map((result) => result.value.disposition)).toContain("appended");
      expect(
        successful.every((result) => ["appended", "existing"].includes(result.value.disposition)),
      ).toBe(true);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "MISSION_LEASE_HELD" });
      const pins = (
        await fixture.controller.readSnapshot({ missionId: fixture.missionId })
      ).events.filter((event) => event.type === "mission.binding.pinned");
      expect(pins).toHaveLength(1);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

async function createFixture(input: {
  readonly kind: "expert" | "team" | "flow";
  readonly id: string;
  readonly command: "expert.run" | "team.run" | "flow.run";
  readonly prompt?: string;
  readonly input?: unknown;
  readonly descriptorFingerprint?: string;
  readonly createdData?: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), "pragma-pinned-backfill-"));
  const controller = createMissionControllerStore({ missionsPath: join(root, "missions") });
  const ref = { kind: input.kind, id: input.id } as ExecutorReference;
  const descriptor = ExecutorDescriptorSchema.parse({
    schemaVersion: "pragma.integration-executor/v1",
    ref,
    name: "Historical fixture",
    description: "fixture",
    source: "project",
    project: { ...project, fingerprint: input.descriptorFingerprint ?? project.fingerprint },
    availability: { status: "ready", blockingCodes: [] },
    workspace: { required: true, allowNonGitDirectory: true },
    capabilities: { interactive: true, resumable: true, steerable: false, supportsQueue: false },
  });
  const historicalHash = hashCanonicalRunPayload({
    command: input.command,
    executor: ref,
    project,
    workspace,
    ...(input.kind === "flow" ? { input: input.input } : { prompt: input.prompt ?? "hello" }),
  });
  const reservation = await controller.reserveRunRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    payloadHash: historicalHash,
  });
  const guard = await controller.claim({
    missionId: reservation.missionId,
    claimId: "22222222-2222-4222-8222-222222222222",
    leaseMs: 10_000,
  });
  await controller.write({
    missionId: reservation.missionId,
    guard,
    operation: async ({ appendEvent }) => {
      await appendEvent("mission.created", {
        requestId: "11111111-1111-4111-8111-111111111111",
        payloadHash: historicalHash,
        executor: ref,
        workspace: workspace.canonicalPath,
        ...input.createdData,
      });
      await appendEvent("run.accepted", {
        requestId: "11111111-1111-4111-8111-111111111111",
        payloadHash: historicalHash,
      });
    },
  });
  await controller.release({ missionId: reservation.missionId, guard });

  const prompt =
    input.kind === "flow"
      ? undefined
      : PromptRequestSchema.parse({
          requestId: "11111111-1111-4111-8111-111111111111",
          sessionId: reservation.missionId,
          content: input.prompt ?? "hello",
          mode: "enqueue",
          executionId: "33333333-3333-4333-8333-333333333333",
          status: "succeeded",
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:01.000Z",
        });
  const execution =
    input.kind === "flow"
      ? ExecutionRecordSchema.parse({
          schemaVersion: "pragma.execution/v10",
          executionId: reservation.missionId,
          version: 1,
          kind: "flow",
          definition: { kind: "flow", id: input.id },
          rootInvocationId: "root",
          status: "succeeded",
          input: input.input,
          state: {},
          lastAppliedSequence: 0,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:01.000Z",
        })
      : undefined;
  const resolve = vi.fn(async () => ({ descriptor }));
  const ports = {
    controller,
    catalog: { resolve } as unknown as Pick<LocalHostProjectCatalog, "resolve">,
    sessions:
      prompt === undefined
        ? undefined
        : ({ listPrompts: async () => [prompt] } as Pick<ExpertSessionStore, "listPrompts">),
    executions:
      execution === undefined
        ? undefined
        : ({ get: async () => execution } as Pick<ExecutionStore, "get">),
  };
  return {
    root,
    controller,
    missionId: reservation.missionId,
    resolve,
    descriptor,
    ports,
  };
}

const realFixtureProject = {
  projectId: "historical-project",
  revision: 7,
  fingerprint: "b".repeat(64),
} as const;

async function createRealM7WriterFixture(input: {
  readonly kind: "expert" | "team" | "flow";
  readonly id: string;
  readonly command: "expert.run" | "team.run" | "flow.run";
}): Promise<{
  readonly root: string;
  readonly missionId: string;
  readonly project: typeof realFixtureProject;
  readonly controller: ReturnType<typeof createMissionControllerStore>;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly ports: Parameters<typeof backfillMissionPinnedBinding>[0];
}> {
  const root = await mkdtemp(join(tmpdir(), "pragma-real-m7-writer-"));
  const workspace = realFixtureWorkspace(root);
  const controller = createMissionControllerStore({ missionsPath: join(root, "missions") });
  const coreStores = createLocalHostCoreStores({ pragmaHome: root });
  const runtime = createRealFixtureRuntime();
  const runtimes = createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: "fixture",
  });
  const definitions = await createRealFixtureDefinitions(root, input);
  const executorPort = createCoreRunExecutorPort({
    pragmaHome: root,
    runtimes,
    executions: coreStores.executions,
    sessions: coreStores.sessions,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome: root, missionId }),
    executors: definitions,
  });
  const controllerMission = createControllerRunMissionPort(controller);
  const legacyMission = {
    ...controllerMission,
    // This is the M7 writer boundary: the new pin event did not exist yet.
    ensurePinnedBinding: async () => ({ disposition: "appended" as const }),
  };
  const run = createLocalHostRunApplication({ executors: executorPort, mission: legacyMission });
  const request: LocalHostRunRequest = {
    requestId:
      input.kind === "expert"
        ? "44444444-4444-4444-8444-444444444441"
        : input.kind === "team"
          ? "44444444-4444-4444-8444-444444444442"
          : "44444444-4444-4444-8444-444444444443",
    command: input.command,
    executor: { kind: input.kind, id: input.id },
    workspace,
    ...(input.kind === "flow"
      ? { input: { z: 7, a: ["historical"] } }
      : { prompt: `${input.kind}\r\nfixture` }),
    project: { projectId: realFixtureProject.projectId, revision: realFixtureProject.revision },
    detach: false,
  };
  const runHandle = await run.start(request);
  await expect(runHandle.outcome).resolves.toMatchObject({ status: "succeeded" });
  const definition = definitions[0]!;
  const resolve = vi.fn(async () => ({ descriptor: definition.descriptor }));
  return {
    root,
    missionId: runHandle.missionId,
    project: realFixtureProject,
    controller,
    resolve,
    ports: {
      controller,
      catalog: { resolve } as unknown as Pick<LocalHostProjectCatalog, "resolve">,
      sessions: coreStores.sessions,
      executions: coreStores.executions,
    },
  };
}

async function createRealFixtureDefinitions(
  root: string,
  input: { readonly kind: "expert" | "team" | "flow"; readonly id: string },
): Promise<readonly LocalHostCoreExecutorDefinition[]> {
  const expert = await defineExpert({
    id: "historical-expert",
    name: "Historical Expert",
    description: "Historical M7 fixture expert",
    tags: [],
    scope: "test",
    workspace: root,
    pragmaHome: root,
  });
  const coordinator = await defineExpert({
    id: "historical-coordinator",
    name: "Historical Coordinator",
    description: "Historical M7 fixture coordinator",
    tags: [],
    scope: "test",
    workspace: root,
    pragmaHome: root,
  });
  const team = defineExpertTeam({
    id: "historical-team",
    coordinator,
    members: [],
    delegation: {},
  });
  const flow = defineFlow<
    { readonly z: number; readonly a: readonly string[] },
    { readonly value: number }
  >({
    id: input.kind === "flow" ? input.id : "historical-flow",
    input: z.object({ z: z.number(), a: z.array(z.string()) }),
    result: ({ terminal }) => terminal.output as { readonly value: number },
  });
  const double = flow.task({
    id: "double",
    handler: ({ input: flowInput }) => ({ value: flowInput.z * 2 }),
  });
  flow.compose(({ start, end }) => start(double).next(end()));
  const definitions = [
    realFixtureDefinition(
      { kind: "expert", id: input.kind === "expert" ? input.id : "0123456789abcdef" },
      expert,
    ),
    realFixtureDefinition(
      { kind: "team", id: input.kind === "team" ? input.id : "123456789abcdefg" },
      team,
    ),
    realFixtureDefinition(
      { kind: "flow", id: input.kind === "flow" ? input.id : "23456789abcdefgh" },
      flow,
    ),
  ];
  return definitions.filter((definition) => definition.descriptor.ref.kind === input.kind);
}

function realFixtureDefinition(
  ref: ExecutorReference,
  definition: LocalHostCoreExecutorDefinition["definition"],
): LocalHostCoreExecutorDefinition {
  return {
    descriptor: ExecutorDescriptorSchema.parse({
      schemaVersion: "pragma.integration-executor/v1",
      ref,
      name: `Historical ${ref.kind}`,
      description: "Real M7 writer fixture",
      source: "project",
      project: realFixtureProject,
      availability: { status: "ready", blockingCodes: [] },
      workspace: { required: true, allowNonGitDirectory: true },
      capabilities: {
        interactive: false,
        resumable: true,
        steerable: false,
        supportsQueue: false,
      },
    }),
    definition,
  };
}

function realFixtureWorkspace(root: string): LocalHostRunRequest["workspace"] {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: root,
    canonicalPath: root,
    displayName: "historical-fixture",
    identityHash: `sha256:${createHash("sha256").update(root).digest("hex")}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  };
}

function createRealFixtureRuntime(): RuntimeAdapter {
  return defineRuntimeTestDriver<never, { readonly id: string; readonly agentId: string }>({
    descriptor: { id: "fixture", kind: "test", displayName: "Historical fixture runtime" },
    createSession: ({ systemSessionId, agent }) => ({
      id: `native-${systemSessionId}`,
      agentId: agent.id,
    }),
    restoreSession: ({ runtimeSession, agent }) => ({ id: runtimeSession!.id, agentId: agent.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (session, turn) => ({
      outputText: `historical-${session.agentId}:${turn.rawQuery}`,
      runtimeSessionId: session.id,
    }),
    mapEvent: () => ({ events: [] }),
  });
}

async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}
