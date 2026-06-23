import type {
  ContextTrigger,
  ExpertAgentContextItem,
  ExpertAgentContextRegisterInput,
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
  readonly call: (
    args: unknown,
    signal: AbortSignal | undefined,
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
  readonly registerContext: (
    input: ExpertAgentContextRegisterInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly updateContext: (
    input: ExpertAgentContextItemUpdateInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentContextItem>>;
  readonly deleteContext: (
    input: ExpertAgentContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<{ readonly id: string }>>;
}

export function createContextTools(
  contextOperations: ExpertAgentContextItemOperations,
  options: CreateContextToolsOptions = {},
): readonly ExpertAgentDefaultTool[] {
  return [
    {
      name: "list_expert_context",
      label: "List expert context",
      description: "List ExpertAgent context by context id, description, and trigger.",
      inputSchema: withContextSchema({}),
      call: async (args) => {
        const result = await contextOperations.listContext(readRunContext(args, options));

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
      inputSchema: withContextSchema(
        {
          id: stringSchema("Context id."),
          start: integerSchema("Zero-based UTF-8 byte offset to start reading from."),
          offset: integerSchema("Maximum UTF-8 bytes to read from start."),
        },
        ["id"],
      ),
      call: async (args) => {
        const id = readStringParam(args, "id");
        const requestedOffset = readOptionalNumberParam(args, "offset");
        const result = await contextOperations.readContext({
          id,
          start: readOptionalNumberParam(args, "start"),
          offset: normalizeToolReadOffset(requestedOffset, options),
          context: readRunContext(args, options),
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
      inputSchema: withContextSchema(
        {
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
          query: readStringParam(args, "query"),
          maxResults: readOptionalNumberParam(args, "maxResults"),
          contextLines: readOptionalNumberParam(args, "contextLines"),
          caseSensitive: readOptionalBooleanParam(args, "caseSensitive"),
          context: readRunContext(args, options),
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
      name: "register_expert_context",
      label: "Register expert context",
      description: "Register an ExpertAgent context item by context id.",
      inputSchema: withContextSchema(
        {
          id: stringSchema("Context id."),
          content: stringSchema("Context content."),
          description: stringSchema("Optional context description."),
          trigger: triggerSchema(),
        },
        ["id", "content"],
      ),
      call: async (args) => {
        const result = await contextOperations.registerContext({
          id: readStringParam(args, "id"),
          content: readStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readRunContext(args, options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Registered context: ${result.value.id}`,
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
      inputSchema: withContextSchema(
        {
          id: stringSchema("Context id."),
          content: stringSchema("Optional replacement context content."),
          description: stringSchema("Optional replacement context description."),
          trigger: triggerSchema(),
        },
        ["id"],
      ),
      call: async (args) => {
        const result = await contextOperations.updateContext({
          id: readStringParam(args, "id"),
          content: readOptionalStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readRunContext(args, options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Updated context: ${result.value.id}`,
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
      inputSchema: withContextSchema(
        {
          id: stringSchema("Context id."),
        },
        ["id"],
      ),
      call: async (args) => {
        const id = readStringParam(args, "id");
        const result = await contextOperations.deleteContext({
          id,
          context: readRunContext(args, options),
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Deleted context: ${id}`,
          details: {
            id,
          },
        };
      },
    },
  ];
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): unknown {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function withContextSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): unknown {
  return objectSchema(
    {
      ...properties,
      source: objectSchema(
        {
          type: stringSchema("Source type, such as user, system, workflow, or agent."),
          id: stringSchema("Optional source id."),
          label: stringSchema("Optional source label."),
        },
        ["type"],
      ),
      context: {
        type: "object",
        description: "Optional permission and request context attributes.",
        additionalProperties: true,
      },
    },
    required,
  );
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

function readParam(params: unknown, key: string): unknown {
  if (typeof params === "object" && params !== null && key in params) {
    return (params as Record<string, unknown>)[key];
  }

  return undefined;
}

function readRunContext(
  params: unknown,
  options: CreateContextToolsOptions,
): ExpertAgentRunContext {
  const baseContext = options.getContext?.();
  const source = readSourceParam(params) ?? baseContext?.source;
  const context = readParam(params, "context");
  const attributes =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)
      : undefined;

  if (source === undefined) {
    throw new Error('Context tool requires "source" either in tool input or run context.');
  }

  return {
    ...baseContext,
    source,
    attributes: {
      ...(baseContext?.attributes ?? {}),
      ...(attributes ?? {}),
    },
  };
}

function readSourceParam(params: unknown): ExpertAgentRunContext["source"] {
  const source = readParam(params, "source");

  if (source === undefined) {
    return undefined;
  }

  if (typeof source !== "object" || source === null) {
    throw new Error('Context tool requires object parameter "source".');
  }

  const type = (source as Record<string, unknown>).type;
  const id = (source as Record<string, unknown>).id;
  const label = (source as Record<string, unknown>).label;

  if (typeof type !== "string") {
    throw new Error('Context tool requires string parameter "source.type".');
  }

  return {
    type,
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof label === "string" ? { label } : {}),
  };
}

function formatContextSummaries(context: readonly ExpertAgentContextItemSummary[]): string {
  if (context.length === 0) {
    return "No ExpertAgent context items are available.";
  }

  return context.map(formatContextSummary).join("\n");
}

function formatContextSummary(context: ExpertAgentContextItemSummary): string {
  return [
    `- ${context.id}`,
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

  return matches.map(formatContextSearchMatch).join("\n");
}

function formatContextSearchMatch(match: ExpertAgentContextItemSearchMatch): string {
  return [
    `- ${match.id}:${match.lineNumber}`,
    ...formatSearchContext(match.before, "before"),
    `  match: ${match.line}`,
    ...formatSearchContext(match.after, "after"),
  ].join("\n");
}

function formatSearchContext(
  lines: readonly string[] | undefined,
  label: string,
): readonly string[] {
  if (lines === undefined || lines.length === 0) {
    return [];
  }

  return lines.map((line) => `  ${label}: ${line}`);
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
