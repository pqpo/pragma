import { createHash } from "node:crypto";

import type { ExecutorReference, WorkspaceSelection } from "@pragma/shared/integration";

export interface CanonicalRunPayloadInput {
  readonly command: "team.run" | "expert.run" | "flow.run";
  readonly executor: ExecutorReference;
  readonly project?: {
    readonly projectId: string;
    readonly revision: number;
    readonly fingerprint: string;
  };
  readonly workspace: Pick<WorkspaceSelection, "canonicalPath" | "identityHash">;
  readonly prompt?: string;
  readonly input?: unknown;
}

export interface CanonicalRunPayload {
  readonly command: CanonicalRunPayloadInput["command"];
  readonly executor: ExecutorReference;
  readonly project?: CanonicalRunPayloadInput["project"];
  readonly workspace: Pick<WorkspaceSelection, "canonicalPath" | "identityHash">;
  readonly prompt?: string;
  readonly input?: unknown;
}

/**
 * Produce the semantic request representation used by Host idempotency.
 * Presentation flags, TTY state, detach and secret values intentionally never
 * enter this object.
 */
export function canonicalizeRunPayload(input: CanonicalRunPayloadInput): CanonicalRunPayload {
  const payload: CanonicalRunPayload = {
    command: input.command,
    executor: { kind: input.executor.kind, id: input.executor.id },
    ...(input.project === undefined ? {} : { project: { ...input.project } }),
    workspace: {
      canonicalPath: input.workspace.canonicalPath,
      identityHash: input.workspace.identityHash,
    },
    ...(input.prompt === undefined ? {} : { prompt: normalizePrompt(input.prompt) }),
    ...(input.input === undefined ? {} : { input: sortJsonObject(input.input) }),
  };
  return sortJsonObject(payload) as CanonicalRunPayload;
}

export function canonicalRunPayloadJson(input: CanonicalRunPayloadInput): string {
  return JSON.stringify(canonicalizeRunPayload(input));
}

export function hashCanonicalRunPayload(input: CanonicalRunPayloadInput): string {
  return `sha256:${createHash("sha256").update(canonicalRunPayloadJson(input), "utf8").digest("hex")}`;
}

function normalizePrompt(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function sortJsonObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonObject);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonObject(item)]),
  );
}
