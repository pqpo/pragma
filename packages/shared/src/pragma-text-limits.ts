export const PRAGMA_TEXT_LIMITS = {
  defaultMetadata: {
    name: 200,
    description: 4_000,
    tag: 100,
    tags: 100,
  },
  expert: {
    name: 50,
    description: 500,
    tag: 20,
    tags: 10,
    scope: 1_000,
    instructions: 5_000,
  },
  expertTeam: {
    name: 50,
    description: 500,
    // New authoring surfaces keep TEAM.md concise; the wider parser ceiling preserves pragma/v5.
    instructionsAuthoring: 2_000,
    instructions: 5_000,
  },
  flow: {
    name: 50,
    description: 500,
    promptTextSegment: 5_000,
  },
  automation: {
    name: 50,
    description: 500,
    // New authoring surfaces use 5,000; the wider parser ceiling keeps existing resources readable.
    promptAuthoring: 5_000,
    prompt: 100_000,
  },
  capability: {
    name: 50,
    description: 500,
  },
  contextStore: {
    name: 50,
    description: 500,
    entryName: 100,
  },
} as const;

export type PragmaKnowledgeBaseEntryNameIssue =
  "empty" | "too_long" | "whitespace" | "invalid_character" | "dot_name" | "reserved_name";

const KNOWLEDGE_BASE_ENTRY_INVALID_CHARACTER_PATTERN = /[<>:"/\\|?*\p{Cc}\p{Cf}]/u;
const WINDOWS_RESERVED_ENTRY_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function pragmaUnicodeLength(value: string): number {
  return [...value].length;
}

export function truncatePragmaUnicode(value: string, maxLength: number): string {
  return [...value].slice(0, maxLength).join("");
}

export function truncatePragmaTrimmedUnicode(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (pragmaUnicodeLength(trimmed) <= maxLength) return value;
  const start = value.indexOf(trimmed);
  return `${value.slice(0, start)}${truncatePragmaUnicode(trimmed, maxLength)}${value.slice(
    start + trimmed.length,
  )}`;
}

/**
 * Validates one user-visible knowledge-base path segment. Callers handling Markdown files should
 * remove the managed `.md` extension before validating so the 100-character limit applies to the
 * name users enter rather than to the system-owned extension.
 */
export function pragmaKnowledgeBaseEntryNameIssue(
  value: string,
): PragmaKnowledgeBaseEntryNameIssue | undefined {
  if (value.length === 0) return "empty";
  if (pragmaUnicodeLength(value) > PRAGMA_TEXT_LIMITS.contextStore.entryName) return "too_long";
  if (/\p{White_Space}/u.test(value)) return "whitespace";
  if (KNOWLEDGE_BASE_ENTRY_INVALID_CHARACTER_PATTERN.test(value)) return "invalid_character";
  if (value === "." || value === ".." || value.startsWith(".") || value.endsWith(".")) {
    return "dot_name";
  }
  if (WINDOWS_RESERVED_ENTRY_NAME_PATTERN.test(value)) return "reserved_name";
  return undefined;
}
