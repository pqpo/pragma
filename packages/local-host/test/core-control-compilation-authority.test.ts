import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  type ExecutionStore,
  type ExpertSession,
  type ExpertSessionStore,
  type PragmaApp,
} from "@pragma/core";
import { ExpertSessionRecordSchema } from "@pragma/shared";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  canonicalPragmaResourceRef,
  formatPragmaYaml,
  loadPragmaProject,
} from "@pragma/interpreter";
import { PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import { createIntegrationError, MissionCommandSchema } from "@pragma/shared/integration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostCoreMissionControlAdapter } from "../src/core-control-adapter.ts";
import { createLocalHostNodeMissionCompiler } from "../src/node-mission-compiler.ts";
import { createLocalHostProjectCatalog } from "../src/project-catalog.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { createMissionPinnedBinding } from "../src/missions/controller/pinned-binding.ts";
import { createPublishedProjectResources } from "./fixtures/published-project.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cold = false, external = false) {
  const home = await mkdtemp(join(tmpdir(), "pragma-warm-authority-"));
  roots.push(home);
  const resources = [...createPublishedProjectResources()];
  const expert = resources.find((resource) => resource.kind === "Expert")!;
  if (expert.kind !== "Expert") throw new Error("Missing fixture Expert.");
  const capabilityId = "pcr7npvx0gv8fpka";
  expert.spec.capabilities = [{ ref: `capability:${capabilityId}`, kind: "tools" }];
  resources.push(
    PragmaCapabilityResourceSchema.parse({
      apiVersion: expert.apiVersion,
      kind: "Capability",
      metadata: { id: capabilityId, name: "Fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: "binding:fixture.tools",
        config: { key: "fixture" },
      },
    }),
  );
  const entry = join(home, "pragma.yaml");
  await writeFile(
    entry,
    formatPragmaYaml({ apiVersion: expert.apiVersion, kind: "Bundle", resources }),
  );
  const canUse = vi.fn(async () => ({ usable: true }));
  const acquire = vi.fn(() => ({}));
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      defineRuntimeTestDriver({
        descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
        canUse,
        createSession: acquire,
        startTurn: () => ({ outputText: "done" }),
        mapEvent: () => ({ events: [] }),
      }),
    ],
  });
  const location = {
    projectId: "studio",
    revision: 1,
    entryFile: entry,
    rootDir: home,
    projectFingerprint: undefined as string | undefined,
  };
  const readRevision = vi.fn(async () => location);
  const compileCalls = vi.fn();
  let activeRevision = 1;
  let missing = false;
  const authority = vi.fn(async () => {
    if (missing)
      throw createIntegrationError({
        code: "DEPENDENCY_UNAVAILABLE",
        category: "dependency",
        message: "Capability missing.",
        details: { diagnosticCode: "capability_not_found" },
      });
    return {
      capabilityId,
      resolvedRevision: activeRevision,
      fingerprint: String(activeRevision).repeat(64),
    };
  });
  const compiler = createLocalHostNodeMissionCompiler({
    pragmaHome: home,
    loggerProvider: createNoopLoggerProvider(),
    runtimes,
    reader: {
      getHead: readRevision,
      getRevision: readRevision,
      getRevisionByPublicationId: async () => undefined,
      readFiles: async () => new Map(),
      openRevision: async () => {
        const project = await loadPragmaProject(entry);
        const compile = project.compile.bind(project);
        project.compile = async (...args) => {
          compileCalls();
          return await compile(...args);
        };
        return project;
      },
    },
    resources: {
      capabilityAuthority: { getCapabilityId: () => capabilityId, resolve: authority },
      adapterHost: () => ({
        environmentId: "cli",
        projectRoot: home,
        resolveBinding: async (ref) => ({
          ref,
          revision: String(activeRevision),
          fingerprint: String(activeRevision).repeat(64),
          value: { contribution: { tools: [] } },
        }),
        resolveArtifact: async () => {
          throw new Error("Unexpected artifact.");
        },
        resolveSecret: async () => undefined,
      }),
    },
  });
  const missionId = randomUUID();
  const ref = { kind: "expert" as const, id: expert.metadata.id };
  const prepared = await compiler.prepare(
    compiler.service.createRequestScope({
      id: missionId,
      project: { id: "studio", revision: 1 },
      executor: {
        kind: ref.kind,
        ref: canonicalPragmaResourceRef(expert),
        name: expert.metadata.name,
      },
      workspace: { path: home },
      contextMounts: [],
    }),
  );
  const compilation = await prepared.ensureCompiled();
  location.projectFingerprint = compilation.compiled.projectFingerprint;
  canUse.mockClear();
  const binding = createMissionPinnedBinding({
    requestId: randomUUID(),
    payloadHash: `sha256:${"a".repeat(64)}`,
    command: "expert.run",
    executor: {
      source: "project",
      ref,
      project: {
        projectId: "studio",
        revision: 1,
        fingerprint: compilation.compiled.projectFingerprint,
      },
    },
    workspace: { canonicalPath: home, identityHash: `sha256:${"a".repeat(64)}` },
    provenance: "new_run",
  });
  let failed = false;
  const prompt = vi.fn(async (_content: string, input: { requestId: string }) => ({
    executionId: randomUUID(),
    requestId: input.requestId,
    result: Promise.resolve("done"),
    settled: Promise.resolve(),
  }));
  const close = vi.fn();
  const rootContextId = randomUUID();
  const now = new Date().toISOString();
  const state = ExpertSessionRecordSchema.parse({
    schemaVersion: "pragma.expert-session/v7",
    sessionId: missionId,
    expertId: expert.metadata.id,
    definitionFingerprint: compilation.definitionFingerprint,
    status: "open",
    queuedRequestIds: [],
    executionIds: [],
    rootContextId,
    contexts: {
      [rootContextId]: {
        schemaVersion: "pragma.runtime-context/v5",
        contextId: rootContextId,
        owner: { type: "expert-session", ownerId: missionId },
        origin: { type: "expert-session", sessionId: missionId },
        expert: { id: expert.metadata.id },
        runtime: (await runtimes.bind()).binding,
        lifecycle: "open",
        createdAt: now,
        updatedAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  const session = {
    sessionId: missionId,
    prompt,
    close,
    getState: async () => state,
    getPromptQueue: async () => [],
    getPromptQueueState: async () => ({ state: "idle", pendingCount: 0 }),
  } as unknown as ExpertSession;
  const owners = new MissionExecutionOwner();
  if (!cold)
    owners.setControlOwner(
      missionId,
      {
        kind: "session",
        session,
        executor: {
          descriptor: {
            schemaVersion: "pragma.integration-executor/v1",
            ref,
            name: expert.metadata.name,
            description: expert.metadata.description,
            source: "project",
            project: binding.executor.source === "project" ? binding.executor.project : undefined,
            availability: { status: "ready", blockingCodes: [] },
            workspace: { required: true, allowNonGitDirectory: true },
            capabilities: {
              interactive: true,
              resumable: true,
              steerable: false,
              supportsQueue: false,
            },
          },
          definition: compilation.compiled.value,
          compilation,
        },
      },
      "live",
    );
  const externalOwner = external ? owners.controlOwner(missionId) : undefined;
  if (externalOwner !== undefined) owners.deleteControlOwnerIfCurrent(missionId, externalOwner);
  const catalog = createLocalHostProjectCatalog({
    projectsPath: join(home, "projects"),
    objectsPath: join(home, "objects"),
    projectViewsPath: join(home, "views"),
    pragmaHome: home,
    runtimes,
    reader: compiler.reader,
    compiler,
  });
  const resolveExecutor = vi.fn(async (input: Parameters<typeof catalog.resolve>[0]) =>
    cold || external ? await catalog.resolve(input) : undefined,
  );
  const resume = vi.fn(async () => session);
  const recover = vi.fn(async () => {
    throw new Error("Unexpected recovery.");
  });
  const control = createLocalHostCoreMissionControlAdapter({
    compiler,
    runtimes,
    ownerAccess: owners,
    ...(external ? { resolveActiveOwner: async () => externalOwner } : {}),
    executors: resolveExecutor,
    executions: {
      get: async () => ({ status: failed ? "failed" : "succeeded" }),
    } as unknown as ExecutionStore,
    sessions: {
      get: async () => state,
      listPrompts: async () => [],
    } as unknown as ExpertSessionStore,
    resolveMissionBinding: async () => binding,
    ...(cold
      ? { app: { experts: { resumeSession: resume } } as unknown as PragmaApp }
      : external
        ? {}
        : { recoverActiveOwner: recover }),
  });
  const send = async () =>
    await control.consumer.apply({
      command: MissionCommandSchema.parse({
        schemaVersion: "pragma.mission-command/v2",
        commandId: randomUUID(),
        missionId,
        kind: "send",
        request: {
          schemaVersion: "pragma.integration-request/v1",
          requestId: randomUUID(),
          payloadHash: `sha256:${"a".repeat(64)}`,
          requestedAt: new Date().toISOString(),
          client: { surface: "cli", version: "test", instanceId: randomUUID() },
        },
        payload: { kind: "send", input: { prompt: "Continue" } },
        state: "accepted",
        createdAt: new Date().toISOString(),
      }),
      guard: { claimId: randomUUID(), fencingToken: "1" },
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
  return {
    send,
    compiler,
    owners,
    session,
    missionId,
    authority,
    compileCalls,
    readRevision,
    prompt,
    close,
    acquire,
    canUse,
    resolveExecutor,
    recover,
    resume,
    change: () => activeRevision++,
    remove: () => (missing = true),
    fail: () => (failed = true),
  };
}

describe("retained Node Mission compilation authority", () => {
  it("reads and compiles the pinned Revision once before cold recovery, then hits the same owner cache", async () => {
    const f = await fixture(true);
    f.readRevision.mockClear();
    f.compileCalls.mockClear();
    await f.send();
    expect(f.readRevision).toHaveBeenCalledExactlyOnceWith("studio", 1);
    expect(f.compileCalls).toHaveBeenCalledOnce();
    expect(f.resolveExecutor).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.prompt).toHaveBeenCalledOnce();
    await f.send();
    expect(f.readRevision).toHaveBeenCalledTimes(2);
    expect(f.compileCalls).toHaveBeenCalledOnce();
    expect(f.resolveExecutor).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.prompt).toHaveBeenCalledTimes(2);
  });

  it("preserves cold dependency failures before recovering or accepting a prompt", async () => {
    const f = await fixture(true);
    f.remove();
    await expect(f.send()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "capability_not_found" },
    });
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("rechecks each pinned request while reusing unchanged compilation and Session", async () => {
    const f = await fixture();
    f.readRevision.mockClear();
    f.authority.mockClear();
    await f.send();
    await f.send();
    expect(f.readRevision).toHaveBeenCalledTimes(2);
    expect(f.authority).toHaveBeenCalledTimes(2);
    expect(f.compileCalls).toHaveBeenCalledTimes(1);
    expect(f.canUse).not.toHaveBeenCalled();
    expect(f.prompt).toHaveBeenCalledTimes(2);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.resolveExecutor).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  });

  it("checks an external live owner rather than treating a newly resolved definition as its authority", async () => {
    const f = await fixture(false, true);
    f.change();
    await expect(f.send()).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "executor_environment_changed_requires_successor" },
    });
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.resolveExecutor).not.toHaveBeenCalled();
    expect(f.owners.controlOwner(f.missionId)?.kind).toBe("session");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("rechecks when the actual owner changes after the request preparation check", async () => {
    const f = await fixture();
    const original = f.owners.controlOwner(f.missionId)!;
    const prepare = f.compiler.prepare.bind(f.compiler);
    let replaced = false;
    const check = vi.spyOn(f.compiler, "prepare").mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (!replaced) {
        replaced = true;
        if (original.executor?.compilation === undefined)
          throw new Error("Missing fixture authority.");
        f.owners.setControlOwner(
          f.missionId,
          {
            ...original,
            executor: {
              ...original.executor,
              compilation: {
                ...original.executor.compilation,
                identity: "obsolete",
                capabilities: original.executor.compilation.capabilities.map((capability) => ({
                  ...capability,
                  resolvedRevision: 0,
                })),
              },
            },
          },
          "live",
        );
      }
      return result;
    });
    await expect(f.send()).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "executor_environment_changed_requires_successor" },
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("compiles an authority change and refuses the old Session until successor support exists", async () => {
    const f = await fixture();
    f.change();
    await expect(f.send()).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "executor_environment_changed_requires_successor" },
    });
    expect(f.compileCalls).toHaveBeenCalledTimes(2);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.owners.controlOwner(f.missionId)?.kind).toBe("session");
    await expect(f.session.getState()).resolves.toMatchObject({ sessionId: f.missionId });
  });

  it("preserves dependency diagnostics and never sends with a missing Capability", async () => {
    const f = await fixture();
    f.remove();
    await expect(f.send()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "capability_not_found" },
    });
    expect(f.compileCalls).toHaveBeenCalledTimes(1);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("invalidates readiness after a failed warm turn without blocking prompt acceptance", async () => {
    const f = await fixture();
    const invalidate = vi.spyOn(f.compiler.readiness, "invalidate");
    await f.send();
    await vi.waitFor(() => expect(invalidate).not.toHaveBeenCalled());
    f.fail();
    await f.send();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await f.send();
    expect(f.canUse).toHaveBeenCalledTimes(1);
  });
});
