import { createHash } from "node:crypto";

import type {
  ExpertAgentManagedTool,
  ExpertAgentManagedToolCallContext,
  ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import type {
  PragmaAgentAutomationPort,
  PragmaAgentDslProjectPort,
  PragmaAgentMissionPort,
} from "./ports.ts";
import {
  PragmaAgentEvaluationDraftOperationSchema,
  PragmaAgentEvaluationDraftRunResultSchema,
  PragmaAgentEvaluationDraftSummarySchema,
  PragmaAgentEvaluationDraftViewSchema,
  PragmaAgentEvaluationCasesSchema,
  PragmaAgentFlowDraftOperationSchema,
  PragmaAgentFlowDraftSchema,
  PragmaAgentFlowDraftUpdateSummarySchema,
  PragmaAgentResourcePageSchema,
  PragmaAgentDslDocumentSchema,
  PragmaAgentExpertOptionPageSchema,
  PragmaAgentCompactPrepareResultSchema,
  PragmaAgentProjectCommitSchema,
  PragmaAgentMissionPageSchema,
  PragmaAgentMissionSchema,
  PragmaAgentMissionWorkItemPageSchema,
  PragmaAgentMissionWorkItemDetailSchema,
  PragmaAgentAutomationPageSchema,
  PragmaAgentAutomationSummarySchema,
  PragmaContentChunkSchema,
  PragmaManagementErrorSchema,
  PragmaManagementPageInputSchema,
  type PragmaAgentEvaluationDraft,
  type PragmaAgentFlowDraft,
  type PragmaAgentFlowDraftDiagnostic,
  type PragmaAgentFlowDraftOperation,
  type PragmaAgentPrepareResult,
} from "./contracts.ts";
import {
  PragmaEvaluationFlowRefSchema,
  PragmaEvaluationMetadataSchema,
  PragmaEvaluationRefSchema,
  PragmaFlowRunDryCaseSchema,
} from "@pragma/evaluation/ast";
import { PragmaMetadataSchema } from "@pragma/interpreter/ast";

const RefInput = z.object({
  ref: z.string().min(1).describe("Exact canonical ref returned by a Pragma list tool."),
});
const ContentRangeInput = z.object({
  offset: z.number().int().nonnegative().default(0).describe("Character offset; defaults to 0."),
  limitChars: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(20_000)
    .describe("Maximum characters to return; defaults to 20000 and cannot exceed 100000."),
});
const ReadResourceInput = RefInput.extend(ContentRangeInput.shape).strict();
const ListDslResourcesInput = PragmaManagementPageInputSchema.extend({
  kinds: z
    .array(
      z.enum([
        "Expert",
        "ExpertTeam",
        "Flow",
        "Automation",
        "Capability",
        "ContextStore",
        "RuntimeProfile",
        "Evaluation",
      ]),
    )
    .max(8)
    .optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
const ListExpertOptionsInput = PragmaManagementPageInputSchema.extend({
  category: z.enum(["runtime-models", "capabilities", "avatars", "builtin-experts"]),
  query: z.string().trim().min(1).max(200).optional(),
  capabilityKind: z.enum(["skill", "tools"]).optional(),
}).strict();
const PrepareInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  sources: z.array(z.string().min(1).max(2_000_000)).min(1).max(50),
});
const CommitInput = z.object({ changeSetId: z.string().uuid() });
const ReadPreparedDslChangeInput = z
  .object({
    changeSetId: z.string().uuid(),
    ref: z.string().min(1),
    ...ContentRangeInput.shape,
  })
  .strict();
const DraftIdInput = z.object({ draftId: z.string().uuid() });
const GetFlowDraftInput = DraftIdInput.extend({
  includeResource: z
    .boolean()
    .default(false)
    .describe("Set true only when the complete Flow resource is required."),
}).strict();
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
const GetEvaluationDraftInput = PragmaManagementPageInputSchema.extend({
  draftId: z.string().uuid(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
const GetEvaluationCasesInput = z
  .object({ draftId: z.string().uuid(), caseIds: EvaluationCaseIdsSchema })
  .strict();
const UpdateEvaluationDraftInput = z.object({
  draftId: z.string().uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
  operations: z.array(PragmaAgentEvaluationDraftOperationSchema).min(1).max(10),
});
const RunEvaluationDraftInput = z.object({
  draftId: z.string().uuid(),
  caseIds: EvaluationCaseIdsSchema,
});
const MissionIdInput = z.object({ missionId: z.string().uuid() }).strict();
const CreateMissionInput = z.object({
  goal: z.string().trim().min(1).max(100_000),
  executorRef: z.string().min(1),
  workspaceId: z.string().min(1),
});
const SendMissionMessageInput = z.object({
  missionId: z.string().uuid(),
  content: z.string().trim().min(1).max(100_000),
});
const ListMissionsInput = PragmaManagementPageInputSchema.extend({
  statuses: z.array(z.string().min(1)).max(20).optional(),
  executorRef: z.string().min(1).optional(),
  updatedAfter: z.string().datetime().optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
const ListMissionWorkItemsInput = PragmaManagementPageInputSchema.extend({
  missionId: z.string().uuid(),
  kinds: z.array(z.string().min(1)).max(20).optional(),
  statuses: z.array(z.string().min(1)).max(20).optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
const GetMissionWorkItemInput = z
  .object({
    missionId: z.string().uuid(),
    workItemId: z.string().min(1),
  })
  .strict();
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
const ListAutomationsInput = PragmaManagementPageInputSchema.extend({
  statuses: z.array(PragmaAgentAutomationSummarySchema.shape.status).max(4).optional(),
  enabled: z.boolean().optional(),
  executorRef: z.string().min(1).optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();

const ReadDslResourceResultSchema = PragmaAgentDslDocumentSchema.omit({ source: true }).extend({
  source: PragmaContentChunkSchema,
});
const AllocatedResourceIdsSchema = z.array(
  z.object({ key: z.string(), id: z.string(), ref: z.string() }).strict(),
);
const DiscardResultSchema = z.object({ discarded: z.literal(true) }).strict();
const DeleteAutomationResultSchema = z
  .object({ deleted: z.literal(true), ref: z.string().min(1) })
  .strict();
const PreparedDslChangeChunkSchema = z
  .object({
    changeSetId: z.string().uuid(),
    ref: z.string().min(1),
    kind: z.enum(["created", "updated"]),
    source: PragmaContentChunkSchema,
  })
  .strict();

type PragmaManagementHostTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

interface PragmaManagementHostToolPorts {
  readonly project: PragmaAgentDslProjectPort;
  readonly missions: PragmaAgentMissionPort;
  readonly automations?: PragmaAgentAutomationPort | undefined;
}

export function createPragmaManagementHostTools(
  options: PragmaManagementHostToolPorts,
): readonly PragmaManagementHostTool[] {
  return buildPragmaManagementHostTools({
    ports: options,
    includeAutomationTools: options.automations !== undefined,
  });
}

function buildPragmaManagementHostTools(options: {
  readonly ports?: PragmaManagementHostToolPorts | undefined;
  readonly includeAutomationTools: boolean;
}): readonly PragmaManagementHostTool[] {
  const project = (): PragmaAgentDslProjectPort => {
    if (options.ports === undefined) throw new Error("Pragma project management is unavailable.");
    return options.ports.project;
  };
  const missions = (): PragmaAgentMissionPort => {
    if (options.ports === undefined) throw new Error("Pragma Mission management is unavailable.");
    return options.ports.missions;
  };
  const automations = (): PragmaAgentAutomationPort => {
    const port = options.ports?.automations;
    if (port === undefined) throw new Error("Pragma Automation management is unavailable.");
    return port;
  };
  const operationId = (context: ExpertAgentManagedToolCallContext | undefined): string => {
    const id = context?.toolCallId;
    if (id === undefined) throw new Error("A Pragma management write tool requires a toolCallId.");
    return id;
  };
  const automationTools: readonly PragmaManagementHostTool[] = !options.includeAutomationTools
    ? []
    : [
        tool(
          "list_automations",
          "List a filtered page of Desktop Automations, schedule status, and continuity Missions.",
          z.toJSONSchema(ListAutomationsInput),
          async (args) => ok(await automations().list(ListAutomationsInput.parse(args))),
        ),
        {
          ...tool(
            "save_automation",
            "Create, edit, enable, or disable one complete Automation YAML resource with its Desktop workspace and permission binding.",
            z.toJSONSchema(SaveAutomationInput),
            async (args, context) =>
              ok(
                await automations().save({
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
                await automations().delete({
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
                await automations().resetSession({
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
      "List a filtered page of current Pragma DSL resources and the exact project revision.",
      z.toJSONSchema(ListDslResourcesInput),
      async (args) => ok(await project().list(ListDslResourcesInput.parse(args))),
    ),
    tool(
      "read_dsl_resource",
      "Read one current project resource or built-in system Expert as a bounded canonical YAML chunk.",
      z.toJSONSchema(ReadResourceInput),
      async (args) => {
        const input = ReadResourceInput.parse(args);
        const document = await project().read(input.ref);
        const { source, ...summary } = document;
        return ok({ ...summary, source: contentChunk(source, input.offset, input.limitChars) });
      },
    ),
    tool(
      "list_expert_options",
      "List one filtered category of host Runtime models, capabilities, avatar personas, or built-in Experts.",
      z.toJSONSchema(ListExpertOptionsInput),
      async (args) => ok(await project().listExpertOptions(ListExpertOptionsInput.parse(args))),
    ),
    tool(
      "allocate_dsl_resource_ids",
      "Allocate Host-generated stable IDs for new Pragma resources before authoring YAML.",
      z.toJSONSchema(AllocateResourceIdsInput),
      async (args) =>
        ok(await project().allocateResourceIds(AllocateResourceIdsInput.parse(args).requests)),
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
      async (args) => ok(summarizePrepareResult(await project().prepare(PrepareInput.parse(args)))),
    ),
    tool(
      "read_prepared_dsl_change",
      "Read a bounded canonical YAML chunk for one exact ref in a prepared DSL change-set.",
      z.toJSONSchema(ReadPreparedDslChangeInput),
      async (args) => {
        const input = ReadPreparedDslChangeInput.parse(args);
        const changeSet = await project().getChangeSet(input.changeSetId);
        const change = changeSet.changes.find((candidate) => candidate.ref === input.ref);
        if (change === undefined) throw new Error(`Prepared DSL change not found: ${input.ref}`);
        return ok({
          changeSetId: changeSet.changeSetId,
          ref: change.ref,
          kind: change.kind,
          source: contentChunk(change.source, input.offset, input.limitChars),
        });
      },
    ),
    tool(
      "create_flow_draft",
      "Create a durable incomplete Flow draft and return a compact summary.",
      z.toJSONSchema(CreateFlowDraftInput),
      async (args) =>
        ok(
          summarizeFlowDraftUpdate(
            await project().createFlowDraft(CreateFlowDraftInput.parse(args)),
            [],
          ),
        ),
    ),
    tool(
      "get_flow_draft",
      "Read a compact Flow draft summary by default; set includeResource only when the complete resource is needed.",
      z.toJSONSchema(GetFlowDraftInput),
      async (args) => {
        const input = GetFlowDraftInput.parse(args);
        const draft = await project().getFlowDraft(input.draftId);
        return ok(input.includeResource ? draft : summarizeFlowDraftUpdate(draft, []));
      },
    ),
    tool(
      "update_flow_draft",
      "Apply typed incremental operations to a Flow draft and return a compact validated revision summary. Use get_flow_draft when the complete resource is needed.",
      z.toJSONSchema(UpdateFlowDraftToolInput),
      async (args) => {
        const { input, warning } = parseUpdateFlowDraftInput(args);
        return ok(
          summarizeFlowDraftUpdate(
            await project().updateFlowDraft(input),
            input.operations,
            warning,
          ),
        );
      },
    ),
    tool(
      "validate_flow_draft",
      "Revalidate a Flow draft and return a compact revision summary without changing it.",
      z.toJSONSchema(DraftIdInput),
      async (args) => {
        const draft = await project().validateFlowDraft(DraftIdInput.parse(args).draftId);
        return ok(summarizeFlowDraftUpdate(draft, []));
      },
    ),
    tool(
      "create_evaluation_draft",
      "Create an empty incremental Evaluation draft for a committed Flow, or start editing one existing Evaluation.",
      z.toJSONSchema(CreateEvaluationDraftToolInput),
      async (args) => {
        return ok(
          summarizeEvaluationDraft(
            await project().createEvaluationDraft(CreateEvaluationDraftInput.parse(args)),
          ),
        );
      },
    ),
    tool(
      "get_evaluation_draft",
      "Read compact Evaluation draft metadata and a filtered page of case summaries.",
      z.toJSONSchema(GetEvaluationDraftInput),
      async (args) => {
        const input = GetEvaluationDraftInput.parse(args);
        return ok(viewEvaluationDraft(await project().getEvaluationDraft(input.draftId), input));
      },
    ),
    tool(
      "get_evaluation_cases",
      "Read full definitions for 1 to 10 exact Evaluation draft case IDs.",
      z.toJSONSchema(GetEvaluationCasesInput),
      async (args) => {
        const input = GetEvaluationCasesInput.parse(args);
        return ok(
          selectEvaluationCases(await project().getEvaluationDraft(input.draftId), input.caseIds),
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
            await project().updateEvaluationDraft(UpdateEvaluationDraftInput.parse(args)),
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
            await project().runEvaluationDraft(RunEvaluationDraftInput.parse(args)),
          ),
        ),
    ),
    tool(
      "prepare_evaluation_draft",
      "Rerun and independently prepare a passing Evaluation draft that targets a committed Flow. Pass the returned changeSetId to commit_dsl_changes to save only the Evaluation.",
      z.toJSONSchema(EvaluationDraftRevisionInput),
      async (args) =>
        ok(
          summarizePrepareResult(
            await project().prepareEvaluationDraft(EvaluationDraftRevisionInput.parse(args)),
          ),
        ),
    ),
    tool(
      "discard_evaluation_draft",
      "Discard an uncommitted Evaluation draft.",
      z.toJSONSchema(DraftIdInput),
      async (args) => {
        await project().discardEvaluationDraft(DraftIdInput.parse(args).draftId);
        return ok({ discarded: true });
      },
    ),
    tool(
      "prepare_flow_draft",
      "Prepare a structurally complete Flow and optional non-Evaluation dependency YAML sources. Evaluations are prepared and saved separately with prepare_evaluation_draft and commit_dsl_changes.",
      z.toJSONSchema(PrepareFlowDraftInput),
      async (args) =>
        ok(
          summarizePrepareResult(
            await project().prepareFlowDraft(PrepareFlowDraftInput.parse(args)),
          ),
        ),
    ),
    tool(
      "discard_flow_draft",
      "Discard an uncommitted Flow draft.",
      z.toJSONSchema(DraftIdInput),
      async (args) => {
        await project().discardFlowDraft(DraftIdInput.parse(args).draftId);
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
            await project().commit({
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
    tool(
      "list_missions",
      "List a filtered page of Pragma Missions and their current status.",
      z.toJSONSchema(ListMissionsInput),
      async (args) => ok(await missions().list(ListMissionsInput.parse(args))),
    ),
    tool(
      "get_mission",
      "Read one Pragma Mission summary and goal by exact missionId.",
      z.toJSONSchema(MissionIdInput),
      async (args) => ok(await missions().get(MissionIdInput.parse(args).missionId)),
    ),
    {
      ...tool(
        "create_mission",
        "Create and start a Mission with an exact Expert, Team, or Flow ref and explicit workspace.",
        z.toJSONSchema(CreateMissionInput),
        async (args, context) =>
          ok(
            await missions().submit({
              ...CreateMissionInput.parse(args),
              operationId: operationId(context),
            }),
          ),
      ),
      approval: { mode: "required", reason: "Start this Mission in the selected workspace." },
    },
    {
      ...tool(
        "send_mission_message",
        "Send a follow-up message to an existing conversational Mission.",
        z.toJSONSchema(SendMissionMessageInput),
        async (args, context) =>
          ok(
            await missions().sendMessage({
              ...SendMissionMessageInput.parse(args),
              operationId: operationId(context),
            }),
          ),
      ),
      approval: { mode: "required", reason: "Send this instruction to the selected Mission." },
    },
    tool(
      "list_mission_work_items",
      "List a filtered page of invocation work items for one Mission.",
      z.toJSONSchema(ListMissionWorkItemsInput),
      async (args) => ok(await missions().listWorkItems(ListMissionWorkItemsInput.parse(args))),
    ),
    tool(
      "get_mission_work_item",
      "Read one Mission work item by exact missionId and workItemId.",
      z.toJSONSchema(GetMissionWorkItemInput),
      async (args) => {
        const input = GetMissionWorkItemInput.parse(args);
        return ok(await missions().getWorkItem(input.missionId, input.workItemId));
      },
    ),
    tool(
      "interrupt_mission",
      "Interrupt the currently running execution of a Mission.",
      z.toJSONSchema(MissionIdInput),
      async (args) => ok(await missions().interrupt(MissionIdInput.parse(args).missionId)),
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
): PragmaManagementHostTool {
  const outputSchema = hostOutputSchema(name);
  const publishedOutputSchema = z.union([outputSchema, PragmaManagementErrorSchema]);
  return {
    name,
    description,
    inputSchema,
    outputSchema: z.toJSONSchema(publishedOutputSchema),
    approval: { mode: "none" },
    call: async (args, _signal, context) => {
      try {
        const value = await call(args, context);
        if (value.isError !== true) outputSchema.parse(value.details);
        if (Buffer.byteLength(value.text, "utf8") > 256 * 1024) {
          return managementErrorResult(new Error("response_too_large"), name);
        }
        return value;
      } catch (error) {
        return managementErrorResult(error, name);
      }
    },
  };
}

export const PRAGMA_MANAGEMENT_HOST_TOOL_DEFINITIONS = buildPragmaManagementHostTools({
  includeAutomationTools: true,
}).map(({ name, description, inputSchema, outputSchema, approval }) => ({
  name,
  description,
  inputSchema,
  outputSchema,
  approval,
}));

function ok(details: unknown): ExpertAgentToolCallResult {
  const text = JSON.stringify(details);
  return { text, details };
}

function managementErrorResult(error: unknown, toolName: string): ExpertAgentToolCallResult {
  const rawMessage = error instanceof Error ? error.message : "Unknown management tool failure.";
  const code =
    error instanceof z.ZodError
      ? "invalid_input"
      : /operations must|received a string|parsed string/iu.test(rawMessage)
        ? "invalid_input"
        : rawMessage === "cursor_invalid" || rawMessage === "cursor_expired"
          ? rawMessage
          : rawMessage === "response_too_large"
            ? "response_too_large"
            : /revision|stale|conflict/iu.test(rawMessage)
              ? "revision_conflict"
              : /not found|missing/iu.test(rawMessage)
                ? "not_found"
                : /permission|denied|not mounted/iu.test(rawMessage)
                  ? "permission_denied"
                  : /already.*attach/iu.test(rawMessage)
                    ? "already_attached"
                    : /unavailable/iu.test(rawMessage)
                      ? "unavailable"
                      : "internal_error";
  const payload = PragmaManagementErrorSchema.parse({
    schemaVersion: "pragma.management-error/v1",
    code,
    message:
      code === "internal_error"
        ? "The management tool failed unexpectedly."
        : rawMessage.slice(0, 2_000),
    retryable:
      ["revision_conflict", "cursor_expired"].includes(code) ||
      (code === "unavailable" && !rawMessage.includes("execution_context")),
    ...(error instanceof z.ZodError ? { details: { issues: error.issues } } : {}),
    ...(code === "cursor_expired"
      ? { recovery: { tool: toolName, reason: "Run the same listing again without cursor." } }
      : code === "response_too_large"
        ? {
            recovery: {
              tool: toolName,
              reason: "Use a smaller page limit, a narrower filter, or a bounded content range.",
            },
          }
        : {}),
  });
  return { text: JSON.stringify(payload), details: payload, isError: true };
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
    caseCount: draft.resource.spec.method.cases.length,
    diagnostics: draft.diagnostics,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

function viewEvaluationDraft(
  draft: PragmaAgentEvaluationDraft,
  input: z.infer<typeof GetEvaluationDraftInput>,
): z.infer<typeof PragmaAgentEvaluationDraftViewSchema> {
  const query = input.query?.toLocaleLowerCase();
  const summaries = draft.resource.spec.method.cases
    .map(({ id, name }) => ({ id, name }))
    .filter(
      (testCase) =>
        query === undefined ||
        testCase.id.toLocaleLowerCase().includes(query) ||
        testCase.name.toLocaleLowerCase().includes(query),
    );
  const offset = decodeEvaluationCursor(input.cursor, draft.draftId, draft.draftRevision, query);
  const cases = summaries.slice(offset, offset + input.limit);
  const nextOffset = offset + cases.length;
  return PragmaAgentEvaluationDraftViewSchema.parse({
    ...summarizeEvaluationDraft(draft),
    cases,
    ...(nextOffset < summaries.length
      ? {
          nextCursor: encodeEvaluationCursor(draft.draftId, draft.draftRevision, query, nextOffset),
        }
      : {}),
  });
}

function selectEvaluationCases(draft: PragmaAgentEvaluationDraft, caseIds: readonly string[]) {
  const casesById = new Map(
    draft.resource.spec.method.cases.map((testCase) => [testCase.id, testCase] as const),
  );
  const cases = caseIds.map((caseId) => {
    const testCase = casesById.get(caseId);
    if (testCase === undefined) throw new Error(`Evaluation draft case not found: ${caseId}`);
    return testCase;
  });
  return PragmaAgentEvaluationCasesSchema.parse({
    draftId: draft.draftId,
    draftRevision: draft.draftRevision,
    cases,
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

function contentChunk(source: string, offset: number, limitChars: number) {
  const content = source.slice(offset, offset + limitChars);
  const nextOffset = offset + content.length;
  return PragmaContentChunkSchema.parse({
    content,
    offset,
    sizeChars: content.length,
    totalChars: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    complete: nextOffset >= source.length,
    ...(nextOffset < source.length ? { nextOffset } : {}),
  });
}

function encodeEvaluationCursor(
  draftId: string,
  draftRevision: number,
  query: string | undefined,
  offset: number,
): string {
  return Buffer.from(JSON.stringify([1, draftId, draftRevision, query ?? null, offset])).toString(
    "base64url",
  );
}

function decodeEvaluationCursor(
  cursor: string | undefined,
  draftId: string,
  draftRevision: number,
  query: string | undefined,
): number {
  if (cursor === undefined) return 0;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor_invalid");
  }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== draftId) {
    throw new Error("cursor_invalid");
  }
  if (value[2] !== draftRevision) throw new Error("cursor_expired");
  if (value[3] !== (query ?? null) || !Number.isInteger(value[4]) || Number(value[4]) < 0) {
    throw new Error("cursor_invalid");
  }
  return Number(value[4]);
}

function summarizePrepareResult(input: PragmaAgentPrepareResult) {
  if (input.status === "invalid") return PragmaAgentCompactPrepareResultSchema.parse(input);
  return PragmaAgentCompactPrepareResultSchema.parse({
    status: "prepared",
    changeSet: {
      changeSetId: input.changeSet.changeSetId,
      projectRevision: input.changeSet.projectRevision,
      diagnostics: input.changeSet.diagnostics,
      changes: input.changeSet.changes.map(({ ref, kind, source }) => ({
        ref,
        kind,
        sizeBytes: Buffer.byteLength(source, "utf8"),
        sha256: createHash("sha256").update(source).digest("hex"),
      })),
      createdAt: input.changeSet.createdAt,
    },
  });
}

function hostOutputSchema(name: string): z.ZodType {
  switch (name) {
    case "list_dsl_resources":
      return PragmaAgentResourcePageSchema;
    case "read_dsl_resource":
      return ReadDslResourceResultSchema;
    case "list_expert_options":
      return PragmaAgentExpertOptionPageSchema;
    case "allocate_dsl_resource_ids":
      return AllocatedResourceIdsSchema;
    case "prepare_dsl_changes":
    case "prepare_flow_draft":
    case "prepare_evaluation_draft":
      return PragmaAgentCompactPrepareResultSchema;
    case "read_prepared_dsl_change":
      return PreparedDslChangeChunkSchema;
    case "create_flow_draft":
      return PragmaAgentFlowDraftUpdateSummarySchema;
    case "get_flow_draft":
      return z.union([PragmaAgentFlowDraftUpdateSummarySchema, PragmaAgentFlowDraftSchema]);
    case "update_flow_draft":
    case "validate_flow_draft":
      return PragmaAgentFlowDraftUpdateSummarySchema;
    case "create_evaluation_draft":
    case "update_evaluation_draft":
      return PragmaAgentEvaluationDraftSummarySchema;
    case "get_evaluation_draft":
      return PragmaAgentEvaluationDraftViewSchema;
    case "get_evaluation_cases":
      return PragmaAgentEvaluationCasesSchema;
    case "run_evaluation_draft":
      return PragmaAgentEvaluationDraftRunResultSchema;
    case "discard_evaluation_draft":
    case "discard_flow_draft":
      return DiscardResultSchema;
    case "commit_dsl_changes":
      return PragmaAgentProjectCommitSchema;
    case "list_missions":
      return PragmaAgentMissionPageSchema;
    case "get_mission":
    case "create_mission":
    case "send_mission_message":
    case "interrupt_mission":
      return PragmaAgentMissionSchema;
    case "list_mission_work_items":
      return PragmaAgentMissionWorkItemPageSchema;
    case "get_mission_work_item":
      return PragmaAgentMissionWorkItemDetailSchema;
    case "list_automations":
      return PragmaAgentAutomationPageSchema;
    case "save_automation":
    case "reset_automation_session":
      return PragmaAgentAutomationSummarySchema;
    case "delete_automation":
      return DeleteAutomationResultSchema;
    default:
      throw new Error(`Missing Pragma management output schema: ${name}`);
  }
}
