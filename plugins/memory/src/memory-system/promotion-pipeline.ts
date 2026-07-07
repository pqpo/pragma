import {
  okMemory,
  type ExperienceMemoryRecord,
  type FactMemoryRecord,
  type MemoryPromotionPipeline,
  type MemoryReference,
  type SkillMemoryRecord,
  type TaskMemoryRecord,
} from "./types.ts";

export function createDefaultMemoryPromotionPipeline(): MemoryPromotionPipeline {
  return {
    async proposeFromTask(records) {
      const experiences = records
        .filter((record) => record.status === "archived" || record.status === "resolved")
        .map((record) => ({
          type: "experience" as const,
          derivedFrom: [{ type: "task" as const, id: record.id }],
          record: toExperienceFromTask(record),
        }));

      return okMemory({
        experiences,
        facts: [],
        skills: [],
      });
    },
    async proposeFromExperience(records) {
      const facts = records.flatMap((record) => proposeFactsFromExperience(record));
      const skills = records.flatMap((record) => proposeSkillsFromExperience(record));

      return okMemory({
        experiences: [],
        facts,
        skills,
      });
    },
  };
}

function toExperienceFromTask(record: TaskMemoryRecord): ExperienceMemoryRecord {
  const now = new Date().toISOString();

  return {
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
    workflowRunId: record.workflowRunId,
    taskRunId: record.taskRunId,
    runtimeSessionId: record.runtimeSessionId,
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

function proposeFactsFromExperience(record: ExperienceMemoryRecord) {
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

  if (!stableSignals.some((signal) => lowerContent.includes(signal) || lowerSummary.includes(signal))) {
    return [];
  }

  const observedAt = record.provenance.updatedAt;
  const reference = createMemoryReference(record);
  const fact: FactMemoryRecord = {
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

function proposeSkillsFromExperience(record: ExperienceMemoryRecord) {
  const lowerContent = record.content.toLowerCase();

  if (!lowerContent.includes("next time") && !lowerContent.includes("recommended")) {
    return [];
  }

  const reference = createMemoryReference(record);
  const skill: SkillMemoryRecord = {
    id: `skill-memory-${record.id}`,
    type: "skill",
    scope: inferFactScope(record),
    title: record.title,
    tags: mergeTags(record.tags, ["source:experience-memory", `experience-kind:${record.kind}`]),
    problemClass: record.title ?? `experience-${record.kind}`,
    recommendedApproach: splitLines(record.content),
    goodPractices: splitLines(record.content),
    antiPatterns: [],
    failureModes: record.kind === "recovery" ? splitLines(record.content) : [],
    recoveryPlaybook: splitLines(record.content),
    confidence: inferFactConfidence(record),
    provenance: {
      createdBy: "memory-promotion",
      updatedBy: "memory-promotion",
      source: "experience-memory",
      createdAt: record.provenance.updatedAt,
      updatedAt: record.provenance.updatedAt,
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
      type: "skill" as const,
      record: skill,
      derivedFrom: [reference],
    },
  ];
}

function inferFactScope(record: ExperienceMemoryRecord): FactMemoryRecord["scope"] {
  return record.scope === "run" ? "workspace" : record.scope;
}

function inferFactConfidence(record: ExperienceMemoryRecord): FactMemoryRecord["confidence"] {
  if (record.provenance.evidence.some((evidence) => evidence.type === "external" || evidence.type === "context")) {
    return "verified";
  }

  if (record.provenance.evidence.some((evidence) => evidence.type === "run" || evidence.type === "session")) {
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
  return record.title ?? `${record.kind} recorded for workflow ${record.workflowRunId}`;
}

function chooseExperienceKind(record: TaskMemoryRecord): ExperienceMemoryRecord["kind"] {
  switch (record.kind) {
    case "handoff":
      return "session";
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

function splitLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function mergeTags(
  current: readonly string[] | undefined,
  extra: readonly string[],
): readonly string[] | undefined {
  const combined = new Set([...(current ?? []), ...extra]);

  return combined.size === 0 ? undefined : [...combined];
}
