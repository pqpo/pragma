import type {
  ContextTrigger,
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
  ExpertAgentContextItemUpdateInput,
} from "./context-system.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import { createExpertAgentRunContext } from "../runtime/run-context.ts";
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
  readonly editContext: (
    input: ExpertAgentContextItemEditInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItemEditResult>>;
  readonly updateContext: (
    input: ExpertAgentContextItemUpdateInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
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
      call: async (args) => {
        const result = await contextOperations.searchContext({
          namespace: readOptionalStringParam(args, "namespace"),
          query: readStringParam(args, "query"),
          scope: readOptionalScopeParam(args),
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
      name: "edit_expert_context",
      label: "Edit expert context",
      description: "Apply a search/replace edit to an ExpertAgent context item.",
      inputSchema: objectSchema(
        {
          namespace: stringSchema("Context namespace."),
          id: stringSchema("Context id."),
          search: stringSchema("The exact text to search for."),
          replace: stringSchema("Replacement text."),
          replaceAll: booleanSchema("Whether to replace every match. Defaults to false."),
          expectedRevision: stringSchema("Optional expected context revision."),
          expectedEtag: stringSchema("Optional expected context etag."),
        },
        ["namespace", "id", "search", "replace"],
      ),
      call: async (args) => {
        const result = await contextOperations.editContext({
          namespace: readStringParam(args, "namespace"),
          id: readStringParam(args, "id"),
          search: readStringParam(args, "search"),
          replace: readStringParam(args, "replace"),
          replaceAll: readOptionalBooleanParam(args, "replaceAll"),
          expectedRevision: readOptionalStringParam(args, "expectedRevision"),
          expectedEtag: readOptionalStringParam(args, "expectedEtag"),
          context: readRunContext(options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Edited context: ${result.value.namespace}/${result.value.id}; replacements=${result.value.replacementCount}`,
          details: {
            context: result.value,
            replacementCount: result.value.replacementCount,
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

function readRunContext(options: CreateContextToolsOptions): ExpertAgentRunContext {
  const baseContext = options.getContext?.();

  return createExpertAgentRunContext(baseContext);
}

function formatContextSummaries(context: readonly ExpertAgentContextItemSummary[]): string {
  if (context.length === 0) {
    return "No ExpertAgent context items are available.";
  }

  return context.map(formatContextSummary).join("\n");
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
