import type { AgentMessageUsage } from "@pragma/shared";

export interface RuntimeTokenUsageInput {
  readonly inputTokens: number;
  readonly inputTokensIncludeCacheRead: boolean;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWrite1hTokens?: number | undefined;
}

export function createEmptyUsage(): AgentMessageUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function createUsageFromTokenCounts(usage: RuntimeTokenUsageInput): AgentMessageUsage {
  const cacheRead = normalizeTokenCount(usage.cacheReadTokens);
  const cacheWrite = normalizeTokenCount(usage.cacheWriteTokens);
  const output = normalizeTokenCount(usage.outputTokens);
  const reportedInput = normalizeTokenCount(usage.inputTokens);
  const input = usage.inputTokensIncludeCacheRead
    ? Math.max(reportedInput - cacheRead, 0)
    : reportedInput;
  const cacheWrite1h = normalizeTokenCount(usage.cacheWrite1hTokens);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function mergeUsage(
  current: AgentMessageUsage | undefined,
  next: AgentMessageUsage | undefined,
): AgentMessageUsage | undefined {
  if (next === undefined) {
    return current;
  }

  if (current === undefined) {
    return next;
  }

  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    ...(current.cacheWrite1h === undefined && next.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (current.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    totalTokens: current.totalTokens + next.totalTokens,
    cost: {
      input: current.cost.input + next.cost.input,
      output: current.cost.output + next.cost.output,
      cacheRead: current.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
      total: current.cost.total + next.cost.total,
    },
  };
}

export function mergeUsages(
  usages: readonly (AgentMessageUsage | undefined)[],
): AgentMessageUsage | undefined {
  return usages.reduce<AgentMessageUsage | undefined>(
    (total, usage) => mergeUsage(total, usage),
    undefined,
  );
}

export function hasNonZeroUsage(usage: AgentMessageUsage | undefined): boolean {
  return (
    usage !== undefined &&
    (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0)
  );
}

export function readFirstTokenCount(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  let zeroValue: number | undefined;

  for (const key of keys) {
    const value = readNumber(record[key]);

    if (value === undefined) {
      continue;
    }

    const normalized = normalizeTokenCount(value);

    if (normalized > 0) {
      return normalized;
    }

    zeroValue = 0;
  }

  return zeroValue;
}

export function normalizeTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
