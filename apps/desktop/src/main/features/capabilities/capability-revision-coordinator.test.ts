import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePragmaPathSegment } from "@pragma/core";

import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";

import type { Capability } from "../../../shared/contracts/index.ts";
import { createDesktopCapabilityResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import {
  PragmaProjectStoreError,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import { CapabilityStoreError, type CapabilityStore } from "./capability-store.ts";
import { createCapabilityRevisionCoordinator as createCapabilityRevisionCoordinatorImpl } from "./capability-revision-coordinator.ts";

const CAPABILITY_ID = "751a410b-4f80-4d0f-9db4-0efbe86afea7";
const roots: string[] = [];

const credentials: CapabilityCredentialStore = {
  overlay: () => ({ get: async () => undefined }),
  setMany: async () => undefined,
  prepareMany: async () => undefined,
  activate: async () => undefined,
  finalize: async () => undefined,
  rollback: async () => undefined,
  pending: async () => undefined,
  get: async () => undefined,
  removeCapability: async () => undefined,
  fingerprint: async () => "0".repeat(64),
};

function createCapabilityRevisionCoordinator(
  options: Omit<Parameters<typeof createCapabilityRevisionCoordinatorImpl>[0], "credentials">,
) {
  return createCapabilityRevisionCoordinatorImpl({ ...options, credentials });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("CapabilityRevisionCoordinator", () => {
  it("publishes once and upgrades every current Project and System Expert binding", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search", "read"]);
    const candidate = capability(2, ["search", "read", "write"]);
    const first = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: CAPABILITY_ID,
      revision: 1,
    });
    const second = createDesktopCapabilityResource({
      owner: "default-agent-option",
      capabilityId: CAPABILITY_ID,
      revision: 1,
      name: "Old name",
    });
    const resources: PragmaResource[] = [
      first,
      second,
      expert("expert0000000001", canonicalPragmaResourceRef(first), ["search"]),
      expert("expert0000000002", canonicalPragmaResourceRef(second), ["read"]),
    ];
    const project = fakeProject(resources);
    const system = fakeSystemExpert(["search"]);
    const store = fakeCapabilityStore(candidate);
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: project.store,
      systemExperts: system.registry,
    });
    const commit = vi.fn(async () => candidate);

    await coordinator.publish({ current, candidate, commit });

    expect(commit).toHaveBeenCalledOnce();
    expect(project.publish).toHaveBeenCalledOnce();
    expect(system.upgrade).toHaveBeenCalledWith(CAPABILITY_ID, 2, ["search", "read", "write"]);
    expect(
      project.resources
        .filter((resource) => resource.kind === "Capability")
        .every((resource) => resource.spec.binding?.endsWith(".2") === true),
    ).toBe(true);
    expect(await journalFiles(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("recomputes the Project update after a real revision conflict", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = capability(2, ["search"]);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: CAPABILITY_ID,
      revision: 1,
    });
    const project = fakeProject([binding]);
    project.publish.mockRejectedValueOnce(
      new PragmaProjectStoreError("revision_conflict", "Simulated concurrent Project update."),
    );
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(candidate),
      project: project.store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await coordinator.publish({ current, candidate, commit: async () => candidate });

    expect(project.publish).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("rechecks compatibility after a concurrent Project revision", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search", "read"]);
    const candidate = capability(2, ["search"]);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: CAPABILITY_ID,
      revision: 1,
    });
    const project = fakeProject([binding]);
    project.publish.mockImplementationOnce(async () => {
      project.concurrentUpdate([
        binding,
        expert("expert0000000003", canonicalPragmaResourceRef(binding), ["read"]),
      ]);
      throw new PragmaProjectStoreError("revision_conflict", "Concurrent Project update.");
    });
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(candidate),
      project: project.store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await expect(
      coordinator.publish({ current, candidate, commit: async () => candidate }),
    ).rejects.toMatchObject({ code: "capability_incompatible" });
    expect(project.publish).toHaveBeenCalledOnce();
  });

  it("rejects a stale health result under the Capability lock", async () => {
    const root = await temporaryRoot();
    const candidate = capability(2, ["search"]);
    const commit = vi.fn(async () => candidate);
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: { get: async () => candidate } as unknown as CapabilityStore,
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await expect(
      coordinator.publishHealth({ id: CAPABILITY_ID, expectedRevision: 1, commit }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent updates based on the same revision", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = capability(2, ["search", "read"]);
    let stored = current;
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: {
        get: async () => stored,
        discardUnpublishedRevision: async () => false,
      } as unknown as CapabilityStore,
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
    });
    const mutation = () =>
      coordinator.publish({
        current,
        candidate,
        commit: async () => {
          stored = candidate;
          return candidate;
        },
      });

    const results = await Promise.allSettled([mutation(), mutation()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "revision_conflict" }) }),
    ]);
    expect(stored.manifest.latestRevision).toBe(2);
  });

  it("blocks removed selected tools before committing any revision", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search", "read"]);
    const candidate = capability(2, ["search"]);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: CAPABILITY_ID,
      revision: 1,
    });
    const project = fakeProject([
      binding,
      expert("expert0000000001", canonicalPragmaResourceRef(binding), ["read"]),
    ]);
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(candidate),
      project: project.store,
      systemExperts: fakeSystemExpert([]).registry,
    });
    const commit = vi.fn(async () => candidate);

    await expect(coordinator.publish({ current, candidate, commit })).rejects.toMatchObject({
      code: "capability_incompatible",
    } satisfies Partial<CapabilityStoreError>);
    expect(commit).not.toHaveBeenCalled();
    expect(project.publish).not.toHaveBeenCalled();
    expect(await journalFiles(root)).toEqual([]);
  });

  it("does not activate a needs-attention revision", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = {
      ...capability(2, ["search"]),
      health: { ...current.health, revision: 2, status: "needs_attention" as const },
    };
    const project = fakeProject([]);
    const system = fakeSystemExpert([]);
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(candidate),
      project: project.store,
      systemExperts: system.registry,
    });
    const commit = vi.fn(async () => candidate);

    await coordinator.publish({ current, candidate, commit });

    expect(commit).toHaveBeenCalledOnce();
    expect(project.publish).not.toHaveBeenCalled();
    expect(system.upgrade).not.toHaveBeenCalled();
  });

  it("replays a journal after Project propagation without creating another Project revision", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = capability(2, ["search"]);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: CAPABILITY_ID,
      revision: 1,
    });
    const project = fakeProject([binding]);
    const failingSystem = fakeSystemExpert([]);
    failingSystem.upgrade.mockRejectedValueOnce(new Error("simulated crash"));
    const store = fakeCapabilityStore(candidate);
    const first = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: project.store,
      systemExperts: failingSystem.registry,
    });

    await expect(
      first.publish({ current, candidate, commit: async () => candidate }),
    ).rejects.toThrow("simulated crash");
    expect(project.publish).toHaveBeenCalledOnce();
    expect(await journalFiles(root)).toHaveLength(1);

    const recoveredSystem = fakeSystemExpert([]);
    await createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: project.store,
      systemExperts: recoveredSystem.registry,
    }).recover();

    expect(project.publish).toHaveBeenCalledOnce();
    expect(recoveredSystem.upgrade).toHaveBeenCalledWith(CAPABILITY_ID, 2, ["search"]);
    expect(await journalFiles(root)).toEqual([]);
  });

  it("discards an unpublished payload when a crash happens before Capability commit", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = capability(2, ["search"]);
    const discard = vi.fn(async () => true);
    const store = {
      get: async () => current,
      discardUnpublishedRevision: discard,
    } as unknown as CapabilityStore;
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await expect(
      coordinator.publish({
        current,
        candidate,
        commit: async () => {
          throw new Error("simulated pre-commit crash");
        },
      }),
    ).rejects.toThrow("simulated pre-commit crash");
    expect(await journalFiles(root)).toHaveLength(1);

    await coordinator.recover();

    expect(discard).toHaveBeenCalledWith(CAPABILITY_ID, 2, current.health);
    expect(await journalFiles(root)).toEqual([]);
  });

  it("rolls back prepared credentials when Capability commit never becomes visible", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const candidate = capability(2, ["search"]);
    const prepared = {
      mutationId: "00000000-0000-4000-8000-000000000201",
      capabilityId: CAPABILITY_ID,
      previousRefs: [],
      nextRefs: [],
    };
    let pending = true;
    const rollback = vi.fn(async () => {
      pending = false;
    });
    const credentialStore: CapabilityCredentialStore = {
      ...credentials,
      prepareMany: async () => prepared,
      pending: async () => (pending ? prepared : undefined),
      rollback,
    };
    const discard = vi.fn(async () => true);
    const store = {
      get: async () => current,
      discardUnpublishedRevision: discard,
    } as unknown as CapabilityStore;
    const coordinator = createCapabilityRevisionCoordinatorImpl({
      journalRoot: root,
      capabilities: store,
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
      credentials: credentialStore,
    });

    await expect(
      coordinator.publish({
        current,
        candidate,
        prepareCredentials: async () => await credentialStore.prepareMany(CAPABILITY_ID, {}),
        commit: async () => {
          throw new Error("simulated storage failure");
        },
      }),
    ).rejects.toThrow("simulated storage failure");

    await coordinator.recover();

    expect(rollback).toHaveBeenCalledWith(prepared);
    expect(pending).toBe(false);
    expect(await journalFiles(root)).toEqual([]);
  });

  it("replays an interrupted deletion from the coordinator journal root", async () => {
    const root = await temporaryRoot();
    const current = capability(1, ["search"]);
    const completeRemoval = vi.fn(async () => undefined);
    const store = {
      get: async () => current,
      completeRemoval,
    } as unknown as CapabilityStore;
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await expect(
      coordinator.mutate({
        id: CAPABILITY_ID,
        expectedRevision: 1,
        mutationType: "delete",
        commit: async () => {
          throw new Error("simulated deletion crash");
        },
      }),
    ).rejects.toThrow("simulated deletion crash");

    await coordinator.recover();

    expect(completeRemoval).toHaveBeenCalledWith(CAPABILITY_ID, 1);
    expect(await journalFiles(root)).toEqual([]);
  });

  it("upgrades and replays a historical v1 journal fixture", async () => {
    const root = await temporaryRoot();
    const directory = join(root, encodePragmaPathSegment(CAPABILITY_ID));
    await mkdir(directory, { recursive: true });
    const fixture = await readFile(
      new URL("./fixtures/capability-revision-propagation-v1.json", import.meta.url),
      "utf8",
    );
    await writeFile(join(directory, "2.json"), fixture);
    const system = fakeSystemExpert([]);

    await createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(capability(2, ["search"])),
      project: fakeProject([]).store,
      systemExperts: system.registry,
    }).recover();

    expect(system.upgrade).toHaveBeenCalledWith(CAPABILITY_ID, 2, ["search"]);
    expect(await journalFiles(root)).toEqual([]);
  });

  it("fails closed and reports a future mutation journal version", async () => {
    const root = await temporaryRoot();
    const directory = join(root, encodePragmaPathSegment(CAPABILITY_ID));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "2.json"),
      `${JSON.stringify({ schemaVersion: "pragma.capability-mutation/v99" })}\n`,
    );
    const warn = vi.fn();

    await createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(capability(2, ["search"])),
      project: fakeProject([]).store,
      systemExperts: fakeSystemExpert([]).registry,
      warn,
    }).recover();

    expect(warn).toHaveBeenCalledWith(
      "Capability revision propagation could not be recovered.",
      expect.anything(),
    );
    expect(await journalFiles(root)).toEqual([`${encodePragmaPathSegment(CAPABILITY_ID)}/2.json`]);
  });
});

function capability(revision: number, tools: string[]): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v2",
      id: CAPABILITY_ID,
      runtimeKey: "search",
      name: `Search ${revision}`,
      kind: "mcp_server",
      latestRevision: revision,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    definition: {
      kind: "mcp_server",
      name: `Search ${revision}`,
      description: "Search",
      connection: { transport: "stdio", command: "search", args: [], env: {}, secretEnv: {} },
      timeoutMs: 30_000,
      tools: tools.map((name) => ({ name, schemaHash: "0".repeat(64) })),
    },
    health: {
      revision,
      status: "ready",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function expert(id: string, capabilityRef: string, tools: string[]): PragmaResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id,
      avatarId: "pragma.avatar.expert.default",
      name: id,
      description: "Expert",
      tags: [],
    },
    spec: {
      scope: "all",
      instructions: "Use tools",
      capabilities: [{ ref: capabilityRef, kind: "tools", tools }],
      toolApprovals: {},
      plugins: [],
      contextStores: [],
      tools: [],
    },
  };
}

function fakeProject(initial: PragmaResource[]) {
  let revision = 1;
  const state = { resources: structuredClone(initial) };
  const publish = vi.fn(async (input: { resources: readonly PragmaResource[] }) => {
    state.resources = structuredClone([...input.resources]);
    revision += 1;
    return { revision, resources: state.resources };
  });
  return {
    get resources() {
      return state.resources;
    },
    publish,
    concurrentUpdate(resources: readonly PragmaResource[]) {
      state.resources = structuredClone([...resources]);
      revision += 1;
    },
    store: {
      get: async () => ({ revision, resources: state.resources }),
      publish,
    } as unknown as PragmaProjectStore,
  };
}

function fakeSystemExpert(selectedTools: string[]) {
  const upgrade = vi.fn(async () => true);
  return {
    upgrade,
    registry: {
      list: () => [{ ref: "expert:pragma", name: "Pragma" }],
      get: () => ({
        capabilities:
          selectedTools.length === 0
            ? []
            : [
                {
                  kind: "tools",
                  capabilityId: CAPABILITY_ID,
                  revision: 1,
                  toolNames: selectedTools,
                },
              ],
      }),
      validateAndUpgradeCapabilityRevision: upgrade,
    } as unknown as DesktopSystemExpertRegistry,
  };
}

function fakeCapabilityStore(candidate: Capability): CapabilityStore {
  let firstRead = true;
  return {
    get: async () => {
      if (!firstRead) return candidate;
      firstRead = false;
      return {
        ...candidate,
        manifest: {
          ...candidate.manifest,
          latestRevision: Math.max(1, candidate.manifest.latestRevision - 1),
        },
        health: {
          ...candidate.health,
          revision: Math.max(1, candidate.health.revision - 1),
        },
      };
    },
  } as unknown as CapabilityStore;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-capability-revision-"));
  roots.push(root);
  return root;
}

async function journalFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const directory of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory()) continue;
    for (const file of await readdir(join(root, directory.name))) {
      if (file.endsWith(".json")) result.push(join(directory.name, file));
    }
  }
  return result;
}
