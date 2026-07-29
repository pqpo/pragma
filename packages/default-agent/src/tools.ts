import type {
  ExpertAgentManagedTool,
  ExpertAgentManagedToolCallContext,
  ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import type {
  DefaultAgentAutomationPort,
  DefaultAgentDslProjectPort,
  DefaultAgentTaskPort,
} from "./ports.ts";
import {
  DefaultAgentEvaluationDraftOperationSchema,
  DefaultAgentEvaluationDraftRunResultSchema,
  DefaultAgentEvaluationDraftSummarySchema,
  DefaultAgentEvaluationDraftViewSchema,
  DefaultAgentFlowDraftOperationSchema,
  DefaultAgentFlowDraftSchema,
  type DefaultAgentEvaluationDraft,
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
  input: DefaultAgentFlowDraftSchema.shape.resource.shape.spec.shape.input.optional(),
  output: DefaultAgentFlowDraftSchema.shape.resource.shape.spec.shape.output.optional(),
  limits: DefaultAgentFlowDraftSchema.shape.resource.shape.spec.shape.limits.optional(),
});
const UpdateFlowDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  operations: z.array(DefaultAgentFlowDraftOperationSchema).min(1).max(50),
});
const EvaluationDraftRevisionInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
});
const PrepareFlowDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  evaluationDraft: EvaluationDraftRevisionInput,
  additionalSources: z.array(z.string().min(1).max(2_000_000)).max(49).optional(),
});
const CreateEvaluationDraftInput = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    expectedProjectRevision: z.number().int().nonnegative(),
    metadata: PragmaEvaluationMetadataSchema,
    targetRef: PragmaEvaluationFlowRefSchema,
    targetFlowDraftId: z.string().uuid().optional(),
  }),
  z.object({
    mode: z.literal("edit"),
    expectedProjectRevision: z.number().int().nonnegative(),
    evaluationRef: PragmaEvaluationRefSchema,
    targetFlowDraftId: z.string().uuid().optional(),
  }),
]);
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
  operations: z.array(DefaultAgentEvaluationDraftOperationSchema).min(1).max(10),
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

type DefaultAgentTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export function createDefaultAgentTools(options: {
  readonly project: DefaultAgentDslProjectPort;
  readonly tasks: DefaultAgentTaskPort;
  readonly automations?: DefaultAgentAutomationPort | undefined;
}): readonly DefaultAgentTool[] {
  const operationId = (context: ExpertAgentManagedToolCallContext | undefined): string => {
    const id = context?.toolCallId;
    if (id === undefined) throw new Error("A default Agent write tool requires a toolCallId.");
    return id;
  };
  const automationTools: readonly DefaultAgentTool[] =
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
      "Read one current Pragma resource as canonical YAML.",
      objectSchema({ ref: { type: "string" } }, ["ref"]),
      async (args) => ok(await options.project.read(RefInput.parse(args).ref)),
    ),
    tool(
      "list_expert_options",
      "List host-provided Runtime models and ready capabilities that can be assigned to an Expert.",
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
      "Read one durable Flow draft with its current diagnostics.",
      z.toJSONSchema(DraftIdInput),
      async (args) => ok(await options.project.getFlowDraft(DraftIdInput.parse(args).draftId)),
    ),
    tool(
      "update_flow_draft",
      "Apply typed incremental operations to a Flow draft and validate the new draft revision.",
      z.toJSONSchema(UpdateFlowDraftInput),
      async (args) => ok(await options.project.updateFlowDraft(UpdateFlowDraftInput.parse(args))),
    ),
    tool(
      "validate_flow_draft",
      "Revalidate a Flow draft without changing it.",
      z.toJSONSchema(DraftIdInput),
      async (args) => ok(await options.project.validateFlowDraft(DraftIdInput.parse(args).draftId)),
    ),
    tool(
      "create_evaluation_draft",
      "Create an empty incremental Evaluation draft or start editing one existing Evaluation. Link a Flow draft when testing uncommitted Flow changes.",
      z.toJSONSchema(CreateEvaluationDraftInput),
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
          DefaultAgentEvaluationDraftRunResultSchema.parse(
            await options.project.runEvaluationDraft(RunEvaluationDraftInput.parse(args)),
          ),
        ),
    ),
    tool(
      "prepare_evaluation_draft",
      "Rerun and prepare a passing Evaluation draft for an existing Flow without emitting complete Evaluation YAML.",
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
      "Rerun a linked Evaluation draft and atomically prepare a structurally complete Flow, passing Evaluation, and optional Expert or Team YAML sources.",
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
): DefaultAgentTool {
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

function summarizeEvaluationDraft(
  draft: DefaultAgentEvaluationDraft,
): z.infer<typeof DefaultAgentEvaluationDraftSummarySchema> {
  return DefaultAgentEvaluationDraftSummarySchema.parse({
    draftId: draft.draftId,
    baseProjectRevision: draft.baseProjectRevision,
    draftRevision: draft.draftRevision,
    metadata: draft.resource.metadata,
    targetRef: draft.resource.spec.target.ref,
    ...(draft.sourceEvaluationRef === undefined
      ? {}
      : { sourceEvaluationRef: draft.sourceEvaluationRef }),
    ...(draft.targetFlowDraftId === undefined
      ? {}
      : { targetFlowDraftId: draft.targetFlowDraftId }),
    cases: draft.resource.spec.method.cases.map(({ id, name }) => ({ id, name })),
    diagnostics: draft.diagnostics,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

function viewEvaluationDraft(
  draft: DefaultAgentEvaluationDraft,
  caseIds: readonly string[],
): z.infer<typeof DefaultAgentEvaluationDraftViewSchema> {
  const cases = new Map(
    draft.resource.spec.method.cases.map((testCase) => [testCase.id, testCase] as const),
  );
  const selectedCases = caseIds.map((caseId) => {
    const testCase = cases.get(caseId);
    if (testCase === undefined) throw new Error(`Evaluation draft case not found: ${caseId}`);
    return testCase;
  });
  return DefaultAgentEvaluationDraftViewSchema.parse({
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
