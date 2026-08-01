import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";

import type { Capability } from "../../../shared/contracts/index.ts";
import { createDesktopCapabilityResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import {
  PragmaProjectStoreError,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import { CapabilityStoreError, type CapabilityStore } from "./capability-store.ts";
import { createCapabilityRevisionCoordinator } from "./capability-revision-coordinator.ts";

const CAPABILITY_ID = "751a410b-4f80-4d0f-9db4-0efbe86afea7";
const roots: string[] = [];

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
    expect(project.apply).toHaveBeenCalledOnce();
    expect(system.upgrade).toHaveBeenCalledWith(CAPABILITY_ID, 2);
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
    project.apply.mockRejectedValueOnce(
      new PragmaProjectStoreError("revision_conflict", "Simulated concurrent Project update."),
    );
    const coordinator = createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: fakeCapabilityStore(candidate),
      project: project.store,
      systemExperts: fakeSystemExpert([]).registry,
    });

    await coordinator.publish({ current, candidate, commit: async () => candidate });

    expect(project.apply).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
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
    expect(project.apply).not.toHaveBeenCalled();
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
    expect(project.apply).not.toHaveBeenCalled();
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
    expect(project.apply).toHaveBeenCalledOnce();
    expect(await journalFiles(root)).toHaveLength(1);

    const recoveredSystem = fakeSystemExpert([]);
    await createCapabilityRevisionCoordinator({
      journalRoot: root,
      capabilities: store,
      project: project.store,
      systemExperts: recoveredSystem.registry,
    }).recover();

    expect(project.apply).toHaveBeenCalledOnce();
    expect(recoveredSystem.upgrade).toHaveBeenCalledWith(CAPABILITY_ID, 2);
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
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: { id, name: id, description: "Expert", tags: [] },
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
  const apply = vi.fn(async (input: { upserts?: readonly PragmaResource[] }) => {
    const byRef = new Map(
      state.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
    );
    for (const resource of input.upserts ?? [])
      byRef.set(canonicalPragmaResourceRef(resource), resource);
    state.resources = [...byRef.values()];
    revision += 1;
    return { revision, resources: state.resources };
  });
  return {
    get resources() {
      return state.resources;
    },
    apply,
    store: {
      get: async () => ({ revision, resources: state.resources }),
      apply,
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
      upgradeCapabilityRevision: upgrade,
    } as unknown as DesktopSystemExpertRegistry,
  };
}

function fakeCapabilityStore(candidate: Capability): CapabilityStore {
  return {
    get: async () => candidate,
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
