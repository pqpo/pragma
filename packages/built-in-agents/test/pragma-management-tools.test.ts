import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "@pragma/core";

import { createPragmaManagementTools } from "../src/pragma-management-tools.ts";

describe("Pragma management tools", () => {
  it("lists knowledge without approval and requires approval for starting or discarding a draft", async () => {
    const target = {
      targetRef: "context-store:0000000000000001",
      name: "Shared knowledge",
      description: "Shared engineering guidance.",
      revision: 3,
      mounted: false,
      mounts: [],
    };
    const listTargets = vi.fn(async () => [target]);
    const start = vi.fn(async () => ({ jobId: "job-1", state: "editing", target }));
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
      reason: "Start a managed knowledge revision task.",
    });
    expect(tools[7]?.approval).toEqual({
      mode: "required",
      reason: "Discard this knowledge draft and reject its unfinished revision task.",
    });
    await tools[0]!.call({}, undefined, context);
    await tools[2]!.call(
      { targetRef: target.targetRef, prompt: "Record the retry invariant." },
      undefined,
      context,
    );
    await tools[7]!.call(
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
    await expect(tools[0]!.call({}, undefined, { toolCallId: "call-1" })).rejects.toThrow(
      "pragma_management_execution_context_unavailable",
    );
  });
});

function revisionPort(overrides: Record<string, unknown> = {}) {
  return {
    listTargets: vi.fn(async () => []),
    listDrafts: vi.fn(async () => []),
    start: vi.fn(async () => ({})),
    getDraft: vi.fn(),
    inspectRebase: vi.fn(),
    rebase: vi.fn(),
    submitDraft: vi.fn(),
    discardDraft: vi.fn(),
    ...overrides,
  };
}
