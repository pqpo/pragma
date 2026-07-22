import type {
  ExpertAgentManagedTool,
  ExpertAgentManagedToolCallContext,
  ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import type { DefaultAgentDslProjectPort, DefaultAgentTaskPort } from "./ports.ts";

const RefInput = z.object({ ref: z.string().min(1) });
const PrepareInput = z.object({
  expectedProjectRevision: z.number().int().nonnegative(),
  sources: z.array(z.string().min(1).max(2_000_000)).min(1).max(50),
});
const CommitInput = z.object({ changeSetId: z.string().uuid() });
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

type DefaultAgentTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export function createDefaultAgentTools(options: {
  readonly project: DefaultAgentDslProjectPort;
  readonly tasks: DefaultAgentTaskPort;
}): readonly DefaultAgentTool[] {
  const operationId = (context: ExpertAgentManagedToolCallContext | undefined): string => {
    const id = context?.toolCallId;
    if (id === undefined) throw new Error("A default Agent write tool requires a toolCallId.");
    return id;
  };
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

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
