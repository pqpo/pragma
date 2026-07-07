import type {
  ExperienceMemoryKind,
  ExperienceMemoryRecord,
  FactMemoryRecord,
  MemoryRuntimeControl,
  MemoryScope,
  SkillMemoryRecord,
  TaskMemoryRecord,
} from "./types.ts";

export interface MemorySummaryConfig {
  readonly maxBytes: number;
  readonly perRecordMaxChars: number;
  readonly maxTaskItems: number;
  readonly maxFactItems: number;
  readonly maxSkillItems: number;
  readonly maxExperienceItems: number;
}

export const DEFAULT_MEMORY_SUMMARY_CONFIG: MemorySummaryConfig = {
  maxBytes: 8192,
  perRecordMaxChars: 220,
  maxTaskItems: 5,
  maxFactItems: 6,
  maxSkillItems: 5,
  maxExperienceItems: 2,
};

export interface AlwaysOnMemorySummaryInput {
  readonly tasks: readonly TaskMemoryRecord[];
  readonly facts: readonly FactMemoryRecord[];
  readonly skills: readonly SkillMemoryRecord[];
  readonly experiences: readonly ExperienceMemoryRecord[];
  readonly config?: Partial<MemorySummaryConfig> | undefined;
}

interface NamedDomain {
  readonly label: string;
  readonly count: number;
}

export function resolveMemorySummaryConfig(
  input: Partial<MemorySummaryConfig> | undefined,
): MemorySummaryConfig {
  return {
    ...DEFAULT_MEMORY_SUMMARY_CONFIG,
    ...input,
  };
}

export function normalizeTaskMemorySummary(
  record: TaskMemoryRecord,
  maxChars: number,
): string {
  const parts = [
    record.title,
    summarizeTaskStatus(record),
    summarizeTaskItems(record),
    firstSentence(record.content),
  ].filter((value): value is string => isNonEmptyString(value));

  return clampSummary(parts.join(". "), maxChars);
}

export function normalizeExperienceMemorySummary(
  record: ExperienceMemoryRecord,
  maxChars: number,
): string {
  const parts = [
    record.title,
    `${humanizeExperienceKind(record.kind)} ${record.status}`,
    firstSentence(record.content),
  ].filter((value): value is string => isNonEmptyString(value));

  return clampSummary(parts.join(". "), maxChars);
}

export function normalizeFactMemorySummary(
  record: FactMemoryRecord,
  maxChars: number,
): string {
  const parts = [
    record.title,
    record.statement,
    summarizeFactScope(record.scope),
    record.confidence === "verified" ? "verified" : `${record.confidence} confidence`,
  ].filter((value): value is string => isNonEmptyString(value));

  return clampSummary(parts.join(". "), maxChars);
}

export function normalizeSkillMemorySummary(
  record: SkillMemoryRecord,
  maxChars: number,
): string {
  const parts = [
    record.problemClass,
    firstNonEmpty(record.recommendedApproach),
    record.failureModes[0] === undefined ? undefined : `Avoid ${record.failureModes[0]}`,
  ].filter((value): value is string => isNonEmptyString(value));

  return clampSummary(parts.join(". "), maxChars);
}

export function normalizeTaskRecord(
  record: TaskMemoryRecord,
  maxChars: number,
): TaskMemoryRecord {
  return {
    ...record,
    summary: normalizeTaskMemorySummary(record, maxChars),
  };
}

export function normalizeExperienceRecord(
  record: ExperienceMemoryRecord,
  maxChars: number,
): ExperienceMemoryRecord {
  return {
    ...record,
    summary: normalizeExperienceMemorySummary(record, maxChars),
  };
}

export function normalizeFactRecord(
  record: FactMemoryRecord,
  maxChars: number,
): FactMemoryRecord {
  return {
    ...record,
    summary: normalizeFactMemorySummary(record, maxChars),
  };
}

export function normalizeSkillRecord(
  record: SkillMemoryRecord,
  maxChars: number,
): SkillMemoryRecord {
  return {
    ...record,
    summary: normalizeSkillMemorySummary(record, maxChars),
  };
}

export function renderAlwaysOnMemorySummary(input: AlwaysOnMemorySummaryInput): string {
  const config = resolveMemorySummaryConfig(input.config);
  const activeTasks = selectTaskSummaries(input.tasks, config);
  const activeFacts = selectFactSummaries(input.facts, config);
  const skillEntries = selectSkillSummaries(input.skills, config);
  const experienceEntries = selectExperienceEntryPoints(input.experiences, config);
  const factDomains = deriveFactDomains(input.facts);
  const skillDomains = deriveSkillDomains(input.skills);
  const experienceDomains = deriveExperienceDomains(input.experiences);

  const content = [
    "# Memory Guide",
    "",
    ...renderCurrentTaskState(activeTasks),
    ...renderActiveConstraints(activeFacts),
    ...renderSkillEntryPoints(skillEntries, skillDomains),
    ...renderMemorySearchGuide(),
    ...renderSearchableDomains(factDomains, skillDomains, experienceDomains, experienceEntries),
  ].join("\n");

  return trimUtf8(content, config.maxBytes);
}

function renderCurrentTaskState(records: readonly TaskMemoryRecord[]): readonly string[] {
  return renderSection(
    "Current Task State",
    records.map((record) => formatSummaryLine(taskLabel(record), record.summary ?? "")),
    "No active or recent task memory is available.",
  );
}

function renderActiveConstraints(records: readonly FactMemoryRecord[]): readonly string[] {
  return renderSection(
    "Active Constraints And Preferences",
    records.map((record) => {
      const scopePrefix = summarizeFactScope(record.scope);
      const summary = record.summary ?? record.statement;
      return formatSummaryLine(factLabel(record), `${scopePrefix}: ${summary}`);
    }),
    "No currently effective fact memory is available.",
  );
}

function renderSkillEntryPoints(
  records: readonly SkillMemoryRecord[],
  domains: readonly NamedDomain[],
): readonly string[] {
  const lines = [
    "## Skill Entry Points",
    "Use skill memory when the problem type is known but the recommended path, pitfalls, or recovery steps are not clear yet.",
    "",
    "### Searchable Skill Domains",
    ...renderBullets(
      domains.slice(0, 8).map((domain) => `${domain.label} (${domain.count})`),
      "No reusable skill domains are available.",
    ),
    "",
    "### Priority Skills To Open First",
    ...renderBullets(
      records.map((record) =>
        formatSummaryLine(skillLabel(record), record.summary ?? record.problemClass),
      ),
      "No priority skill entry point is available.",
    ),
    "",
  ];

  return lines;
}

function renderMemorySearchGuide(): readonly string[] {
  return [
    "## Memory Search Guide",
    "- Search `fact` memory when you need to confirm what is true, what the user prefers, or which rules and boundaries are currently in force.",
    "- Search `skill` memory when you know the class of problem but need the recommended approach, common pitfalls, or a recovery path.",
    "- Search `experience` memory when you need precedent: what was tried before, what failed, and how recovery worked.",
    "- Prefer `task` memory for the current execution state; use the other memory types when the answer is not already in the current task snapshot.",
    "",
  ];
}

function renderSearchableDomains(
  factDomains: readonly NamedDomain[],
  skillDomains: readonly NamedDomain[],
  experienceDomains: readonly NamedDomain[],
  experienceEntries: readonly ExperienceMemoryRecord[],
): readonly string[] {
  return [
    "## Searchable Domains",
    "### Fact Domains",
    ...renderBullets(
      factDomains.slice(0, 8).map((domain) => `${domain.label} (${domain.count})`),
      "No searchable fact domain is available.",
    ),
    "",
    "### Skill Domains",
    ...renderBullets(
      skillDomains.slice(0, 8).map((domain) => `${domain.label} (${domain.count})`),
      "No searchable skill domain is available.",
    ),
    "",
    "### Experience Domains",
    ...renderBullets(
      experienceDomains.slice(0, 6).map((domain) => `${domain.label} (${domain.count})`),
      "No searchable experience domain is available.",
    ),
    "",
    "### Recent Experience Entry Points",
    ...renderBullets(
      experienceEntries.map((record) =>
        formatSummaryLine(experienceLabel(record), record.summary ?? firstSentence(record.content)),
      ),
      "No recent experience entry point is available.",
    ),
    "",
  ];
}

function renderSection(title: string, items: readonly string[], empty: string): readonly string[] {
  return [
    `## ${title}`,
    ...renderBullets(items, empty),
    "",
  ];
}

function renderBullets(items: readonly string[], empty: string): readonly string[] {
  if (items.length === 0) {
    return [`- ${empty}`];
  }

  return items.map((item) => `- ${item}`);
}

function selectTaskSummaries(
  records: readonly TaskMemoryRecord[],
  config: MemorySummaryConfig,
): readonly TaskMemoryRecord[] {
  return [...records]
    .filter((record) => record.status === "active" || record.status === "resolved")
    .sort((left, right) => {
      const statusDelta = taskStatusWeight(right.status) - taskStatusWeight(left.status);

      if (statusDelta !== 0) {
        return statusDelta;
      }

      const kindDelta = taskKindWeight(right.kind) - taskKindWeight(left.kind);

      if (kindDelta !== 0) {
        return kindDelta;
      }

      return right.provenance.updatedAt.localeCompare(left.provenance.updatedAt);
    })
    .slice(0, config.maxTaskItems);
}

function selectFactSummaries(
  records: readonly FactMemoryRecord[],
  config: MemorySummaryConfig,
): readonly FactMemoryRecord[] {
  return [...records]
    .filter((record) => isActiveFact(record))
    .sort((left, right) => compareFactsForExposure(left, right))
    .slice(0, config.maxFactItems);
}

function selectSkillSummaries(
  records: readonly SkillMemoryRecord[],
  config: MemorySummaryConfig,
): readonly SkillMemoryRecord[] {
  return [...records]
    .sort((left, right) => {
      const signalDelta = skillSignalWeight(right) - skillSignalWeight(left);

      if (signalDelta !== 0) {
        return signalDelta;
      }

      const priorityDelta = runtimePriority(right.runtime) - runtimePriority(left.runtime);

      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return right.provenance.updatedAt.localeCompare(left.provenance.updatedAt);
    })
    .slice(0, config.maxSkillItems);
}

function selectExperienceEntryPoints(
  records: readonly ExperienceMemoryRecord[],
  config: MemorySummaryConfig,
): readonly ExperienceMemoryRecord[] {
  return [...records]
    .filter((record) => record.status === "summarized" || record.status === "promoted")
    .sort((left, right) => {
      const statusDelta = experienceStatusWeight(right.status) - experienceStatusWeight(left.status);

      if (statusDelta !== 0) {
        return statusDelta;
      }

      return right.provenance.updatedAt.localeCompare(left.provenance.updatedAt);
    })
    .slice(0, config.maxExperienceItems);
}

function deriveFactDomains(records: readonly FactMemoryRecord[]): readonly NamedDomain[] {
  return countNamedDomains(
    records
      .filter((record) => isActiveFact(record))
      .flatMap((record) => inferFactDomains(record)),
  );
}

function deriveSkillDomains(records: readonly SkillMemoryRecord[]): readonly NamedDomain[] {
  return countNamedDomains(
    records.flatMap((record) => inferSkillDomains(record)),
  );
}

function deriveExperienceDomains(records: readonly ExperienceMemoryRecord[]): readonly NamedDomain[] {
  return countNamedDomains(
    records.map((record) => humanizeExperienceKind(record.kind)),
  );
}

function countNamedDomains(labels: readonly string[]): readonly NamedDomain[] {
  const counts = new Map<string, number>();

  for (const label of labels.map(normalizeDomainLabel).filter(isNonEmptyString)) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function inferFactDomains(record: FactMemoryRecord): readonly string[] {
  const haystack = [record.title, record.summary, record.statement, ...(record.tags ?? [])]
    .filter((value): value is string => isNonEmptyString(value))
    .join(" ")
    .toLowerCase();
  const domains = [
    haystack.includes("user preference") || haystack.includes("prefers") ? "user preferences" : undefined,
    haystack.includes("architecture") || haystack.includes("module") || haystack.includes("owner")
      ? "architecture and ownership"
      : undefined,
    haystack.includes("business rule") || haystack.includes("policy") ? "rules and policies" : undefined,
    haystack.includes("workflow") || haystack.includes("process") ? "workflow constraints" : undefined,
  ].filter((value): value is string => value !== undefined);

  return domains.length > 0 ? domains : deriveDomainsFromTags(record.tags);
}

function inferSkillDomains(record: SkillMemoryRecord): readonly string[] {
  const domains = [
    record.problemClass,
    ...deriveDomainsFromTags(record.tags),
  ]
    .flatMap((value) => splitDomainTokens(value))
    .slice(0, 6);

  return domains.length > 0 ? domains : ["general problem solving"];
}

function deriveDomainsFromTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) {
    return [];
  }

  return tags
    .map((tag) => tag.replace(/^[^:]+:/, "").replace(/[-_]/g, " ").trim())
    .filter((tag) => tag.length >= 3);
}

function splitDomainTokens(value: string | undefined): readonly string[] {
  if (!isNonEmptyString(value)) {
    return [];
  }

  const normalized = value.toLowerCase().replace(/[^a-z0-9\s/-]/g, " ");
  const segments = normalized
    .split(/[/,]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 3);

  if (segments.length > 0) {
    return segments.slice(0, 3);
  }

  return [normalized.trim()].filter((segment) => segment.length >= 3);
}

function normalizeDomainLabel(label: string): string {
  return label
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function compareFactsForExposure(left: FactMemoryRecord, right: FactMemoryRecord): number {
  const scopeDelta = scopeExposureWeight(right.scope) - scopeExposureWeight(left.scope);

  if (scopeDelta !== 0) {
    return scopeDelta;
  }

  const triggerDelta = runtimeTriggerWeight(right.runtime) - runtimeTriggerWeight(left.runtime);

  if (triggerDelta !== 0) {
    return triggerDelta;
  }

  const affinityDelta = factAffinityWeight(right) - factAffinityWeight(left);

  if (affinityDelta !== 0) {
    return affinityDelta;
  }

  const confidenceDelta = factConfidenceWeight(right.confidence) - factConfidenceWeight(left.confidence);

  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return right.observedAt.localeCompare(left.observedAt);
}

function scopeExposureWeight(scope: MemoryScope): number {
  switch (scope) {
    case "session":
      return 5;
    case "run":
      return 4;
    case "agent":
      return 3;
    case "workspace":
      return 2;
    case "organization":
    default:
      return 1;
  }
}

function runtimeTriggerWeight(runtime: MemoryRuntimeControl | undefined): number {
  switch (runtime?.trigger) {
    case "always_on":
      return 3;
    case "model_decision":
      return 2;
    case "manual":
    default:
      return 1;
  }
}

function taskStatusWeight(status: TaskMemoryRecord["status"]): number {
  switch (status) {
    case "active":
      return 2;
    case "resolved":
      return 1;
    case "archived":
    default:
      return 0;
  }
}

function taskKindWeight(kind: TaskMemoryRecord["kind"]): number {
  switch (kind) {
    case "progress":
      return 6;
    case "todo":
      return 5;
    case "question":
      return 4;
    case "decision":
      return 3;
    case "handoff":
      return 2;
    case "note":
    default:
      return 1;
  }
}

function factAffinityWeight(record: FactMemoryRecord): number {
  const haystack = [record.title, record.summary, record.statement, ...(record.tags ?? [])]
    .filter((value): value is string => isNonEmptyString(value))
    .join(" ")
    .toLowerCase();

  return [
    "user profile",
    "user preference",
    "prefers",
    "business rule",
    "architecture",
    "owner",
    "module",
    "constraint",
    "must",
    "do not",
  ].reduce((score, needle) => score + (haystack.includes(needle) ? 1 : 0), 0);
}

function factConfidenceWeight(confidence: FactMemoryRecord["confidence"]): number {
  switch (confidence) {
    case "verified":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function skillSignalWeight(record: SkillMemoryRecord): number {
  return (
    record.recommendedApproach.length * 3 +
    record.failureModes.length * 2 +
    record.recoveryPlaybook.length +
    record.goodPractices.length
  );
}

function runtimePriority(runtime: MemoryRuntimeControl | undefined): number {
  return runtime?.priority ?? 0;
}

function experienceStatusWeight(status: ExperienceMemoryRecord["status"]): number {
  switch (status) {
    case "promoted":
      return 3;
    case "summarized":
      return 2;
    case "recorded":
    default:
      return 1;
  }
}

function isActiveFact(record: FactMemoryRecord): boolean {
  if (record.invalidatedAt !== undefined || record.supersededBy !== undefined) {
    return false;
  }

  return record.expiresAt === undefined || Date.parse(record.expiresAt) > Date.now();
}

function clampSummary(value: string, maxChars: number): string {
  return trimCharacters(value.replace(/\s+/g, " ").trim(), maxChars);
}

function summarizeTaskItems(record: TaskMemoryRecord): string | undefined {
  if (record.kind !== "todo" || record.items === undefined || record.items.length === 0) {
    return undefined;
  }

  const pending = record.items.filter((item) => !item.done).map((item) => item.text);

  if (pending.length === 0) {
    return "all todo items completed";
  }

  return `next: ${pending.slice(0, 2).join("; ")}`;
}

function summarizeTaskStatus(record: TaskMemoryRecord): string {
  return `${record.kind} is ${record.status}`;
}

function summarizeFactScope(scope: MemoryScope): string {
  switch (scope) {
    case "session":
      return "session rule";
    case "run":
      return "run rule";
    case "agent":
      return "agent preference";
    case "workspace":
      return "workspace rule";
    case "organization":
      return "organization rule";
    default:
      return `${scope} fact`;
  }
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.{1,220}?[.!?])(?:\s|$)/);

  return match?.[1] ?? trimCharacters(normalized, 220);
}

function firstNonEmpty(values: readonly string[]): string | undefined {
  return values.find((value) => isNonEmptyString(value));
}

function humanizeExperienceKind(kind: ExperienceMemoryKind): string {
  switch (kind) {
    case "conversation":
      return "conversation";
    case "recovery":
      return "recovery path";
    case "run":
      return "task history";
    case "session":
      return "session history";
    case "tool":
    default:
      return "tool usage";
  }
}

function formatSummaryLine(label: string, summary: string): string {
  return `**${label}**: ${summary}`;
}

function taskLabel(record: TaskMemoryRecord): string {
  return record.title ?? `${record.kind} (${record.status})`;
}

function factLabel(record: FactMemoryRecord): string {
  return record.title ?? trimCharacters(record.statement, 80);
}

function skillLabel(record: SkillMemoryRecord): string {
  return record.title ?? trimCharacters(record.problemClass, 80);
}

function experienceLabel(record: ExperienceMemoryRecord): string {
  return record.title ?? `${humanizeExperienceKind(record.kind)} (${record.status})`;
}

function trimCharacters(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function trimUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, mid).trimEnd()}\n`;

    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(0, low).trimEnd();
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
