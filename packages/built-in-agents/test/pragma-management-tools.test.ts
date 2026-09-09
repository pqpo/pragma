import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "@pragma/core";

import {
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
  createPragmaManagementTools,
} from "../src/pragma-management-tools.ts";

describe("Pragma management tools", () => {
  it("combines Host and knowledge tools through one factory", () => {
    const tools = createPragmaManagementTools({
      project: definitionOnlyPort(),
      missions: definitionOnlyPort(),
      automations: definitionOnlyPort(),
      knowledgeRevisions: revisionPort(),
    });

    expect(tools).toHaveLength(PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.length);
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
    expect(
      tools.map(({ name, description, inputSchema, approval }) => ({
        name,
        description,
        inputSchema,
        approval,
      })),
    ).toEqual(
      PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(({ name, description, inputSchema, approval }) => ({
        name,
        description,
        inputSchema,
        approval,
      })),
    );
  });

  it("rejects partial Host port groups instead of silently dropping tools", () => {
    expect(() => createPragmaManagementTools({ project: definitionOnlyPort() })).toThrow(
      "must be provided together",
    );
    expect(() => createPragmaManagementTools({ automations: definitionOnlyPort() })).toThrow(
      "must be provided together",
    );
  });

  it("lists knowledge without approval and requires approval for starting or discarding a draft", async () => {
    const target = {
      targetRef: "context-store:0000000000000001",
      name: "Shared knowledge",
      description: "Shared engineering guidance.",
      revision: 3,
      mounted: false,
      mounts: [],
    };
    const listTargets = vi.fn(async () => ({ items: [target] }));
    const start = vi.fn(async () => ({
      jobId: "00000000-0000-4000-8000-000000000302",
      draftId: "00000000-0000-4000-8000-000000000303",
      state: "editing",
      target,
    }));
    const discardDraft = vi.fn(async (input: { readonly draftId: string }) => ({
      draftId: input.draftId,
      discarded: true as const,
    }));
    const tools = createPragmaManagementTools({
      knowledgeRevisions: revisionPort({ listTargets, start, discardDraft }),
    });
    const context = {
      toolCallId: "call-1",
      runContext: {
        attributes: {
          [EXECUTION_ID_ATTR]: "execution-1",
          [INVOCATION_ID_ATTR]: "invocation-1",
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "0000000000000002",
          [EXECUTION_CURRENT_TEAM_ID_ATTR]: "0000000000000003",
        },
      },
    };

    expect(tools[0]?.approval).toEqual({ mode: "none" });
    expect(tools[2]?.approval).toEqual({
      mode: "required",
      reason: "Start a managed knowledge revision Mission.",
    });
    expect(
      tools.find((tool) => tool.name === "knowledge_revision_discard_draft")?.approval,
    ).toEqual({
      mode: "required",
      reason: "Discard this knowledge draft and reject its unfinished revision Mission.",
    });
    await tools[0]!.call({}, undefined, context);
    await tools[2]!.call(
      { targetRef: target.targetRef, prompt: "Record the retry invariant." },
      undefined,
      context,
    );
    await tools
      .find((tool) => tool.name === "knowledge_revision_discard_draft")!
      .call(
        {
          draftId: "00000000-0000-4000-8000-000000000301",
          expectedRevision: 5,
        },
        undefined,
        context,
      );

    expect(listTargets).toHaveBeenCalledWith({
      executionId: "execution-1",
      invocationId: "invocation-1",
      expertId: "0000000000000002",
      teamId: "0000000000000003",
      operationId: "call-1",
      limit: 25,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRef: target.targetRef,
        prompt: "Record the retry invariant.",
      }),
    );
    expect(discardDraft).toHaveBeenCalledWith({
      executionId: "execution-1",
      invocationId: "invocation-1",
      expertId: "0000000000000002",
      teamId: "0000000000000003",
      operationId: "call-1",
      draftId: "00000000-0000-4000-8000-000000000301",
      expectedRevision: 5,
    });
  });

  it("fails closed outside an execution tool call", async () => {
    const tools = createPragmaManagementTools({
      knowledgeRevisions: revisionPort(),
    });
    await expect(tools[0]!.call({}, undefined, { toolCallId: "call-1" })).resolves.toMatchObject({
      isError: true,
      details: { code: "unavailable", retryable: false },
    });
  });
});

function revisionPort(overrides: Record<string, unknown> = {}) {
  return {
    listTargets: vi.fn(async () => ({ items: [] })),
    listDrafts: vi.fn(async () => ({ items: [] })),
    start: vi.fn(async () => ({})),
    getDraft: vi.fn(),
    inspectRebase: vi.fn(),
    getRebaseConflict: vi.fn(),
    rebase: vi.fn(),
    submitDraft: vi.fn(),
    discardDraft: vi.fn(),
    ...overrides,
  };
}

function definitionOnlyPort() {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as never;
}
