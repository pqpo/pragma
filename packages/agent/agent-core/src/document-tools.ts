import type {
  DocumentIndexer,
  DocumentTrigger,
  ExpertAgentDocument,
  ExpertAgentDocumentError,
  ExpertAgentDocumentMetadata,
  ExpertAgentDocumentSummary
} from "./document-indexer.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";

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
    signal: AbortSignal | undefined
  ) => Promise<ExpertAgentDefaultToolCallResult>;
}

export interface CreateDocumentToolsOptions {
  readonly getContext?: (() => ExpertAgentRunContext | undefined) | undefined;
}

export function createDocumentTools(
  documentIndexer: DocumentIndexer,
  options: CreateDocumentToolsOptions = {}
): readonly ExpertAgentDefaultTool[] {
  return [
    {
      name: "list_expert_documents",
      label: "List expert documents",
      description: "List ExpertAgent documents by document id, description, and trigger.",
      inputSchema: withContextSchema({}),
      call: async (args) => {
        const result = await documentIndexer.index(readDocumentContext(args, options));

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: formatDocumentSummaries(result.value),
          details: {
            documents: result.value
          }
        };
      }
    },
    {
      name: "read_expert_document",
      label: "Read expert document",
      description: "Read an ExpertAgent document by document id.",
      inputSchema: withContextSchema({
        id: stringSchema("Document id.")
      }, ["id"]),
      call: async (args) => {
        const id = readStringParam(args, "id");
        const result = await documentIndexer.read({
          id,
          context: readDocumentContext(args, options)
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: formatDocument(result.value),
          details: {
            document: result.value
          }
        };
      }
    },
    {
      name: "create_expert_document",
      label: "Create expert document",
      description: "Create an ExpertAgent document by document id.",
      inputSchema: withContextSchema(
        {
          id: stringSchema("Document id."),
          content: stringSchema("Document content."),
          description: stringSchema("Optional document description."),
          trigger: triggerSchema()
        },
        ["id", "content"]
      ),
      call: async (args) => {
        const result = await documentIndexer.create({
          id: readStringParam(args, "id"),
          content: readStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readDocumentContext(args, options)
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Created document: ${result.value.id}`,
          details: {
            document: result.value
          }
        };
      }
    },
    {
      name: "update_expert_document",
      label: "Update expert document",
      description: "Update an ExpertAgent document's content or metadata by document id.",
      inputSchema: withContextSchema(
        {
          id: stringSchema("Document id."),
          content: stringSchema("Optional replacement document content."),
          description: stringSchema("Optional replacement document description."),
          trigger: triggerSchema()
        },
        ["id"]
      ),
      call: async (args) => {
        const result = await documentIndexer.update({
          id: readStringParam(args, "id"),
          content: readOptionalStringParam(args, "content"),
          metadata: readMetadataParams(args),
          context: readDocumentContext(args, options)
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Updated document: ${result.value.id}`,
          details: {
            document: result.value
          }
        };
      }
    },
    {
      name: "delete_expert_document",
      label: "Delete expert document",
      description: "Delete an ExpertAgent document by document id.",
      inputSchema: withContextSchema({
        id: stringSchema("Document id.")
      }, ["id"]),
      call: async (args) => {
        const id = readStringParam(args, "id");
        const result = await documentIndexer.delete({
          id,
          context: readDocumentContext(args, options)
        });

        if (!result.ok) {
          return errorResult(result.error);
        }

        return {
          text: `Deleted document: ${id}`,
          details: {
            id
          }
        };
      }
    }
  ];
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): unknown {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function withContextSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = []
): unknown {
  return objectSchema(
    {
      ...properties,
      source: objectSchema(
        {
          type: stringSchema("Source type, such as user, system, workflow, or agent."),
          id: stringSchema("Optional source id."),
          label: stringSchema("Optional source label.")
        },
        ["type"]
      ),
      context: {
        type: "object",
        description: "Optional permission and request context attributes.",
        additionalProperties: true
      }
    },
    required
  );
}

function stringSchema(description: string): unknown {
  return {
    type: "string",
    description
  };
}

function triggerSchema(): unknown {
  return {
    type: "string",
    enum: ["always_on", "model_decision", "manual"],
    description: "Document trigger. Defaults to model_decision when omitted."
  };
}

function readStringParam(params: unknown, key: string): string {
  const value = readParam(params, key);

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Document tool requires string parameter "${key}".`);
}

function readOptionalStringParam(params: unknown, key: string): string | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Document tool parameter "${key}" must be a string when provided.`);
}

function readMetadataParams(params: unknown): Partial<ExpertAgentDocumentMetadata> {
  const description = readOptionalStringParam(params, "description");
  const trigger = readOptionalTriggerParam(params);

  return {
    ...(description === undefined ? {} : { description }),
    ...(trigger === undefined ? {} : { trigger })
  };
}

function readOptionalTriggerParam(params: unknown): DocumentTrigger | undefined {
  const value = readParam(params, "trigger");

  if (value === undefined) {
    return undefined;
  }

  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  throw new Error('Document tool parameter "trigger" must be always_on, model_decision, or manual.');
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params === "object" && params !== null && key in params) {
    return (params as Record<string, unknown>)[key];
  }

  return undefined;
}

function readDocumentContext(
  params: unknown,
  options: CreateDocumentToolsOptions
): ExpertAgentRunContext {
  const baseContext = options.getContext?.();
  const source = readSourceParam(params) ?? baseContext?.source;
  const context = readParam(params, "context");
  const attributes = typeof context === "object" && context !== null
    ? (context as Record<string, unknown>)
    : undefined;

  if (source === undefined) {
    throw new Error('Document tool requires "source" either in tool input or run context.');
  }

  return {
    ...baseContext,
    source,
    attributes: {
      ...(baseContext?.attributes ?? {}),
      ...(attributes ?? {})
    }
  };
}

function readSourceParam(params: unknown): ExpertAgentRunContext["source"] {
  const source = readParam(params, "source");

  if (source === undefined) {
    return undefined;
  }

  if (typeof source !== "object" || source === null) {
    throw new Error('Document tool requires object parameter "source".');
  }

  const type = (source as Record<string, unknown>).type;
  const id = (source as Record<string, unknown>).id;
  const label = (source as Record<string, unknown>).label;

  if (typeof type !== "string") {
    throw new Error('Document tool requires string parameter "source.type".');
  }

  return {
    type,
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof label === "string" ? { label } : {})
  };
}

function formatDocumentSummaries(documents: readonly ExpertAgentDocumentSummary[]): string {
  if (documents.length === 0) {
    return "No ExpertAgent documents are available.";
  }

  return documents.map(formatDocumentSummary).join("\n");
}

function formatDocumentSummary(document: ExpertAgentDocumentSummary): string {
  return [
    `- ${document.id}`,
    document.metadata.description === undefined
      ? undefined
      : `  description: ${document.metadata.description}`,
    `  trigger: ${document.metadata.trigger}`
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatDocument(document: ExpertAgentDocument): string {
  return [
    formatDocumentSummary(document),
    "  content:",
    document.content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")
  ].join("\n");
}

function errorResult(error: ExpertAgentDocumentError): ExpertAgentDefaultToolCallResult {
  return {
    text: `Document operation failed: ${error.message}`,
    isError: true,
    details: {
      error
    }
  };
}
