import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "@pragma/core";

import {
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
  KnowledgeRevisionToolError,
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

    const availableDefinitions = PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.filter(
      ({ name }) => !name.startsWith("skill_revision_"),
    );
    expect(tools).toHaveLength(availableDefinitions.length);
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
    expect(
      tools.map(({ name, description, inputSchema, approval }) => ({
        name,
        description,
        inputSchema,
        approval,
      })),
    ).toEqual(
      availableDefinitions.map(({ name, description, inputSchema, approval }) => ({
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
    const started = await tools[2]!.call(
      { targetRef: target.targetRef, prompt: "Record the retry invariant." },
      undefined,
      context,
    );
    expect(started.isError).not.toBe(true);
    expect(started.details).toEqual(await start());
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

  it.each([
    [new Error("knowledge_revision_mission_unavailable"), "unavailable", false],
    [
      Object.assign(new Error("Stopped revision cannot run"), { code: "invalid_state" }),
      "unavailable",
      false,
    ],
    [Object.assign(new Error("Revision record absent"), { code: "not_found" }), "not_found", false],
    [
      new KnowledgeRevisionToolError("not_found", "knowledge_revision_target_unavailable", false),
      "not_found",
      false,
    ],
    [
      new KnowledgeRevisionToolError(
        "permission_denied",
        "knowledge_revision_target_not_mounted",
        false,
      ),
      "permission_denied",
      false,
    ],
    [
      new KnowledgeRevisionToolError("revision_conflict", "Expected revision differs", true),
      "revision_conflict",
      true,
    ],
  ])("classifies revision errors explicitly: %s", async (error, code, retryable) => {
    const tools = createPragmaManagementTools({
      knowledgeRevisions: revisionPort({
        listTargets: vi.fn(async () => {
          throw error;
        }),
      }),
    });
    const result = await tools[0]!.call({}, undefined, {
      toolCallId: "call",
      runContext: {
        attributes: {
          [EXECUTION_ID_ATTR]: "execution",
          [INVOCATION_ID_ATTR]: "invocation",
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "0000000000000002",
        },
      },
    });
    expect(result).toMatchObject({ isError: true, details: { code, retryable } });
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

  it("returns path-addressed Skill validation feedback to the revision Agent", async () => {
    const validation = {
      passed: false,
      diagnostics: [
        {
          path: "scripts/run.mjs",
          code: "skill_network_access_forbidden",
          message: "Network access is forbidden.",
        },
      ],
    };
    const tools = createPragmaManagementTools({
      skillRevisions: {
        listTargets: vi.fn(),
        listDrafts: vi.fn(),
        start: vi.fn(),
        getDraft: vi.fn(),
        submitDraft: vi.fn(async () => {
          throw Object.assign(new Error("scripts/run.mjs: network access is forbidden"), {
            code: "invalid_input",
            retryable: true,
            validation,
          });
        }),
        discardDraft: vi.fn(),
      },
    });
    const submit = tools.find((tool) => tool.name === "skill_revision_submit_draft")!;

    const response = await submit.call(
      {
        draftId: "10000000-0000-4000-8000-000000000001",
        expectedRevision: 2,
        expectedWorkingTreeHash: "a".repeat(64),
        summary: "Validate the candidate.",
      },
      undefined,
      {
        toolCallId: "call",
        runContext: {
          attributes: {
            [EXECUTION_ID_ATTR]: "execution",
            [INVOCATION_ID_ATTR]: "invocation",
            [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "0000000000sk1rev",
          },
        },
      },
    );

    expect(response).toMatchObject({
      isError: true,
      details: {
        code: "invalid_input",
        retryable: true,
        details: { validation },
        recovery: { tool: "skill_revision_submit_draft" },
      },
    });
  });
});

function revisionPort(overrides: Record<string, unknown> = {}) {
  return {
    listTargets: vi.fn(async () => ({ items: [] })),
    listDrafts: vi.fn(async () => ({ items: [] })),
    start:
      vi.fn<import("../src/pragma-management-tools.ts").KnowledgeRevisionSubmissionPort["start"]>(),
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
