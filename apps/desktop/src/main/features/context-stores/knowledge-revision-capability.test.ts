import { describe, expect, it, vi } from "vitest";
import { PragmaExpertResourceSchema } from "@pragma/interpreter/ast";

import { createDesktopContextResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "./knowledge-revision-capability.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

const TEAM_ID = "0000000000000001";
const EXPERT_ID = "0000000000000002";
const STORE_ID = "00000000-0000-4000-8000-000000000201";
const UNMOUNTED_STORE_ID = "00000000-0000-4000-8000-000000000202";

function fixture() {
  const contextResource = createDesktopContextResource({
    owner: "project-expert",
    storeId: STORE_ID,
  });
  const systemContextResource = createDesktopContextResource({
    owner: "system-expert-customization",
    storeId: STORE_ID,
  });
  const targetRef = `context-store:${contextResource.metadata.id}`;
  const expert = {
    apiVersion: "pragma/v5",
    kind: "Expert",
    metadata: { id: EXPERT_ID, name: "Reflector", description: "", tags: [] },
    spec: {
      scope: "Reflect",
      instructions: "Reflect",
      capabilities: [],
      toolApprovals: {},
      contextStores: [{ ref: targetRef, namespace: "private-knowledge", required: false }],
      plugins: [],
      tools: [],
    },
  } as const;
  const team = {
    apiVersion: "pragma/v5",
    kind: "ExpertTeam",
    metadata: { id: TEAM_ID, name: "Reflection team", description: "", tags: [] },
    spec: {
      coordinator: { ref: `expert:${EXPERT_ID}` },
      members: [{ ref: "expert:0000000000000003" }],
      contextStores: [
        {
          ref: targetRef,
          namespace: "team-knowledge",
          required: true,
          visibility: { mode: "whitelist", expertIds: [EXPERT_ID] },
        },
      ],
      delegation: { permissions: { interact: {} }, maxConcurrency: 2, maxDepth: 2, runtimes: {} },
    },
  } as const;
  const systemExpert = PragmaExpertResourceSchema.parse({
    ...expert,
    metadata: {
      ...expert.metadata,
      id: "0000000000000004",
      name: "Pragma",
      description: "Built-in expert",
      avatarId: "pragma.avatar.expert.default",
    },
    spec: {
      ...expert.spec,
      contextStores: [
        {
          ref: `context-store:${systemContextResource.metadata.id}`,
          namespace: "system-knowledge",
          required: true,
        },
      ],
    },
  });
  const project = {
    get: vi.fn(async () => ({ resources: [expert, team, contextResource] })),
  } as unknown as PragmaProjectStore;
  const contextStores = {
    list: vi.fn(async () => [
      {
        id: STORE_ID,
        name: "Team knowledge",
        description: "Shared engineering invariants.",
        contentRevision: 4,
      },
      {
        id: UNMOUNTED_STORE_ID,
        name: "Unattached knowledge",
        description: "Available but not mounted.",
        contentRevision: 2,
      },
    ]),
  } as unknown as ContextStoreStore;
  const submit = vi.fn(async (request) => ({ id: "job-1", state: "pending", request }));
  const scheduleProcessing = vi.fn();
  const revisions = { submit, scheduleProcessing } as unknown as ContextStoreRevisionService;
  return {
    port: createDesktopKnowledgeRevisionSubmissionPort({
      project,
      contextStores,
      revisions,
      additionalMountResources: () => [systemExpert, systemContextResource],
    }),
    submit,
    scheduleProcessing,
    targetRef,
  };
}

const invocation = {
  executionId: "execution-1",
  invocationId: "invocation-1",
  expertId: EXPERT_ID,
  operationId: "call-1",
};

describe("Desktop Pragma management knowledge revision tools", () => {
  it("lists every knowledge base with descriptions and current Expert or Team mounts", async () => {
    const { port, targetRef } = fixture();

    await expect(port.listTargets(invocation)).resolves.toEqual([
      {
        targetRef,
        name: "Team knowledge",
        description: "Shared engineering invariants.",
        revision: 4,
        mounted: true,
        mounts: [
          {
            ownerKind: "expert",
            ownerRef: `expert:${EXPERT_ID}`,
            ownerName: "Reflector",
            namespace: "private-knowledge",
            required: false,
          },
          {
            ownerKind: "team",
            ownerRef: `team:${TEAM_ID}`,
            ownerName: "Reflection team",
            namespace: "team-knowledge",
            required: true,
            visibility: { mode: "whitelist", expertIds: [EXPERT_ID] },
          },
          {
            ownerKind: "expert",
            ownerRef: "expert:0000000000000004",
            ownerName: "Pragma",
            namespace: "system-knowledge",
            required: true,
          },
        ],
      },
      expect.objectContaining({
        name: "Unattached knowledge",
        description: "Available but not mounted.",
        revision: 2,
        mounted: false,
        mounts: [],
      }),
    ]);
  });

  it("submits to any listed target and records Team provenance when applicable", async () => {
    const { port, submit, scheduleProcessing } = fixture();
    const unmounted = (await port.listTargets(invocation)).find(
      (target) => target.name === "Unattached knowledge",
    )!;

    await port.submit({
      ...invocation,
      teamId: TEAM_ID,
      targetRef: unmounted.targetRef,
      prompt: "Record invariant",
    });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: UNMOUNTED_STORE_ID,
        source: "expert-reflection",
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        provenance: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          expertId: EXPERT_ID,
          teamId: TEAM_ID,
        },
      }),
    );
    expect(scheduleProcessing).toHaveBeenCalledOnce();
  });

  it("supports standalone Experts and rejects targets that are not in the current store list", async () => {
    const { port, submit } = fixture();
    const unmounted = (await port.listTargets(invocation)).find(
      (target) => target.name === "Unattached knowledge",
    )!;

    await expect(
      port.submit({
        ...invocation,
        targetRef: "context-store:0000000000000999",
        prompt: "No",
      }),
    ).rejects.toThrow("knowledge_revision_target_unavailable");
    await port.submit({
      ...invocation,
      targetRef: unmounted.targetRef,
      prompt: "Record invariant",
    });
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provenance: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          expertId: EXPERT_ID,
        },
      }),
    );
  });
});
