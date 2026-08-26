import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "@pragma/core";

import { createPragmaManagementTools } from "../src/pragma-management-tools.ts";

describe("Pragma management tools", () => {
  it("lists knowledge without approval and requires approval for revision submission", async () => {
    const target = {
      targetRef: "context-store:0000000000000001",
      name: "Shared knowledge",
      description: "Shared engineering guidance.",
      revision: 3,
      mounted: false,
      mounts: [],
    };
    const listTargets = vi.fn(async () => [target]);
    const submit = vi.fn(async () => ({ jobId: "job-1", state: "pending", target }));
    const tools = createPragmaManagementTools({ knowledgeRevisions: { listTargets, submit } });
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
    expect(tools[1]?.approval).toEqual({
      mode: "required",
      reason: "Submit a knowledge-base revision request for user review.",
    });
    await tools[0]!.call({}, undefined, context);
    await tools[1]!.call(
      { targetRef: target.targetRef, prompt: "Record the retry invariant." },
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
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRef: target.targetRef,
        prompt: "Record the retry invariant.",
      }),
    );
  });

  it("fails closed outside an execution tool call", async () => {
    const tools = createPragmaManagementTools({
      knowledgeRevisions: { listTargets: vi.fn(), submit: vi.fn() },
    });
    await expect(tools[0]!.call({}, undefined, { toolCallId: "call-1" })).rejects.toThrow(
      "pragma_management_execution_context_unavailable",
    );
  });
});
