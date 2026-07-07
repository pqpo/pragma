import {
  createExpertAgentRunContext,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import type {
  FactMemoryRecord,
  MemoryConfidence,
  MemoryScope,
  MemorySystem,
} from "../memory-system/index.ts";
import {
  booleanSchema,
  createDefaultEvidence,
  enumSchema,
  errorResult,
  evidenceArraySchema,
  objectSchema,
  readOptionalBooleanParam as readOptionalBooleanParamHelper,
  readOptionalEvidenceParam as readOptionalEvidenceParamHelper,
  readOptionalStringArrayParam as readOptionalStringArrayParamHelper,
  readOptionalStringParam as readOptionalStringParamHelper,
  readParam,
  readStringParam as readStringParamHelper,
  stringArraySchema,
  stringSchema,
} from "../memory-system/tool-helpers.ts";

export function createFactMemoryTools(options: {
  readonly memorySystem: MemorySystem;
  readonly defaultAgentId?: string | undefined;
}): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return [
    {
      name: "list_fact_memory",
      description: "List fact memory entries by scope, confidence, and active status.",
      inputSchema: objectSchema(
        {
          scope: enumSchema(["run", "session", "agent", "workspace", "organization"], "Optional scope filter."),
          confidenceAtLeast: enumSchema(["low", "medium", "high", "verified"], "Optional confidence floor."),
          onlyActive: booleanSchema("Whether to return only active facts."),
          tags: stringArraySchema("Optional tag filter."),
        },
        [],
      ),
      async call(args, _signal, context) {
        const runContext = createExpertAgentRunContext(context?.runContext);
        const result = await options.memorySystem.listFacts({
          scope: readOptionalScopeParam(args, "scope"),
          confidenceAtLeast: readOptionalConfidenceParam(args, "confidenceAtLeast"),
          onlyActive: readOptionalBooleanParamBase(args, "onlyActive"),
          tags: readOptionalStringArrayParamBase(args, "tags"),
          context: runContext,
        });

        if (!result.ok) {
          return errorResult("Fact memory operation failed", result.error);
        }

        return {
          text: formatFactList(result.value),
          details: { entries: result.value },
        };
      },
    },
    {
      name: "get_fact_memory",
      description: "Read a single fact memory entry by id.",
      inputSchema: objectSchema({ id: stringSchema("Fact memory entry id.") }, ["id"]),
      async call(args, _signal, context) {
        const runContext = createExpertAgentRunContext(context?.runContext);
        const result = await options.memorySystem.getFact({
          id: readStringParamBase(args, "id"),
          context: runContext,
        });

        if (!result.ok) {
          return errorResult("Fact memory operation failed", result.error);
        }

        return {
          text: formatFactRecord(result.value),
          details: { entry: result.value },
        };
      },
    },
    {
      name: "write_fact_memory",
      description: "Write a fact memory entry backed by explicit or inferred evidence.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Optional fact memory id."),
          scope: enumSchema(["run", "session", "agent", "workspace", "organization"], "Fact scope."),
          title: stringSchema("Optional title."),
          statement: stringSchema("Fact statement."),
          confidence: enumSchema(["low", "medium", "high", "verified"], "Fact confidence."),
          observedAt: stringSchema("Observation timestamp in ISO format."),
          verifiedAt: stringSchema("Optional verification timestamp in ISO format."),
          expiresAt: stringSchema("Optional expiration timestamp in ISO format."),
          reviewAt: stringSchema("Optional review timestamp in ISO format."),
          tags: stringArraySchema("Optional tags."),
          evidence: evidenceArraySchema(),
        },
        ["scope", "statement", "confidence", "observedAt"],
      ),
      async call(args, _signal, context) {
        const scope = resolveMemoryScope(context?.runContext);
        const now = new Date().toISOString();
        const record: FactMemoryRecord = {
          id: readOptionalStringParamBase(args, "id") ?? createFactMemoryId(),
          type: "fact",
          scope: readScopeParam(args, "scope"),
          title: readOptionalStringParamBase(args, "title"),
          statement: readStringParamBase(args, "statement"),
          confidence: readConfidenceParam(args, "confidence"),
          observedAt: readStringParamBase(args, "observedAt"),
          verifiedAt: readOptionalStringParamBase(args, "verifiedAt"),
          expiresAt: readOptionalStringParamBase(args, "expiresAt"),
          reviewAt: readOptionalStringParamBase(args, "reviewAt"),
          tags: readOptionalStringArrayParamBase(args, "tags"),
          provenance: {
            createdBy: scope.actorAgentId ?? options.defaultAgentId ?? "unknown-agent",
            updatedBy: scope.actorAgentId ?? options.defaultAgentId ?? "unknown-agent",
            createdAt: now,
            updatedAt: now,
            evidence: readOptionalEvidenceParamBase(args, "evidence") ?? createDefaultEvidence(scope),
          },
        };
        const result = await options.memorySystem.writeFact({
          record,
          context: scope.runContext,
        });

        if (!result.ok) {
          return errorResult("Fact memory operation failed", result.error);
        }

        return {
          text: `Wrote fact memory: ${result.value.id}`,
          details: { entry: result.value },
        };
      },
    },
    {
      name: "update_fact_memory",
      description: "Replace an existing fact memory entry.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Fact memory id."),
          scope: enumSchema(["run", "session", "agent", "workspace", "organization"], "Fact scope."),
          title: stringSchema("Optional title."),
          statement: stringSchema("Fact statement."),
          confidence: enumSchema(["low", "medium", "high", "verified"], "Fact confidence."),
          observedAt: stringSchema("Observation timestamp in ISO format."),
          verifiedAt: stringSchema("Optional verification timestamp in ISO format."),
          expiresAt: stringSchema("Optional expiration timestamp in ISO format."),
          reviewAt: stringSchema("Optional review timestamp in ISO format."),
          invalidatedAt: stringSchema("Optional invalidation timestamp in ISO format."),
          tags: stringArraySchema("Optional tags."),
          evidence: evidenceArraySchema(),
        },
        ["id", "scope", "statement", "confidence", "observedAt"],
      ),
      async call(args, _signal, context) {
        const scope = resolveMemoryScope(context?.runContext);
        const current = await options.memorySystem.getFact({
          id: readStringParamBase(args, "id"),
          context: scope.runContext,
        });

        if (!current.ok) {
          return errorResult("Fact memory operation failed", current.error);
        }

        const record: FactMemoryRecord = {
          ...current.value,
          scope: readScopeParam(args, "scope"),
          title: readOptionalStringParamBase(args, "title"),
          statement: readStringParamBase(args, "statement"),
          confidence: readConfidenceParam(args, "confidence"),
          observedAt: readStringParamBase(args, "observedAt"),
          verifiedAt: readOptionalStringParamBase(args, "verifiedAt"),
          expiresAt: readOptionalStringParamBase(args, "expiresAt"),
          reviewAt: readOptionalStringParamBase(args, "reviewAt"),
          invalidatedAt: readOptionalStringParamBase(args, "invalidatedAt"),
          tags: readOptionalStringArrayParamBase(args, "tags"),
          provenance: {
            ...current.value.provenance,
            updatedBy: scope.actorAgentId ?? options.defaultAgentId ?? "unknown-agent",
            updatedAt: new Date().toISOString(),
            evidence:
              readOptionalEvidenceParamBase(args, "evidence") ?? current.value.provenance.evidence,
          },
        };
        const result = await options.memorySystem.updateFact({
          record,
          context: scope.runContext,
        });

        if (!result.ok) {
          return errorResult("Fact memory operation failed", result.error);
        }

        return {
          text: `Updated fact memory: ${result.value.id}`,
          details: { entry: result.value },
        };
      },
    },
  ];
}

function resolveMemoryScope(runContextInput: Parameters<typeof createExpertAgentRunContext>[0]) {
  const runContext = createExpertAgentRunContext(runContextInput);
  const runScope = readExecutionRunScope(runContext);

  return {
    workflowRunId: runScope.workflowRunId,
    taskRunId: runScope.taskRunId,
    runtimeSessionId: runScope.runtimeSessionId,
    actorAgentId: runContext.source?.id,
    runContext,
  };
}

function createFactMemoryId(): string {
  return `fact-memory-${crypto.randomUUID()}`;
}

function formatFactList(entries: readonly FactMemoryRecord[]): string {
  if (entries.length === 0) {
    return "No fact memory entries found.";
  }

  return entries.map(formatFactRecord).join("\n\n");
}

function formatFactRecord(entry: FactMemoryRecord): string {
  const lines = [
    `- id: ${entry.id}`,
    `  scope: ${entry.scope}`,
    `  confidence: ${entry.confidence}`,
    `  observedAt: ${entry.observedAt}`,
    entry.verifiedAt === undefined ? undefined : `  verifiedAt: ${entry.verifiedAt}`,
    entry.invalidatedAt === undefined ? undefined : `  invalidatedAt: ${entry.invalidatedAt}`,
    entry.title === undefined ? undefined : `  title: ${entry.title}`,
    entry.summary === undefined ? undefined : `  summary: ${entry.summary}`,
    "  statement:",
    ...entry.statement.split("\n").map((line) => `    ${line}`),
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function readConfidenceParam(params: unknown, key: string): MemoryConfidence {
  const value = readParam(params, key);

  if (value === "low" || value === "medium" || value === "high" || value === "verified") {
    return value;
  }

  throw new Error(`Fact memory tool requires confidence parameter "${key}".`);
}

function readOptionalConfidenceParam(params: unknown, key: string): MemoryConfidence | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  return readConfidenceParam(params, key);
}

function readScopeParam(params: unknown, key: string): MemoryScope {
  const value = readParam(params, key);

  if (
    value === "run" ||
    value === "session" ||
    value === "agent" ||
    value === "workspace" ||
    value === "organization"
  ) {
    return value;
  }

  throw new Error(`Fact memory tool requires scope parameter "${key}".`);
}

function readOptionalScopeParam(params: unknown, key: string): MemoryScope | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  return readScopeParam(params, key);
}

function readStringParamBase(params: unknown, key: string): string {
  return readStringParamHelper(params, key, "Fact memory tool");
}

function readOptionalStringParamBase(params: unknown, key: string): string | undefined {
  return readOptionalStringParamHelper(params, key, "Fact memory tool");
}

function readOptionalBooleanParamBase(params: unknown, key: string): boolean | undefined {
  return readOptionalBooleanParamHelper(params, key, "Fact memory tool");
}

function readOptionalStringArrayParamBase(params: unknown, key: string): readonly string[] | undefined {
  return readOptionalStringArrayParamHelper(params, key, "Fact memory tool");
}

function readOptionalEvidenceParamBase(params: unknown, key: string) {
  return readOptionalEvidenceParamHelper(params, key, "Fact memory tool");
}
