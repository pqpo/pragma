import { StaticContextStore } from "@pragma/core";
import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import { describe, expect, it, vi } from "vitest";

import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createExpertMemoryContextStoreBrowserService } from "./expert-memory-context-store-browser.ts";

const expertResource: PragmaExpertResource = {
  apiVersion: "pragma/v5",
  kind: "Expert",
  metadata: {
    id: "1xddvess309a6gme",
    avatarId: "pragma.avatar.expert.default",
    name: "Writer",
    description: "Writer",
    tags: [],
  },
  spec: {
    scope: "Writer",
    instructions: "Writer instructions",
    capabilities: [],
    toolApprovals: {},
    contextStores: [],
    plugins: [],
    tools: [],
  },
};

describe("ExpertMemoryContextStoreBrowserService", () => {
  it("exposes the selected Expert's read-only memory view", async () => {
    const getContextStoreViewStatus = vi.fn(async () => "available" as const);
    const createContextStoreView = vi.fn(
      async () =>
        new StaticContextStore([
          {
            id: "overview.md",
            content: "# Overview\nWriter memory",
            metadata: { trigger: "always_on", priority: "high" },
          },
        ]),
    );
    const service = createExpertMemoryContextStoreBrowserService({
      project: {
        projectId: "pragma",
        get: vi.fn(async () => ({ resources: [expertResource] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: vi.fn(() => undefined),
      } as unknown as Pick<DesktopSystemExpertRegistry, "getResource">,
      memory: {
        getContextStoreViewStatus,
        createContextStoreView,
      } as unknown as DesktopMemoryPlane,
    });

    const descriptor = await service.get({ expertRef: "expert:1xddvess309a6gme" });
    expect(descriptor).toMatchObject({
      storeId: "memory",
      readOnly: true,
      searchable: true,
      hasMemory: true,
      root: { type: "pragma.expert", id: expertResource.metadata.id, name: "Writer" },
      scopes: [
        {
          id: "expert:1xddvess309a6gme",
          expertId: expertResource.metadata.id,
          role: "root",
          availability: "available",
        },
      ],
    });
    expect(getContextStoreViewStatus).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert", id: expertResource.metadata.id },
      expertRef: { type: "pragma.expert", id: expertResource.metadata.id },
      projectId: "pragma",
    });

    await service.list({
      expertRef: "expert:1xddvess309a6gme",
      scopeId: "expert:1xddvess309a6gme",
    });
    expect(createContextStoreView).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert", id: expertResource.metadata.id },
      expertRef: { type: "pragma.expert", id: expertResource.metadata.id },
      projectId: "pragma",
    });
  });

  it("rejects an Expert that is not part of the active project or system registry", async () => {
    const service = createExpertMemoryContextStoreBrowserService({
      project: {
        projectId: "pragma",
        get: vi.fn(async () => ({ resources: [] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: vi.fn(() => undefined),
      } as unknown as Pick<DesktopSystemExpertRegistry, "getResource">,
      memory: {
        getContextStoreViewStatus: vi.fn(async () => "empty" as const),
        createContextStoreView: vi.fn(async () => new StaticContextStore()),
      } as unknown as DesktopMemoryPlane,
    });

    await expect(service.get({ expertRef: "expert:1xddvess309a6gme" })).rejects.toMatchObject({
      code: "expert_not_found",
    });
  });
});
