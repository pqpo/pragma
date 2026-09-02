import type {
  ExpertAgentManagedTool,
  ExpertAgentManagedToolCallContext,
  ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import type {
  PragmaAgentAutomationPort,
  PragmaAgentDslProjectPort,
  PragmaAgentTaskPort,
} from "./ports.ts";
import {
  PragmaAgentEvaluationDraftOperationSchema,
  PragmaAgentEvaluationDraftRunResultSchema,
  PragmaAgentEvaluationDraftSummarySchema,
  PragmaAgentEvaluationDraftViewSchema,
  PragmaAgentFlowDraftOperationSchema,
  PragmaAgentFlowDraftSchema,
  PragmaAgentFlowDraftUpdateSummarySchema,
  type PragmaAgentEvaluationDraft,
  type PragmaAgentFlowDraft,
  type PragmaAgentFlowDraftDiagnostic,
  type PragmaAgentFlowDraftOperation,
} from "./contracts.ts";
import {
  PragmaEvaluationFlowRefSchema,
  PragmaEvaluationMetadataSchema,
  PragmaEvaluationRefSchema,
  PragmaFlowRunDryCaseSchema,
} from "@pragma/evaluation/ast";
import { PragmaMetadataSchema } from "@pragma/interpreter/ast";

const RefInput = z.object({ ref: z.string().min(1) });
const PrepareInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  sources: z.array(z.string().min(1).max(2_000_000)).min(1).max(50),
});
const CommitInput = z.object({ changeSetId: z.string().uuid() });
const DraftIdInput = z.object({ draftId: z.string().uuid() });
const AllocateResourceIdsInput = z.object({
  requests: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(100),
        kind: z.enum([
          "expert",
          "team",
          "flow",
          "automation",
          "capability",
          "context-store",
          "runtime-profile",
          "evaluation",
        ]),
      }),
    )
    .min(1)
    .max(50),
});
const CreateFlowDraftInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  metadata: PragmaMetadataSchema,
  input: PragmaAgentFlowDraftSchema.shape.resource.shape.spec.shape.input.optional(),
  output: PragmaAgentFlowDraftSchema.shape.resource.shape.spec.shape.output.optional(),
  limits: PragmaAgentFlowDraftSchema.shape.resource.shape.spec.shape.limits.optional(),
});
const UpdateFlowDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  operations: z.array(PragmaAgentFlowDraftOperationSchema).min(1).max(50),
});
const UpdateFlowDraftToolInput = UpdateFlowDraftInput.extend({
  operations: z
    .union([UpdateFlowDraftInput.shape.operations, z.string()])
    .describe(
      "Pass a native JSON array. A string containing a JSON array is accepted only as a recovery path.",
    ),
});
const EvaluationDraftRevisionInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
});
const PrepareFlowDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  additionalSources: z.array(z.string().min(1).max(2_000_000)).max(49).optional(),
});
const CreateEvaluationDraftCreateInput = z.object({
  mode: z.literal("create"),
  expectedProjectRevision: z.number().int().nonnegative(),
  metadata: PragmaEvaluationMetadataSchema,
  targetRef: PragmaEvaluationFlowRefSchema,
});
const CreateEvaluationDraftEditInput = z.object({
  mode: z.literal("edit"),
  expectedProjectRevision: z.number().int().nonnegative(),
  evaluationRef: PragmaEvaluationRefSchema,
});
const CreateEvaluationDraftInput = z.discriminatedUnion("mode", [
  CreateEvaluationDraftCreateInput,
  CreateEvaluationDraftEditInput,
]);
// MCP tool inputs must expose a top-level object. A root discriminated union materializes as
// `oneOf` and is reduced to an empty object by the MCP catalog, so keep the strict execution
// validator above and publish the union fields through this model-facing object schema.
const CreateEvaluationDraftToolInput = z.object({
  mode: z
    .enum(["create", "edit"])
    .describe("Use create for a new test set or edit for an existing Evaluation."),
  expectedProjectRevision: CreateEvaluationDraftCreateInput.shape.expectedProjectRevision,
  metadata: CreateEvaluationDraftCreateInput.shape.metadata
    .optional()
    .describe("Required when mode is create."),
  targetRef: CreateEvaluationDraftCreateInput.shape.targetRef
    .optional()
    .describe("Exact committed Flow ref; required when mode is create."),
  evaluationRef: CreateEvaluationDraftEditInput.shape.evaluationRef
    .optional()
    .describe("Exact existing Evaluation ref; required when mode is edit."),
});
const EvaluationCaseIdsSchema = z
  .array(PragmaFlowRunDryCaseSchema.shape.id)
  .min(1)
  .max(10)
  .refine((caseIds) => new Set(caseIds).size === caseIds.length, "Case IDs must be unique.");
const GetEvaluationDraftInput = z.object({
  draftId: z.string().uuid(),
  caseIds: EvaluationCaseIdsSchema.optional(),
});
const UpdateEvaluationDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  operations: z.array(PragmaAgentEvaluationDraftOperationSchema).min(1).max(10),
});
const RunEvaluationDraftInput = z.object({
  draftId: z.string().uuid(),
  caseIds: EvaluationCaseIdsSchema,
});
const TaskIdInput = z.object({ id: z.string().min(1) });
const SubmitTaskInput = z.object({
  goal: z.string().trim().min(1).max(100_000),
  executorRef: z.string().min(1),
  workspaceId: z.string().min(1),
});
const SendTaskMessageInput = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1).max(100_000),
});
const SaveAutomationInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  source: z.string().min(1).max(2_000_000),
  workspaceId: z.string().min(1),
  toolPermissionMode: z.enum(["request-approval", "auto-approve", "full-access"]),
});
const DeleteAutomationInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  ref: z.string().min(1),
});

type PragmaAgentTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export function createPragmaAgentTools(options: {
  readonly project: PragmaAgentDslProjectPort;
  readonly tasks: PragmaAgentTaskPort;
  readonly automations?: PragmaAgentAutomationPort | undefined;
}): readonly PragmaAgentTool[] {
  const operationId = (context: ExpertAgentManagedToolCallContext | undefined): string => {
    const id = context?.toolCallId;
    if (id === undefined) throw new Error("A default Agent write tool requires a toolCallId.");
    return id;
  };
  const automationTools: readonly PragmaAgentTool[] =
    options.automations === undefined
      ? []
      : [
          tool(
            "list_automations",
            "List Desktop Automations, their schedule status, continuity Mission, and project revision.",
            {},
            async () => ok(await options.automations!.list()),
          ),
          {
            ...tool(
              "save_automation",
              "Create, edit, enable, or disable one complete Automation YAML resource with its Desktop workspace and permission binding.",
              z.toJSONSchema(SaveAutomationInput),
              async (args, context) =>
                ok(
                  await options.automations!.save({
                    ...SaveAutomationInput.parse(args),
                    operationId: operationId(context),
                  }),
                ),
            ),
            approval: {
              mode: "required",
              reason: "Save this Automation and its Desktop execution binding.",
            },
          },
          {
            ...tool(
              "delete_automation",
              "Delete an Automation while retaining every Mission and conversation it created.",
              z.toJSONSchema(DeleteAutomationInput),
              async (args, context) =>
                ok(
                  await options.automations!.delete({
                    ...DeleteAutomationInput.parse(args),
                    operationId: operationId(context),
                  }),
                ),
            ),
            approval: {
              mode: "required",
              reason: "Delete this Automation while retaining its Missions.",
            },
          },
          {
            ...tool(
              "reset_automation_session",
              "Reset the continuity binding so the next reusable Automation event starts a new Mission.",
              z.toJSONSchema(RefInput),
              async (args, context) =>
                ok(
                  await options.automations!.resetSession({
                    ref: RefInput.parse(args).ref,
                    operationId: operationId(context),
                  }),
                ),
            ),
            approval: {
              mode: "required",
              reason: "Reset this Automation's reusable Mission binding.",
            },
          },
        ];
  return [
    tool(
      "list_dsl_resources",
      "List the current Pragma project revision and DSL resources.",
      {},
      async () => ok(await options.project.list()),
    ),
    tool(
      "read_dsl_resource",
      "Read one current project resource or read-only built-in system Expert as canonical YAML.",
      objectSchema({ ref: { type: "string" } }, ["ref"]),
      async (args) => ok(await options.project.read(RefInput.parse(args).ref)),
    ),
    tool(
      "list_expert_options",
      "List host-provided Runtime models, ready capabilities, named avatar personas, and read-only built-in Experts. Built-in Experts can be referenced directly as an ExpertTeam coordinator or member.",
      {},
      async () => ok(await options.project.listExpertOptions()),
    ),
    tool(
      "allocate_dsl_resource_ids",
      "Allocate Host-generated stable IDs for new Pragma resources before authoring YAML.",
      z.toJSONSchema(AllocateResourceIdsInput),
      async (args) =>
        ok(
          await options.project.allocateResourceIds(AllocateResourceIdsInput.parse(args).requests),
        ),
    ),
    tool(
      "prepare_dsl_changes",
      "Parse and validate complete YAML documents against the full candidate project without saving.",
      objectSchema(
        {
          expectedProjectRevision: { type: "integer", minimum: 0 },
          sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        },
        ["expectedProjectRevision", "sources"],
      ),
      async (args) => ok(await options.project.prepare(PrepareInput.parse(args))),
    ),
    tool(
      "create_flow_draft",
      "Create a durable incomplete Flow draft at the current project revision.",
      z.toJSONSchema(CreateFlowDraftInput),
      async (args) => ok(await options.project.createFlowDraft(CreateFlowDraftInput.parse(args))),
    ),
    tool(
      "get_flow_draft",
      "Read one durable Flow draft with its full resource and current diagnostics.",
      z.toJSONSchema(DraftIdInput),
      async (args) => ok(await options.project.getFlowDraft(DraftIdInput.parse(args).draftId)),
    ),
    tool(
      "update_flow_draft",
      "Apply typed incremental operations to a Flow draft and return a compact validated revision summary. Use get_flow_draft when the complete resource is needed.",
      z.toJSONSchema(UpdateFlowDraftToolInput),
      async (args) => {
        const { input, warning } = parseUpdateFlowDraftInput(args);
        return ok(
          summarizeFlowDraftUpdate(
            await options.project.updateFlowDraft(input),
            input.operations,
            warning,
          ),
        );
      },
    ),
    tool(
      "validate_flow_draft",
      "Revalidate a Flow draft without changing it.",
      z.toJSONSchema(DraftIdInput),
      async (args) => ok(await options.project.validateFlowDraft(DraftIdInput.parse(args).draftId)),
    ),
    tool(
      "create_evaluation_draft",
      "Create an empty incremental Evaluation draft for a committed Flow, or start editing one existing Evaluation.",
      z.toJSONSchema(CreateEvaluationDraftToolInput),
      async (args) => {
        return ok(
          summarizeEvaluationDraft(
            await options.project.createEvaluationDraft(CreateEvaluationDraftInput.parse(args)),
          ),
        );
      },
    ),
    tool(
      "get_evaluation_draft",
      "Read compact Evaluation draft metadata and case summaries. Request at most 10 case IDs to include their full definitions.",
      z.toJSONSchema(GetEvaluationDraftInput),
      async (args) => {
        const input = GetEvaluationDraftInput.parse(args);
        return ok(
          viewEvaluationDraft(
            await options.project.getEvaluationDraft(input.draftId),
            input.caseIds ?? [],
          ),
        );
      },
    ),
    tool(
      "update_evaluation_draft",
      "Apply at most 10 typed case or rebase operations to an Evaluation draft. Default to one case per call.",
      z.toJSONSchema(UpdateEvaluationDraftInput),
      async (args) =>
        ok(
          summarizeEvaluationDraft(
            await options.project.updateEvaluationDraft(UpdateEvaluationDraftInput.parse(args)),
          ),
        ),
    ),
    tool(
      "run_evaluation_draft",
      "Run the complete Evaluation draft internally, returning detailed results for only 1 to 10 requested cases plus compact suite and cumulative coverage status.",
      z.toJSONSchema(RunEvaluationDraftInput),
      async (args) =>
        ok(
          PragmaAgentEvaluationDraftRunResultSchema.parse(
            await options.project.runEvaluationDraft(RunEvaluationDraftInput.parse(args)),
          ),
        ),
    ),
    tool(
      "prepare_evaluation_draft",
      "Rerun and independently prepare a passing Evaluation draft that targets a committed Flow. Pass the returned changeSetId to commit_dsl_changes to save only the Evaluation.",
      z.toJSONSchema(EvaluationDraftRevisionInput),
      async (args) =>
        ok(await options.project.prepareEvaluationDraft(EvaluationDraftRevisionInput.parse(args))),
    ),
    tool(
      "discard_evaluation_draft",
      "Discard an uncommitted Evaluation draft.",
      z.toJSONSchema(DraftIdInput),
      async (args) => {
        await options.project.discardEvaluationDraft(DraftIdInput.parse(args).draftId);
        return ok({ discarded: true });
      },
    ),
    tool(
      "prepare_flow_draft",
      "Prepare a structurally complete Flow and optional non-Evaluation dependency YAML sources. Evaluations are prepared and saved separately with prepare_evaluation_draft and commit_dsl_changes.",
      z.toJSONSchema(PrepareFlowDraftInput),
      async (args) => ok(await options.project.prepareFlowDraft(PrepareFlowDraftInput.parse(args))),
    ),
    tool(
      "discard_flow_draft",
      "Discard an uncommitted Flow draft.",
      z.toJSONSchema(DraftIdInput),
      async (args) => {
        await options.project.discardFlowDraft(DraftIdInput.parse(args).draftId);
        return ok({ discarded: true });
      },
    ),
    {
      ...tool(
        "commit_dsl_changes",
        "Atomically commit one previously prepared and validated DSL change-set.",
        objectSchema({ changeSetId: { type: "string", format: "uuid" } }, ["changeSetId"]),
        async (args, context) => {
          const input = CommitInput.parse(args);
          return ok(
            await options.project.commit({
              changeSetId: input.changeSetId,
              operationId: operationId(context),
            }),
          );
        },
      ),
      approval: {
        mode: "required",
        reason: "Commit this validated DSL change-set to a new project revision.",
      },
    },
    tool("list_tasks", "List recent Pragma tasks and their current status.", {}, async () =>
      ok(await options.tasks.list()),
    ),
    tool(
      "get_task",
      "Read one Pragma task and its current status.",
      objectSchema({ id: { type: "string" } }, ["id"]),
      async (args) => ok(await options.tasks.get(TaskIdInput.parse(args).id)),
    ),
    {
      ...tool(
        "submit_task",
        "Create and start a task with an exact Expert, Team, or Flow ref and explicit workspace.",
        objectSchema(
          {
            goal: { type: "string" },
            executorRef: { type: "string" },
            workspaceId: { type: "string" },
          },
          ["goal", "executorRef", "workspaceId"],
        ),
        async (args, context) =>
          ok(
            await options.tasks.submit({
              ...SubmitTaskInput.parse(args),
              operationId: operationId(context),
            }),
          ),
      ),
      approval: { mode: "required", reason: "Start this task in the selected workspace." },
    },
    {
      ...tool(
        "send_task_message",
        "Send a follow-up message to an existing conversational task.",
        objectSchema({ id: { type: "string" }, content: { type: "string" } }, ["id", "content"]),
        async (args, context) =>
          ok(
            await options.tasks.sendMessage({
              ...SendTaskMessageInput.parse(args),
              operationId: operationId(context),
            }),
          ),
      ),
      approval: { mode: "required", reason: "Send this instruction to the selected task." },
    },
    tool(
      "list_task_work_items",
      "List the invocation work tree for a task.",
      objectSchema({ id: { type: "string" } }, ["id"]),
      async (args) => ok(await options.tasks.listWorkItems(TaskIdInput.parse(args).id)),
    ),
    tool(
      "interrupt_task",
      "Interrupt the currently running execution of a task.",
      objectSchema({ id: { type: "string" } }, ["id"]),
      async (args) => ok(await options.tasks.interrupt(TaskIdInput.parse(args).id)),
    ),
    ...automationTools,
  ];
}

function tool(
  name: string,
  description: string,
  inputSchema: unknown,
  call: (
    args: unknown,
    context?: ExpertAgentManagedToolCallContext,
  ) => Promise<ExpertAgentToolCallResult>,
): PragmaAgentTool {
  return {
    name,
    description,
    inputSchema,
    call: async (args, _signal, context) => await call(args, context),
  };
}

function ok(details: unknown): ExpertAgentToolCallResult {
  return { text: JSON.stringify(details, null, 2), details };
}

function parseUpdateFlowDraftInput(args: unknown): {
  readonly input: z.infer<typeof UpdateFlowDraftInput>;
  readonly warning?: PragmaAgentFlowDraftDiagnostic | undefined;
} {
  if (!isRecord(args) || typeof args["operations"] !== "string") {
    return { input: UpdateFlowDraftInput.parse(args) };
  }

  let operations: unknown;
  try {
    operations = JSON.parse(args["operations"]);
  } catch {
    throw new Error(
      "operations must be a JSON array; received a string that could not be parsed as JSON.",
    );
  }
  if (!Array.isArray(operations)) {
    throw new Error("operations must be a JSON array; parsed string did not contain an array.");
  }

  return {
    input: UpdateFlowDraftInput.parse({ ...args, operations }),
    warning: {
      severity: "warning",
      code: "flow_draft.operations_string_coerced",
      message: "operations was parsed from a JSON string; pass a native JSON array instead.",
      path: ["operations"],
    },
  };
}

function summarizeFlowDraftUpdate(
  draft: PragmaAgentFlowDraft,
  operations: readonly PragmaAgentFlowDraftOperation[],
  warning?: PragmaAgentFlowDraftDiagnostic,
): z.infer<typeof PragmaAgentFlowDraftUpdateSummarySchema> {
  const stepsChanged = new Set<string>();
  const transitionsChanged = new Set<string>();
  const loopsChanged = new Set<string>();
  let startChanged = false;
  let contractsChanged = false;
  let rebasedToProjectRevision: number | undefined;

  for (const operation of operations) {
    switch (operation.type) {
      case "set_start":
        startChanged = true;
        break;
      case "upsert_step":
      case "remove_step":
        stepsChanged.add(operation.stepId);
        break;
      case "set_transition":
      case "remove_transition":
        transitionsChanged.add(operation.stepId);
        break;
      case "upsert_loop":
      case "remove_loop":
        loopsChanged.add(operation.loopId);
        break;
      case "set_contracts":
        contractsChanged = true;
        break;
      case "rebase":
        rebasedToProjectRevision = operation.projectRevision;
        break;
    }
  }

  const diagnostics = warning === undefined ? draft.diagnostics : [warning, ...draft.diagnostics];
  return PragmaAgentFlowDraftUpdateSummarySchema.parse({
    draftId: draft.draftId,
    baseProjectRevision: draft.baseProjectRevision,
    draftRevision: draft.draftRevision,
    applied: {
      operationCount: operations.length,
      stepsChanged: [...stepsChanged],
      transitionsChanged: [...transitionsChanged],
      loopsChanged: [...loopsChanged],
      startChanged,
      contractsChanged,
      ...(rebasedToProjectRevision === undefined ? {} : { rebasedToProjectRevision }),
    },
    diagnostics,
    stepCount: Object.keys(draft.resource.spec.graph.steps).length,
    transitionCount: Object.keys(draft.resource.spec.graph.transitions).length,
    loopCount: Object.keys(draft.resource.spec.graph.loops).length,
    hasErrors: diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    isComplete: diagnostics.every(
      (diagnostic) => diagnostic.severity !== "error" && diagnostic.severity !== "incomplete",
    ),
    updatedAt: draft.updatedAt,
  });
}

function summarizeEvaluationDraft(
  draft: PragmaAgentEvaluationDraft,
): z.infer<typeof PragmaAgentEvaluationDraftSummarySchema> {
  return PragmaAgentEvaluationDraftSummarySchema.parse({
    draftId: draft.draftId,
    baseProjectRevision: draft.baseProjectRevision,
    draftRevision: draft.draftRevision,
    metadata: draft.resource.metadata,
    targetRef: draft.resource.spec.target.ref,
    ...(draft.sourceEvaluationRef === undefined
      ? {}
      : { sourceEvaluationRef: draft.sourceEvaluationRef }),
    cases: draft.resource.spec.method.cases.map(({ id, name }) => ({ id, name })),
    diagnostics: draft.diagnostics,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

function viewEvaluationDraft(
  draft: PragmaAgentEvaluationDraft,
  caseIds: readonly string[],
): z.infer<typeof PragmaAgentEvaluationDraftViewSchema> {
  const cases = new Map(
    draft.resource.spec.method.cases.map((testCase) => [testCase.id, testCase] as const),
  );
  const selectedCases = caseIds.map((caseId) => {
    const testCase = cases.get(caseId);
    if (testCase === undefined) throw new Error(`Evaluation draft case not found: ${caseId}`);
    return testCase;
  });
  return PragmaAgentEvaluationDraftViewSchema.parse({
    ...summarizeEvaluationDraft(draft),
    selectedCases,
  });
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
