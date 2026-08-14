import { createHash } from "node:crypto";

import type {
  ContextTrigger,
  ContextMutationApproval,
  ContextPriority,
  ContextIndex,
  ExpertAgentContextItem,
  ExpertAgentContextAddInput,
  ExpertAgentContextItemEditInput,
  ExpertAgentContextItemEditResult,
  ExpertAgentContextItemDeleteResult,
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextError,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemReadInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
} from "./context-system.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import { createExpertAgentRunContext, withExecutionRunScope } from "../runtime/run-context.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentToolApproval,
  ExpertToolExecutionContext,
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
      readonly runContext?: ExpertAgentRunContext | undefined;
      readonly execution?: ExpertToolExecutionContext | undefined;
    },
  ) => Promise<ExpertAgentDefaultToolCallResult>;
}

export interface CreateContextToolsOptions {
  readonly getContext?: (() => ExpertAgentRunContext | undefined) | undefined;
  readonly readByteBudget?: number | undefined;
  readonly resultByteBudget?: number | undefined;
  readonly mutationApprovalFor?: ((namespace: string) => ContextMutationApproval) | undefined;
}

export interface ExpertAgentContextItemOperations {
  readonly listContext: (input?: {
    readonly namespace?: string | undefined;
    readonly context?: ExpertAgentRunContext | undefined;
  }) => Promise<ExpertAgentContextResult<ContextIndex>>;
  readonly readContext: (
    input: ExpertAgentContextItemReadInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly searchContext: (
    input: ExpertAgentContextItemSearchInput,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>>;
  readonly addContext: (
    input: ExpertAgentContextAddInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly editContext: (
    input: ExpertAgentContextItemEditInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItemEditResult>>;
  readonly deleteContext: (
    input: ExpertAgentContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItemDeleteResult>>;
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
      description:
        "List Expert context by id, description, and trigger. Optionally restrict the listing to one context namespace. Continue with nextCursor using the same namespace when the result is paginated.",
      inputSchema: objectSchema({
        namespace: stringSchema(
          "Optional context namespace to list. Omit to list every namespace.",
        ),
        cursor: stringSchema("Opaque cursor returned by a previous list_expert_context call."),
        limit: integerSchema("Maximum items to return. Defaults to 20 and is capped at 50."),
      }),
      call: async (args, _signal, context) => {
        const namespace = readOptionalStringParam(args, "namespace");
        const result = await contextOperations.listContext({
          ...(namespace === undefined ? {} : { namespace }),
          context: readRunContext(options, context),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        const page = paginateContextIndex(
          result.value,
          readOptionalStringParam(args, "cursor"),
          normalizeListLimit(readOptionalNumberParam(args, "limit")),
          normalizeResultByteBudget(options),
          namespace,
        );
        if (!page.ok) return errorResult(page.error);

        return {
          text: formatContextIndexPage(page.value),
          details: {
            context: page.value.items,
            issues: page.value.issues,
            page: {
              total: page.value.total,
              returned: page.value.items.length,
              hasMore: page.value.nextCursor !== undefined,
              skippedOversized: page.value.skippedOversized,
              omittedIssues: page.value.omittedIssues,
              ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }),
            },
          },
        };
      },
    },
    {
      name: "read_expert_context",
      label: "Read expert context",
      description: "Read an Expert context by context id, optionally as a byte range.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Context id."),
          namespace: stringSchema("Context namespace."),
          start: integerSchema("Zero-based UTF-8 byte offset to start reading from."),
          offset: integerSchema("Maximum UTF-8 bytes to read from start."),
        },
        ["namespace", "id"],
      ),
      call: async (args, _signal, context) => {
        const id = readStringParam(args, "id");
        const requestedOffset = readOptionalNumberParam(args, "offset");
        const offset = normalizeToolReadOffset(requestedOffset, options);
        const result = await contextOperations.readContext({
          namespace: readStringParam(args, "namespace"),
          id,
          start: readOptionalNumberParam(args, "start"),
          offset,
          context: readRunContext(options, context),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        const bounded = boundReadContext(result.value, offset);
        return {
          text: formatContext(bounded),
          details: {
            context: bounded,
          },
        };
      },
    },
    {
      name: "search_expert_context",
      label: "Search expert context",
      description: "Search Expert context by literal text.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Optional context namespace. Omit to search every namespace."),
          query: stringSchema("Literal text to search for."),
          scope: {
            type: "string",
            enum: ["path", "content", "hybrid"],
            description: "Search mode. Defaults to hybrid.",
          },
          maxResults: integerSchema("Maximum number of matches to return. Defaults to 20."),
          contextLines: integerSchema("Number of context lines around each match. Defaults to 0."),
          caseSensitive: booleanSchema(
            "Whether search should be case-sensitive. Defaults to false.",
          ),
        },
        ["query"],
      ),
      call: async (args, _signal, context) => {
        const result = await contextOperations.searchContext({
          namespace: readOptionalStringParam(args, "namespace"),
          query: readStringParam(args, "query"),
          scope: readOptionalScopeParam(args),
          maxResults: readOptionalNumberParam(args, "maxResults"),
          contextLines: readOptionalNumberParam(args, "contextLines"),
          caseSensitive: readOptionalBooleanParam(args, "caseSensitive"),
          context: readRunContext(options, context),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        const bounded = boundSearchMatches(result.value, normalizeResultByteBudget(options));
        return {
          text: bounded.text,
          details: {
            matches: bounded.matches,
            truncated: bounded.truncated,
          },
        };
      },
    },
    {
      name: "add_expert_context",
      label: "Add expert context",
      description: "Add an Expert context item to a context namespace by context id.",
      approval: {
        mode: "required",
        reason: "Writing Expert context requires explicit approval.",
        when: (request) => requiresMutationApproval("add", request.input, options),
      },
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
          content: stringSchema("Context content."),
          description: stringSchema("Optional context description."),
          trigger: triggerSchema(),
          priority: prioritySchema(),
        },
        ["namespace", "id", "content"],
      ),
      call: async (args, _signal, context) => {
        const namespace = readStringParam(args, "namespace");
        const id = readStringParam(args, "id");
        const content = readStringParam(args, "content");
        const result = await contextOperations.addContext({
          namespace,
          id,
          content,
          metadata: readMetadataParams(args),
          context: readRunContext(options, context),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        const receipt = createContextWriteReceipt(result.value, namespace);
        return {
          text: `Added context: ${receipt.namespace}/${receipt.id}; sizeBytes=${receipt.sizeBytes}`,
          details: {
            context: receipt,
          },
        };
      },
    },
    {
      name: "edit_expert_context",
      label: "Edit expert context",
      description:
        'Edit an Expert context item. Use mode="replace" for full content or metadata replacement, or mode="search_replace" for exact text search/replace.',
      approval: {
        mode: "required",
        reason: "Writing Expert context requires explicit approval.",
        when: (request) => requiresMutationApproval("edit", request.input, options),
      },
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
          mode: {
            type: "string",
            enum: ["replace", "search_replace"],
            description: "Edit mode. Defaults to search_replace.",
          },
          content: stringSchema('Replacement context content for mode="replace".'),
          description: stringSchema('Replacement context description for mode="replace".'),
          trigger: triggerSchema(),
          priority: prioritySchema(),
          search: stringSchema('The exact text to search for in mode="search_replace".'),
          replace: stringSchema('Replacement text for mode="search_replace".'),
          replaceAll: booleanSchema(
            'Whether to replace every match in mode="search_replace". Defaults to false.',
          ),
          expectedRevision: stringSchema("Optional expected context revision."),
          expectedEtag: stringSchema("Optional expected context etag."),
        },
        ["namespace", "id"],
      ),
      call: async (args, _signal, context) => {
        const mode = readOptionalEditModeParam(args);
        const input =
          mode === "replace"
            ? {
                namespace: readStringParam(args, "namespace"),
                id: readStringParam(args, "id"),
                mode,
                content: readOptionalStringParam(args, "content"),
                metadata: readMetadataParams(args),
                expectedRevision: readOptionalStringParam(args, "expectedRevision"),
                expectedEtag: readOptionalStringParam(args, "expectedEtag"),
                context: readRunContext(options, context),
              }
            : {
                namespace: readStringParam(args, "namespace"),
                id: readStringParam(args, "id"),
                mode: "search_replace" as const,
                search: readStringParam(args, "search"),
                replace: readStringParam(args, "replace"),
                replaceAll: readOptionalBooleanParam(args, "replaceAll"),
                expectedRevision: readOptionalStringParam(args, "expectedRevision"),
                expectedEtag: readOptionalStringParam(args, "expectedEtag"),
                context: readRunContext(options, context),
              };
        const result = await contextOperations.editContext(input);

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text:
            result.value.mode === "search_replace"
              ? `Edited context: ${result.value.namespace}/${result.value.id}; mode=${result.value.mode}; replacements=${result.value.replacementCount}`
              : `Edited context: ${result.value.namespace}/${result.value.id}; mode=${result.value.mode}`,
          details: {
            context: result.value,
            mode: result.value.mode,
            replacementCount: result.value.replacementCount,
          },
        };
      },
    },
    {
      name: "delete_expert_context",
      label: "Delete expert context",
      description: "Delete an Expert context by context id.",
      approval: {
        mode: "required",
        reason: "Deleting Expert context requires explicit approval.",
        when: (request) => requiresMutationApproval("delete", request.input, options),
      },
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
        },
        ["namespace", "id"],
      ),
      call: async (args, _signal, context) => {
        const namespace = readStringParam(args, "namespace");
        const id = readStringParam(args, "id");
        const result = await contextOperations.deleteContext({
          namespace,
          id,
          context: readRunContext(options, context),
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
  ];
}

interface ContextWriteReceipt {
  readonly status: "created";
  readonly namespace: string;
  readonly id: string;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256: string;
}

function createContextWriteReceipt(
  context: ExpertAgentContextItem,
  requestedNamespace: string,
): ContextWriteReceipt {
  const content = context.content;
  if (typeof content !== "string") {
    throw new Error("createContextWriteReceipt: content must be a string");
  }

  return {
    status: "created",
    namespace: context.namespace ?? requestedNamespace,
    id: context.id,
    ...(context.revision === undefined ? {} : { revision: context.revision }),
    ...(context.etag === undefined ? {} : { etag: context.etag }),
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function requiresMutationApproval(
  operation: "add" | "edit" | "delete",
  input: unknown,
  options: CreateContextToolsOptions,
): boolean {
  if (!isRecord(input) || typeof input.namespace !== "string") {
    return true;
  }

  const approval = options.mutationApprovalFor?.(input.namespace) ?? "required";
  if (approval === "required") return true;
  if (approval === "none") return false;

  if (operation === "add") return input.trigger === "always_on";
  if (operation === "edit") {
    return input.mode === "replace" && input.trigger === "always_on";
  }
  return false;
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
    description:
      "Context trigger. Defaults to manual when omitted. always_on preloads the complete body into every applicable Expert context; model_decision exposes only its id and description for optional loading.",
  };
}

function prioritySchema(): unknown {
  return {
    type: "string",
    enum: ["critical", "high", "normal", "low"],
    description: "Context assembly priority. Defaults to normal when omitted.",
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

function normalizeResultByteBudget(options: CreateContextToolsOptions): number {
  return Math.max(1_024, Math.trunc(options.resultByteBudget ?? 8_000));
}

function normalizeListLimit(value: number | undefined): number {
  return Math.min(50, Math.max(1, Math.trunc(value ?? 20)));
}

function readMetadataParams(params: unknown): Partial<ExpertAgentContextItemMetadata> {
  const description = readOptionalStringParam(params, "description");
  const trigger = readOptionalTriggerParam(params);
  const priority = readOptionalPriorityParam(params);

  return {
    ...(description === undefined ? {} : { description }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function readOptionalPriorityParam(params: unknown): ContextPriority | undefined {
  const value = readParam(params, "priority");

  if (value === undefined) {
    return undefined;
  }

  if (value === "critical" || value === "high" || value === "normal" || value === "low") {
    return value;
  }

  throw new Error('Context tool parameter "priority" must be critical, high, normal, or low.');
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

function readOptionalEditModeParam(params: unknown): "replace" | "search_replace" {
  const value = readParam(params, "mode");

  if (value === undefined) {
    return "search_replace";
  }

  if (value === "replace" || value === "search_replace") {
    return value;
  }

  throw new Error('Context tool parameter "mode" must be replace or search_replace.');
}

function readOptionalScopeParam(params: unknown): "path" | "content" | "hybrid" | undefined {
  const value = readParam(params, "scope");

  if (value === undefined) {
    return undefined;
  }

  if (value === "path" || value === "content" || value === "hybrid") {
    return value;
  }

  throw new Error('Context tool parameter "scope" must be path, content, or hybrid.');
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

function readRunContext(
  options: CreateContextToolsOptions,
  callContext?: {
    readonly runContext?: ExpertAgentRunContext | undefined;
    readonly execution?: ExpertToolExecutionContext | undefined;
  },
): ExpertAgentRunContext {
  const baseContext = createExpertAgentRunContext(
    callContext?.runContext ?? options.getContext?.(),
  );
  const execution = callContext?.execution;

  return execution === undefined
    ? baseContext
    : withExecutionRunScope(baseContext, {
        executionId: execution.executionId,
        invocationId: execution.invocationId,
      });
}

function formatContextSummaries(context: readonly ExpertAgentContextItemSummary[]): string {
  if (context.length === 0) {
    return "No Expert context items are available.";
  }

  return context.map(formatContextSummary).join("\n");
}

interface ContextIndexPage {
  readonly items: readonly ExpertAgentContextItemSummary[];
  readonly issues: ContextIndex["issues"];
  readonly total: number;
  readonly byteBudget: number;
  readonly skippedOversized: number;
  readonly omittedIssues: number;
  readonly nextCursor?: string | undefined;
}

type ContextListCursor =
  | readonly [version: 1, offset: number]
  | readonly [version: 2, offset: number, namespace: string | null];

function paginateContextIndex(
  index: ContextIndex,
  encodedCursor: string | undefined,
  limit: number,
  byteBudget: number,
  namespace: string | undefined,
): ExpertAgentContextResult<ContextIndexPage> {
  const cursor = decodeContextListCursor(encodedCursor);
  if (!cursor.ok) return cursor;
  const cursorNamespace = cursor.value?.length === 3 ? cursor.value[2] : null;
  const requestedNamespace = namespace ?? null;
  if (cursor.value !== undefined && cursorNamespace !== requestedNamespace) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Context list cursor does not match the requested namespace.",
      },
    };
  }
  const sorted = [...index.items].sort(compareContextSummary);
  const startOffset = Math.min(cursor.value?.[1] ?? 0, sorted.length);
  const selected: ExpertAgentContextItemSummary[] = [];
  let usedBytes = 0;
  let consumed = 0;
  let skippedOversized = 0;
  const reservedBytes = 512;
  const maximumItemBytes = Math.max(256, byteBudget - reservedBytes);
  for (const item of sorted.slice(startOffset)) {
    if (consumed >= limit) break;
    const available = Math.max(256, byteBudget - usedBytes - reservedBytes);
    const bounded = boundContextSummary(item, available);
    const blockBytes = Buffer.byteLength(formatContextSummary(bounded), "utf8") + 1;
    if (blockBytes > available) {
      const maximumBounded = boundContextSummary(item, maximumItemBytes);
      if (Buffer.byteLength(formatContextSummary(maximumBounded), "utf8") + 1 <= maximumItemBytes) {
        break;
      }
      consumed += 1;
      skippedOversized += 1;
      continue;
    }
    selected.push(bounded);
    usedBytes += blockBytes;
    consumed += 1;
  }
  const nextOffset = startOffset + consumed;
  const hasMore = nextOffset < sorted.length;
  const boundedIssues = boundContextIssues(index.issues, 384);
  return {
    ok: true,
    value: {
      items: selected,
      issues: boundedIssues.issues,
      total: sorted.length,
      byteBudget,
      skippedOversized,
      omittedIssues: boundedIssues.omitted,
      ...(hasMore
        ? { nextCursor: encodeContextListCursor([2, nextOffset, requestedNamespace]) }
        : {}),
    },
  };
}

function formatContextIndexPage(page: ContextIndexPage): string {
  const summaries = formatContextSummaries(page.items);
  const pageLines = [
    `Showing ${page.items.length} of ${page.total} Expert context items.`,
    summaries,
    ...(page.nextCursor === undefined
      ? []
      : [
          `More items are available. Call list_expert_context again with cursor=${JSON.stringify(page.nextCursor)}.`,
        ]),
    ...(page.skippedOversized === 0
      ? []
      : [
          `${page.skippedOversized} context item(s) were skipped because their identifiers exceed the result budget.`,
        ]),
  ];

  const output =
    page.issues.length === 0
      ? pageLines.join("\n")
      : [
          ...pageLines,
          "Context store issues:",
          ...page.issues.map(
            (issue) => `- ${issue.namespace}: ${issue.error.code}: ${issue.error.message}`,
          ),
          ...(page.omittedIssues === 0
            ? []
            : [`- ${page.omittedIssues} additional issue(s) omitted.`]),
        ].join("\n");
  return truncateUtf8(output, page.byteBudget, "");
}

function encodeContextListCursor(cursor: ContextListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeContextListCursor(
  cursor: string | undefined,
): ExpertAgentContextResult<ContextListCursor | undefined> {
  if (cursor === undefined) return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      (value.length !== 2 && value.length !== 3) ||
      (value[0] !== 1 && value[0] !== 2) ||
      typeof value[1] !== "number" ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      (value[0] === 1 && value.length !== 2) ||
      (value[0] === 2 &&
        (value.length !== 3 || (typeof value[2] !== "string" && value[2] !== null)))
    ) {
      throw new Error("invalid cursor shape");
    }
    return value[0] === 1
      ? { ok: true, value: [1, value[1]] }
      : { ok: true, value: [2, value[1], value[2] as string | null] };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Context list cursor is invalid." },
    };
  }
}

function compareContextSummary(
  left: ExpertAgentContextItemSummary,
  right: ExpertAgentContextItemSummary,
): number {
  const priority =
    contextPriorityRank(left.metadata.priority) - contextPriorityRank(right.metadata.priority);
  if (priority !== 0) return priority;
  const namespace = (left.namespace ?? "").localeCompare(right.namespace ?? "");
  return namespace !== 0 ? namespace : left.id.localeCompare(right.id);
}

function contextPriorityRank(priority: ContextPriority): number {
  return { critical: 0, high: 1, normal: 2, low: 3 }[priority];
}

function boundContextIssues(
  issues: ContextIndex["issues"],
  byteBudget: number,
): { readonly issues: ContextIndex["issues"]; readonly omitted: number } {
  const included: Array<ContextIndex["issues"][number]> = [];
  let usedBytes = 0;
  for (const issue of issues) {
    const bounded = {
      namespace: truncateUtf8(issue.namespace, 128),
      operation: issue.operation,
      error: {
        code: issue.error.code,
        message: truncateUtf8(issue.error.message, 256),
      },
    };
    const issueBytes = Buffer.byteLength(
      `${bounded.namespace}:${bounded.error.code}:${bounded.error.message}`,
      "utf8",
    );
    if (included.length > 0 && usedBytes + issueBytes > byteBudget) break;
    included.push(bounded);
    usedBytes += issueBytes;
  }
  return { issues: included, omitted: issues.length - included.length };
}

function boundContextSummary(
  item: ExpertAgentContextItemSummary,
  byteBudget: number,
): ExpertAgentContextItemSummary {
  const description = item.metadata.description;
  const metadata: ExpertAgentContextItemMetadata = {
    trigger: item.metadata.trigger,
    priority: item.metadata.priority,
    ...(item.metadata.trustLevel === undefined ? {} : { trustLevel: item.metadata.trustLevel }),
    ...(item.metadata.sensitivity === undefined ? {} : { sensitivity: item.metadata.sensitivity }),
  };
  const withoutDescription: ExpertAgentContextItemSummary = {
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    id: item.id,
    metadata,
    ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
  };
  if (description === undefined) return withoutDescription;
  const withDescription = {
    ...withoutDescription,
    metadata: { ...metadata, description },
  };
  if (Buffer.byteLength(formatContextSummary(withDescription), "utf8") <= byteBudget) {
    return withDescription;
  }
  const fixedBytes = Buffer.byteLength(formatContextSummary(withoutDescription), "utf8");
  return {
    ...withoutDescription,
    metadata: {
      ...metadata,
      description: truncateUtf8(description, Math.max(16, byteBudget - fixedBytes - 18)),
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
    `  priority: ${context.metadata.priority}`,
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

function boundReadContext(
  context: ExpertAgentContextItem,
  byteBudget: number,
): ExpertAgentContextItem {
  const contentBytes = Buffer.byteLength(context.content, "utf8");
  if (contentBytes <= byteBudget) return context;
  const content = truncateUtf8(context.content, byteBudget, "");
  const includedBytes = Buffer.byteLength(content, "utf8");
  const requestedStartOffset = context.contentRange?.requestedStartOffset ?? 0;
  const startOffset = context.contentRange?.startOffset ?? requestedStartOffset;
  const endOffset = startOffset + includedBytes;
  const startLine = context.contentRange?.startLine;
  return {
    ...context,
    content,
    contentRange: {
      requestedStartOffset,
      startOffset,
      endOffset,
      nextStartOffset: endOffset,
      truncated: true,
      sizeBytes: context.contentRange?.sizeBytes ?? Math.max(contentBytes, endOffset + 1),
      maxBytes: byteBudget,
      ...(startLine === undefined
        ? {}
        : { startLine, endLine: startLine + countNewlines(content) }),
      ...(context.contentRange?.totalLines === undefined
        ? {}
        : { totalLines: context.contentRange.totalLines }),
    },
  };
}

function countNewlines(value: string): number {
  return value.split("\n").length - 1;
}

function formatContextSearchMatches(matches: readonly ExpertAgentContextItemSearchMatch[]): string {
  if (matches.length === 0) {
    return "No Expert context matches found.";
  }

  const groups = groupContextSearchMatches(matches);
  const itemLabel = groups.length === 1 ? "context item" : "context items";

  return [
    `Found ${matches.length} ${matches.length === 1 ? "match" : "matches"} in ${groups.length} ${itemLabel}.`,
    "",
    groups.map(formatContextSearchMatchGroup).join("\n\n---\n\n"),
  ].join("\n");
}

function boundSearchMatches(
  matches: readonly ExpertAgentContextItemSearchMatch[],
  byteBudget: number,
): {
  readonly text: string;
  readonly matches: readonly ExpertAgentContextItemSearchMatch[];
  readonly truncated: boolean;
} {
  if (matches.length === 0) {
    return { text: "No Expert context matches found.", matches: [], truncated: false };
  }
  const included: ExpertAgentContextItemSearchMatch[] = [];
  let snippetTruncated = false;
  const contentBudget = Math.max(256, byteBudget - 512);
  for (const match of matches) {
    const bounded = boundSearchMatch(match);
    const candidate = [...included, bounded.match];
    if (
      included.length > 0 &&
      Buffer.byteLength(formatContextSearchMatches(candidate), "utf8") > contentBudget
    ) {
      break;
    }
    included.push(bounded.match);
    snippetTruncated ||= bounded.truncated;
    if (Buffer.byteLength(formatContextSearchMatches(included), "utf8") >= contentBudget) break;
  }
  const omitted = included.length < matches.length;
  const notices = [
    ...(snippetTruncated
      ? [
          "Search snippets were truncated. Use read_expert_context with the shown namespace and id to read the source document.",
        ]
      : []),
    ...(omitted
      ? ["Additional matches were omitted. Refine the query or reduce contextLines."]
      : []),
  ];
  const text = [formatContextSearchMatches(included), ...notices].join("\n\n");
  return {
    text: truncateUtf8(text, byteBudget, ""),
    matches: included,
    truncated: snippetTruncated || omitted,
  };
}

function boundSearchMatch(match: ExpertAgentContextItemSearchMatch): {
  readonly match: ExpertAgentContextItemSearchMatch;
  readonly truncated: boolean;
} {
  const id = truncateUtf8(match.id, 1_024);
  const namespace = match.namespace === undefined ? undefined : truncateUtf8(match.namespace, 256);
  const line = truncateUtf8(match.line, 768);
  const before = match.before?.map((value) => truncateUtf8(value, 256));
  const after = match.after?.map((value) => truncateUtf8(value, 256));
  const truncated =
    id !== match.id ||
    namespace !== match.namespace ||
    line !== match.line ||
    before?.some((value, index) => value !== match.before?.[index]) === true ||
    after?.some((value, index) => value !== match.after?.[index]) === true;
  return {
    match: {
      ...match,
      id,
      ...(namespace === undefined ? {} : { namespace }),
      line,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
    truncated,
  };
}

function truncateUtf8(value: string, maxBytes: number, suffix = "…"): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}${suffix}`;
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
  if (match.matchType === "path") {
    return `> path | ${match.line}`;
  }

  const lineNumber = match.lineNumber ?? 1;
  return [
    ...formatSearchContextLines(match.before, lineNumber - (match.before?.length ?? 0), " "),
    formatSearchContextLine(lineNumber, match.line, ">"),
    ...formatSearchContextLines(match.after, lineNumber + 1, " "),
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
