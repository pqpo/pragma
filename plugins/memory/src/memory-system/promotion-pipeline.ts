import {
  okMemory,
  type ExperienceMemoryRecord,
  type FactMemoryRecord,
  type MemoryDistillationCandidate,
  type MemoryDistillationPipeline,
  type MemoryEvidenceRecord,
  type MemoryRunEvidencePayload,
  type MemoryExecutionEvidencePayload,
  type MemoryReference,
  type SkillMemoryRecord,
  type TaskMemoryRecord,
} from "./types.ts";
import {
  EXPERIENCE_MEMORY_SCHEMA_VERSION,
  FACT_MEMORY_SCHEMA_VERSION,
  SKILL_MEMORY_SCHEMA_VERSION,
} from "./schema.ts";

export function createDefaultMemoryDistillationPipeline(): MemoryDistillationPipeline {
  return {
    async distill(input) {
      const experiences = input.evidence.flatMap((record) =>
        proposeExperiencesFromEvidence(record),
      );
      const facts = experiences.flatMap((candidate) =>
        proposeFactsFromExperience(candidate.record),
      );
      const skills = input.evidence.flatMap((record) => proposeSkillsFromEvidence(record));

      return okMemory({
        experiences,
        facts,
        skills,
      });
    },
  };
}

function proposeExperiencesFromEvidence(
  record: MemoryEvidenceRecord,
): readonly MemoryDistillationCandidate<"experience", ExperienceMemoryRecord>[] {
  if (record.kind === "task_archive") {
    const payload = record.payload as { readonly task: TaskMemoryRecord };
    const task = payload.task;

    if (task.status !== "archived" && task.status !== "resolved") {
      return [];
    }

    return [
      {
        type: "experience" as const,
        derivedFrom: [{ type: "task" as const, id: task.id }],
        record: toExperienceFromTask(task),
      },
    ] satisfies readonly MemoryDistillationCandidate<"experience", ExperienceMemoryRecord>[];
  }

  if (record.kind !== "execution") {
    return [];
  }

  const payload = record.payload as MemoryExecutionEvidencePayload;
  const content = toExecutionExperienceContent(payload);
  const now = record.updatedAt;

  return [
    {
      type: "experience" as const,
      derivedFrom: [],
      record: {
        schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
        id: `experience-memory-${record.id}`,
        type: "experience" as const,
        scope: record.scope,
        title: `Execution evidence ${payload.executionId}`,
        summary: content,
        tags: mergeTags(undefined, [
          "source:evidence-execution",
          ...(payload.externalContext ? ["external-context"] : []),
        ]),
        executionId: record.executionId,
        invocationId: record.invocationId,
        runtimeSession: record.runtimeSession,
        kind: "execution",
        content,
        status: "summarized",
        provenance: {
          createdBy: "memory-distillation",
          updatedBy: "memory-distillation",
          source: "execution-evidence",
          createdAt: now,
          updatedAt: now,
          evidence: [
            {
              type: "external",
              id: record.id,
              uri: `memory://${record.id}`,
            },
          ],
        },
      },
    },
  ] satisfies readonly MemoryDistillationCandidate<"experience", ExperienceMemoryRecord>[];
}

function toExperienceFromTask(record: TaskMemoryRecord): ExperienceMemoryRecord {
  const now = new Date().toISOString();

  return {
    schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
    id: `experience-memory-${record.id}`,
    type: "experience",
    scope: "session",
    title: record.title,
    summary: summarizeTaskRecord(record),
    tags: mergeTags(record.tags, [
      "source:task-memory",
      `task-kind:${record.kind}`,
      ...(record.visibility === "private" ? ["visibility:private"] : ["visibility:shared"]),
    ]),
    executionId: record.executionId,
    invocationId: record.invocationId,
    runtimeSession: record.runtimeSession,
    kind: chooseExperienceKind(record),
    content: record.content,
    status: "summarized",
    provenance: {
      createdBy: "memory-promotion",
      updatedBy: "memory-promotion",
      source: "task-memory",
      createdAt: now,
      updatedAt: now,
      evidence: [
        {
          type: "memory",
          id: record.id,
          memory: { type: "task", id: record.id },
        },
      ],
    },
  };
}

function toExecutionExperienceContent(payload: MemoryExecutionEvidencePayload): string {
  const runLines = payload.runs.map((run, index) => {
    const prefix = `Run ${index + 1}: ${run.query}`;
    if (run.status === "succeeded") {
      return run.outputExcerpt === undefined
        ? `${prefix}. Succeeded.`
        : `${prefix}. ${run.outputExcerpt}`;
    }

    if (run.status === "cancelled") {
      return `${prefix}. Cancelled.`;
    }

    return run.errorMessage === undefined
      ? `${prefix}. Failed without a captured error message.`
      : `${prefix}. Failed. ${run.errorMessage}`;
  });

  const lessons = dedupeStrings(payload.runs.flatMap((run) => run.lessons)).slice(0, 6);

  return [
    `Execution ${payload.executionId} completed ${payload.runs.length} run(s).`,
    ...runLines,
    ...(lessons.length === 0 ? [] : [`Reusable lessons: ${lessons.join(" ")}`]),
  ].join("\n");
}

function proposeFactsFromExperience(
  record: ExperienceMemoryRecord,
): readonly MemoryDistillationCandidate<"fact", FactMemoryRecord>[] {
  if (record.provenance.evidence.length === 0) {
    return [];
  }

  if (record.status === "recorded") {
    return [];
  }

  const lowerContent = record.content.toLowerCase();
  const lowerSummary = record.summary?.toLowerCase() ?? "";

  if (isTimeSensitive(lowerContent) || isTimeSensitive(lowerSummary)) {
    return [];
  }

  const confidence = inferFactConfidence(record);

  if (confidence === "low" || confidence === "medium") {
    return [];
  }

  const stableSignals = [
    "path:",
    "located at",
    "under ",
    "user prefers",
    "business rule",
    "architecture",
    "owned by",
    "belongs to",
  ];

  if (
    !stableSignals.some((signal) => lowerContent.includes(signal) || lowerSummary.includes(signal))
  ) {
    return [];
  }

  const observedAt = record.provenance.updatedAt;
  const reference = createMemoryReference(record);
  const fact: FactMemoryRecord = {
    schemaVersion: FACT_MEMORY_SCHEMA_VERSION,
    id: `fact-memory-${record.id}`,
    type: "fact",
    scope: inferFactScope(record),
    title: record.title,
    tags: mergeTags(record.tags, ["source:experience-memory", `experience-kind:${record.kind}`]),
    statement: record.content,
    confidence,
    observedAt,
    verifiedAt: confidence === "verified" ? observedAt : undefined,
    reviewAt: undefined,
    expiresAt: undefined,
    invalidatedAt: undefined,
    supersededBy: undefined,
    conflictsWith: undefined,
    provenance: {
      createdBy: "memory-promotion",
      updatedBy: "memory-promotion",
      source: "experience-memory",
      createdAt: observedAt,
      updatedAt: observedAt,
      evidence: [
        ...record.provenance.evidence,
        {
          type: "memory",
          id: record.id,
          memory: reference,
        },
      ],
    },
  };

  return [
    {
      type: "fact" as const,
      record: fact,
      derivedFrom: [reference],
    },
  ];
}

function proposeSkillsFromEvidence(
  record: MemoryEvidenceRecord,
): readonly MemoryDistillationCandidate<"skill", SkillMemoryRecord>[] {
  if (record.kind !== "execution") {
    return [];
  }

  const payload = record.payload as MemoryExecutionEvidencePayload;

  if (payload.runs.length === 0) {
    return [];
  }

  const recommendedApproach = dedupeStrings(
    payload.runs.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "completed")
        .map((tool) => `Prefer ${tool.toolName} when solving this class of problem.`),
    ),
  );
  const failureModes = dedupeStrings(
    payload.runs.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "failed")
        .map((tool) => `${tool.toolName} can fail if retried without a clearer path.`),
    ),
  );
  const recoveryPlaybook = dedupeStrings(payload.runs.flatMap((run) => deriveDefaultFixes(run)));
  const goodPractices = dedupeStrings(payload.runs.flatMap((run) => derivePositivePractices(run)));
  const antiPatterns = dedupeStrings(payload.runs.flatMap((run) => deriveAntiPatterns(run)));
  const skillId = deriveSkillIdFromQueries(payload.runs.map((run) => run.query));

  if (
    recommendedApproach.length === 0 &&
    failureModes.length === 0 &&
    recoveryPlaybook.length === 0
  ) {
    return [];
  }

  return [
    {
      type: "skill" as const,
      derivedFrom: [],
      record: {
        schemaVersion: SKILL_MEMORY_SCHEMA_VERSION,
        id: skillId,
        type: "skill" as const,
        scope: record.scope === "run" ? "workspace" : record.scope,
        title: `Skill derived from execution ${payload.executionId}`,
        summary: payload.runs[0]?.query,
        tags: mergeTags(undefined, ["source:evidence-execution"]),
        problemClass: skillId.replaceAll("-", " "),
        recommendedApproach,
        goodPractices,
        antiPatterns,
        failureModes,
        recoveryPlaybook,
        confidence: "high",
        provenance: {
          createdBy: "memory-distillation",
          updatedBy: "memory-distillation",
          source: "execution-evidence",
          createdAt: record.updatedAt,
          updatedAt: record.updatedAt,
          evidence: [
            {
              type: "external",
              id: record.id,
              uri: `memory://${record.id}`,
            },
          ],
        },
      },
    },
  ] satisfies readonly MemoryDistillationCandidate<"skill", SkillMemoryRecord>[];
}

function inferFactScope(record: ExperienceMemoryRecord): FactMemoryRecord["scope"] {
  return record.scope === "run" ? "workspace" : record.scope;
}

function inferFactConfidence(record: ExperienceMemoryRecord): FactMemoryRecord["confidence"] {
  if (
    record.provenance.evidence.some(
      (evidence) => evidence.type === "external" || evidence.type === "context",
    )
  ) {
    return "verified";
  }

  if (
    record.provenance.evidence.some(
      (evidence) => evidence.type === "run" || evidence.type === "execution",
    )
  ) {
    return "high";
  }

  return "medium";
}

function createMemoryReference(record: ExperienceMemoryRecord): MemoryReference {
  return {
    type: "experience",
    id: record.id,
  };
}

function summarizeTaskRecord(record: TaskMemoryRecord): string {
  return record.title ?? `${record.kind} recorded for execution ${record.executionId}`;
}

function chooseExperienceKind(record: TaskMemoryRecord): ExperienceMemoryRecord["kind"] {
  switch (record.kind) {
    case "handoff":
      return "execution";
    case "question":
      return "conversation";
    case "todo":
      return "run";
    case "note":
    case "decision":
    case "progress":
    default:
      return "tool";
  }
}

function isTimeSensitive(value: string): boolean {
  return value.includes("today") || value.includes("yesterday") || value.includes("current time");
}

function deriveDefaultFixes(run: MemoryRunEvidencePayload): readonly string[] {
  if (run.tools.some((tool) => tool.status === "failed")) {
    return [
      "Inspect the failed tool path first, then move to the successful path that produced a cleaner result.",
    ];
  }

  if (run.status === "failed") {
    return ["Tighten the approach and validate assumptions earlier in the task."];
  }

  return ["Start from the successful path recorded here before exploring alternatives."];
}

function derivePositivePractices(run: MemoryRunEvidencePayload): readonly string[] {
  const practices = run.tools
    .filter((tool) => tool.status === "completed")
    .map((tool) => `Use ${tool.toolName} deliberately once the task direction is clear.`);

  return practices.length === 0
    ? ["Record the successful path when the task finishes well."]
    : practices;
}

function deriveAntiPatterns(run: MemoryRunEvidencePayload): readonly string[] {
  const patterns = run.tools
    .filter((tool) => tool.status === "failed")
    .map((tool) => `Do not keep retrying ${tool.toolName} without changing the approach.`);

  return patterns.length === 0
    ? ["Do not treat a one-off success as universal without evidence."]
    : patterns;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function deriveSkillIdFromQueries(queries: readonly string[]): string {
  const text = queries.join(" ").toLowerCase();
  const tokens = text
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  const chosen = dedupeStrings(tokens).slice(0, 4);

  return (chosen.length === 0 ? "general-memory-skill" : chosen.join("-")).toLowerCase();
}

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "should",
  "could",
  "would",
  "there",
  "their",
  "task",
  "session",
  "please",
  "implement",
  "continue",
]);

function mergeTags(
  current: readonly string[] | undefined,
  extra: readonly string[],
): readonly string[] | undefined {
  const combined = new Set([...(current ?? []), ...extra]);

  return combined.size === 0 ? undefined : [...combined];
}
