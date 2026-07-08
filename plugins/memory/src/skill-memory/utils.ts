import type {
  ContextSensitivity,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextResult,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemEditInput,
} from "@pragma/core";
import { error, ok } from "@pragma/core";

import {
  DISTILLATION_EVIDENCE_PREFIX,
  EXPERIENCE_MEMORY_PREFIX,
  FACT_MEMORY_PREFIX,
  MARKDOWN_EXTENSION,
  RUNS_EVIDENCE_PREFIX,
  SKILLS_PREFIX,
  SUMMARY_CONTEXT_ID,
  TASK_MEMORY_PREFIX,
  TASKS_PREFIX,
  WORKFLOWS_EVIDENCE_PREFIX,
} from "../context-projection/constants.ts";

export function parseMarkdown(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
} {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, content: raw };
  }

  const end = raw.indexOf("\n---\n", 4);

  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }

  const frontmatter = Object.fromEntries(
    raw
      .slice(4, end)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf(":");
        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();

        return [key, parseFrontmatterValue(rawValue)];
      }),
  );

  return {
    frontmatter,
    content: raw.slice(end + "\n---\n".length),
  };
}

export function parseFrontmatterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseMetadata(
  frontmatter: Record<string, unknown>,
  id: string,
): ExpertAgentContextItemMetadata {
  return {
    ...(typeof frontmatter["description"] === "string"
      ? { description: frontmatter["description"] }
      : {}),
    trigger:
      frontmatter["trigger"] === "always_on" ||
      frontmatter["trigger"] === "model_decision" ||
      frontmatter["trigger"] === "manual"
        ? frontmatter["trigger"]
        : defaultTriggerForContextId(id),
    ...(isTrustLevel(frontmatter["trustLevel"]) ? { trustLevel: frontmatter["trustLevel"] } : {}),
    ...(isSensitivity(frontmatter["sensitivity"])
      ? { sensitivity: frontmatter["sensitivity"] }
      : {}),
  };
}

export function isTrustLevel(
  value: unknown,
): value is ExpertAgentContextItemMetadata["trustLevel"] {
  return value === "system" || value === "workspace" || value === "user" || value === "external";
}

export function isSensitivity(value: unknown): value is ContextSensitivity {
  return (
    value === "public" || value === "internal" || value === "confidential" || value === "restricted"
  );
}

export function defaultTriggerForContextId(id: string): ExpertAgentContextItemMetadata["trigger"] {
  if (id === SUMMARY_CONTEXT_ID) {
    return "always_on";
  }

  if (id.startsWith(SKILLS_PREFIX)) {
    return "model_decision";
  }

  if (id.startsWith(FACT_MEMORY_PREFIX)) {
    return "model_decision";
  }

  if (id.startsWith(EXPERIENCE_MEMORY_PREFIX) || id.startsWith(TASK_MEMORY_PREFIX)) {
    return "manual";
  }

  return "manual";
}

export function validateExpectedRevision(
  existing: ExpertAgentStoredContextItem,
  input: ExpertAgentStoredContextItemEditInput,
): ExpertAgentContextResult<never> | undefined {
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    return error("context_conflict", `Skill memory revision conflict: ${input.id}`);
  }

  if (input.expectedEtag !== undefined && input.expectedEtag !== existing.etag) {
    return error("context_conflict", `Skill memory etag conflict: ${input.id}`);
  }

  return undefined;
}

export function readContentRange(
  content: string,
  options: { readonly start: number; readonly offset?: number | undefined },
): {
  readonly content: string;
  readonly requestedStartOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nextStartOffset: number;
  readonly truncated: boolean;
} {
  const buffer = Buffer.from(content, "utf8");
  const requestedStartOffset = Math.min(buffer.byteLength, Math.max(0, options.start));
  const end =
    options.offset === undefined
      ? buffer.byteLength
      : Math.min(buffer.byteLength, requestedStartOffset + Math.max(0, options.offset));
  const decoded = buffer.subarray(requestedStartOffset, end).toString("utf8");

  return {
    content: decoded,
    requestedStartOffset,
    startOffset: requestedStartOffset,
    endOffset: end,
    nextStartOffset: end,
    truncated: end < buffer.byteLength,
  };
}

export function calculateLineRange(
  content: string,
  startOffset: number,
  endOffset: number,
): {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
} {
  const prefix = Buffer.from(content, "utf8").subarray(0, startOffset).toString("utf8");
  const range = Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");

  return {
    startLine: countNewlines(prefix) + 1,
    endLine: countNewlines(prefix) + countNewlines(range) + 1,
    totalLines: countNewlines(content) + 1,
  };
}

export function countNewlines(content: string): number {
  return content.split("\n").length - 1;
}

export function readContextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly string[] {
  return lines.slice(Math.max(0, start), Math.min(lines.length, end));
}

export function sanitizeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function trimCharacters(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}\n[truncated]`;
}

export function trimUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");

  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  const suffix = "\n[truncated]\n";
  const contentMaxBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let sizeBytes = 0;

  for (const character of value) {
    const characterSizeBytes = Buffer.byteLength(character, "utf8");

    if (sizeBytes + characterSizeBytes > contentMaxBytes) {
      break;
    }

    output += character;
    sizeBytes += characterSizeBytes;
  }

  return `${output}${suffix}`;
}

export function toErrorDetails(errorValue: unknown): Record<string, unknown> {
  if (errorValue instanceof Error) {
    return { message: errorValue.message };
  }

  return { message: String(errorValue) };
}

export function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

export function containsSensitiveContent(content: string): boolean {
  return /(api[_-]?key|password|private[_-]?key|secret|token)\s*[:=]/i.test(content);
}

export function readErrorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

export function renderBullets(values: readonly string[], fallback: string): readonly string[] {
  return values.length === 0 ? [`- ${fallback}`] : values.map((value) => `- ${value}`);
}

export function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function parseSections(content: string): Map<string, readonly string[]> {
  const sections = new Map<string, readonly string[]>();
  const lines = content.split("\n");
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeading !== undefined) {
        sections.set(
          currentHeading,
          buffer.filter((value) => value.trim().length > 0),
        );
      }
      currentHeading = line.slice(3).trim();
      buffer = [];
      continue;
    }

    if (currentHeading !== undefined) {
      buffer.push(line);
    }
  }

  if (currentHeading !== undefined) {
    sections.set(
      currentHeading,
      buffer.filter((value) => value.trim().length > 0),
    );
  }

  return sections;
}

export function extractSectionBullets(content: string, section: string): readonly string[] {
  const lines = parseSections(content).get(section) ?? [];
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

export function firstOrDefault(values: readonly string[] | undefined, fallback: string): string {
  return values === undefined || values.length === 0 ? fallback : (values[0] ?? fallback);
}

export function humanizeSkillId(id: string): string {
  const base = id.replace(SKILLS_PREFIX, "").replace(MARKDOWN_EXTENSION, "").replaceAll("-", " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function inferSchemaVersion(id: string): string {
  if (id.startsWith(SKILLS_PREFIX)) {
    return "pragma.memory-skill/v1";
  }

  if (id.startsWith(TASKS_PREFIX)) {
    return id.endsWith(`/workflow${MARKDOWN_EXTENSION}`)
      ? "pragma.memory-workflow-summary/v1"
      : "pragma.memory-task-summary/v1";
  }

  if (id.startsWith(TASK_MEMORY_PREFIX)) {
    return "pragma.memory-task-view/v1";
  }

  if (id.startsWith(EXPERIENCE_MEMORY_PREFIX)) {
    return "pragma.memory-experience-view/v1";
  }

  if (id.startsWith(FACT_MEMORY_PREFIX)) {
    return "pragma.memory-fact-view/v1";
  }

  if (id.startsWith(RUNS_EVIDENCE_PREFIX)) {
    return "pragma.memory-run-evidence/v1";
  }

  if (id.startsWith(WORKFLOWS_EVIDENCE_PREFIX)) {
    return "pragma.memory-workflow-evidence/v1";
  }

  if (id.startsWith(DISTILLATION_EVIDENCE_PREFIX)) {
    return "pragma.memory-distillation-evidence/v1";
  }

  return "pragma.memory-summary/v2";
}

export function normalizeMemoryContextId(id: string): ExpertAgentContextResult<string> {
  if (isAllowedMemoryContextId(id)) {
    return ok(id);
  }

  return error("invalid_input", `Invalid skill memory context id: ${id}`, { id });
}

export function normalizeWritableMemoryContextId(id: string): ExpertAgentContextResult<string> {
  if (id === SUMMARY_CONTEXT_ID) {
    return error(
      "permission_denied",
      "summary.md is generated by the memory system and cannot be written directly.",
    );
  }

  return normalizeMemoryContextId(id);
}

export function isAllowedMemoryContextId(id: string): boolean {
  return (
    id === SUMMARY_CONTEXT_ID ||
    (id.startsWith(SKILLS_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    (id.startsWith(TASKS_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    (id.startsWith(TASK_MEMORY_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    (id.startsWith(EXPERIENCE_MEMORY_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    (id.startsWith(FACT_MEMORY_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    ((id.startsWith(RUNS_EVIDENCE_PREFIX) ||
      id.startsWith(WORKFLOWS_EVIDENCE_PREFIX) ||
      id.startsWith(DISTILLATION_EVIDENCE_PREFIX)) &&
      id.endsWith(".json"))
  );
}
