import { readFile } from "node:fs/promises";

import type {
  ExpertAgentPluginSetupContext,
} from "@pragma/core";
import {
  errorMemory,
  okMemory,
  type MemoryResult,
  type RuntimeMemoryRetrieveInput,
  type SkillMemoryGetInput,
  type SkillMemoryListInput,
  type SkillMemoryRecord,
  type SkillMemoryStore,
} from "../memory-system/index.ts";

import { SKILLS_PREFIX } from "./constants.ts";
import { resolveConfig } from "./config.ts";
import {
  collectRecursiveIds,
  createStoredContext,
  exists,
  readStoredContext,
  resolveContextPath,
  resolveMemoryRoot,
  writeStoredMarkdown,
} from "./filesystem.ts";
import {
  dedupeStrings,
  extractSectionBullets,
  humanizeSkillId,
  parseMarkdown,
  sanitizeIdSegment,
} from "./utils.ts";
import { skillIdToContextId } from "./rendering.ts";

export function createSkillMemoryStore(context: ExpertAgentPluginSetupContext): SkillMemoryStore {
  return new FileSystemSkillMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    context,
  });
}

class FileSystemSkillMemoryStore implements SkillMemoryStore {
  private readonly agentId: string;
  private readonly context: ExpertAgentPluginSetupContext;

  constructor(options: {
    readonly agentId: string;
    readonly context: ExpertAgentPluginSetupContext;
  }) {
    this.agentId = options.agentId;
    this.context = options.context;
  }

  async list(input: SkillMemoryListInput): Promise<MemoryResult<readonly SkillMemoryRecord[]>> {
    try {
      if (!(await this.isEnabledForUsage())) {
        return okMemory([]);
      }

      const records = await this.readSkillRecords();
      return okMemory(filterSkillRecords(records, input));
    } catch (caught) {
      return toStoreError("Failed to list skill memory.", caught);
    }
  }

  async get(input: SkillMemoryGetInput): Promise<MemoryResult<SkillMemoryRecord>> {
    try {
      if (!(await this.isEnabledForUsage())) {
        return errorMemory("store_unavailable", "Skill memory is disabled.");
      }

      const id = normalizeSkillContextId(input.id);
      const record = await this.readSkillRecordByContextId(id);

      if (record === undefined) {
        return errorMemory("memory_not_found", `Skill memory not found: ${input.id}`, {
          id: input.id,
        });
      }

      return okMemory(record);
    } catch (caught) {
      return toStoreError(`Failed to read skill memory: ${input.id}`, caught);
    }
  }

  async upsert(inputRecord: SkillMemoryRecord): Promise<MemoryResult<SkillMemoryRecord>> {
    try {
      if (!(await this.isEnabledForUsage())) {
        return errorMemory("store_unavailable", "Skill memory is disabled.");
      }

      const contextId = normalizeSkillContextId(inputRecord.id);
      const stored = createStoredContext({
        id: contextId,
        content: renderSkillRecord(inputRecord),
        metadata: {
          description:
            inputRecord.summary ??
            inputRecord.title ??
            `Skill memory for ${inputRecord.problemClass}.`,
          trigger: inputRecord.runtime?.trigger ?? "model_decision",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      });
      const rootDir = await this.resolveRootDir();
      await writeStoredMarkdown(rootDir, stored, {
        schemaVersion: "pragma.memory-skill/v1",
        agentId: this.agentId,
        skillId: sanitizeIdSegment(inputRecord.id),
        updatedAt: inputRecord.provenance.updatedAt,
        createdAt: inputRecord.provenance.createdAt,
        audit: {
          createdBy: inputRecord.provenance.createdBy ?? "skill-memory",
          updatedBy: inputRecord.provenance.updatedBy,
        },
      });

      const written = await this.readSkillRecordByContextId(contextId);

      if (written === undefined) {
        return errorMemory("store_error", `Failed to load written skill memory: ${inputRecord.id}`);
      }

      return okMemory(written);
    } catch (caught) {
      return toStoreError(`Failed to write skill memory: ${inputRecord.id}`, caught);
    }
  }

  async search(input: {
    readonly query: string;
  }): Promise<MemoryResult<readonly { readonly record: SkillMemoryRecord; readonly score?: number; readonly excerpt?: string }[]>> {
    try {
      if (!(await this.isEnabledForUsage())) {
        return okMemory([]);
      }

      const records = await this.readSkillRecords();
      const matches = scoreSkillRecords(records, input.query).map((match) => ({
        record: match.record,
        score: match.score,
        excerpt: match.excerpt,
      }));

      return okMemory(matches);
    } catch (caught) {
      return toStoreError("Failed to search skill memory.", caught);
    }
  }

  async retrieveForRuntime(
    input: RuntimeMemoryRetrieveInput,
    options?: { readonly maxItems?: number | undefined },
  ): Promise<MemoryResult<readonly SkillMemoryRecord[]>> {
    try {
      if (!(await this.isEnabledForUsage())) {
        return okMemory([]);
      }

      const records = await this.readSkillRecords();
      const matches =
        input.query === undefined || input.query.trim().length === 0
          ? records.map((record) => ({ record, score: 0 }))
          : scoreSkillRecords(records, input.query);
      const maxItems = Math.max(1, options?.maxItems ?? 5);

      return okMemory(matches.slice(0, maxItems).map((match) => match.record));
    } catch (caught) {
      return toStoreError("Failed to retrieve skill memory for runtime.", caught);
    }
  }

  private async resolveRootDir(): Promise<string> {
    const config = await resolveConfig(this.context);

    return resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
  }

  private async isEnabledForUsage(): Promise<boolean> {
    const config = await resolveConfig(this.context);

    return config.enabled && config.useMemories;
  }

  private async readSkillRecords(): Promise<readonly SkillMemoryRecord[]> {
    const rootDir = await this.resolveRootDir();
    const ids = await collectRecursiveIds(rootDir, SKILLS_PREFIX, [".md"]);
    const records = await Promise.all(
      ids.map(async (id) => await this.readSkillRecordByContextId(id)),
    );

    return records.filter((record): record is SkillMemoryRecord => record !== undefined);
  }

  private async readSkillRecordByContextId(contextId: string): Promise<SkillMemoryRecord | undefined> {
    const rootDir = await this.resolveRootDir();
    const path = resolveContextPath(rootDir, contextId);

    if (!(await exists(path))) {
      return undefined;
    }

    const [stored, raw] = await Promise.all([readStoredContext(rootDir, contextId), readFile(path, "utf8")]);
    const parsed = parseMarkdown(raw);
    const problemClass = readSectionBody(stored.content, "Skill Scope") ?? humanizeSkillId(contextId);
    const title = typeof parsed.frontmatter["skillId"] === "string"
      ? humanizeSkillId(skillIdToContextId(String(parsed.frontmatter["skillId"])))
      : humanizeSkillId(contextId);

    return {
      id: contextId,
      type: "skill",
      scope: "workspace",
      title,
      summary: stored.metadata.description,
      tags: dedupeStrings([
        ...problemClass.toLowerCase().split(/\s+/).filter((token) => token.length >= 4),
      ]),
      runtime: {
        trigger: stored.metadata.trigger,
      },
      provenance: {
        createdBy: readAuditIdentity(parsed.frontmatter["audit"], "createdBy"),
        updatedBy: readAuditIdentity(parsed.frontmatter["audit"], "updatedBy"),
        source: "skill-memory",
        createdAt: readTimestamp(parsed.frontmatter["createdAt"], parsed.frontmatter["updatedAt"]),
        updatedAt: readTimestamp(parsed.frontmatter["updatedAt"], parsed.frontmatter["createdAt"]),
        evidence: deriveEvidenceReferences(parsed.frontmatter["sessions"], contextId),
      },
      problemClass,
      recommendedApproach: extractSectionBullets(stored.content, "Recommended Approach"),
      goodPractices: extractSectionBullets(stored.content, "Good Practices"),
      antiPatterns: extractSectionBullets(stored.content, "Anti-Patterns"),
      failureModes: extractSectionBullets(stored.content, "Common Failure Modes"),
      recoveryPlaybook: extractSectionBullets(stored.content, "Recovery Playbook"),
      confidence: "medium",
    };
  }
}

function filterSkillRecords(
  records: readonly SkillMemoryRecord[],
  input: SkillMemoryListInput,
): readonly SkillMemoryRecord[] {
  return records.filter((record) => {
    if (input.scope !== undefined && record.scope !== input.scope) {
      return false;
    }

    if (input.problemClass !== undefined && !record.problemClass.includes(input.problemClass)) {
      return false;
    }

    if (input.tags !== undefined && input.tags.length > 0) {
      const tags = new Set(record.tags ?? []);
      if (!input.tags.every((tag) => tags.has(tag))) {
        return false;
      }
    }

    return true;
  });
}

function scoreSkillRecords(records: readonly SkillMemoryRecord[], query: string) {
  const loweredTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  return records
    .map((record) => {
      const haystack = [
        record.problemClass,
        record.summary ?? "",
        ...record.recommendedApproach,
        ...record.failureModes,
        ...record.recoveryPlaybook,
        ...record.goodPractices,
        ...record.antiPatterns,
      ]
        .join("\n")
        .toLowerCase();
      const score = loweredTerms.reduce(
        (count, term) => count + (haystack.includes(term) ? 1 : 0),
        0,
      );

      return {
        record,
        score,
        excerpt: record.summary ?? record.problemClass,
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id));
}

function normalizeSkillContextId(id: string): string {
  return id.startsWith(SKILLS_PREFIX) ? id : skillIdToContextId(sanitizeIdSegment(id));
}

function renderSkillRecord(record: SkillMemoryRecord): string {
  return [
    "# Skill Card",
    "",
    "## Skill Scope",
    record.problemClass,
    "",
    "## Recommended Approach",
    ...toBullets(record.recommendedApproach),
    "",
    "## Common Failure Modes",
    ...toBullets(record.failureModes),
    "",
    "## Recovery Playbook",
    ...toBullets(record.recoveryPlaybook),
    "",
    "## Good Practices",
    ...toBullets(record.goodPractices),
    "",
    "## Anti-Patterns",
    ...toBullets(record.antiPatterns),
    "",
    "## Lessons Confirmed By Past Tasks",
    ...toBullets(record.recommendedApproach),
    "",
  ].join("\n");
}

function toBullets(values: readonly string[]): readonly string[] {
  return values.length === 0 ? ["- No entries recorded yet."] : values.map((value) => `- ${value}`);
}

function readSectionBody(content: string, section: string): string | undefined {
  const marker = `## ${section}`;
  const start = content.indexOf(marker);

  if (start === -1) {
    return undefined;
  }

  const remaining = content.slice(start + marker.length).trimStart();
  const nextHeading = remaining.indexOf("\n## ");
  const body = (nextHeading === -1 ? remaining : remaining.slice(0, nextHeading)).trim();

  return body.length === 0 ? undefined : body.replace(/^- /gm, "").trim();
}

function readAuditIdentity(audit: unknown, key: "createdBy" | "updatedBy"): string | undefined {
  if (audit !== null && typeof audit === "object" && key in audit) {
    const value = (audit as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}

function readTimestamp(primary: unknown, fallback: unknown): string {
  if (typeof primary === "string") {
    return primary;
  }

  if (typeof fallback === "string") {
    return fallback;
  }

  return new Date(0).toISOString();
}

function deriveEvidenceReferences(sessions: unknown, contextId: string) {
  const sessionIds = Array.isArray(sessions)
    ? sessions.filter((value): value is string => typeof value === "string")
    : [];

  return [
    { type: "context" as const, id: contextId, label: "skill-card" },
    ...sessionIds.map((sessionId) => ({
      type: "session" as const,
      id: sessionId,
      label: "source-session",
    })),
  ];
}

function toStoreError(message: string, caught: unknown): MemoryResult<never> {
  return errorMemory("store_error", message, {
    message: caught instanceof Error ? caught.message : String(caught),
  });
}
