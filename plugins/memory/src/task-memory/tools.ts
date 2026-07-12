import {
  createExpertAgentRunContext,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type RuntimeSessionRef,
} from "@pragma/core";
import type {
  MemorySystem,
  TaskMemoryAppendInput,
  TaskMemoryListInput,
  TaskMemoryPatchInput,
  TaskMemoryRecord,
} from "../memory-system/index.ts";

export function createTaskMemoryTools(options: {
  readonly memorySystem: MemorySystem;
  readonly defaultAgentId?: string | undefined;
}): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return [
    {
      name: "list_task_memory",
      description:
        "List task memory entries for the current Execution. Uses execution execution context by default.",
      inputSchema: objectSchema(
        {
          executionId: stringSchema("Execution id. Defaults to the current session Execution."),
          invocationId: stringSchema("Optional task run id filter."),
          runtimeSession: runtimeSessionSchema("Optional runtime session filter."),
          visibility: enumSchema(["shared", "private"], "Optional visibility filter."),
          status: {
            oneOf: [
              enumSchema(["active", "resolved", "archived"]),
              {
                type: "array",
                items: enumSchema(["active", "resolved", "archived"]),
              },
            ],
            description: "Optional status filter.",
          },
        },
        [],
      ),
      async call(args, _signal, context) {
        const scope = resolveTaskMemoryScope(args, context?.runContext, options.defaultAgentId, {
          requireExecutionId: true,
        });

        if (!scope.ok) {
          return scope.result;
        }

        const result = await options.memorySystem.listTaskMemory({
          executionId: scope.executionId!,
          actorAgentId: scope.actorAgentId,
          invocationId: readOptionalStringParam(args, "invocationId"),
          runtimeSession: readOptionalRuntimeSessionParam(args, "runtimeSession"),
          visibility: readOptionalVisibilityParam(args, "visibility"),
          status: readOptionalTaskMemoryStatusParam(args),
          context: scope.runContext,
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: formatTaskMemoryList(result.value),
          details: { entries: result.value },
        };
      },
    },
    {
      name: "get_task_memory",
      description: "Read a single task memory entry by id.",
      inputSchema: objectSchema({ id: stringSchema("Task memory entry id.") }, ["id"]),
      async call(args, _signal, context) {
        const runContext = createExpertAgentRunContext(context?.runContext);
        const result = await options.memorySystem.getTaskMemory({
          id: readStringParam(args, "id"),
          actorAgentId: resolveActorAgentId(runContext, options.defaultAgentId),
          context: runContext,
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: formatTaskMemoryRecord(result.value),
          details: { entry: result.value },
        };
      },
    },
    {
      name: "append_task_memory",
      description:
        "Append a task memory entry. Execution id defaults to the current execution context.",
      inputSchema: objectSchema(
        {
          executionId: stringSchema("Execution id. Defaults to the current session Execution."),
          invocationId: stringSchema("Optional task run id."),
          runtimeSession: runtimeSessionSchema("Optional runtime session provenance."),
          visibility: enumSchema(["shared", "private"], "Entry visibility."),
          kind: enumSchema(
            ["decision", "handoff", "note", "todo", "progress", "question"],
            "Task memory kind.",
          ),
          title: stringSchema("Optional entry title."),
          content: stringSchema("Entry content."),
          status: enumSchema(["active", "resolved", "archived"], "Optional entry status."),
          items: {
            type: "array",
            description: "Todo items. Required for todo entries.",
            items: objectSchema(
              {
                id: stringSchema("Todo item id."),
                text: stringSchema("Todo item text."),
                done: booleanSchema("Whether the todo item is complete."),
                assigneeAgentId: stringSchema("Optional assignee agent id."),
              },
              ["id", "text", "done"],
            ),
          },
        },
        ["visibility", "kind", "content"],
      ),
      async call(args, _signal, context) {
        const scope = resolveTaskMemoryScope(args, context?.runContext, options.defaultAgentId, {
          requireExecutionId: true,
        });

        if (!scope.ok) {
          return scope.result;
        }

        const visibility = readVisibilityParam(args, "visibility");
        const actorAgentId = scope.actorAgentId;
        const result = await options.memorySystem.appendTaskMemory({
          actorAgentId,
          record: {
            type: "task",
            scope: "session",
            executionId: scope.executionId!,
            invocationId: readOptionalStringParam(args, "invocationId") ?? scope.invocationId,
            runtimeSession: scope.runtimeSession,
            visibility,
            ownerAgentId: visibility === "private" ? actorAgentId : undefined,
            kind: readTaskMemoryKindParam(args, "kind"),
            title: readOptionalStringParam(args, "title"),
            content: readStringParam(args, "content"),
            status: readOptionalTaskMemorySingleStatusParam(args, "status") ?? "active",
            items: readOptionalTaskTodoItems(args, "items"),
          },
          context: scope.runContext,
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: `Appended task memory: ${result.value.id}`,
          details: { entry: result.value },
        };
      },
    },
    {
      name: "patch_task_memory",
      description: "Patch a task memory entry using optimistic concurrency via expectedRevision.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Task memory entry id."),
          expectedRevision: integerSchema("Current revision expected by the caller."),
          title: stringSchema("Optional replacement title."),
          content: stringSchema("Optional replacement content."),
          status: enumSchema(["active", "resolved", "archived"], "Optional replacement status."),
          items: {
            type: "array",
            description: "Optional full todo item replacement for todo entries.",
            items: objectSchema(
              {
                id: stringSchema("Todo item id."),
                text: stringSchema("Todo item text."),
                done: booleanSchema("Whether the todo item is complete."),
                assigneeAgentId: stringSchema("Optional assignee agent id."),
              },
              ["id", "text", "done"],
            ),
          },
        },
        ["id", "expectedRevision"],
      ),
      async call(args, _signal, context) {
        const runContext = createExpertAgentRunContext(context?.runContext);
        const result = await options.memorySystem.patchTaskMemory({
          id: readStringParam(args, "id"),
          actorAgentId: resolveActorAgentId(runContext, options.defaultAgentId),
          expectedRevision: readNumberParam(args, "expectedRevision"),
          patch: {
            title: readOptionalStringParam(args, "title"),
            content: readOptionalStringParam(args, "content"),
            status: readOptionalTaskMemorySingleStatusParam(args, "status"),
            items: readOptionalTaskTodoItems(args, "items"),
          },
          context: runContext,
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: `Patched task memory: ${result.value.id} @ revision ${result.value.revision}`,
          details: { entry: result.value },
        };
      },
    },
  ];
}

function resolveTaskMemoryScope(
  args: unknown,
  runContextInput: Parameters<typeof createExpertAgentRunContext>[0],
  defaultAgentId: string | undefined,
  requirements: {
    readonly requireExecutionId: boolean;
  },
):
  | {
      readonly ok: true;
      readonly executionId?: string | undefined;
      readonly actorAgentId: string;
      readonly invocationId?: string | undefined;
      readonly runtimeSession?: RuntimeSessionRef | undefined;
      readonly runContext: ReturnType<typeof createExpertAgentRunContext>;
    }
  | {
      readonly ok: false;
      readonly result: ExpertAgentToolCallResult;
    } {
  const runContext = createExpertAgentRunContext(runContextInput);
  const runScope = readExecutionRunScope(runContext);
  const executionId = readOptionalStringParam(args, "executionId") ?? runScope.executionId;
  const runtimeSession =
    readOptionalRuntimeSessionParam(args, "runtimeSession") ?? runScope.runtimeSession;

  if (requirements.requireExecutionId && (executionId === undefined || executionId.length === 0)) {
    return {
      ok: false as const,
      result: {
        text: "Task memory operation requires executionId. Provide it explicitly or run the agent inside a execution execution context.",
        isError: true,
      },
    };
  }

  return {
    ok: true as const,
    executionId,
    actorAgentId: resolveActorAgentId(runContext, defaultAgentId),
    invocationId: runScope.invocationId,
    runtimeSession,
    runContext,
  };
}

function resolveActorAgentId(
  runContext: ReturnType<typeof createExpertAgentRunContext>,
  defaultAgentId: string | undefined,
): string {
  return runContext.source?.id ?? defaultAgentId ?? "unknown-agent";
}

function readStringParam(params: unknown, key: string): string {
  const value = readParam(params, key);

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Task memory tool requires string parameter "${key}".`);
}

function readOptionalStringParam(params: unknown, key: string): string | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Task memory tool parameter "${key}" must be a string when provided.`);
}

function readOptionalRuntimeSessionParam(
  params: unknown,
  key: string,
): RuntimeSessionRef | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.id === "string" &&
    value.id.length > 0
  ) {
    return { type: value.type, id: value.id };
  }

  throw new Error(
    `Task memory tool parameter "${key}" must contain non-empty string type and id fields.`,
  );
}

function readNumberParam(params: unknown, key: string): number {
  const value = readParam(params, key);

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Task memory tool requires number parameter "${key}".`);
}

function readVisibilityParam(params: unknown, key: string): "shared" | "private" {
  const value = readParam(params, key);

  if (value === "shared" || value === "private") {
    return value;
  }

  throw new Error(
    `Task memory tool requires visibility parameter "${key}" to be shared or private.`,
  );
}

function readOptionalVisibilityParam(
  params: unknown,
  key: string,
): "shared" | "private" | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (value === "shared" || value === "private") {
    return value;
  }

  throw new Error(`Task memory tool parameter "${key}" must be shared or private when provided.`);
}

function readTaskMemoryKindParam(
  params: unknown,
  key: string,
): TaskMemoryAppendInput["record"]["kind"] {
  const value = readParam(params, key);

  if (
    value === "decision" ||
    value === "handoff" ||
    value === "note" ||
    value === "todo" ||
    value === "progress" ||
    value === "question"
  ) {
    return value;
  }

  throw new Error(`Task memory tool parameter "${key}" must be a supported task memory kind.`);
}

function readOptionalTaskMemorySingleStatusParam(
  params: unknown,
  key: string,
): TaskMemoryRecord["status"] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (value === "active" || value === "resolved" || value === "archived") {
    return value;
  }

  throw new Error(`Task memory tool parameter "${key}" must be active, resolved, or archived.`);
}

function readOptionalTaskMemoryStatusParam(
  params: unknown,
): TaskMemoryListInput["status"] | undefined {
  const value = readParam(params, "status");

  if (value === undefined) {
    return undefined;
  }

  if (value === "active" || value === "resolved" || value === "archived") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === "active" || item === "resolved" || item === "archived") {
        return item;
      }

      throw new Error(
        'Task memory tool parameter "status" contains an invalid task memory status.',
      );
    });
  }

  throw new Error('Task memory tool parameter "status" must be a task memory status or array.');
}

function readOptionalTaskTodoItems(
  params: unknown,
  key: string,
): TaskMemoryAppendInput["record"]["items"] | TaskMemoryPatchInput["patch"]["items"] {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Task memory tool parameter "${key}" must be an array when provided.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Task memory tool parameter "${key}" item ${index} must be an object.`);
    }

    if (
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      typeof item.done !== "boolean"
    ) {
      throw new Error(
        `Task memory tool parameter "${key}" item ${index} requires string id, string text, and boolean done.`,
      );
    }

    if (item.assigneeAgentId !== undefined && typeof item.assigneeAgentId !== "string") {
      throw new Error(
        `Task memory tool parameter "${key}" item ${index} assigneeAgentId must be a string when provided.`,
      );
    }

    return {
      id: item.id,
      text: item.text,
      done: item.done,
      assigneeAgentId: item.assigneeAgentId === undefined ? undefined : item.assigneeAgentId,
    };
  });
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params === "object" && params !== null && key in params) {
    return (params as Record<string, unknown>)[key];
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatTaskMemoryList(entries: readonly TaskMemoryRecord[]): string {
  if (entries.length === 0) {
    return "No task memory entries found.";
  }

  return entries.map(formatTaskMemoryRecord).join("\n\n");
}

function formatTaskMemoryRecord(entry: TaskMemoryRecord): string {
  const lines = [
    `- id: ${entry.id}`,
    `  executionId: ${entry.executionId}`,
    entry.invocationId === undefined ? undefined : `  invocationId: ${entry.invocationId}`,
    `  visibility: ${entry.visibility}`,
    entry.ownerAgentId === undefined ? undefined : `  ownerAgentId: ${entry.ownerAgentId}`,
    `  kind: ${entry.kind}`,
    `  status: ${entry.status}`,
    `  revision: ${entry.revision}`,
    entry.title === undefined ? undefined : `  title: ${entry.title}`,
    "  content:",
    ...entry.content.split("\n").map((line) => `    ${line}`),
    ...(entry.items === undefined || entry.items.length === 0
      ? []
      : [
          "  items:",
          ...entry.items.map(
            (item) =>
              `    - [${item.done ? "x" : " "}] ${item.id}: ${item.text}${
                item.assigneeAgentId === undefined ? "" : ` @${item.assigneeAgentId}`
              }`,
          ),
        ]),
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function taskMemoryErrorResult(message: string, error: unknown): ExpertAgentToolCallResult {
  return {
    text: `Task memory operation failed: ${message}`,
    isError: true,
    details: { error },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    required: [...required],
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    description,
  };
}

function runtimeSessionSchema(description: string): Record<string, unknown> {
  return {
    ...objectSchema(
      {
        type: stringSchema("Runtime adapter kind."),
        id: stringSchema("Runtime-native session id."),
      },
      ["type", "id"],
    ),
    description,
  };
}

function integerSchema(description: string): Record<string, unknown> {
  return {
    type: "integer",
    description,
  };
}

function booleanSchema(description: string): Record<string, unknown> {
  return {
    type: "boolean",
    description,
  };
}

function enumSchema(values: readonly string[], description?: string): Record<string, unknown> {
  return {
    type: "string",
    enum: [...values],
    ...(description === undefined ? {} : { description }),
  };
}
