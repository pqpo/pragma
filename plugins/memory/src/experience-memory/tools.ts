import {
  createExpertAgentRunContext,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import type {
  ExperienceMemoryRecord,
  MemorySystem,
} from "../memory-system/index.ts";
import {
  createDefaultEvidence,
  enumSchema,
  errorResult,
  evidenceArraySchema,
  objectSchema,
  readOptionalEvidenceParam as readOptionalEvidenceParamHelper,
  readOptionalStringArrayParam as readOptionalStringArrayParamHelper,
  readOptionalStringParam as readOptionalStringParamHelper,
  readParam,
  readStringParam as readStringParamHelper,
  stringArraySchema,
  stringSchema,
} from "../memory-system/tool-helpers.ts";

export function createExperienceMemoryTools(options: {
  readonly memorySystem: MemorySystem;
  readonly defaultAgentId?: string | undefined;
}): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return [
    {
      name: "list_experience_memory",
      description: "List experience memory entries filtered by workflow, task, or session scope.",
      inputSchema: objectSchema(
        {
          workflowRunId: stringSchema("Optional workflow run id filter."),
          taskRunId: stringSchema("Optional task run id filter."),
          runtimeSessionId: stringSchema("Optional runtime session id filter."),
          status: enumSchema(["recorded", "summarized", "promoted"], "Optional status filter."),
          kind: enumSchema(["conversation", "recovery", "run", "session", "tool"], "Optional kind filter."),
        },
        [],
      ),
      async call(args, _signal, context) {
        const scope = resolveMemoryScope(args, context?.runContext);
        const result = await options.memorySystem.listExperiences({
          workflowRunId: readOptionalStringParamBase(args, "workflowRunId") ?? scope.workflowRunId,
          taskRunId: readOptionalStringParamBase(args, "taskRunId") ?? scope.taskRunId,
          runtimeSessionId:
            readOptionalStringParamBase(args, "runtimeSessionId") ?? scope.runtimeSessionId,
          status: readOptionalExperienceStatusParam(args, "status"),
          kind: readOptionalExperienceKindParam(args, "kind"),
          context: scope.runContext,
        });

        if (!result.ok) {
          return errorResult("Experience memory operation failed", result.error);
        }

        return {
          text: formatExperienceList(result.value),
          details: { entries: result.value },
        };
      },
    },
    {
      name: "get_experience_memory",
      description: "Read a single experience memory entry by id.",
      inputSchema: objectSchema({ id: stringSchema("Experience memory entry id.") }, ["id"]),
      async call(args, _signal, context) {
        const runContext = createExpertAgentRunContext(context?.runContext);
        const result = await options.memorySystem.getExperience({
          id: readStringParamBase(args, "id"),
          context: runContext,
        });

        if (!result.ok) {
          return errorResult("Experience memory operation failed", result.error);
        }

        return {
          text: formatExperienceRecord(result.value),
          details: { entry: result.value },
        };
      },
    },
    {
      name: "append_experience_memory",
      description: "Append an experience memory entry with evidence derived from the current run when possible.",
      inputSchema: objectSchema(
        {
          id: stringSchema("Optional experience memory id."),
          scope: enumSchema(["run", "session", "agent", "workspace", "organization"], "Memory scope."),
          workflowRunId: stringSchema("Optional workflow run id."),
          taskRunId: stringSchema("Optional task run id."),
          runtimeSessionId: stringSchema("Optional runtime session id."),
          kind: enumSchema(["conversation", "recovery", "run", "session", "tool"], "Experience kind."),
          title: stringSchema("Optional title."),
          content: stringSchema("Experience content."),
          status: enumSchema(["recorded", "summarized", "promoted"], "Optional status."),
          tags: stringArraySchema("Optional tags."),
          evidence: evidenceArraySchema(),
        },
        ["scope", "kind", "content"],
      ),
      async call(args, _signal, context) {
        const scope = resolveMemoryScope(args, context?.runContext);
        const record: ExperienceMemoryRecord = {
          id: readOptionalStringParamBase(args, "id") ?? createExperienceMemoryId(),
          type: "experience",
          scope: readScopeParam(args, "scope"),
          workflowRunId: readOptionalStringParamBase(args, "workflowRunId") ?? scope.workflowRunId,
          taskRunId: readOptionalStringParamBase(args, "taskRunId") ?? scope.taskRunId,
          runtimeSessionId:
            readOptionalStringParamBase(args, "runtimeSessionId") ?? scope.runtimeSessionId,
          kind: readExperienceKindParam(args, "kind"),
          title: readOptionalStringParamBase(args, "title"),
          content: readStringParamBase(args, "content"),
          status: readOptionalExperienceStatusParam(args, "status") ?? "recorded",
          tags: readOptionalStringArrayParamBase(args, "tags"),
          provenance: {
            createdBy: scope.actorAgentId ?? options.defaultAgentId ?? "unknown-agent",
            updatedBy: scope.actorAgentId ?? options.defaultAgentId ?? "unknown-agent",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            evidence:
              readOptionalEvidenceParamBase(args, "evidence") ?? createDefaultEvidence(scope),
          },
        };
        const result = await options.memorySystem.writeExperience({
          record,
          context: scope.runContext,
        });

        if (!result.ok) {
          return errorResult("Experience memory operation failed", result.error);
        }

        return {
          text: `Appended experience memory: ${result.value.id}`,
          details: { entry: result.value },
        };
      },
    },
  ];
}

function resolveMemoryScope(
  args: unknown,
  runContextInput: Parameters<typeof createExpertAgentRunContext>[0],
) {
  const runContext = createExpertAgentRunContext(runContextInput);
  const runScope = readExecutionRunScope(runContext);

  return {
    workflowRunId: readOptionalStringParamBase(args, "workflowRunId") ?? runScope.workflowRunId,
    taskRunId: readOptionalStringParamBase(args, "taskRunId") ?? runScope.taskRunId,
    runtimeSessionId:
      readOptionalStringParamBase(args, "runtimeSessionId") ?? runScope.runtimeSessionId,
    actorAgentId: runContext.source?.id,
    runContext,
  };
}

function createExperienceMemoryId(): string {
  return `experience-memory-${crypto.randomUUID()}`;
}

function formatExperienceList(entries: readonly ExperienceMemoryRecord[]): string {
  if (entries.length === 0) {
    return "No experience memory entries found.";
  }

  return entries.map(formatExperienceRecord).join("\n\n");
}

function formatExperienceRecord(entry: ExperienceMemoryRecord): string {
  const lines = [
    `- id: ${entry.id}`,
    `  scope: ${entry.scope}`,
    `  kind: ${entry.kind}`,
    `  status: ${entry.status}`,
    entry.workflowRunId === undefined ? undefined : `  workflowRunId: ${entry.workflowRunId}`,
    entry.taskRunId === undefined ? undefined : `  taskRunId: ${entry.taskRunId}`,
    entry.runtimeSessionId === undefined ? undefined : `  runtimeSessionId: ${entry.runtimeSessionId}`,
    entry.title === undefined ? undefined : `  title: ${entry.title}`,
    entry.summary === undefined ? undefined : `  summary: ${entry.summary}`,
    "  content:",
    ...entry.content.split("\n").map((line) => `    ${line}`),
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function readScopeParam(
  params: unknown,
  key: string,
): ExperienceMemoryRecord["scope"] {
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

  throw new Error(`Experience memory tool requires scope parameter "${key}".`);
}

function readExperienceKindParam(
  params: unknown,
  key: string,
): ExperienceMemoryRecord["kind"] {
  const value = readParam(params, key);

  if (
    value === "conversation" ||
    value === "recovery" ||
    value === "run" ||
    value === "session" ||
    value === "tool"
  ) {
    return value;
  }

  throw new Error(`Experience memory tool requires kind parameter "${key}".`);
}

function readOptionalExperienceKindParam(
  params: unknown,
  key: string,
): ExperienceMemoryRecord["kind"] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  return readExperienceKindParam(params, key);
}

function readOptionalExperienceStatusParam(
  params: unknown,
  key: string,
): ExperienceMemoryRecord["status"] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (value === "recorded" || value === "summarized" || value === "promoted") {
    return value;
  }

  throw new Error(`Experience memory tool parameter "${key}" must be recorded, summarized, or promoted.`);
}

function readStringParamBase(params: unknown, key: string): string {
  return readStringParamHelper(params, key, "Experience memory tool");
}

function readOptionalStringParamBase(params: unknown, key: string): string | undefined {
  return readOptionalStringParamHelper(params, key, "Experience memory tool");
}

function readOptionalStringArrayParamBase(params: unknown, key: string): readonly string[] | undefined {
  return readOptionalStringArrayParamHelper(params, key, "Experience memory tool");
}

function readOptionalEvidenceParamBase(params: unknown, key: string) {
  return readOptionalEvidenceParamHelper(params, key, "Experience memory tool");
}
