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
    prompt: 100_000,
  },
  capability: {
    name: 50,
    description: 500,
  },
  contextStore: {
    name: 50,
    description: 500,
  },
} as const;

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
