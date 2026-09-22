import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import type {
  PragmaAgentAutomationPort,
  PragmaAgentDslProjectPort,
  PragmaAgentMissionPort,
} from "../src/ports.ts";
import {
  PragmaAgentDslValueSummarySchema,
  PragmaAgentEvaluationDraftSchema,
  PragmaAgentFlowDraftSchema,
} from "../src/contracts.ts";
import { createPragmaManagementTools } from "../src/pragma-management-tools.ts";

describe("Pragma Host management tools", () => {
  it("counts bounded DSL value previews by Unicode character", () => {
    expect(
      PragmaAgentDslValueSummarySchema.parse({
        type: "string",
        preview: "😀".repeat(80),
        size: 80,
      }),
    ).toMatchObject({ preview: "😀".repeat(80) });
    expect(
      PragmaAgentDslValueSummarySchema.safeParse({
        type: "string",
        preview: "😀".repeat(81),
        size: 81,
      }).success,
    ).toBe(false);
  });

  it("injects Mission ownership into DSL file-draft tools without exposing paths in input", async () => {
    let received: Parameters<PragmaAgentDslProjectPort["startDslDraft"]>[0] | undefined;
    const project = projectPort({
      async startDslDraft(input) {
        received = input;
        throw new Error("captured");
      },
    });
    const tools = createPragmaManagementTools(
      { project, missions: missionPort() },
      {
        missionId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
        workspacePath: "/workspace/project",
      },
    );
    const start = tools.find((tool) => tool.name === "start_dsl_draft")!;
    expect(JSON.stringify(start.inputSchema)).not.toContain("missionId");
    expect(JSON.stringify(start.inputSchema)).not.toContain("workspacePath");
    await start.call(
      { targets: [{ mode: "edit", ref: "expert:1h2j3k4m5n6p7q8r" }] },
      undefined,
      undefined,
    );
    expect(received).toEqual({
      missionId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
      workspacePath: "/workspace/project",
      targets: [{ mode: "edit", ref: "expert:1h2j3k4m5n6p7q8r" }],
    });
  });

  it("keeps read tools open and gates durable writes", async () => {
    const tools = createPragmaManagementTools({ project: projectPort(), missions: missionPort() });
    expect(tools.find((tool) => tool.name === "list_dsl_resources")?.approval?.mode).toBe("none");
    expect(tools.find((tool) => tool.name === "list_expert_options")?.approval?.mode).toBe("none");
    expect(tools.find((tool) => tool.name === "commit_dsl_changes")?.approval?.mode).toBe(
      "required",
    );
    expect(tools.find((tool) => tool.name === "create_mission")?.approval?.mode).toBe("required");
    expect(tools.find((tool) => tool.name === "interrupt_mission")?.approval?.mode).toBe("none");
  });

  it("requires Expert and ExpertTeam changes to use Mission-owned file drafts", async () => {
    let prepareCalls = 0;
    const project = projectPort({
      async prepare() {
        prepareCalls += 1;
        throw new Error("must not be called");
      },
    });
    const tool = createPragmaManagementTools({ project, missions: missionPort() }).find(
      (candidate) => candidate.name === "prepare_dsl_changes",
    )!;

    await expect(
      tool.call({ expectedProjectRevision: 0, sources: ["kind: Expert\n"] }, undefined, undefined),
    ).resolves.toMatchObject({
      details: {
        status: "invalid",
        diagnostics: [expect.objectContaining({ code: "dsl.file_draft_required" })],
      },
    });
    expect(prepareCalls).toBe(0);
  });

  it("returns the bounded draft review without returning prepared YAML", async () => {
    const project = projectPort({
      async prepareDslDraft() {
        return {
          status: "prepared",
          changeSet: {
            changeSetId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
            projectRevision: 3,
            diagnostics: [
              {
                severity: "warning",
                code: "full.warning",
                message: "Only the compact review diagnostic should be returned.",
                path: [],
              },
            ],
            changes: [
              {
                ref: "expert:1h2j3k4m5n6p7q8r",
                kind: "updated",
                source: `kind: Expert\nspec:\n  instructions: ${"private-long-source".repeat(100)}\n`,
              },
            ],
            review: compactDraftReview(),
            createdAt: "2026-09-22T00:00:00.000Z",
          },
        };
      },
    });
    const tool = createPragmaManagementTools(
      { project, missions: missionPort() },
      {
        missionId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
        workspacePath: "/workspace/project",
      },
    ).find((candidate) => candidate.name === "prepare_dsl_draft")!;

    const result = await tool.call(
      { draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b" },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({
      status: "prepared",
      changeSet: {
        review: { unknownFieldPolicy: "preserve-additive" },
        diagnostics: [{ code: "compact.warning" }],
        changes: [
          {
            ref: "expert:1h2j3k4m5n6p7q8r",
            kind: "updated",
            sizeBytes: expect.any(Number),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ],
      },
    });
    expect(result.text).not.toContain("private-long-source");
  });

  it("injects the runtime toolCallId as the write operation id", async () => {
    let operationId = "";
    const project = projectPort({
      async commit(input) {
        operationId = input.operationId;
        return { projectId: "studio", projectRevision: 2, changedRefs: [] };
      },
    });
    const tool = createPragmaManagementTools({ project, missions: missionPort() }).find(
      (candidate) => candidate.name === "commit_dsl_changes",
    )!;
    await tool.call({ changeSetId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b" }, undefined, {
      toolCallId: "runtime-call-7",
    });
    expect(operationId).toBe("runtime-call-7");
  });

  it("carries the active Mission into prepared change reads and commits", async () => {
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    let readMissionId: string | undefined;
    let commitMissionId: string | undefined;
    const changeSetId = "4fc96ef9-1825-447d-a17f-d820f6fd4855";
    const project = projectPort({
      async getChangeSet(_changeSetId, receivedMissionId) {
        readMissionId = receivedMissionId;
        return {
          changeSetId,
          projectRevision: 1,
          diagnostics: [],
          changes: [
            {
              ref: "expert:1h2j3k4m5n6p7q8r",
              kind: "updated",
              source: "kind: Expert\n",
            },
          ],
          createdAt: "2026-09-22T00:00:00.000Z",
        };
      },
      async commit(input) {
        commitMissionId = input.missionId;
        return { projectId: "studio", projectRevision: 2, changedRefs: [] };
      },
    });
    const tools = createPragmaManagementTools(
      { project, missions: missionPort() },
      { missionId, workspacePath: "/workspace/project" },
    );

    await tools
      .find((candidate) => candidate.name === "read_prepared_dsl_change")!
      .call(
        { changeSetId, ref: "expert:1h2j3k4m5n6p7q8r", offset: 0, limitChars: 100 },
        undefined,
        undefined,
      );
    await tools
      .find((candidate) => candidate.name === "commit_dsl_changes")!
      .call({ changeSetId }, undefined, { toolCallId: "scoped-commit" });

    expect(readMissionId).toBe(missionId);
    expect(commitMissionId).toBe(missionId);
  });

  it("replaces complete Evaluation YAML with bounded draft tools", async () => {
    const project = projectPort({
      async runEvaluationDraft() {
        return {} as never;
      },
    });
    const tools = createPragmaManagementTools({ project, missions: missionPort() });
    expect(tools.some((candidate) => candidate.name === "run_evaluation")).toBe(false);
    const tool = tools.find((candidate) => candidate.name === "run_evaluation_draft")!;

    await expect(
      tool.call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          caseIds: ["case-1"],
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    await expect(
      tool.call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          caseIds: Array.from({ length: 11 }, (_, index) => `case-${index}`),
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
  });

  it("exposes independent Flow and Evaluation prepare-and-save paths", () => {
    const tools = createPragmaManagementTools({ project: projectPort(), missions: missionPort() });
    const createEvaluation = tools.find(
      (candidate) => candidate.name === "create_evaluation_draft",
    )!;
    const prepareFlow = tools.find((candidate) => candidate.name === "prepare_flow_draft")!;
    const prepareEvaluation = tools.find(
      (candidate) => candidate.name === "prepare_evaluation_draft",
    )!;

    expect(JSON.stringify(createEvaluation.inputSchema)).not.toContain("targetFlowDraftId");
    expect(createEvaluation.inputSchema).toMatchObject({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["create", "edit"] },
        expectedProjectRevision: { type: "integer", minimum: 0 },
        metadata: { type: "object" },
        targetRef: { type: "string" },
        evaluationRef: { type: "string" },
      },
      required: ["mode", "expectedProjectRevision"],
      additionalProperties: false,
    });
    expect(createEvaluation.description).toContain("committed Flow");
    expect(createEvaluation.description).not.toContain("uncommitted Flow");
    expect(JSON.stringify(prepareFlow.inputSchema)).not.toContain("evaluationDraft");
    expect(prepareFlow.description).toContain("Evaluations are prepared and saved separately");
    expect(prepareEvaluation.description).toContain("committed Flow");
    expect(prepareEvaluation.description).toContain("commit_dsl_changes");
    expect(prepareEvaluation.description).toContain("save only the Evaluation");
  });

  it("validates both create_evaluation_draft modes before calling the project port", async () => {
    const inputs: Parameters<PragmaAgentDslProjectPort["createEvaluationDraft"]>[0][] = [];
    const project = projectPort({
      async createEvaluationDraft(input) {
        inputs.push(input);
        return evaluationDraft();
      },
    });
    const tool = createPragmaManagementTools({ project, missions: missionPort() }).find(
      (candidate) => candidate.name === "create_evaluation_draft",
    )!;

    await expect(
      tool.call(
        {
          mode: "create",
          expectedProjectRevision: 3,
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    expect(inputs).toHaveLength(0);

    await expect(
      tool.call(
        {
          mode: "create",
          expectedProjectRevision: 3,
          metadata: {
            id: "7h8j9k0m1n2p3q4r",
            name: "Test Run Dry",
            description: "Tests a committed Flow.",
            tags: [],
          },
          targetRef: "flow:8h9j0k1m2n3p4q5r",
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ details: { targetRef: "flow:8h9j0k1m2n3p4q5r" } });
    await expect(
      tool.call(
        {
          mode: "edit",
          expectedProjectRevision: 4,
          evaluationRef: "evaluation:7h8j9k0m1n2p3q4r",
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ details: { targetRef: "flow:8h9j0k1m2n3p4q5r" } });
    expect(inputs).toEqual([
      {
        mode: "create",
        expectedProjectRevision: 3,
        metadata: {
          id: "7h8j9k0m1n2p3q4r",
          name: "Test Run Dry",
          description: "Tests a committed Flow.",
          tags: [],
        },
        targetRef: "flow:8h9j0k1m2n3p4q5r",
      },
      {
        mode: "edit",
        expectedProjectRevision: 4,
        evaluationRef: "evaluation:7h8j9k0m1n2p3q4r",
      },
    ]);
  });

  it("returns compact draft summaries and caps update batches at 10 operations", async () => {
    const project = projectPort({
      async getEvaluationDraft() {
        return evaluationDraft();
      },
      async updateEvaluationDraft() {
        return evaluationDraft();
      },
    });
    const tools = createPragmaManagementTools({ project, missions: missionPort() });
    const get = tools.find((candidate) => candidate.name === "get_evaluation_draft")!;
    const summary = await get.call(
      { draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b" },
      undefined,
      undefined,
    );
    expect(summary.details).toMatchObject({
      cases: [{ id: "case-1", name: "Case one" }],
    });
    expect(summary.text).not.toContain("expectInput");
    const selected = await tools
      .find((candidate) => candidate.name === "get_evaluation_cases")!
      .call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          caseIds: ["case-1"],
        },
        undefined,
        undefined,
      );
    expect(selected.text).toContain("expectInput");
    await expect(
      get.call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          caseIds: Array.from({ length: 11 }, (_, index) => `case-${index}`),
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });

    const update = tools.find((candidate) => candidate.name === "update_evaluation_draft")!;
    await expect(
      update.call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          expectedDraftRevision: 0,
          operations: Array.from({ length: 10 }, (_, index) => ({
            type: "remove_case",
            caseId: `case-${index}`,
          })),
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ details: { caseCount: 1 } });
    await expect(
      update.call(
        {
          draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
          expectedDraftRevision: 0,
          operations: Array.from({ length: 11 }, (_, index) => ({
            type: "remove_case",
            caseId: `case-${index}`,
          })),
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
  });

  it("paginates Evaluation cases with short and legacy cursors", async () => {
    const draft = evaluationDraft();
    const firstCase = draft.resource.spec.method.cases[0]!;
    draft.resource.spec.method.cases.push(
      { ...firstCase, id: "case-2", name: "Case two" },
      { ...firstCase, id: "case-3", name: "Case three" },
    );
    const project = projectPort({
      async getEvaluationDraft() {
        return draft;
      },
    });
    const get = createPragmaManagementTools({ project, missions: missionPort() }).find(
      (candidate) => candidate.name === "get_evaluation_draft",
    )!;
    const draftId = draft.draftId;
    const first = await get.call({ draftId, limit: 1 }, undefined);
    const nextCursor = (first.details as { nextCursor: string }).nextCursor;
    expect(nextCursor).toMatch(/^p1\.[A-Za-z0-9_-]{40}$/u);
    const second = await get.call({ draftId, limit: 1, cursor: nextCursor }, undefined);
    expect(second.details).toMatchObject({ cases: [{ id: "case-2" }] });

    const legacy = Buffer.from(JSON.stringify([1, draftId, draft.draftRevision, null, 1])).toString(
      "base64url",
    );
    const legacyPage = await get.call({ draftId, limit: 1, cursor: legacy }, undefined);
    expect(legacyPage.details).toMatchObject({ cases: [{ id: "case-2" }] });
    expect(legacyPage.details).toMatchObject({
      nextCursor: (second.details as { nextCursor: string }).nextCursor,
    });

    await expect(
      get.call({ draftId, limit: 1, cursor: nextCursor, query: "Case" }, undefined),
    ).resolves.toMatchObject({ isError: true, details: { code: "cursor_invalid" } });
    draft.draftRevision += 1;
    await expect(
      get.call({ draftId, limit: 1, cursor: nextCursor }, undefined),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: "cursor_expired" },
    });
  });

  it("keeps the Flow operation schema strict while recovering JSON array strings", async () => {
    const inputs: Parameters<PragmaAgentDslProjectPort["updateFlowDraft"]>[0][] = [];
    const project = projectPort({
      async getFlowDraft() {
        return flowDraft();
      },
      async updateFlowDraft(input) {
        inputs.push(input);
        return flowDraft();
      },
    });
    const tools = createPragmaManagementTools({ project, missions: missionPort() });
    const update = tools.find((candidate) => candidate.name === "update_flow_draft")!;
    const get = tools.find((candidate) => candidate.name === "get_flow_draft")!;

    expect(update.inputSchema).toMatchObject({
      type: "object",
      properties: {
        operations: {
          anyOf: [{ type: "array", minItems: 1, maxItems: 50 }, { type: "string" }],
          description: expect.stringContaining("native JSON array"),
        },
      },
    });
    const result = await update.call(
      {
        draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
        expectedDraftRevision: 0,
        operations: `\n${JSON.stringify([
          { type: "set_start", stepId: "review" },
          { type: "remove_step", stepId: "review" },
          { type: "remove_step", stepId: "review" },
          { type: "remove_transition", stepId: "review" },
          { type: "remove_loop", loopId: "retry" },
          { type: "set_contracts" },
          { type: "rebase", projectRevision: 3 },
        ])}\n`,
      },
      undefined,
      undefined,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.operations).toHaveLength(7);
    expect(result.details).toMatchObject({
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      draftRevision: 1,
      applied: {
        operationCount: 7,
        stepsChanged: ["review"],
        transitionsChanged: ["review"],
        loopsChanged: ["retry"],
        startChanged: true,
        contractsChanged: true,
        rebasedToProjectRevision: 3,
      },
      diagnostics: [
        expect.objectContaining({
          severity: "warning",
          code: "flow_draft.operations_string_coerced",
          path: ["operations"],
        }),
      ],
      stepCount: 2,
      transitionCount: 2,
      loopCount: 1,
      hasErrors: false,
      isComplete: true,
      updatedAt: "2026-08-03T00:00:01.000Z",
    });
    expect(result.details).not.toHaveProperty("resource");
    expect(result.text).not.toContain('"resource"');

    const nativeResult = await update.call(
      {
        draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
        expectedDraftRevision: 0,
        operations: [{ type: "remove_step", stepId: "review" }],
      },
      undefined,
      undefined,
    );
    expect(inputs).toHaveLength(2);
    expect(nativeResult.details).toMatchObject({
      applied: { operationCount: 1, stepsChanged: ["review"] },
      diagnostics: [],
    });

    const compact = await get.call(
      { draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855" },
      undefined,
      undefined,
    );
    expect(compact.details).not.toHaveProperty("resource");

    const complete = await get.call(
      { draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855", includeResource: true },
      undefined,
      undefined,
    );
    expect(complete.details).toHaveProperty("resource");
    expect(complete.details).toMatchObject({ diagnostics: [] });
  });

  it("rejects malformed string fallbacks before updating a Flow draft", async () => {
    let updateCount = 0;
    const project = projectPort({
      async updateFlowDraft() {
        updateCount += 1;
        return flowDraft();
      },
    });
    const update = createPragmaManagementTools({ project, missions: missionPort() }).find(
      (candidate) => candidate.name === "update_flow_draft",
    )!;
    const base = {
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      expectedDraftRevision: 0,
    };

    await expect(
      update.call({ ...base, operations: "not json" }, undefined, undefined),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    await expect(
      update.call({ ...base, operations: '{"type":"set_start"}' }, undefined, undefined),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    await expect(
      update.call({ ...base, operations: "[]" }, undefined, undefined),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    await expect(
      update.call({ ...base, operations: '[{"type":"unknown_operation"}]' }, undefined, undefined),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    await expect(
      update.call(
        {
          ...base,
          operations: JSON.stringify(
            Array.from({ length: 51 }, () => ({ type: "remove_step", stepId: "review" })),
          ),
        },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    expect(updateCount).toBe(0);
  });

  it("exposes approved Automation maintenance tools when the host supplies the port", async () => {
    let operationId = "";
    const automations = automationPort({
      async resetSession(input) {
        operationId = input.operationId;
        return automationSummary();
      },
    });
    const tools = createPragmaManagementTools({
      project: projectPort(),
      missions: missionPort(),
      automations,
    });

    expect(tools.find((tool) => tool.name === "list_automations")?.approval?.mode).toBe("none");
    expect(tools.find((tool) => tool.name === "save_automation")?.approval?.mode).toBe("required");
    expect(tools.find((tool) => tool.name === "delete_automation")?.approval?.mode).toBe(
      "required",
    );
    const reset = tools.find((tool) => tool.name === "reset_automation_session")!;
    await reset.call({ ref: "automation:55af1v8nmn4j0h3z" }, undefined, {
      toolCallId: "runtime-call-reset",
    });
    expect(operationId).toBe("runtime-call-reset");
  });
});

function projectPort(
  overrides: Partial<PragmaAgentDslProjectPort> = {},
): PragmaAgentDslProjectPort {
  return {
    startDslDraft: async () => {
      throw new Error("unused");
    },
    listDslDrafts: async () => ({ items: [] }),
    inspectDslDraft: async () => {
      throw new Error("unused");
    },
    prepareDslDraft: async () => {
      throw new Error("unused");
    },
    restartDslDraft: async () => {
      throw new Error("unused");
    },
    discardDslDraft: async () => undefined,
    list: async () => ({ projectRevision: 0, items: [] }),
    listExpertOptions: async (input) => ({ category: input.category, items: [] }),
    allocateResourceIds: async (requests) =>
      requests.map((request) => ({
        key: request.key,
        id: "0000000000000000",
        ref: `${request.kind}:0000000000000000`,
      })),
    read: async () => {
      throw new Error("unused");
    },
    prepare: async () => {
      throw new Error("unused");
    },
    createFlowDraft: async () => {
      throw new Error("unused");
    },
    getFlowDraft: async () => {
      throw new Error("unused");
    },
    updateFlowDraft: async () => {
      throw new Error("unused");
    },
    validateFlowDraft: async () => {
      throw new Error("unused");
    },
    createEvaluationDraft: async () => {
      throw new Error("unused");
    },
    getEvaluationDraft: async () => {
      throw new Error("unused");
    },
    updateEvaluationDraft: async () => {
      throw new Error("unused");
    },
    runEvaluationDraft: async () => {
      throw new Error("unused");
    },
    prepareEvaluationDraft: async () => {
      throw new Error("unused");
    },
    discardEvaluationDraft: async () => undefined,
    prepareFlowDraft: async () => {
      throw new Error("unused");
    },
    discardFlowDraft: async () => undefined,
    getChangeSet: async () => {
      throw new Error("unused");
    },
    commit: async () => ({ projectId: "studio", projectRevision: 1, changedRefs: [] }),
    ...overrides,
  };
}

function compactDraftReview() {
  return {
    unknownFieldPolicy: "preserve-additive" as const,
    summary: {
      resourceCount: 1,
      changedResourceCount: 1,
      fieldsAdded: 0,
      fieldsChanged: 1,
      fieldsRemoved: 0,
      omittedFieldCount: 0,
      diagnosticCount: 1,
      errorCount: 0,
      warningCount: 1,
      hostDependencyCount: 0,
    },
    diagnostics: [
      {
        severity: "warning" as const,
        code: "compact.warning",
        message: "Compact warning.",
        path: [],
      },
    ],
    fieldChanges: [
      {
        ref: "expert:1h2j3k4m5n6p7q8r",
        path: ["spec", "instructions"],
        change: "changed" as const,
        before: { type: "string" as const, preview: "before", size: 6 },
        after: { type: "string" as const, preview: "after", size: 5 },
      },
    ],
    omittedFields: [],
    hostDependencies: [],
    truncation: {
      diagnostics: { total: 1, returned: 1, omitted: 0 },
      fieldChanges: { total: 1, returned: 1, omitted: 0 },
      omittedFields: { total: 0, returned: 0, omitted: 0 },
      hostDependencies: { total: 0, returned: 0, omitted: 0 },
    },
  };
}

function missionPort(): PragmaAgentMissionPort {
  return {
    list: async () => ({ items: [] }),
    get: async () => {
      throw new Error("unused");
    },
    submit: async () => {
      throw new Error("unused");
    },
    sendMessage: async () => {
      throw new Error("unused");
    },
    listWorkItems: async () => ({ items: [] }),
    getWorkItem: async () => {
      throw new Error("unused");
    },
    interrupt: async () => {
      throw new Error("unused");
    },
  };
}

function automationPort(
  overrides: Partial<PragmaAgentAutomationPort> = {},
): PragmaAgentAutomationPort {
  return {
    list: async () => ({ projectRevision: 1, items: [] }),
    save: async () => automationSummary(),
    delete: async (input) => ({ deleted: true, ref: input.ref }),
    resetSession: async () => automationSummary(),
    ...overrides,
  };
}

function automationSummary() {
  return {
    ref: "automation:55af1v8nmn4j0h3z",
    name: "Daily review",
    enabled: true,
    status: "scheduled" as const,
    executorRef: "expert:2h3j4k5m6n7p8q9r",
    interaction: "reuse-session" as const,
    workspaceId: "/work/review",
    nextRunAt: "2026-07-24T01:00:00.000Z",
    queueDepth: 0,
  };
}

function evaluationDraft() {
  return PragmaAgentEvaluationDraftSchema.parse({
    draftId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
    baseProjectRevision: 0,
    draftRevision: 1,
    resource: {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Test Run Dry",
        description: "Tests a Flow.",
        tags: [],
      },
      spec: {
        target: { ref: "flow:8h9j0k1m2n3p4q5r" },
        method: {
          type: "flow-run-dry",
          cases: [
            {
              id: "case-1",
              name: "Case one",
              input: {},
              mocks: {
                step: { expectInput: {}, output: {} },
              },
              expect: { status: "succeeded", path: ["step"], output: {} },
            },
          ],
        },
      },
    },
    diagnostics: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
  });
}

function flowDraft() {
  return PragmaAgentFlowDraftSchema.parse({
    draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
    baseProjectRevision: 3,
    draftRevision: 1,
    resource: {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Review Flow",
        description: "Reviews a change.",
        tags: [],
      },
      spec: {
        graph: {
          start: "review",
          steps: {
            review: {
              human: {
                selectionMode: "single",
                prompt: { segments: [{ text: "Approve?" }] },
                options: [
                  { value: "approve", label: "Approve" },
                  { value: "reject", label: "Reject" },
                ],
              },
            },
            revise: {
              human: {
                selectionMode: "single",
                prompt: { segments: [{ text: "Revise?" }] },
                options: [
                  { value: "revise", label: "Revise" },
                  { value: "stop", label: "Stop" },
                ],
              },
            },
          },
          transitions: { review: { end: true }, revise: { end: true } },
          loops: {
            retry: { entry: "review", maxIterations: 2, onLimit: { end: true } },
          },
        },
      },
    },
    diagnostics: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
  });
}
