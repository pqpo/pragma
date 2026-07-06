import type {
  ContextTrigger,
  ExpertAgentContextItem,
  ExpertAgentContextAddInput,
  ExpertAgentContextItemDeleteResult,
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextError,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemReadInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextItemUpdateInput,
} from "./context-system.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import {
  createExpertAgentRunContext,
  readTaskMemoryRunScope,
} from "../runtime/run-context.ts";
import type {
  TaskMemoryAppendInput,
  TaskMemoryGetInput,
  TaskMemoryListInput,
  TaskMemoryPatchInput,
  MemoryResult,
  TaskMemoryRecord,
} from "../memory-system/types.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentToolApproval,
  ExpertAgentUserQuestion,
} from "../tools/managed-tool.ts";

export interface ExpertAgentDefaultToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export interface ExpertAgentDefaultTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly approval?: ExpertAgentToolApproval | undefined;
  readonly call: (
    args: unknown,
    signal: AbortSignal | undefined,
    context?: {
      readonly humanInteraction?: ExpertAgentHumanInteractionHandler | undefined;
      readonly toolCallId?: string | undefined;
    },
  ) => Promise<ExpertAgentDefaultToolCallResult>;
}

export interface CreateContextToolsOptions {
  readonly getContext?: (() => ExpertAgentRunContext | undefined) | undefined;
  readonly readByteBudget?: number | undefined;
  readonly agentId?: string | undefined;
}

export interface ExpertAgentContextItemOperations {
  readonly listContext: (
    context?: ExpertAgentRunContext,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>>;
  readonly readContext: (
    input: ExpertAgentContextItemReadInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly searchContext: (
    input: ExpertAgentContextItemSearchInput,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>>;
  readonly addContext: (
    input: ExpertAgentContextAddInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly updateContext: (
    input: ExpertAgentContextItemUpdateInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly deleteContext: (
    input: ExpertAgentContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItemDeleteResult>>;
  readonly listTaskMemory?: (
    input: TaskMemoryListInput,
  ) => Promise<MemoryResult<readonly TaskMemoryRecord[]>>;
  readonly getTaskMemory?: (
    input: TaskMemoryGetInput,
  ) => Promise<MemoryResult<TaskMemoryRecord>>;
  readonly appendTaskMemory?: (
    input: TaskMemoryAppendInput,
  ) => Promise<MemoryResult<TaskMemoryRecord>>;
  readonly patchTaskMemory?: (
    input: TaskMemoryPatchInput,
  ) => Promise<MemoryResult<TaskMemoryRecord>>;
}

export function createContextTools(
  contextOperations: ExpertAgentContextItemOperations,
  options: CreateContextToolsOptions = {},
): readonly ExpertAgentDefaultTool[] {
  return [
    createAskUserQuestionTool(),
    {
      name: "list_expert_context",
      label: "List expert context",
      description: "List ExpertAgent context by context id, description, and trigger.",
      inputSchema: objectSchema({}),
      call: async () => {
        const result = await contextOperations.listContext(readRunContext(options));

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: formatContextSummaries(result.value),
          details: {
            context: result.value,
          },
        };
      },
    },
    {
      name: "read_expert_context",
      label: "Read expert context",
      description: "Read an ExpertAgent context by context id, optionally as a byte range.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Context id."),
          namespace: stringSchema("Context namespace."),
          start: integerSchema("Zero-based UTF-8 byte offset to start reading from."),
          offset: integerSchema("Maximum UTF-8 bytes to read from start."),
        },
        ["namespace", "id"],
      ),
      call: async (args) => {
        const id = readStringParam(args, "id");
        const requestedOffset = readOptionalNumberParam(args, "offset");
        const result = await contextOperations.readContext({
          namespace: readStringParam(args, "namespace"),
          id,
          start: readOptionalNumberParam(args, "start"),
          offset: normalizeToolReadOffset(requestedOffset, options),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: formatContext(result.value),
          details: {
            context: result.value,
          },
        };
      },
    },
    {
      name: "search_expert_context",
      label: "Search expert context",
      description: "Search ExpertAgent context by literal text.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Optional context namespace. Omit to search every namespace."),
          query: stringSchema("Literal text to search for."),
          maxResults: integerSchema("Maximum number of matches to return. Defaults to 20."),
          contextLines: integerSchema("Number of context lines around each match. Defaults to 0."),
          caseSensitive: booleanSchema(
            "Whether search should be case-sensitive. Defaults to false.",
          ),
        },
        ["query"],
      ),
      call: async (args) => {
        const result = await contextOperations.searchContext({
          namespace: readOptionalStringParam(args, "namespace"),
          query: readStringParam(args, "query"),
          maxResults: readOptionalNumberParam(args, "maxResults"),
          contextLines: readOptionalNumberParam(args, "contextLines"),
          caseSensitive: readOptionalBooleanParam(args, "caseSensitive"),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: formatContextSearchMatches(result.value),
          details: {
            matches: result.value,
          },
        };
      },
    },
    {
      name: "add_expert_context",
      label: "Add expert context",
      description: "Add an ExpertAgent context item to a context namespace by context id.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
          content: stringSchema("Context content."),
          description: stringSchema("Optional context description."),
          trigger: triggerSchema(),
        },
        ["namespace", "id", "content"],
      ),
      call: async (args) => {
        const result = await contextOperations.addContext({
          namespace: readStringParam(args, "namespace"),
          id: readStringParam(args, "id"),
          content: readStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Added context: ${result.value.namespace}/${result.value.id}`,
          details: {
            context: result.value,
          },
        };
      },
    },
    {
      name: "update_expert_context",
      label: "Update expert context",
      description: "Update an ExpertAgent context's content or metadata by context id.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
          content: stringSchema("Optional replacement context content."),
          description: stringSchema("Optional replacement context description."),
          trigger: triggerSchema(),
        },
        ["namespace", "id"],
      ),
      call: async (args) => {
        const result = await contextOperations.updateContext({
          namespace: readStringParam(args, "namespace"),
          id: readStringParam(args, "id"),
          content: readOptionalStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Updated context: ${result.value.namespace}/${result.value.id}`,
          details: {
            context: result.value,
          },
        };
      },
    },
    {
      name: "delete_expert_context",
      label: "Delete expert context",
      description: "Delete an ExpertAgent context by context id.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
        },
        ["namespace", "id"],
      ),
      call: async (args) => {
        const namespace = readStringParam(args, "namespace");
        const id = readStringParam(args, "id");
        const result = await contextOperations.deleteContext({
          namespace,
          id,
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Deleted context: ${namespace}/${id}`,
          details: {
            namespace,
            id,
          },
        };
      },
    },
    ...createTaskMemoryTools(contextOperations, options),
  ];
}

function createTaskMemoryTools(
  contextOperations: ExpertAgentContextItemOperations,
  options: CreateContextToolsOptions,
): readonly ExpertAgentDefaultTool[] {
  if (
    contextOperations.listTaskMemory === undefined ||
    contextOperations.getTaskMemory === undefined ||
    contextOperations.appendTaskMemory === undefined ||
    contextOperations.patchTaskMemory === undefined
  ) {
    return [];
  }

  return [
    {
      name: "list_task_memory",
      label: "List task memory",
      description:
        "List task memory entries for the current workflow run. Uses session workflow context by default.",
      inputSchema: objectSchema(
        {
          workflowRunId: stringSchema("Workflow run id. Defaults to the current session workflow run."),
          taskRunId: stringSchema("Optional task run id filter."),
          visibility: {
            type: "string",
            enum: ["shared", "private"],
            description: "Optional visibility filter.",
          },
          status: {
            oneOf: [
              {
                type: "string",
                enum: ["active", "resolved", "archived"],
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["active", "resolved", "archived"],
                },
              },
            ],
            description: "Optional status filter.",
          },
        },
        [],
      ),
      call: async (args) => {
        const scope = resolveTaskMemoryScope(args, options, true);

        if (!scope.ok) {
          return scope.result;
        }

        const result = await contextOperations.listTaskMemory!({
          workflowRunId: scope.workflowRunId,
          actorAgentId: scope.actorAgentId,
          taskRunId: readOptionalStringParam(args, "taskRunId"),
          visibility: readOptionalVisibilityParam(args, "visibility"),
          status: readOptionalTaskMemoryStatusParam(args),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: formatTaskMemoryList(result.value),
          details: {
            entries: result.value,
          },
        };
      },
    },
    {
      name: "get_task_memory",
      label: "Get task memory",
      description: "Read a single task memory entry by id.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Task memory entry id."),
        },
        ["id"],
      ),
      call: async (args) => {
        const actorAgentId = resolveActorAgentId(options);
        const result = await contextOperations.getTaskMemory!({
          id: readStringParam(args, "id"),
          actorAgentId,
          context: readRunContext(options),
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: formatTaskMemoryRecord(result.value),
          details: {
            entry: result.value,
          },
        };
      },
    },
    {
      name: "append_task_memory",
      label: "Append task memory",
      description:
        "Append a task memory entry. Workflow run id defaults to the current session workflow run.",
      inputSchema: objectSchema(
        {
          workflowRunId: stringSchema("Workflow run id. Defaults to the current session workflow run."),
          taskRunId: stringSchema("Optional task run id."),
          runtimeSessionId: stringSchema("Optional runtime session id."),
          visibility: {
            type: "string",
            enum: ["shared", "private"],
            description: "Entry visibility.",
          },
          kind: {
            type: "string",
            enum: ["decision", "handoff", "note", "todo", "progress", "question"],
            description: "Task memory kind.",
          },
          title: stringSchema("Optional entry title."),
          content: stringSchema("Entry content."),
          status: {
            type: "string",
            enum: ["active", "resolved", "archived"],
            description: "Optional entry status. Defaults to active.",
          },
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
      call: async (args) => {
        const scope = resolveTaskMemoryScope(args, options, true);

        if (!scope.ok) {
          return scope.result;
        }

        const visibility = readVisibilityParam(args, "visibility");
        const actorAgentId = scope.actorAgentId;
        const result = await contextOperations.appendTaskMemory!({
          actorAgentId,
          record: {
            type: "task",
            scope: "session",
            workflowRunId: scope.workflowRunId,
            taskRunId: readOptionalStringParam(args, "taskRunId") ?? scope.taskRunId,
            runtimeSessionId:
              readOptionalStringParam(args, "runtimeSessionId") ?? scope.runtimeSessionId,
            visibility,
            ownerAgentId: visibility === "private" ? actorAgentId : undefined,
            kind: readTaskMemoryKindParam(args, "kind"),
            title: readOptionalStringParam(args, "title"),
            content: readStringParam(args, "content"),
            status: readOptionalTaskMemorySingleStatusParam(args, "status") ?? "active",
            items: readOptionalTaskTodoItems(args, "items"),
          },
          context: readRunContext(options),
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: `Appended task memory: ${result.value.id}`,
          details: {
            entry: result.value,
          },
        };
      },
    },
    {
      name: "patch_task_memory",
      label: "Patch task memory",
      description: "Patch a task memory entry using optimistic concurrency via expectedRevision.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Task memory entry id."),
          expectedRevision: integerSchema("Current revision expected by the caller."),
          title: stringSchema("Optional replacement title."),
          content: stringSchema("Optional replacement content."),
          status: {
            type: "string",
            enum: ["active", "resolved", "archived"],
            description: "Optional replacement status.",
          },
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
      call: async (args) => {
        const actorAgentId = resolveActorAgentId(options);
        const result = await contextOperations.patchTaskMemory!({
          id: readStringParam(args, "id"),
          actorAgentId,
          expectedRevision: readNumberParam(args, "expectedRevision"),
          patch: {
            title: readOptionalStringParam(args, "title"),
            content: readOptionalStringParam(args, "content"),
            status: readOptionalTaskMemorySingleStatusParam(args, "status"),
            items: readOptionalTaskTodoItems(args, "items"),
          },
          context: readRunContext(options),
        });

        if (!result.ok) {
          return taskMemoryErrorResult(result.error.message, result.error);
        }

        return {
          text: `Patched task memory: ${result.value.id} @ revision ${result.value.revision}`,
          details: {
            entry: result.value,
          },
        };
      },
    },
  ];
}

function createAskUserQuestionTool(): ExpertAgentDefaultTool {
  return {
    name: "askUserQuestion",
    label: "Ask user question",
    description:
      "Ask the user structured questions and return answers. Supports single choice, multiple choice, and direct text answers.",
    approval: {
      mode: "none",
    },
    inputSchema: objectSchema(
      {
        questions: {
          type: "array",
          items: objectSchema(
            {
              question: stringSchema("Complete question text."),
              header: stringSchema("Short label shown to the user."),
              kind: {
                type: "string",
                enum: ["single_choice", "multiple_choice", "text"],
                description:
                  "Question type. Defaults to single_choice when options are present, otherwise text.",
              },
              options: {
                type: "array",
                items: objectSchema(
                  {
                    label: stringSchema("Answer option label."),
                    description: stringSchema("Short option description."),
                  },
                  ["label"],
                ),
              },
            },
            ["question", "header", "options"],
          ),
        },
      },
      ["questions"],
    ),
    call: async (args, _signal, context) => {
      const questions = readAskUserQuestions(args);
      if (questions.length === 0) {
        return {
          text: "Invalid askUserQuestion input: questions array is empty or missing.",
          isError: true,
        };
      }

      const humanInteraction = context?.humanInteraction;

      if (humanInteraction === undefined) {
        return {
          text: questions.map(formatAskUserQuestion).join("\n\n"),
        };
      }

      const response = await humanInteraction({
        kind: "user_question",
        toolName: "askUserQuestion",
        toolCallId: context?.toolCallId,
        questions,
      });

      if (response.kind !== "user_question" || !response.answered) {
        return {
          text:
            response.kind === "user_question" && response.reason !== undefined
              ? response.reason
              : "User declined to answer the question.",
          isError: true,
        };
      }

      return {
        text:
          response.answers === undefined
            ? "User answered the question."
            : JSON.stringify(response.answers, null, 2),
        details: response.answers,
      };
    },
  };
}

function readAskUserQuestions(args: unknown): readonly ExpertAgentUserQuestion[] {
  if (!isRecord(args) || !Array.isArray(args.questions)) {
    return [];
  }

  return args.questions
    .filter(isRecord)
    .map((question: Record<string, unknown>) => ({
      question: typeof question.question === "string" ? question.question : "",
      header: typeof question.header === "string" ? question.header : "",
      kind: readAskUserQuestionKind(question),
      options: Array.isArray(question.options)
        ? question.options
            .filter(isRecord)
            .map((option: Record<string, unknown>) => ({
              label: typeof option.label === "string" ? option.label : "",
              description: typeof option.description === "string" ? option.description : "",
            }))
            .filter((option) => option.label.length > 0)
        : [],
    }))
    .filter(
      (question) =>
        question.question.length > 0 &&
        question.header.length > 0 &&
        (question.kind === "text" || question.options.length > 0),
    );
}

function readAskUserQuestionKind(
  question: Record<string, unknown>,
): "single_choice" | "multiple_choice" | "text" {
  if (
    question.kind === "single_choice" ||
    question.kind === "multiple_choice" ||
    question.kind === "text"
  ) {
    return question.kind;
  }

  return Array.isArray(question.options) && question.options.length > 0 ? "single_choice" : "text";
}

function formatAskUserQuestion(question: {
  readonly question: string;
  readonly header: string;
  readonly kind: "single_choice" | "multiple_choice" | "text";
  readonly options: readonly { readonly label: string; readonly description: string }[];
}): string {
  const lines = [`${question.header}: ${question.question}`, `type: ${question.kind}`];

  if (question.options.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    "options:",
    ...question.options.map((option) =>
      option.description.length === 0
        ? `- ${option.label}`
        : `- ${option.label}: ${option.description}`,
    ),
  ].join("\n");
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): unknown {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): unknown {
  return {
    type: "string",
    description,
  };
}

function integerSchema(description: string): unknown {
  return {
    type: "integer",
    description,
  };
}

function booleanSchema(description: string): unknown {
  return {
    type: "boolean",
    description,
  };
}

function triggerSchema(): unknown {
  return {
    type: "string",
    enum: ["always_on", "model_decision", "manual"],
    description: "Context trigger. Defaults to model_decision when omitted.",
  };
}

function readStringParam(params: unknown, key: string): string {
  const value = readParam(params, key);

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Context tool requires string parameter "${key}".`);
}

function readOptionalStringParam(params: unknown, key: string): string | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Context tool parameter "${key}" must be a string when provided.`);
}

function readNumberParam(params: unknown, key: string): number {
  const value = readParam(params, key);

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Context tool requires number parameter "${key}".`);
}

function readOptionalNumberParam(params: unknown, key: string): number | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Context tool parameter "${key}" must be a number when provided.`);
}

function readOptionalBooleanParam(params: unknown, key: string): boolean | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`Context tool parameter "${key}" must be a boolean when provided.`);
}

function readVisibilityParam(params: unknown, key: string): "shared" | "private" {
  const value = readParam(params, key);

  if (value === "shared" || value === "private") {
    return value;
  }

  throw new Error(`Context tool requires visibility parameter "${key}" to be shared or private.`);
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

  throw new Error(`Context tool parameter "${key}" must be shared or private when provided.`);
}

function readTaskMemoryKindParam(
  params: unknown,
  key: string,
): "decision" | "handoff" | "note" | "todo" | "progress" | "question" {
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

  throw new Error(`Context tool parameter "${key}" must be a supported task memory kind.`);
}

function readOptionalTaskMemorySingleStatusParam(
  params: unknown,
  key: string,
): "active" | "resolved" | "archived" | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (value === "active" || value === "resolved" || value === "archived") {
    return value;
  }

  throw new Error(`Context tool parameter "${key}" must be active, resolved, or archived.`);
}

function readOptionalTaskMemoryStatusParam(
  params: unknown,
): "active" | "resolved" | "archived" | readonly ("active" | "resolved" | "archived")[] | undefined {
  const value = readParam(params, "status");

  if (value === undefined) {
    return undefined;
  }

  if (value === "active" || value === "resolved" || value === "archived") {
    return value;
  }

  if (Array.isArray(value)) {
    const statuses = value.map((item) => {
      if (item === "active" || item === "resolved" || item === "archived") {
        return item;
      }

      throw new Error('Context tool parameter "status" contains an invalid task memory status.');
    });

    return statuses;
  }

  throw new Error('Context tool parameter "status" must be a task memory status or array.');
}

function readOptionalTaskTodoItems(
  params: unknown,
  key: string,
): readonly {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly assigneeAgentId?: string | undefined;
}[] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Context tool parameter "${key}" must be an array when provided.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Context tool parameter "${key}" item ${index} must be an object.`);
    }

    if (typeof item.id !== "string" || typeof item.text !== "string" || typeof item.done !== "boolean") {
      throw new Error(
        `Context tool parameter "${key}" item ${index} requires string id, string text, and boolean done.`,
      );
    }

    if (item.assigneeAgentId !== undefined && typeof item.assigneeAgentId !== "string") {
      throw new Error(
        `Context tool parameter "${key}" item ${index} assigneeAgentId must be a string when provided.`,
      );
    }

    return {
      id: item.id,
      text: item.text,
      done: item.done,
      assigneeAgentId:
        item.assigneeAgentId === undefined ? undefined : item.assigneeAgentId,
    };
  });
}

function normalizeToolReadOffset(
  requestedOffset: number | undefined,
  options: CreateContextToolsOptions,
): number {
  const budget = Math.max(1, Math.trunc(options.readByteBudget ?? 8_000));

  if (requestedOffset === undefined) {
    return budget;
  }

  return Math.min(Math.max(1, Math.trunc(requestedOffset)), budget);
}

function readMetadataParams(params: unknown): Partial<ExpertAgentContextItemMetadata> {
  const description = readOptionalStringParam(params, "description");
  const trigger = readOptionalTriggerParam(params);

  return {
    ...(description === undefined ? {} : { description }),
    ...(trigger === undefined ? {} : { trigger }),
  };
}

function readOptionalTriggerParam(params: unknown): ContextTrigger | undefined {
  const value = readParam(params, "trigger");

  if (value === undefined) {
    return undefined;
  }

  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  throw new Error('Context tool parameter "trigger" must be always_on, model_decision, or manual.');
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

function readRunContext(options: CreateContextToolsOptions): ExpertAgentRunContext {
  const baseContext = options.getContext?.();

  return createExpertAgentRunContext(baseContext);
}

function resolveActorAgentId(options: CreateContextToolsOptions): string {
  const context = readRunContext(options);
  const actorAgentId = context.source?.id;

  return actorAgentId ?? options.agentId ?? "unknown-agent";
}

function resolveTaskMemoryScope(
  args: unknown,
  options: CreateContextToolsOptions,
  requireWorkflowRunId: true,
):
  | {
      readonly ok: true;
      readonly workflowRunId: string;
      readonly actorAgentId: string;
      readonly taskRunId?: string | undefined;
      readonly runtimeSessionId?: string | undefined;
    }
  | {
      readonly ok: false;
      readonly result: ExpertAgentDefaultToolCallResult;
    };
function resolveTaskMemoryScope(
  args: unknown,
  options: CreateContextToolsOptions,
  requireWorkflowRunId: false,
):
  | {
      readonly ok: true;
      readonly workflowRunId?: string | undefined;
      readonly actorAgentId: string;
      readonly taskRunId?: string | undefined;
      readonly runtimeSessionId?: string | undefined;
    }
  | {
      readonly ok: false;
      readonly result: ExpertAgentDefaultToolCallResult;
    };
function resolveTaskMemoryScope(
  args: unknown,
  options: CreateContextToolsOptions,
  requireWorkflowRunId: boolean,
):
  | {
      readonly ok: true;
      readonly workflowRunId?: string | undefined;
      readonly actorAgentId: string;
      readonly taskRunId?: string | undefined;
      readonly runtimeSessionId?: string | undefined;
    }
  | {
      readonly ok: false;
      readonly result: ExpertAgentDefaultToolCallResult;
    } {
  const context = readRunContext(options);
  const runScope = readTaskMemoryRunScope(context);
  const workflowRunId = readOptionalStringParam(args, "workflowRunId") ?? runScope.workflowRunId;

  if (requireWorkflowRunId && (workflowRunId === undefined || workflowRunId.length === 0)) {
    return {
      ok: false,
      result: {
        text:
          "Task memory operation requires workflowRunId. Provide it explicitly or run the agent inside a workflow execution context.",
        isError: true,
      },
    };
  }

  return {
    ok: true,
    workflowRunId,
    actorAgentId: resolveActorAgentId(options),
    taskRunId: runScope.taskRunId,
    runtimeSessionId: runScope.runtimeSessionId,
  };
}

function formatContextSummaries(context: readonly ExpertAgentContextItemSummary[]): string {
  if (context.length === 0) {
    return "No ExpertAgent context items are available.";
  }

  return context.map(formatContextSummary).join("\n");
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
    `  workflowRunId: ${entry.workflowRunId}`,
    entry.taskRunId === undefined ? undefined : `  taskRunId: ${entry.taskRunId}`,
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
          ...entry.items.map((item) =>
            `    - [${item.done ? "x" : " "}] ${item.id}: ${item.text}${
              item.assigneeAgentId === undefined ? "" : ` @${item.assigneeAgentId}`
            }`,
          ),
        ]),
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function taskMemoryErrorResult(
  message: string,
  error: unknown,
): ExpertAgentDefaultToolCallResult {
  return {
    text: `Task memory operation failed: ${message}`,
    isError: true,
    details: {
      error,
    },
  };
}

function formatContextSummary(context: ExpertAgentContextItemSummary): string {
  return [
    `- id: ${context.id}`,
    context.namespace === undefined ? undefined : `  namespace: ${context.namespace}`,
    context.metadata.description === undefined
      ? undefined
      : `  description: ${context.metadata.description}`,
    `  trigger: ${context.metadata.trigger}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatContext(context: ExpertAgentContextItem): string {
  return [
    formatContextSummary(context),
    ...formatContentRange(context),
    "  content:",
    context.content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  ].join("\n");
}

function formatContentRange(context: ExpertAgentContextItem): readonly string[] {
  if (context.contentRange === undefined) {
    return [];
  }

  const byteTotal =
    context.contentRange.sizeBytes === undefined
      ? "unknown total bytes"
      : `${context.contentRange.sizeBytes} total bytes`;
  const lineTotal =
    context.contentRange.totalLines === undefined
      ? "unknown total lines"
      : `${context.contentRange.totalLines} total lines`;
  const lineRange =
    context.contentRange.startLine === undefined || context.contentRange.endLine === undefined
      ? "unknown lines"
      : `lines ${context.contentRange.startLine}-${context.contentRange.endLine}`;
  const lines = [
    `  contentRange: requestedStart=${context.contentRange.requestedStartOffset}; bytes ${context.contentRange.startOffset}-${context.contentRange.endOffset}; nextStart=${context.contentRange.nextStartOffset}; ${lineRange}; ${byteTotal}; ${lineTotal}`,
  ];

  if (!context.contentRange.truncated) {
    return lines;
  }

  const maxBytes =
    context.contentRange.maxBytes === undefined
      ? "the configured read budget"
      : `${context.contentRange.maxBytes} bytes`;

  return [
    ...lines,
    `  truncationNotice: This context output is truncated. Continue with start=${context.contentRange.nextStartOffset} and offset<=${maxBytes}.`,
  ];
}

function formatContextSearchMatches(matches: readonly ExpertAgentContextItemSearchMatch[]): string {
  if (matches.length === 0) {
    return "No ExpertAgent context matches found.";
  }

  const groups = groupContextSearchMatches(matches);
  const itemLabel = groups.length === 1 ? "context item" : "context items";

  return [
    `Found ${matches.length} ${matches.length === 1 ? "match" : "matches"} in ${groups.length} ${itemLabel}.`,
    "",
    groups.map(formatContextSearchMatchGroup).join("\n\n---\n\n"),
  ].join("\n");
}

interface ContextSearchMatchGroup {
  readonly id: string;
  readonly matches: ExpertAgentContextItemSearchMatch[];
}

function groupContextSearchMatches(
  matches: readonly ExpertAgentContextItemSearchMatch[],
): readonly ContextSearchMatchGroup[] {
  const groups = new Map<string, ContextSearchMatchGroup>();

  for (const match of matches) {
    const id = formatContextSearchMatchId(match);
    const group = groups.get(id);

    if (group === undefined) {
      groups.set(id, {
        id,
        matches: [match],
      });
      continue;
    }

    group.matches.push(match);
  }

  return [...groups.values()];
}

function formatContextSearchMatchId(match: ExpertAgentContextItemSearchMatch): string {
  return match.namespace === undefined ? match.id : `${match.namespace}/${match.id}`;
}

function formatContextSearchMatchGroup(group: ContextSearchMatchGroup): string {
  return [group.id, group.matches.map(formatContextSearchMatchLines).join("\n--\n")].join("\n");
}

function formatContextSearchMatchLines(match: ExpertAgentContextItemSearchMatch): string {
  return [
    ...formatSearchContextLines(match.before, match.lineNumber - (match.before?.length ?? 0), " "),
    formatSearchContextLine(match.lineNumber, match.line, ">"),
    ...formatSearchContextLines(match.after, match.lineNumber + 1, " "),
  ].join("\n");
}

function formatSearchContextLines(
  lines: readonly string[] | undefined,
  startLineNumber: number,
  marker: string,
): readonly string[] {
  if (lines === undefined || lines.length === 0) {
    return [];
  }

  return lines.map((line, index) => formatSearchContextLine(startLineNumber + index, line, marker));
}

function formatSearchContextLine(lineNumber: number, line: string, marker: string): string {
  return `${marker}${lineNumber} | ${line}`;
}

function errorResult(error: ExpertAgentContextError): ExpertAgentDefaultToolCallResult {
  return {
    text: `Context operation failed: ${error.message}`,
    isError: true,
    details: {
      error,
    },
  };
}
